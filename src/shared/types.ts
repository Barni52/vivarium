// Shared types used by both the main process and the renderer.

export type ImageVariant = 'slim' | 'full'

export type SessionType = 'agent' | 'chat' | 'container-shell' | 'host-shell'

/**
 * The two permission modes a chat session runs in, and nothing else.
 *
 * Both enforce nothing: a session that can reach `bypassPermissions` has plan
 * mode's blocks unenforced, and today's terminal agents already launch with
 * `--dangerously-skip-permissions`, so plan mode in Vivarium was only ever a
 * suggestion. `plan` is kept because the agent reliably reaches for
 * `ExitPlanMode` in it — and *that call is the plan card*.
 */
export type ChatMode = 'plan' | 'bypassPermissions'

export interface Session {
  id: string
  name: string
  type: SessionType
  /**
   * For `agent` and `chat` sessions: a stable UUID pinned as Claude Code's own
   * conversation id (`claude --session-id <uuid>` on first launch, `--resume <uuid>`
   * after), so a conversation survives the container being stopped/recreated and the
   * app restarting — the transcript persists on the claude-box-creds volume, and we
   * re-attach the *conversation* without any multiplexer. Undefined for shell
   * sessions, and for legacy agent sessions until backfilled on config load.
   *
   * NOT write-once for chat: `/clear` mints a new conversation and the outgoing id
   * moves to `previousClaudeSessionIds`.
   */
  claudeSessionId?: string
  /**
   * chat only. Ids retired by `/clear`. Kept so the delete cascade can take the
   * *whole chain* — deleting a chat takes everything it ever said, not only its
   * latest incarnation. `/clear` itself destroys nothing, so an accidental one
   * stays recoverable through Claude's own `--resume` picker.
   */
  previousClaudeSessionIds?: string[]
  /**
   * chat only. A deliberate exception to "runtime state is queried live, never
   * persisted": this is a per-session *user preference* about how the agent runs,
   * not state observed from Docker — which is exactly what config.json is for.
   * Restored at reopen as the launch `--permission-mode`.
   */
  mode?: ChatMode
  /** chat only. Same exception, same argument; applied as `--model` at spawn. */
  model?: string
  /**
   * chat only. This name was written by the app, not by you — so the app may
   * write it again.
   *
   * The sixth deliberate exception to "runtime state is queried live": it is a
   * fact about *who last named this session*, and there is nowhere to query
   * that from. It exists because auto-titling has exactly one way to be
   * obnoxious — overwriting a name a human chose — and a flag is the only thing
   * that can tell the two apart once both are just a string in `name`.
   *
   * Set whenever a generated title lands, cleared for good by the sidebar's
   * rename (see the CH.renameSession handler). Absent on every session that
   * existed before the feature, which is why `isDefaultName` is consulted
   * *alongside* it: a chat still called `chat-3` was named by the counter, not
   * by a person, so it is fair game with no migration.
   */
  autoName?: true
  /**
   * chat only. Stretches of this conversation's transcript that a revert
   * abandoned, skipped by every later whole-file read.
   *
   * The same exception again, and on the strongest version of the argument: a
   * rewind you performed is a fact that *cannot* be queried. Claude Code does
   * not truncate the file when it winds a conversation back — it appends a
   * `last-prompt` branch pointer and leaves the abandoned lines in place — and
   * its own loader resolves the live branch through compaction boundaries and
   * preserved segments that this app cannot re-derive without guessing. So the
   * act is recorded rather than the content mirrored, exactly like
   * `previousClaudeSessionIds` below it.
   *
   * Cleared by `/clear`: a new conversation is a new file, and these offsets
   * would point into the retired one.
   */
  rewound?: ChatRewindRange[]
}

/**
 * A stretch of transcript bytes a revert abandoned — half-open, `[from, to)`.
 *
 * Byte offsets, never string indices: a transcript is read as a Buffer and
 * every offset in this app is `Buffer.byteLength`, or one multibyte character
 * anywhere in the conversation slides the whole range.
 */
export interface ChatRewindRange {
  from: number
  to: number
}

/** What `chat:rewind` answers: what came off, and what to put in the composer. */
export interface ChatRewindResult {
  ok: boolean
  /** how many of your messages were dropped — 0 when nothing moved */
  removed: number
  /** the picked message's own text, handed back for editing */
  prefill: string | null
  /** why it refused, or why it stopped short of what was asked */
  message?: string
}

export interface Project {
  id: string
  name: string
  /** Absolute host path the project is rooted at (host shells cwd here). */
  basePath: string
  /** Absolute host paths of the subfolders mounted into the container. */
  mounts: string[]
  image: ImageVariant
  /** Only meaningful for `full` projects; slim projects never publish a port. */
  publishedPort?: number
  sessions: Session[]
  /**
   * Last known `/`-command names for this project's container, cached so a chat
   * opened cold has a menu before its first turn (nothing is emitted on the wire
   * until the first user message, so there is no `init` to read yet).
   *
   * Runtime-derived data in config, and admissible for a reason that does not
   * generalise: **the cache is a hint, never authority**. The composer forwards
   * every `/…` verbatim and the CLI always decides, so a stale entry can only
   * mis-suggest, never mis-execute. `Session.model` deliberately does *not* get
   * the same treatment — a chip reading "opus" while the process spawned on
   * something else is a reading that lies about a live fact.
   */
  slashCommands?: string[]
}

export interface Config {
  version: 1
  projects: Project[]
  /**
   * Absolute host path of the shared output folder, mounted read-write into
   * every container at /workspace/output. Where agents drop artifacts (HTML,
   * etc.) the user wants to read. Optional / may be unset.
   */
  sharedOutputFolder?: string
  /**
   * Base ref the "Write branch diff" project action diffs the current branch
   * against (e.g. "origin/master"). Defaults to "origin/master" when unset.
   */
  diffBase?: string
  /**
   * The chat window's zoom factor, shared by every chat session.
   *
   * Persisted, unlike `terminalFontSize`, and the difference is not principled —
   * it is what was asked for. The reason it *can* be persisted is that this is a
   * preference about the monitor you are sitting at, not runtime state observed
   * from Docker: nothing can query it, and a factor that resets to 1 every time
   * the app restarts is a setting the app keeps forgetting.
   *
   * Optional, and clamped by both ends (`zoomChat` in the store, the handler in
   * `ipc.ts`) — a hand-edited config.json must not be able to set 40×.
   */
  chatZoom?: number
  /**
   * Conversations owed a delete: bare Claude conversation uuids, enqueued in the
   * *same* atomic mutate that removes the session or project that owned them.
   *
   * Not a never-persist exception. That invariant forbids persisting what can be
   * queried live; a deletion you owe is exactly a fact that cannot be, since
   * Docker being down is *why* you owe it. There is no success path and no
   * failure path here — the debt is recorded, then the debt is paid, and the fast
   * case is a drain that runs immediately and succeeds.
   */
  pendingTranscriptDeletes?: string[]
}

/** Result of the "Write branch diff" project action. */
export interface DiffResult {
  ok: boolean
  message: string
}

/** One node in the shared-output-folder file tree. */
export interface OutputNode {
  name: string
  /** absolute host path */
  path: string
  type: 'file' | 'dir'
  children?: OutputNode[]
}

/** Live container state (queried from docker, not persisted). */
export interface ContainerState {
  projectId: string
  running: boolean
  exists: boolean
}

/**
 * What an agent is doing right now. 'waiting' is still mid-turn — the agent has
 * blocked on the user (a question, or a plan waiting for approval) and is
 * burning no time at all, which is why it is a state of its own rather than a
 * flavor of 'working': the turn clock pauses for exactly as long as it lasts.
 */
export type AgentActivity = 'idle' | 'working' | 'waiting'

/**
 * What an agent session is doing, from either producer.
 *
 * There are two now, and they unify **at the event, not at the channel**:
 * `bridge.ts` maps Claude Code hooks for pty `agent` sessions, `chat.ts` derives
 * the same triple from the ordinary stream-json output for `chat` sessions. The
 * store cannot tell them apart, which is the point — an adapter emitting hook
 * *kinds* was the earlier design and it does not work in this direction: main
 * would have to emit 'ExitPlanMode' to mean "waiting", and a working-directory
 * permission prompt (which blocks a chat turn on a human just as much) has no
 * hook kind to lie with at all.
 */
export interface AgentActivityEvent {
  sessionId: string
  activity: AgentActivity
  /**
   * Epoch ms, stamped on the HOST as the producer read the event — never a
   * container-side timestamp: a WSL2 clock drifts from Windows across host sleep,
   * and these values are subtracted from `Date.now()` to show "working 4m", so a
   * skewed one would print a negative or absurd turn. The bridge's events.log
   * keeps its own timestamp for post-mortem reading only.
   */
  at: number
  /**
   * The one bit a *state* cannot carry: a queued prompt starts a new turn while
   * the state is already 'working', where setActivity deliberately no-ops. Set
   * whenever a user message really was submitted.
   */
  turnStart?: true
  /**
   * The second such bit: land the state change but raise no attention flag. Set
   * for the `idle` that follows an interrupt — you ended the turn, so being told
   * it finished is noise. (Esc normally requires the session focused and
   * selected, which notifyAgentAttention already declines, but there is a ~100 ms
   * window in which clicking away first would flag the turn you just killed.)
   */
  quiet?: true
}

/**
 * Claude Code hook events read out of the container bridge. `bridge.ts`'s own
 * internal vocabulary now — it maps these to an AgentActivityEvent before
 * anything crosses IPC, so the attention rules live in exactly one place instead
 * of once per producer. `AskUserQuestion`/`ExitPlanMode` are the two tools whose
 * "execution" is waiting for the user; `Resumed` is their PostToolUse, i.e. the
 * answer landed and the agent is running again.
 */
export type AgentHookKind =
  | 'UserPromptSubmit'
  | 'Stop'
  | 'AskUserQuestion'
  | 'ExitPlanMode'
  | 'Resumed'

/**
 * One rate-limit window from the (undocumented) Claude OAuth usage endpoint —
 * `kind` is 'session' (5h) / 'weekly_all' / 'weekly_scoped' (per-model, see
 * modelName) today, but treated as an open string since the API is unstable.
 */
export interface UsageLimit {
  kind: string
  /** 0-100 (the endpoint may report fractions) */
  percent: number
  /** 'normal' until Anthropic escalates it — surfaced in the tooltip only */
  severity: string
  /** ISO timestamp, null if the endpoint omitted it */
  resetsAt: string | null
  /** display name for weekly_scoped limits (e.g. "Fable"), null otherwise */
  modelName: string | null
  isActive: boolean
}

/** Claude plan usage fetched by main (see main/usage.ts). */
export interface UsageSnapshot {
  ok: boolean
  /** when ok=false: 'no-credentials' | 'auth-expired' | 'network' | http status text */
  error?: string
  limits: UsageLimit[]
  fetchedAt: number
}

/**
 * Claude Code version state for one project's container. The CLI is installed
 * *inside* the container (image layer + whatever a manual update put in the
 * writable layer), so there is nothing to read while it isn't running.
 */
export interface ClaudeVersionInfo {
  projectId: string
  /** version read from the container, null when it couldn't be read */
  installed: string | null
  /** why `installed` is null: 'stopped' | 'no-container' | 'docker-missing' | 'error' */
  reason?: 'stopped' | 'no-container' | 'docker-missing' | 'error'
}

/** Snapshot behind the title-bar version chip and the Claude Code dialog. */
export interface ClaudeStatus {
  /** newest version published on npm, null when the check failed */
  latest: string | null
  /** why `latest` is null: 'network' | 'offline' | `http-<status>` */
  latestError?: string
  /** epoch ms of the last successful npm check; 0 = never succeeded */
  checkedAt: number
  containers: ClaudeVersionInfo[]
}

/** Result of one manual "update Claude Code in this container" run. */
export interface ClaudeUpdateResult {
  ok: boolean
  /** version read back after the install, null when unreadable */
  version: string | null
  /** short error tail when ok=false */
  message?: string
}

/**
 * One docker volume, as shown in the Volumes dialog.
 *
 * Three kinds exist:
 *  - `shared`   the claude-box-creds / claude-box-home pair. Auth, settings and
 *               agent memory live here and they are deliberately shared with the
 *               user's older claude-box setup — never removable from the UI.
 *  - `shadow`   `vivarium-<hash>-<suffix>`: a container-local overlay on one
 *               mounted folder's build output (node_modules, Maven target …).
 *               `hash` identifies the host path, so a volume whose hash matches
 *               no current mount is orphaned — its folder was unmounted or its
 *               project deleted, and nothing else will ever clean it up.
 *  - `other`    any remaining `vivarium-*` volume (dev leftovers, older naming).
 */
export interface VolumeInfo {
  name: string
  kind: 'shared' | 'shadow' | 'other'
  /** docker's own human-readable size, e.g. "1.21GB"; null when unreported */
  size: string | null
  /** same size in bytes, for totals and sorting; null when unparseable */
  bytes: number | null
  /** containers currently using it — docker refuses to remove a volume in use */
  links: number
  /** what a shadow volume overlays ("node_modules"), null for the other kinds */
  contents: string | null
  /** projects whose mounts produced this volume; empty means orphaned */
  projects: string[]
  /** never offer removal (the shared pair) */
  locked: boolean
}

/** Volumes plus whether the size sweep actually reported anything. */
export interface VolumeReport {
  volumes: VolumeInfo[]
  /** false when `docker system df` failed — names are listed, sizes are null */
  sized: boolean
  error?: string
}

/** Result of removing one volume. */
export interface VolumeRemoveResult {
  ok: boolean
  /** docker's message when ok=false (e.g. "volume is in use") */
  message?: string
}

/**
 * One conversation that contains the search term.
 *
 * Keyed by the Claude conversation uuid rather than by session, because the two
 * are not one-to-one: `/clear` retires an id onto `previousClaudeSessionIds` and
 * mints a new one, so a single sidebar row can own several transcripts. Each is
 * reported separately — an archived one is a real place the answer might be, and
 * folding it into its session's current conversation would claim the hit is
 * somewhere it is not.
 */
export interface TranscriptHit {
  /** the Claude conversation uuid */
  uuid: string
  /** how many transcript lines matched (lines, not occurrences — grep counts lines) */
  matches: number
  /** null when no session in config owns this uuid — see `foreign` */
  projectId: string | null
  projectName: string | null
  sessionId: string | null
  sessionName: string | null
  /** this uuid was retired by a `/clear`; its session has moved on */
  archived: boolean
  /**
   * One line of context around the first match, or absent when the second grep
   * found nothing to show (see DockerService.transcriptSnippets). It is a slice
   * of a JSON line rather than a rendered message, so it is a *preview* — enough
   * to tell two plausible conversations apart, which is the question the count
   * on its own could not answer.
   */
  snippet?: string
  /**
   * Nothing in config.json owns this conversation. The shared creds volume holds
   * the user's claude-box transcripts as well as Vivarium's, and a deleted
   * session's conversation may still be sitting there awaiting a drain — so these
   * are real hits that simply have nowhere to navigate to, and they are reported
   * rather than hidden.
   */
  foreign: boolean
}

export interface TranscriptSearchResult {
  ok: boolean
  /** newest-looking first is meaningless here, so: most matches first */
  hits: TranscriptHit[]
  /** why ok=false: 'docker-missing' | 'no-volume' | 'timed-out' | a docker message */
  error?: string
}

/** Versions shown on the title-bar chip — enough to paste into a bug report. */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
}

/** Taskbar overlay badge pushed by the renderer (drawn there — main has no canvas). */
export interface BadgePayload {
  /** outstanding attention count (finished + asking agents); 0 clears the overlay */
  count: number
  /** 32×32 PNG data URL of the count disc, null when count is 0 */
  dataUrl: string | null
  /** flash the taskbar button — set for events arriving while unfocused */
  flash: boolean
}

/** Result of trying to open a session's pty. */
export interface SpawnResult {
  ok: boolean
  /** Present when ok === false, e.g. 'container-stopped' | 'docker-missing'. */
  reason?: string
  message?: string
}

/** Payload streamed from a pty to the renderer. */
export interface PtyDataEvent {
  sessionId: string
  data: string
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
}

/** Docker availability + build progress signalling. */
export interface DockerStatus {
  available: boolean
  binary: string | null
  message?: string
}

// ---------------------------------------------------------------------------
// chat sessions
//
// A `chat` session drives Claude Code over `claude -p --input-format stream-json
// --output-format stream-json` (one live CLI process per session, `docker exec -i`,
// never `-it`). Hooks, skills, CLAUDE.md, --resume and the whole harness stay
// intact — this is not a bespoke agent loop against the Anthropic API.
//
// The *model* of a conversation is the container-side transcript, not anything
// this app keeps: while a turn runs the log paints from the stream, and at the
// turn's `result` main re-reads the bytes appended to the .jsonl and replaces
// that turn's entries with transcript-derived ones. So anything more than a few
// seconds old is always the same bytes a restart would render, and a mapper
// disagreement shows up as a visible twitch at turn end during development
// rather than as a bug report after a restart weeks later.
// ---------------------------------------------------------------------------

/**
 * The gutter role of one log row — the fixed left column that makes a long turn
 * scannable. Every row shares a left edge; this word is what it says.
 */
export type ChatRole =
  | 'you'
  | 'claude'
  | 'think'
  | 'read'
  | 'edit'
  | 'bash'
  | 'run'
  | 'ask'
  | 'plan'
  | 'cmd'
  | 'task'
  | 'todo'
  | 'stop'

export type ChatToolStatus = 'running' | 'ok' | 'error' | 'cancelled'

/**
 * A tool card's body. Main keeps the full text and hands the renderer a clipped
 * copy (a read's body dropped entirely, a bash tail, a diff capped) — across a
 * 20-transcript sample, 728 assistant text blocks weighed 1.2 MB while 2 074
 * tool_result blocks weighed 14.6 MB, so prose is a rounding error and tool
 * output is the entire weight. Expanding a clipped card fetches the rest over
 * `chat:body`.
 */
export interface ChatToolBody {
  kind: 'none' | 'text' | 'diff'
  text: string
  truncated: boolean
}

/** One attachment chip, in a `you` row or pending on the composer. */
export interface ChatChip {
  kind: 'path' | 'image' | 'document' | 'text' | 'error'
  name: string
  /** container path for `path`, dimensions for images, the reason for `error` */
  detail?: string
  /**
   * A handle for the picture itself, fetched over `chat:image` when the row is
   * on screen — **never the bytes**.
   *
   * A screenshot is a megabyte or two of base64, and a chip rides on an ordinary
   * `you` row: inlining it would put that megabyte in every `entries-appended`
   * payload the turn emits, in the renderer's store for the life of the session,
   * and in the clone the store makes on each update. Tool bodies are clipped on
   * the way out for exactly this reason (`wireEntries`), and this is the same
   * rule for the same size of thing — main keeps the picture, the renderer asks
   * for the one it is about to draw.
   *
   * Absent when main no longer holds it (see the image budget in chat.ts), and
   * the row falls back to naming the attachment rather than showing it.
   */
  imageId?: string
}

export interface ChatQuestionOption {
  label: string
  description?: string
  /**
   * Optional block of content shown while the option is focused — a mockup, a
   * snippet, a config sample. Markdown in a monospace box, which is what the
   * CLI's own dialog renders and what the tool's schema tells the model to
   * write. Previews are single-select only (the tool description says so), and
   * the chosen one travels back in `annotations[question].preview`.
   */
  preview?: string
}

export interface ChatQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: ChatQuestionOption[]
}

/**
 * What the user chose for one question, recovered on reopen.
 *
 * Kept per question rather than as one flat list of labels because a
 * multi-select answer is written into the transcript as a *joined string*
 * (`"q"="A, B"`), and a free-text "Other" answer is a label that matches no
 * option at all — both of which a flat `string[]` silently mis-renders: the
 * first ticks nothing, the second disappears.
 */
export interface ChatQuestionAnswer {
  /** the question text, which is the key the CLI files the answer under */
  question: string
  /** the ticked labels, plus at most one free-text answer that matches none */
  values: string[]
  /** free-text notes the user attached to the question */
  notes?: string
}

interface ChatEntryBase {
  /** stable across the stream→transcript settle, so the renderer upserts by id */
  id: string
  role: ChatRole
  at: number
  /** the turn this row belongs to; turn-end replacement swaps a whole turn */
  turn: number
}

export type ChatEntry =
  | (ChatEntryBase & { kind: 'text'; md: string; chips?: ChatChip[] })
  /** collapsed to its first line with a `▸ show` */
  | (ChatEntryBase & { kind: 'thinking'; md: string })
  | (ChatEntryBase & {
      kind: 'tool'
      toolUseId: string
      title: string
      /** the one-line outcome shown beside the title ("+18 −11", "exit 0") */
      result: string
      status: ChatToolStatus
      body: ChatToolBody
    })
  | (ChatEntryBase & {
      kind: 'ask'
      questions: ChatQuestion[]
      /** what was chosen, recovered from the tool_result on reopen (may be empty) */
      answers: ChatQuestionAnswer[]
      pending?: boolean
    })
  | (ChatEntryBase & {
      kind: 'plan'
      md: string
      state: 'pending' | 'approved' | 'denied' | 'cancelled'
    })
  /** a local slash command's output, a Skill call, or `Unknown command: /x` */
  | (ChatEntryBase & { kind: 'cmd'; title: string; md: string; truncated: boolean })
  | (ChatEntryBase & {
      kind: 'task'
      toolUseId: string
      /** keys the sibling sub-log; null until the subagent reports one */
      agentId: string | null
      agentType: string
      description: string
      status: string
      durationMs: number | null
      tools: number | null
      tokens: number | null
      running?: boolean
    })
  | (ChatEntryBase & { kind: 'todo'; text: string })
  /**
   * An interrupt, a crash, a timeout or a desync. `alert` is the one place
   * colour appears in the log body — an interrupt is something the user just
   * did, so it stays muted; a crash is not.
   */
  | (ChatEntryBase & { kind: 'stop'; text: string; tone: 'muted' | 'alert'; retry?: boolean })
  /** full-width `compacted · 144k → 11k` / `model · sonnet → opus` */
  | (ChatEntryBase & { kind: 'divider'; text: string })
  /**
   * The turn clock, in the log rather than the header (#5 enumerated the
   * header's three items without it). Live while the turn runs, frozen at
   * `result` into Claude Code's own `turn_duration` — so a turn reads identically
   * whether you watched it or reopened the session a week later. An interrupted
   * or crashed turn has nothing to freeze to and gets no number at all: the
   * `stop` row replaces this one.
   */
  | (ChatEntryBase & {
      kind: 'turn'
      startedAt: number
      durationMs?: number
      /** what the turn has spent so far, or its total once frozen */
      tokens?: ChatTurnTokens
    })

/**
 * What one turn spent, exactly as Claude Code's protocol reports it.
 *
 * Every field is a **turn** total. The CLI reports usage per API message — once
 * provisionally at `stream_event/message_start`, once finally at
 * `message_delta` — and again for the whole turn at `result`, and the two
 * agree: a three-message turn's `result.usage.output_tokens` was exactly the sum
 * of its three `message_delta`s (155 = 75+75+5, verified against 2.1.220). So
 * the live reading is that running sum and the frozen one is `result.usage`,
 * and the freeze is not a correction the user can see.
 *
 * **Subagent work is deliberately absent, because it is absent from
 * `result.usage` too** (verified: a turn whose Task subagent spent 6 output
 * tokens reported 213, the two main-thread messages' 198+15; the subagent's
 * tokens appear only in `result.modelUsage`, which is per model and also counts
 * the account's title-generation Haiku calls). Counting the frames
 * `--forward-subagent-text` forwards would make the live number climb past the
 * number the CLI settles on, and the freeze would then visibly walk it back.
 *
 * `output` is the field on screen; the other three are the tooltip, and they are
 * *why* the visible one is output-only: the whole context is re-sent with every
 * message, so a summed input across a ten-message turn reads as ten times the
 * context — a cost the turn did not incur. The context meter already answers
 * "how full is the window".
 */
export interface ChatTurnTokens {
  output: number
  input: number
  cacheRead: number
  cacheCreation: number
}

export interface ChatTodo {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * A tool call blocked on the user. Plan approval, a question and an ordinary
 * permission prompt all arrive as the *same* `can_use_tool` control request and
 * are answered with the same result — one handler, not three.
 */
export interface ChatBlockingCard {
  requestId: string
  kind: 'plan' | 'question' | 'tool'
  toolName: string
  toolUseId?: string
  /** the plan markdown, or a one-line description of the tool being asked about */
  title: string
  md?: string
  questions?: ChatQuestion[]
  at: number
}

/** What the user did with a blocking card. */
export type ChatAnswer =
  | { behavior: 'plan-approve' }
  | { behavior: 'plan-deny'; message: string }
  /**
   * Everything the question card can produce, in one variant.
   *
   * `answers` is keyed by question *text* — an `allow` with no answers map
   * yields "The user did not answer the questions." Values are **strings**, not
   * arrays, including for multi-select: the CLI's own dialog joins with `", "`
   * before submitting, and its result builder splits on exactly that to decide
   * whether every pick was a real option. `notes` is keyed the same way and
   * becomes `annotations[q].notes`. `clarify` is "Chat about this" — a *deny*
   * carrying the questions back as prose, not an answer at all.
   */
  | {
      behavior: 'question'
      answers: Record<string, string>
      notes?: Record<string, string>
      clarify?: boolean
    }
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'cancelled' }

/**
 * The context meter's reading. From the control protocol's `get_context_usage`
 * (documented, and live from spawn — it answers with no user message ever
 * written, which is what makes the open-time reading possible). `maxTokens` came
 * back as 1 000 000 on one model, so thresholds are percentages, never counts.
 */
export interface ChatContextUsage {
  percentage: number
  totalTokens: number
  maxTokens: number
  /** derived from `result.usage` because get_context_usage failed — approximate, not absent */
  approximate?: boolean
}

export interface ChatErrorInfo {
  kind: 'crashed' | 'timeout' | 'transcript-read'
  message: string
}

/**
 * One row of the model picker.
 *
 * Three fields rather than one string, because `list_models` reports three
 * different things and the picker used to show the wrong one: `value` is the
 * alias the CLI accepts back (`opus`, `default`, or a pinned id) and is the only
 * thing that may be sent, while `displayName` is the only field that says
 * *which* model it is — a menu of bare aliases cannot tell you whether `opus`
 * means Opus 4.1 or Opus 5, which is precisely the reading the chip exists for.
 * `detail` carries the resolved id when it adds something the label doesn't.
 */
export interface ChatModelOption {
  value: string
  label: string
  detail?: string
}

/** Everything a freshly-opened chat needs to paint itself. */
export interface ChatState {
  /** the tail the renderer mounts; earlier entries come from `chat:earlier` */
  entries: ChatEntry[]
  /** how many entries main holds, so the renderer knows there *is* an earlier */
  total: number
  todos: ChatTodo[]
  mode: ChatMode
  model: string | null
  commands: string[]
  context: ChatContextUsage | null
  blocking: ChatBlockingCard | null
  /** §12.3: the history read failed. The chat still works — this is a banner, not a takeover. */
  historyError?: string
}

export interface ChatOpenResult {
  ok: boolean
  /** 'container-stopped' | 'docker-missing' | 'not-found' | 'spawn-failed' */
  reason?: string
  message?: string
  state?: ChatState
}

/**
 * Inbound chat traffic — ONE channel carrying a discriminated union, which is
 * the single deliberate departure from this app's one-channel-per-payload style.
 *
 * ptyData/ptyExit can be separate channels safely because exit is terminal and
 * data is opaque bytes. Chat's inbound is neither: a turn emits appended entries,
 * then the turn-end *replacement* of those same entries, plus blocking cards,
 * task/todo, reset and exit — and these are strictly ordered. Electron guarantees
 * ordering *within* a channel, not across channels, so split them and a blocking
 * card can overtake the text it refers to, rendering a question above the
 * sentence asking it. The alternative is a sequence number and a reorder buffer
 * in the renderer: the same guarantee bought back at a higher price.
 *
 * Activity is the one thing that does *not* ride here — it goes out as an
 * AgentActivityEvent on `agent:activity`, the channel it shares with the hook
 * bridge, precisely so the store cannot tell the two producers apart.
 */
export type ChatEvent =
  | { kind: 'entries-appended'; sessionId: string; entries: ChatEntry[] }
  /** the transcript-derived replacement for one whole turn */
  | { kind: 'turn-settled'; sessionId: string; turn: number; entries: ChatEntry[] }
  | { kind: 'blocking'; sessionId: string; card: ChatBlockingCard }
  | { kind: 'blocking-cleared'; sessionId: string; requestId: string }
  /** live sub-log frames for one subagent, buffered by its spawning tool_use id */
  | { kind: 'task'; sessionId: string; toolUseId: string; entries: ChatEntry[] }
  | { kind: 'todo'; sessionId: string; todos: ChatTodo[] }
  | { kind: 'context'; sessionId: string; context: ChatContextUsage | null }
  /** `/clear` landed: a new conversation id, and the log is dropped */
  | { kind: 'reset'; sessionId: string; claudeSessionId: string }
  /**
   * A revert landed: the log is **replaced** by this window rather than merged
   * into, the one event on this channel that is not an upsert.
   *
   * It carries a whole window rather than a truncate-at-this-id instruction
   * because the renderer holds only a clipped tail (MOUNT_WINDOW): an id-based
   * truncation has a case where the id is not in the window at all, and
   * replacement has none. It costs what an open already costs.
   */
  | { kind: 'rewound'; sessionId: string; entries: ChatEntry[]; total: number }
  | { kind: 'error'; sessionId: string; error: ChatErrorInfo }
  | { kind: 'exit'; sessionId: string; exitCode: number }
  /** model / mode / command list, from each turn's re-emitted `init` */
  | { kind: 'meta'; sessionId: string; model?: string; mode?: ChatMode; commands?: string[] }

/**
 * What the renderer hands `chat:send` alongside the prose. Routed by
 * reachability, decided in the renderer against the mount tree: a file under one
 * of the project's mounts becomes a **container path**, anything else becomes
 * **inline content**. Nothing is copied, /clip is never written to, and no mount
 * is ever changed.
 */
export type ChatAttachment =
  | { kind: 'path'; name: string; containerPath: string }
  | { kind: 'image'; name: string; mediaType: string; data: string }
  | { kind: 'document'; name: string; mediaType: string; data: string }
  | { kind: 'text'; name: string; text: string }

/** One node of a project's mounted tree, for the composer's `@` typeahead. */
export interface MountNode {
  name: string
  hostPath: string
  containerPath: string
  type: 'file' | 'dir'
  children?: MountNode[]
}

/** Draft used by the Add-Project dialog. */
export interface NewProjectInput {
  name: string
  basePath: string
  mounts: string[]
  image: ImageVariant
  publishedPort?: number
}

/** Patch used by the Project-Settings dialog. */
export interface UpdateProjectInput {
  id: string
  name: string
  basePath: string
  mounts: string[]
  image: ImageVariant
  publishedPort?: number
}
