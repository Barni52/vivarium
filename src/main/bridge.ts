import { app } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AgentActivityEvent, AgentHookKind } from '@shared/types'

// The "bridge" is how agent lifecycle events get out of the container: a small
// host dir (one per project) bind-mounted at /vivarium, holding a Claude Code hooks
// settings file plus a tiny shell script. The agent launches with
// `--settings /vivarium/hooks.json`, so Claude Code itself reports UserPromptSubmit
// (turn started), Stop (turn finished), the two tools that block on the user
// (AskUserQuestion / ExitPlanMode) and their completion (Resumed), by appending a
// line to /vivarium/events.log which the main process tails from the host side.
// This replaces scraping the xterm buffer for the "esc to interrupt" spinner, which
// broke silently whenever the TUI changed: hooks are a documented interface.
//
// Scoping them to `--settings` rather than the shared
// /home/node/.claude/settings.json keeps claude-box.ps1 sessions and
// manually-launched `claude` runs unaffected.
//
// This bridge serves **pty `agent` sessions only**. A `chat` session is never
// pointed at /vivarium/hooks.json and never gets a VIVARIUM_SESSION_ID: it
// derives the same working/waiting/idle triple from its own stream-json output
// (main/chat.ts), and double-emitting would give the store two producers for one
// session. What the two share is the *event* — both emit AgentActivityEvent, and
// the hook→state mapping below is why hook vocabulary no longer crosses IPC.

// Everything hook.sh can legally write. A line with anything else in the first
// field is dropped rather than forwarded — the file is a plain append log, and a
// half-written or hand-edited line must not reach the store as an event.
const HOOK_KINDS: readonly AgentHookKind[] = [
  'UserPromptSubmit',
  'Stop',
  'AskUserQuestion',
  'ExitPlanMode',
  'Resumed'
]

function isHookKind(v: string): v is AgentHookKind {
  return (HOOK_KINDS as readonly string[]).includes(v)
}

/**
 * Hook vocabulary → the state the rest of the app reasons about. This mapping
 * used to live in the renderer store, which meant the *hook kinds themselves*
 * crossed IPC — fine while hooks were the only producer, wrong the moment chat
 * sessions started deriving the same triple from stream-json. Doing it here
 * keeps the attention rules (waiting → "?", idle → "!") in exactly one place
 * rather than once per source.
 *
 * The mapping survives the collapse almost intact:
 *  - AskUserQuestion / ExitPlanMode  → waiting   (blocked on the user, mid-turn)
 *  - Stop                            → idle
 *  - Resumed                         → working   (the store's setActivity already
 *    does the coming-back-from-a-wait arithmetic in its waitedFrom branch)
 *  - UserPromptSubmit                → working, **plus turnStart** — the one bit
 *    a bare state cannot carry, since a queued prompt starts a new turn while
 *    the state is already 'working', where setActivity deliberately no-ops.
 */
function toActivityEvent(kind: AgentHookKind, sessionId: string, at: number): AgentActivityEvent {
  if (kind === 'UserPromptSubmit') return { sessionId, activity: 'working', at, turnStart: true }
  if (kind === 'Resumed') return { sessionId, activity: 'working', at }
  if (kind === 'Stop') return { sessionId, activity: 'idle', at }
  return { sessionId, activity: 'waiting', at }
}

/** Host-side bridge dir for a project (bind-mounted at /vivarium). */
export function bridgeDir(projectId: string): string {
  return join(app.getPath('userData'), 'bridge', projectId)
}

const EVENTS_FILE = 'events.log'

// Stop does NOT fire on a user esc-interrupt (documented behavior), so the
// renderer additionally resets the activity indicator on Esc keypresses.
const HOOKS_JSON = `${JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh UserPromptSubmit' }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh Stop' }] }],
      // Neither blocking tool has a dedicated hook event; their "execution" IS
      // the wait (showing the question UI / the plan for approval), so PreToolUse
      // fires exactly when the agent starts waiting for the user. Two entries
      // rather than one `AskUserQuestion|ExitPlanMode` matcher only so the log
      // stays readable after the fact — the renderer treats them identically.
      // Agents run with --dangerously-skip-permissions, so these are the only
      // two things that can block a turn on a human.
      PreToolUse: [
        {
          matcher: 'AskUserQuestion',
          hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh AskUserQuestion' }]
        },
        {
          matcher: 'ExitPlanMode',
          hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh ExitPlanMode' }]
        }
      ],
      // …and PostToolUse is the other half: the tool only completes once the
      // user has answered, which is when the turn clock starts again. It does
      // NOT fire when the call is rejected ("No, keep planning" denies the tool
      // and hands the agent feedback instead), so the renderer also resumes on
      // the keystroke that answers — see TerminalView.
      PostToolUse: [
        {
          matcher: 'AskUserQuestion|ExitPlanMode',
          hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh Resumed' }]
        }
      ]
    }
  },
  null,
  2
)}\n`

// Invoked as `sh /vivarium/hook.sh <event>` — the file has no exec bit because
// it is written from the Windows host. Reads (and discards) the JSON payload
// Claude Code puts on stdin so the hook never dies on a broken pipe, then
// appends one TSV line. Single small O_APPEND writes don't interleave.
const HOOK_SH = [
  '#!/bin/sh',
  'cat > /dev/null',
  `printf '%s\\t%s\\t%s\\n' "$1" "\${VIVARIUM_SESSION_ID:-}" "$(date +%s)" >> /vivarium/${EVENTS_FILE}`,
  ''
].join('\n')

/**
 * (Re)write the bridge files for a project and truncate its event log. Called
 * right before a container is started or created — never while one is running —
 * so hook-script updates propagate without an image rebuild, and stale events
 * from a previous container life are dropped (the watcher handles the shrink).
 */
export async function ensureBridgeFiles(projectId: string): Promise<void> {
  const dir = bridgeDir(projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'hooks.json'), HOOKS_JSON, 'utf8')
  await writeFile(join(dir, 'hook.sh'), HOOK_SH, 'utf8')
  await writeFile(join(dir, EVENTS_FILE), '', 'utf8')
}

/**
 * Drop a deleted project's bridge dir — hooks.json, hook.sh and events.log.
 *
 * The same cascade `removeClips` performs, for the same reason: nothing else will
 * ever name this directory again, since it is keyed by a project id that is about
 * to leave config.json, and there is no dialog or sweep that could reclaim it
 * later. `syncBridgeWatchers` only drops the in-memory `BridgeWatcher`, so without
 * this every deleted project left a folder behind for the life of the install.
 *
 * **Call it after the watcher is gone.** fs.watch holds a handle on this very
 * directory, and on Windows a directory with an open handle does not always
 * remove — so this belongs after the `syncBridgeWatchers()` that follows the
 * config write, not beside the container removal that precedes it.
 *
 * The guard is the one `removeClips` uses: `projectId` arrives over IPC, and only a
 * direct child of the bridge root is ever removed, so a value carrying a separator or
 * `..` resolves elsewhere and is refused rather than followed.
 */
export async function removeBridge(projectId: string): Promise<void> {
  const root = join(app.getPath('userData'), 'bridge')
  if (!projectId || relative(root, bridgeDir(projectId)) !== projectId) return
  await rm(bridgeDir(projectId), { recursive: true, force: true }).catch(() => {})
}

/**
 * Tails one project's events.log and emits parsed hook events. Lines written
 * before the watcher started are skipped (no replaying stale notifications
 * after an app restart while the container kept running).
 */
export class BridgeWatcher {
  private watcher: FSWatcher | null = null
  private offset = 0
  private reading = false
  private pending = false

  constructor(
    private dir: string,
    private onEvent: (e: AgentActivityEvent) => void
  ) {}

  async start(): Promise<void> {
    const file = join(this.dir, EVENTS_FILE)
    await mkdir(this.dir, { recursive: true })
    try {
      this.offset = (await stat(file)).size
    } catch {
      await writeFile(file, '', 'utf8').catch(() => {})
      this.offset = 0
    }
    try {
      // Watch the dir, not the file: dir watches survive the truncate-rewrite
      // that ensureBridgeFiles does on container start.
      this.watcher = watch(this.dir, (_event, filename) => {
        if (!filename || filename === EVENTS_FILE) void this.drain()
      })
    } catch {
      this.watcher = null // dir vanished — no events until recreated
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /** Serialize reads; coalesce change-event bursts into one trailing read. */
  private async drain(): Promise<void> {
    if (this.reading) {
      this.pending = true
      return
    }
    this.reading = true
    try {
      do {
        this.pending = false
        await this.readNew()
      } while (this.pending)
    } finally {
      this.reading = false
    }
  }

  private async readNew(): Promise<void> {
    const file = join(this.dir, EVENTS_FILE)
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return
    }
    if (size < this.offset) this.offset = 0 // truncated by ensureBridgeFiles
    if (size === this.offset) return

    const fh = await open(file, 'r')
    let chunk: Buffer
    try {
      const buf = Buffer.alloc(size - this.offset)
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
      chunk = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }

    // Only consume complete lines — a partially-flushed line stays for the
    // change event its terminating newline will trigger.
    const nl = chunk.lastIndexOf(0x0a)
    if (nl < 0) return
    this.offset += nl + 1

    // The line's third field is the container's own timestamp; it stays in the
    // log for post-mortem reading but never reaches the UI — see
    // AgentActivityEvent.at for why the host stamps these instead.
    const at = Date.now()
    for (const line of chunk.subarray(0, nl).toString('utf8').split('\n')) {
      const [kind, sessionId] = line.split('\t')
      if (sessionId && isHookKind(kind)) this.onEvent(toActivityEvent(kind, sessionId, at))
    }
  }
}
