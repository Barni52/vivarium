import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// A host project's agents: the Windows Claude Code, run straight in the
// project folder with no container in between. What lives here is the two
// things docker.ts answers for a container agent and nothing else can answer
// for this one — *which* `claude` to run, and whether its conversation already
// exists — so PtyManager can stay a spawner.

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
  const root = join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects')
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return false // no Claude Code has ever run on this machine
  }
  const hits = await Promise.all(
    dirs.map((d) =>
      access(join(root, d, `${uuid}.jsonl`)).then(
        () => true,
        () => false
      )
    )
  )
  return hits.includes(true)
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
