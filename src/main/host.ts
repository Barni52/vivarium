import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// A host project's agents and chats: the Windows Claude Code, run straight in
// the project folder with no container in between. What lives here is what
// docker.ts answers for a container session and nothing else can answer for
// this one — *which* `claude` to run, how to start it without a shell, and
// where its conversations live on this disk and how to read, list and delete
// them — so PtyManager can stay a spawner and ChatService can stay ignorant of
// which side of the container boundary its transcript is on.

/** How to start the host `claude`: an executable, or a batch shim run by cmd. */
export type ClaudeLaunch = { kind: 'exe' | 'cmd'; path: string }

/**
 * Find `claude` the way typing it into a terminal would, minus the shell.
 *
 * `PATH` first, `.exe` before `.cmd` in each directory. Two installs are in
 * play: the native installer drops `claude.exe` in `~/.local/bin`, and npm
 * leaves a `claude.cmd` shim in its global prefix. Only these two, and not the
 * `.ps1` npm writes beside the shim: that one runs only under a PowerShell
 * whose execution policy allows it, which is a question for the user's shell,
 * not for a spawner.
 *
 * `~/.local/bin` is also looked in directly, after PATH. Electron inherits the
 * environment of whatever launched it, so an app that was already open when
 * Claude Code was installed has a PATH that predates it; the native installer's
 * own directory is the one place worth guessing.
 *
 * Never cached: this is a couple of dozen `access` calls per agent opened, and
 * a cached miss would outlive the install that fixes it.
 */
export async function resolveClaude(): Promise<ClaudeLaunch | null> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  dirs.push(join(homedir(), '.local', 'bin'))
  for (const dir of dirs) {
    for (const [name, kind] of [
      ['claude.exe', 'exe'],
      ['claude.cmd', 'cmd']
    ] as const) {
      const path = join(dir, name)
      try {
        await access(path)
        return { kind, path }
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/**
 * Does the host Claude Code already have a transcript for `uuid`?
 *
 * The host side of `DockerService.claudeConversationExists`, and globbed the
 * same way for the same reason: Claude files a transcript under an escaped copy
 * of the directory it was started in, and re-deriving that escaping here would
 * break silently the day it changes. So every project directory is looked in,
 * which is safe because the uuid is one this app minted — a hit anywhere can
 * only be this session's own conversation.
 *
 * Only "anywhere" is good enough *because* a host agent's directory never
 * changes under a live conversation id: Claude refuses a `--resume` from a
 * different directory, so when a host project's base folder moves its agents
 * are given new ids (see the updateProject handler) rather than being left to
 * find their old transcript and fail on it.
 *
 * Honours `CLAUDE_CONFIG_DIR`, which relocates the whole of `~/.claude`.
 */
export async function hostConversationExists(uuid: string): Promise<boolean> {
  return (await transcriptDir(uuid)) !== null
}

/**
 * The host Claude Code's own directory: `~/.claude`, or wherever
 * `CLAUDE_CONFIG_DIR` moved it. The container pins this to `/home/node/.claude`
 * on the shared creds volume; on Windows it is the user's, shared with every
 * `claude` they ever typed into a terminal — which is why nothing below ever
 * touches a path in it that is not named by a uuid this app minted.
 */
export function hostClaudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

function projectsRoot(): string {
  return join(hostClaudeDir(), 'projects')
}

/** Every per-folder transcript directory under `projects/`, absolute. */
async function projectDirs(): Promise<string[] | null> {
  const root = projectsRoot()
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name))
  } catch {
    return null // no Claude Code has ever run on this machine
  }
}

/**
 * Which `projects/<slug>` directory holds this conversation, remembered once
 * found.
 *
 * Found by looking rather than by escaping `basePath` into a slug, for the
 * reason `hostConversationExists` gives — and measured to be a real risk, not a
 * theoretical one: this repo's own folder is `D:\vivarium` on disk and Claude
 * filed it under `D--Vivarium`, so the escaping is not even a pure function of
 * the path string Vivarium holds.
 *
 * Remembered because a host chat reads its transcript at every turn end (the
 * settle) and the scan is a few dozen `access` calls. The memory is checked on
 * every use, so a file that has gone (a delete, a cleanup) costs one failed
 * `access` and a rescan rather than a stale answer.
 */
const located = new Map<string, string>()

async function transcriptDir(uuid: string): Promise<string | null> {
  const known = located.get(uuid)
  if (known) {
    try {
      await access(join(known, `${uuid}.jsonl`))
      return known
    } catch {
      located.delete(uuid)
    }
  }
  const dirs = await projectDirs()
  if (!dirs) return null
  const hits = await Promise.all(
    dirs.map((d) =>
      access(join(d, `${uuid}.jsonl`)).then(
        () => d,
        () => null
      )
    )
  )
  const hit = hits.find((d): d is string => d !== null) ?? null
  if (hit) located.set(uuid, hit)
  return hit
}

/** What a transcript read answers — the same shape `DockerService.readTranscript` returns. */
export interface TranscriptRead {
  ok: boolean
  text: string
  /** bytes actually read, which is what every offset after this one is counted in */
  bytes: number
  message?: string
}

/**
 * A host conversation's transcript, whole or from a byte offset — the host
 * side of `DockerService.readTranscript`, and the *only* thing that differs
 * about reading one. What the caller does with the bytes (whole lines only, one
 * turn per settle, the prose floor, the rewound ranges) is ChatService's and is
 * identical on both sides, because the file is the same file Claude Code writes
 * in a container: same lines, same order, same byte offsets.
 *
 * A conversation that has never been messaged has no file yet, which is an
 * empty history and not a failure — the same reading `cat` exiting 1 gives the
 * container side.
 *
 * Read with a positioned read rather than a stream: the CLI is appending to the
 * file while this runs, and `size` is taken once so a read never chases a
 * write. Whatever lands after it is the next read's — and a line half-written
 * at that instant is dropped whole by `completeLines` on the way in.
 */
export async function readHostTranscript(uuid: string, fromByte = 0): Promise<TranscriptRead> {
  const dir = await transcriptDir(uuid)
  if (!dir) return { ok: true, text: '', bytes: 0 }
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(join(dir, `${uuid}.jsonl`), 'r')
    const { size } = await fh.stat()
    const length = Math.max(0, size - fromByte)
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await fh.read(buf, read, length - read, fromByte + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { ok: true, text: buf.subarray(0, read).toString('utf8'), bytes: read }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, text: '', bytes: 0 }
    return { ok: false, text: '', bytes: 0, message: err instanceof Error ? err.message : String(err) }
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * One subagent's sibling log — `<slug>/<uuid>/subagents/agent-<id>.jsonl`, the
 * host side of `DockerService.readSubagentLog`.
 *
 * `agentId` is parsed out of tool-result content, so it is model-influenced
 * data, and here it goes into a **path** on the user's own disk rather than
 * into a shell inside a container. The same validation the container side does
 * is therefore not belt-and-braces but the whole guard: no separator, no `..`,
 * so the join cannot leave the conversation's own directory.
 */
export async function readHostSubagentLog(uuid: string, agentId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return null
  const dir = await transcriptDir(uuid)
  if (!dir) return null
  try {
    const text = await readFile(join(dir, uuid, 'subagents', `agent-${agentId}.jsonl`), 'utf8')
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** Claude's conversation uuids, and nothing else — the shape `randomUUID()` produces. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Delete host conversations by uuid — the host side of
 * `DockerService.deleteTranscripts`, and the same two paths per conversation:
 * the `<uuid>.jsonl` and the `<uuid>/` directory beside it, which holds the
 * subagent logs and most of the bytes.
 *
 * **Recursive removal with an interpolated name, so the safety argument sits
 * here as it does on the container side:** every uuid is `randomUUID()` output
 * and is re-checked against that exact shape before it goes near a path, so it
 * holds no separator, no `..` and no wildcard, and each removal names one
 * conversation inside one `projects/<slug>` directory. Every slug directory is
 * looked in rather than the one `basePath` escapes to, for the reason
 * `transcriptDir` gives; that is safe for the same reason it is safe to *read*
 * from anywhere — a hit can only be this app's own conversation.
 *
 * True only when nothing failed; a missing file is not a failure (`force`), so
 * a debt whose files are already gone self-clears. A file a just-killed CLI
 * still holds open fails with EBUSY on Windows, which leaves the debt for the
 * next launch to pay.
 */
export async function deleteHostTranscripts(uuids: string[]): Promise<boolean> {
  const safe = uuids.filter((u) => UUID_RE.test(u))
  if (safe.length === 0) return true
  const dirs = await projectDirs()
  if (!dirs) return true // no projects directory, so nothing to owe
  let ok = true
  for (const uuid of safe) {
    located.delete(uuid)
    for (const dir of dirs) {
      for (const target of [join(dir, `${uuid}.jsonl`), join(dir, uuid)]) {
        try {
          await rm(target, { recursive: true, force: true })
        } catch {
          ok = false
        }
      }
    }
  }
  return ok
}

/**
 * Count a literal term across host conversations — the host side of
 * `DockerService.searchTranscripts`, with one deliberate narrowing: only the
 * uuids handed in are read, never the whole of `~/.claude/projects`.
 *
 * The creds volume is Vivarium's and claude-box's, so grepping all of it is
 * searching "conversations this setup had". `~/.claude` on Windows is every
 * conversation the user has ever had with any `claude` on this machine; a
 * search box in this app reaching into all of that would answer a question
 * nobody asked it, and slowly. So the caller names the conversations host
 * sessions own (current and retired ids) and this reads those — plus each one's
 * subagent logs, folded into the conversation as the container side folds them.
 *
 * `grep -c` semantics: a count of *matching lines*, case-sensitive and literal.
 * `fragments` carries the `before`/`after` window around the first match in
 * each conversation's densest file, for `snippetOf` to make readable — the same
 * window the container's `grep -o` cuts.
 */
export async function searchHostTranscripts(
  uuids: string[],
  query: string,
  before: number,
  after: number
): Promise<{ counts: Map<string, number>; fragments: Map<string, string> }> {
  const counts = new Map<string, number>()
  const fragments = new Map<string, string>()
  for (const uuid of uuids) {
    if (!UUID_RE.test(uuid)) continue
    const dir = await transcriptDir(uuid)
    if (!dir) continue
    const files = [join(dir, `${uuid}.jsonl`)]
    try {
      const subs = join(dir, uuid, 'subagents')
      for (const name of await readdir(subs)) if (name.endsWith('.jsonl')) files.push(join(subs, name))
    } catch {
      /* no subagents — the common case */
    }
    let total = 0
    let densest = 0
    for (const file of files) {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      let n = 0
      let first: string | null = null
      for (const line of text.split('\n')) {
        const at = line.indexOf(query)
        if (at < 0) continue
        n += 1
        first ??= line.slice(Math.max(0, at - before), at + query.length + after)
      }
      total += n
      if (n > densest && first !== null) {
        densest = n
        fragments.set(uuid, first)
      }
    }
    if (total > 0) counts.set(uuid, total)
  }
  return { counts, fragments }
}

/**
 * The slash-command and skill definitions on this disk — the host side of
 * `DockerService.listCommandFiles`, over the same four directories: the
 * project's `<basePath>/.claude` and the user's own `~/.claude`.
 *
 * The user's paths are **spelled** `~/.claude/…` whatever `CLAUDE_CONFIG_DIR`
 * calls the directory: `commandNamesFrom` keys on the `/.claude/` segment and
 * takes the name from what follows it, so that segment has to be there and
 * nothing before it matters. Bounded like the container's `head -500`.
 */
export async function listHostCommandFiles(basePath: string): Promise<string[]> {
  const roots: [string, string][] = [
    [join(basePath, '.claude'), `${basePath.replace(/\\/g, '/')}/.claude`],
    [hostClaudeDir(), '~/.claude']
  ]
  const out: string[] = []
  for (const [dir, spelled] of roots) {
    for (const rel of await filesUnder(join(dir, 'commands'), 0)) {
      if (rel.endsWith('.md')) out.push(`${spelled}/commands/${rel}`)
    }
    // A skill is a directory holding SKILL.md, exactly one level down. Tested
    // with `access` rather than by dirent type so a symlinked skill counts.
    let skills: string[] = []
    try {
      skills = await readdir(join(dir, 'skills'))
    } catch {
      /* no skills here — the common case */
    }
    for (const name of skills) {
      try {
        await access(join(dir, 'skills', name, 'SKILL.md'))
        out.push(`${spelled}/skills/${name}/SKILL.md`)
      } catch {
        /* not a skill */
      }
    }
  }
  return out.slice(0, 500)
}

/** Files under `dir`, as `/`-joined paths relative to it. Depth-capped; silent on error. */
async function filesUnder(dir: string, depth: number): Promise<string[]> {
  if (depth > 6) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isFile()) out.push(e.name)
    else if (e.isDirectory()) {
      for (const rel of await filesUnder(join(dir, e.name), depth + 1)) out.push(`${e.name}/${rel}`)
    }
  }
  return out
}

/**
 * Start the host `claude` as a plain child process with pipes — the chat's
 * process and the titler's, where PtyManager starts the agent's under a pty.
 *
 * No shell, as for the agent. An `.exe` is spawned directly; an npm `.cmd` shim
 * has to go through cmd.exe, because Node refuses to spawn a batch file without
 * a shell (CVE-2024-27980), and it goes through it as one verbatim string for
 * the quoting reason `cmdLine` gives. Either way the environment loses an outer
 * Claude Code's session markers (see `withoutParentSession`) — a chat launched
 * from an app that was itself launched inside a Claude session would otherwise
 * save no transcript, and for a chat the transcript is the whole model.
 *
 * Throws what `spawn` throws; a missing cwd arrives later as an `error` event.
 */
export function spawnHostClaude(
  claude: ClaudeLaunch,
  args: string[],
  cwd: string
): ChildProcessWithoutNullStreams {
  const env = withoutParentSession({ ...process.env } as Record<string, string>)
  if (claude.kind === 'exe') return spawn(claude.path, args, { cwd, env, windowsHide: true })
  return spawn(process.env['ComSpec'] || 'cmd.exe', [cmdLine(claude.path, args)], {
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: true
  })
}

/**
 * Ask the host Claude Code a one-shot question in a conversation that is thrown
 * away before this resolves — the host side of `DockerService.askClaude`, which
 * argues each of these choices; only their host spelling is here.
 *
 * - **A fixed, empty working directory** (`%TEMP%\vivarium-titler`) where the
 *   container uses `/tmp`: cwd decides which CLAUDE.md loads, and the project's
 *   is what this must not pay for. *Fixed* rather than a fresh `mkdtemp` per
 *   call, because Claude files every conversation under a directory named after
 *   its cwd — a new cwd per title would grow `~/.claude/projects` by one
 *   directory per title, forever.
 * - **A pinned `--session-id`**, so the transcript it necessarily writes has a
 *   name we know and is deleted right after, through the same uuid-checked
 *   removal a deleted chat gets.
 * - No `--permission-mode`: a plain `-p` run auto-denies every prompt, which is
 *   exactly what a process asked for five words should get.
 *
 * Null on any failure at all; the caller keeps the name it has.
 */
export async function askHostClaude(
  prompt: string,
  model: string,
  timeoutMs = 90_000
): Promise<string | null> {
  const claude = await resolveClaude()
  if (!claude) return null
  const cwd = join(tmpdir(), 'vivarium-titler')
  try {
    await mkdir(cwd, { recursive: true })
  } catch {
    return null
  }
  const uuid = randomUUID()
  const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnHostClaude(claude, ['-p', '--model', model, '--session-id', uuid], cwd)
    } catch {
      resolve({ code: null, stdout: '' })
      return
    }
    let stdout = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (stdout += c))
    child.stderr.on('data', () => {
      /* diagnostic noise; the exit code is the report */
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
    child.stdin.on('error', () => {
      /* the child died before it read us; the exit code is the report */
    })
    child.stdin.end(prompt)
  })
  // Best-effort and not awaited into the answer, as on the container side.
  void deleteHostTranscripts([uuid])
  if (r.code !== 0) return null
  return r.stdout.trim() || null
}

/**
 * What an *outer* Claude Code exports to every process it runs, naming itself:
 * "you are inside session X, reach me on this pipe". Found by launching the app
 * from inside a Claude Code session (which is how it gets developed): Electron
 * inherits them, a host pty inherits them from Electron, and the `claude`
 * started there decides it is that session's child — it prints "Transcript
 * saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" and writes no
 * transcript, which silently breaks the `--resume` every host agent relies on.
 *
 * An explicit list, not a `CLAUDE_CODE_` prefix: that prefix is also where the
 * user's own configuration lives (`CLAUDE_CODE_GIT_BASH_PATH`,
 * `CLAUDE_CODE_USE_BEDROCK`, …), and it has to reach the agent untouched.
 */
const PARENT_SESSION_VARS = new Set([
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID'
])

/**
 * Drop the parent-session markers from a host pty's environment, so whatever
 * runs there — a host agent, or a `claude` typed into a host PowerShell — is a
 * top-level session of its own, as it would be in a terminal opened from the
 * Start menu. Case-blind, because Windows environment names are.
 */
export function withoutParentSession(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(env)) {
    if (PARENT_SESSION_VARS.has(key.toUpperCase())) delete env[key]
  }
  return env
}

/**
 * The argument string for running a `.cmd` shim through cmd.exe.
 *
 * A string rather than an argv because node-pty would quote an argv the
 * MSVCRT way (`\"`), which cmd.exe does not understand; node-pty passes a
 * string through as the command line verbatim. `/s /c "…"` strips exactly the
 * outer pair of quotes and runs the rest, so each piece inside is quoted on its
 * own. None of what is passed can hold a `"` (a Windows path cannot, and the
 * rest are flags and a uuid).
 */
export function cmdLine(shim: string, args: string[]): string {
  const q = (s: string): string => (/[\s&|<>^()]/.test(s) ? `"${s}"` : s)
  return `/d /s /c "${[shim, ...args].map(q).join(' ')}"`
}
