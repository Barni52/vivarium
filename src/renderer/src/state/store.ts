import { create } from 'zustand'
import type { ReactNode } from 'react'
import type {
  AgentActivityEvent,
  AppInfo,
  ChatAnswer,
  ChatAttachment,
  ChatBlockingCard,
  ChatContextUsage,
  ChatEntry,
  ChatErrorInfo,
  ChatEvent,
  ChatMode,
  ChatRewindResult,
  ChatTodo,
  ClaudeStatus,
  ClaudeUpdateResult,
  Config,
  ContainerState,
  DockerStatus,
  ImageVariant,
  OutputNode,
  Project,
  SessionType,
  AgentActivity,
  TranscriptHit,
  UsageSnapshot,
  VolumeInfo
} from '@shared/types'
import { behindIds } from '../claude'
import {
  ADD_SESSION_POPOVER,
  MONO,
  THEMES,
  applyTheme,
  currentTheme,
  tokensFor,
  type ThemeName
} from '../theme'

/**
 * Why an agent session is flagged: turn finished, or blocked on the user —
 * a question or a plan waiting for approval, which are the same thing from the
 * sidebar's point of view (nothing moves until you answer).
 */
export type AttentionKind = 'finished' | 'question'

/** Container lifecycle operation currently in flight for a project. */
export type ContainerOp = 'start' | 'stop' | 'restart'

export type DialogKind =
  | 'addProject'
  | 'settings'
  | 'addSession'
  | 'confirmKill'
  | 'confirmMove'
  | 'confirmDeleteProject'
  | 'confirmQuit'
  | 'claudeUpdate'
  | 'volumes'
  | 'searchTranscripts'
  | null

export interface ContextMenuItem {
  /** '---' renders a separator; label otherwise */
  label: string
  /**
   * Optional glyph shown left of the label. If *any* item in a menu has one,
   * every row reserves the slot so the labels stay on one left edge.
   */
  icon?: ReactNode
  /**
   * Keyboard equivalent, shown right-aligned and dimmed. This is where a chord
   * gets taught — the terminal takes several keys from the shell (Ctrl+F, the
   * zoom chords) and a menu that performs the same action is the only place a
   * user would find out.
   */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  /**
   * Called after the menu closes via a keep-me-here gesture (item selection or
   * Escape). The terminal passes this to restore its focus so the user can keep
   * typing — sidebar/output menus omit it so they don't steal focus (e.g. from
   * the rename input).
   */
  onClose?: () => void
}

export interface DragState {
  kind: 'project' | 'session'
  id: string
  projectId?: string
}

export interface DropTarget {
  id: string
  /**
   * 'before'/'after' insert next to the row `id` names; 'into' means "append to
   * this project", which is what a session dragged over a project row gets — a
   * project has no midpoint worth reading there. No kind field is needed: `id` is
   * a project id only when a project row is the target, so `pos` is enough to tell
   * a project reorder from a session landing in one.
   */
  pos: 'before' | 'after' | 'into'
}

export interface ProjectDraft {
  name: string
  basePath: string
  mounts: string[]
  mountDraft: string
  image: ImageVariant
  port: string
}

export interface SettingsDraft extends ProjectDraft {
  id: string
  locked: boolean
}

export interface AddSessionDraft {
  projectId: string
  top: number
  left: number
  type: SessionType
  name: string
}

interface KillTarget {
  projectId: string
  sessionId: string
  name: string
}

interface MoveTarget {
  fromProjectId: string
  toProjectId: string
  sessionId: string
  /** Insertion index in the target project's session list; -1 appends. */
  index: number
  sessionName: string
  toProjectName: string
  /** Whether the session has a pty right now — the dialog's wording turns on it. */
  live: boolean
}

interface DeleteProjectTarget {
  id: string
  name: string
}

/**
 * Everything one chat session shows. Kept in the store rather than in ChatView
 * so a hidden view keeps its log — the window stays mounted on deselect like a
 * terminal, but for a weaker reason: nothing in a chat is unrecoverable, so
 * terminals *must* stay mounted while a chat merely *may*. What it buys is
 * scroll position, which cards are expanded and the composer draft; those three
 * live in the component precisely because a move is meant to drop them.
 */
export interface ChatSessionState {
  entries: ChatEntry[]
  /** how many entries main holds — there is an "earlier" whenever this is larger */
  total: number
  todos: ChatTodo[]
  blocking: ChatBlockingCard | null
  context: ChatContextUsage | null
  commands: string[]
  model: string | null
  mode: ChatMode
  /** the process is up and the log is real */
  open: boolean
  opening: boolean
  /** why the open failed: 'container-stopped' | 'docker-missing' | 'spawn-failed' */
  reason?: string
  /** the history read failed — a banner above the log, cleared only by a good read */
  historyError?: string
  /** crash / timeout, each offering the one Retry there is */
  error?: ChatErrorInfo
  /** full tool bodies fetched on expand, by entry id */
  bodies: Record<string, string>
  /**
   * Attached pictures as `data:` URLs, by the handle their chip carries, fetched
   * when a row carrying one is drawn. `null` records that main no longer has it,
   * so a chip that has been evicted is asked for once and not on every render.
   */
  images: Record<string, string | null>
  /** a subagent's sub-log, by its spawning tool_use id */
  subagents: Record<string, ChatEntry[]>
}

const emptyChat = (): ChatSessionState => ({
  entries: [],
  total: 0,
  todos: [],
  blocking: null,
  context: null,
  commands: [],
  model: null,
  mode: 'bypassPermissions',
  open: false,
  opening: false,
  bodies: {},
  images: {},
  subagents: {}
})

/**
 * Merge incoming rows into a log, upserting by id.
 *
 * Ids are stable across the stream→transcript settle (both envelopes carry the
 * same `message.id` and block index), so a tool card completing, a streamed
 * paragraph filling in and a settled row replacing a provisional one are all the
 * same operation.
 */
function applyEntries(list: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const next = list.slice()
  for (const e of incoming) {
    // "The stop row *is* the frozen clock row": an interrupted or crashed turn
    // has nothing to freeze to, so the live `working · 4m` row is replaced rather
    // than left showing a number that never resolves.
    if (e.kind === 'stop') {
      const clock = next.findIndex((x) => x.turn === e.turn && x.kind === 'turn')
      if (clock >= 0) next.splice(clock, 1)
    }
    const i = next.findIndex((x) => x.id === e.id)
    // A clock row that is written to again is *moved* to the end, not replaced
    // in place. Main makes the same move on its own copy (freezeTurnClock): the
    // row reports on the whole turn, so it belongs under the work it timed, and
    // upserting it where it first landed would put `done · 12s` back above the
    // answer for the second between the freeze and the turn's settle. The freeze
    // is no longer the only such write — the token reading updates the row once
    // per API message while the turn runs — which changes nothing here: a running
    // clock is drawn at the tail anyway (see ChatView's `rows`), so re-appending
    // it is where it already was.
    if (i >= 0 && e.kind === 'turn') {
      next.splice(i, 1)
      next.push(e)
      continue
    }
    if (i >= 0) next[i] = e
    else next.push(e)
  }
  return next
}

/**
 * The same upsert for a **sub-log**, without any of the log's special cases.
 *
 * A subagent has no turn clock and no stop row to swap one for, so this is the
 * plain rule: replace by id, append what is new. It exists at all because the
 * sub-log used to be *concatenated*, which meant every tool call the agent made
 * appeared twice — once still running, once completed — with one id between them.
 */
function mergeEntriesById(list: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const next = list.slice()
  for (const e of incoming) {
    const i = next.findIndex((x) => x.id === e.id)
    if (i >= 0) next[i] = e
    else next.push(e)
  }
  return next
}

interface AppState {
  config: Config
  states: Record<string, ContainerState>
  branches: Record<string, string | null>
  docker: DockerStatus | null
  outputTree: OutputNode[]
  outputExpanded: Record<string, boolean>
  outputCollapsed: boolean
  /** user-dragged height of the shared-output panel body (px, session-only like sidebarWidth) */
  outputHeight: number
  selectedSessionId: string | null
  expanded: Record<string, boolean>
  sidebarWidth: number
  sidebarCollapsed: boolean
  /**
   * Which theme is on.
   *
   * **Mirrored state, and the mirror is the point.** `data-theme` on `<html>` is
   * the authority — it is what the CSS keys off and what the pre-paint script in
   * `index.html` sets before any of this exists — but every consumer that is not
   * CSS needs to *re-render* when it changes: the terminals repaint their canvas
   * theme, the title bar re-outlines a swatch. An attribute is not reactive and
   * a zustand field is, so this holds a copy and `setTheme` writes both. Nothing
   * else may write `data-theme`.
   */
  theme: ThemeName
  terminalFontSize: number
  /**
   * The chat window's zoom factor, shared by every chat session the way
   * `terminalFontSize` is shared by every terminal — you zoom because of the
   * monitor you are sitting at, not because of the conversation.
   *
   * A factor rather than a font size: the chat is a whole layout (a gutter,
   * cards, a composer) and scaling only the type would leave the gutter behind
   * at its 13px-era proportions.
   *
   * **Persisted**, unlike `terminalFontSize` — `Config.chatZoom`, read back in
   * `init` and written through `persistZoom`. It is a fact about the monitor,
   * and a monitor does not change when the app closes.
   */
  chatZoom: number
  /** session ids that currently have a live pty */
  live: Record<string, boolean>
  activity: Record<string, AgentActivity>
  /**
   * When each agent's current state began (epoch ms) — a turn start for
   * 'working', the turn's end for 'idle'. Drives "working 4m" in the sidebar and
   * "finished 12m ago" on the attention badge. Session-only: a duration is only
   * meaningful for a state this app run has actually observed.
   */
  agentSince: Record<string, number>
  /**
   * When the current 'waiting' state began (epoch ms), for agents blocked on the
   * user. Present only while `activity` is 'waiting', and it is what stops the
   * clock: the duration on screen reads `agentWaitingSince - agentSince` and
   * holds there, instead of counting the minutes the agent spent waiting for a
   * human as time it was working. Resuming shifts `agentSince` forward by the
   * wait, so a turn's reading always means work done, not wall time.
   */
  agentWaitingSince: Record<string, number>
  /** agent sessions needing attention while unwatched — "!" (finished) or "?" (question) until opened */
  notifications: Record<string, AttentionKind>
  /** chat sessions' logs and chrome, keyed by session id */
  chats: Record<string, ChatSessionState>
  /** container start/stop/restart currently in flight, keyed by project id */
  containerOps: Record<string, ContainerOp>
  /** last failed container op's message, keyed by project id (auto-clears) */
  containerErrors: Record<string, string>
  /** claude plan usage shown in the title bar; null until the first poll lands */
  usage: UsageSnapshot | null
  /** Claude Code versions (per container + npm's latest); null until first check */
  claude: ClaudeStatus | null
  /** a version check is in flight (drives the chip/dialog "checking…" state) */
  claudeChecking: boolean
  /** project ids whose container is mid-update */
  claudeUpdating: Record<string, boolean>
  /** last update outcome per project, kept until the dialog closes */
  claudeResults: Record<string, ClaudeUpdateResult>
  /** app + runtime versions for the title-bar chip; null until init lands */
  appInfo: AppInfo | null

  // docker volumes (housekeeping dialog)
  /** null until the first sweep; [] genuinely means "no Vivarium volumes" */
  volumes: VolumeInfo[] | null
  /** a sweep is in flight — it measures every volume on disk, so it's slow */
  volumesLoading: boolean
  /** false when docker couldn't report sizes (names still listed) */
  volumesSized: boolean
  volumesError?: string
  /** volumes currently being removed */
  volumeBusy: Record<string, boolean>
  /** last removal failure per volume (docker's own message) */
  volumeErrors: Record<string, string>

  // transcript search (the "which conversation was that in" dialog)
  /** what is in the search box; kept in the store so reopening restores it */
  transcriptQuery: string
  /** null until a search has actually run — [] genuinely means "no matches" */
  transcriptHits: TranscriptHit[] | null
  transcriptSearching: boolean
  transcriptError?: string
  /**
   * A term to hand to the next chat that becomes visible, so picking a result
   * lands you in the conversation *with the find bar already open on it*.
   *
   * In the store rather than passed down because the two ends are in different
   * trees — a dialog and whichever ChatView the selection is about to reveal —
   * and the chat may not even be mounted yet when the dialog closes. Consumed
   * once and cleared, so switching back to that session later does not reopen a
   * search you finished with.
   */
  pendingFind: { sessionId: string; term: string } | null

  dialog: DialogKind
  ap: ProjectDraft
  st: SettingsDraft | null
  addSession: AddSessionDraft | null
  /**
   * Type the picker preselects — the last one that was actually created.
   * Session-only on purpose: it's a "carry on doing what you were doing" hint,
   * not a setting, and it shouldn't outlive the app run.
   */
  lastSessionType: SessionType
  killTarget: KillTarget | null
  moveTarget: MoveTarget | null
  deleteTarget: DeleteProjectTarget | null
  editingSessionId: string | null
  editDraft: string
  contextMenu: ContextMenuState | null
  drag: DragState | null
  dropTarget: DropTarget | null

  init: () => Promise<void>
  refreshStates: () => Promise<void>
  refreshBranches: () => Promise<void>
  refreshUsage: () => Promise<void>

  // claude code version / manual update
  refreshClaude: (force?: boolean) => Promise<void>
  openClaudeUpdate: () => void
  updateClaudeIn: (projectId: string) => Promise<void>
  updateClaudeAll: () => Promise<void>

  // docker volume housekeeping
  openVolumes: () => void
  refreshVolumes: () => Promise<void>

  // transcript search
  openTranscriptSearch: () => void
  setTranscriptQuery: (q: string) => void
  runTranscriptSearch: () => Promise<void>
  /** jump to the conversation a result names, with the term ready to find */
  openTranscriptHit: (hit: TranscriptHit) => void
  takePendingFind: (sessionId: string) => string | null
  removeVolume: (name: string) => Promise<void>
  removeOrphanVolumes: () => Promise<void>

  // shared output folder
  setSharedOutput: (folder: string | null) => Promise<void>
  refreshOutputTree: () => Promise<void>
  openOutputFile: (abs: string) => void
  openOutputFolder: () => void
  deleteOutputPath: (abs: string) => Promise<void>
  toggleOutputDir: (path: string) => void
  toggleOutputPanel: () => void
  setOutputHeight: (n: number) => void

  // git diff → changes.txt
  setDiffBase: (value: string) => Promise<void>
  runProjectDiff: (projectId: string) => Promise<void>

  select: (sessionId: string) => void
  toggle: (projectId: string) => void
  setSidebarWidth: (n: number) => void
  toggleSidebar: () => void
  setTheme: (name: ThemeName) => void
  /** the next theme in `THEMES` order, wrapping — what Ctrl+Shift+T does */
  cycleTheme: () => void
  zoomTerminal: (delta: number) => void
  resetTerminalZoom: () => void
  /** The chat window's own zoom — one step per call, the terminal's convention. */
  zoomChat: (delta: number) => void
  resetChatZoom: () => void
  setLive: (sessionId: string, live: boolean) => void
  /** `at` (from a hook event) keeps the turn clock on main's timestamp */
  setActivity: (sessionId: string, a: AgentActivity, at?: number) => void
  /** The user answered: leave 'waiting' for 'working' without losing the turn. */
  resumeAgent: (sessionId: string, at?: number) => void
  notifyAgentAttention: (sessionId: string, kind: AttentionKind) => void
  /** Window activation: the session already on screen counts as viewed. */
  acknowledgeSelected: () => void
  /** One handler for both producers — the hook bridge and the chat stream. */
  handleAgentActivity: (e: AgentActivityEvent) => void

  // chat sessions
  handleChatEvent: (e: ChatEvent) => void
  openChat: (projectId: string, sessionId: string, retry?: boolean) => Promise<void>
  closeChat: (sessionId: string) => void
  /** false when the process is gone — the composer puts the draft back rather than eating it */
  sendChat: (sessionId: string, text: string, attachments: ChatAttachment[]) => Promise<boolean>
  interruptChat: (sessionId: string) => Promise<void>
  /** wind the conversation back to just before `entryId`, and hand its text back */
  rewindChat: (sessionId: string, entryId: string) => Promise<ChatRewindResult>
  answerChat: (sessionId: string, requestId: string, answer: ChatAnswer) => Promise<void>
  setChatMode: (sessionId: string, mode: ChatMode) => Promise<void>
  setChatModel: (sessionId: string, model: string) => Promise<void>
  loadEarlier: (sessionId: string) => Promise<void>
  loadBody: (sessionId: string, entryId: string) => Promise<void>
  /** fetch the picture behind an image chip, once */
  loadImage: (sessionId: string, imageId: string) => Promise<void>
  loadSubagent: (sessionId: string, toolUseId: string, agentId: string | null) => Promise<void>

  // dialogs
  openAddProject: () => void
  openSettings: (projectId: string) => void
  openAddSession: (projectId: string, anchor: DOMRect) => void
  closeDialog: () => void
  requestQuit: () => void
  confirmQuit: () => void
  setAp: (patch: Partial<ProjectDraft>) => void
  setSt: (patch: Partial<SettingsDraft>) => void
  setAddSession: (patch: Partial<AddSessionDraft>) => void

  // mutations
  createProject: () => Promise<void>
  saveSettings: () => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  requestDeleteProject: (projectId: string, name: string) => void
  confirmDeleteProject: () => Promise<void>

  // context menu
  openContextMenu: (x: number, y: number, items: ContextMenuItem[], onClose?: () => void) => void
  closeContextMenu: () => void

  // drag reorder / move
  setDrag: (drag: DragState | null) => void
  setDropTarget: (t: DropTarget | null) => void
  reorderProjects: (orderedIds: string[]) => Promise<void>
  reorderSessions: (projectId: string, orderedSessionIds: string[]) => Promise<void>
  requestMoveSession: (
    fromProjectId: string,
    toProjectId: string,
    sessionId: string,
    index: number
  ) => void
  confirmMoveSession: () => Promise<void>
  confirmAddSession: () => Promise<void>
  startRename: (sessionId: string, name: string) => void
  setEditDraft: (v: string) => void
  commitRename: (projectId: string) => Promise<void>
  cancelRename: () => void
  /** Take a Config main wrote on its own initiative (the chat auto-titler). */
  adoptConfig: (config: Config) => void
  /** "Retitle" — regenerate a chat's name from what it has been about. */
  retitleChat: (sessionId: string) => void
  requestKill: (projectId: string, sessionId: string, name: string) => void
  confirmKill: () => Promise<void>

  // container power
  togglePower: (projectId: string) => Promise<void>
  restart: (projectId: string) => Promise<void>
  runContainerOp: (projectId: string, op: ContainerOp) => Promise<void>
}

const emptyDraft = (): ProjectDraft => ({
  name: '',
  basePath: '',
  mounts: [],
  mountDraft: '',
  image: 'slim',
  port: ''
})

export function defaultSessionName(project: Project | undefined, type: SessionType): string {
  const base =
    type === 'agent'
      ? 'agent'
      : type === 'chat'
        ? 'chat'
        : type === 'container-shell'
          ? 'bash'
          : 'ps-host'
  // One past the highest number in use, not one past the *count* — deleting
  // `chat-2` of three and adding one used to mint a second `chat-3`. Chats hide
  // it within a message or two now that they name themselves, but agents and
  // shells never do.
  //
  // Read off every session of the type, whatever it is called: a renamed one no
  // longer matches, which is correct — its number is free again.
  let highest = 0
  for (const s of project?.sessions ?? []) {
    if (s.type !== type) continue
    const m = new RegExp(`^${base}-(\\d+)$`).exec(s.name.trim())
    if (m) highest = Math.max(highest, parseInt(m[1], 10))
  }
  return `${base}-${highest + 1}`
}

function parsePort(v: string): number | undefined {
  const n = parseInt(v.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// Taskbar overlay disc with the outstanding-attention count. Drawn here — the
// main process has no canvas — and shipped over IPC as a data URL.
function badgeDataUrl(count: number): string {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const g = c.getContext('2d')
  if (!g) return ''
  g.beginPath()
  g.arc(16, 16, 16, 0, Math.PI * 2)
  // A canvas is one of the four places in this app that cannot resolve a custom
  // property (see the note on MIDNIGHT in theme.ts), so the values are read off
  // the active theme's token map by name instead. `currentTheme()` rather than a
  // captured value: a badge is redrawn on every change to the notification map,
  // which is long after the theme may have been switched.
  const t = tokensFor(currentTheme())
  g.fillStyle = t.danger
  g.fill()
  const label = count > 9 ? '9+' : String(count)
  g.fillStyle = t['danger-fg']
  g.font = `bold ${label.length > 1 ? 16 : 20}px ${MONO}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, 16, 17)
  return c.toDataURL('image/png')
}

// Mirror the notifications map onto the taskbar badge. Called after every
// mutation of the map — the count only clears by viewing each flagged session,
// not by focusing the window, so "how much stuff is done" stays glanceable.
function pushBadge(notifications: Record<string, AttentionKind>, flash: boolean): void {
  const count = Object.keys(notifications).length
  window.vivarium.setBadge({
    count,
    dataUrl: count > 0 ? badgeDataUrl(count) : null,
    flash
  })
}

/** 70% to 220%, the range `zoomChat` steps through in tenths. */
function clampZoom(z: number): number {
  return Math.max(0.7, Math.min(2.2, Number.isFinite(z) ? z : 1))
}

/**
 * Write the chat zoom to config.json, at most once per settled gesture.
 *
 * Ctrl+wheel emits a notch every few milliseconds and each write is an atomic
 * temp-file-plus-rename of the whole config — a single scroll would be thirty of
 * them. The debounce is short enough that the value is on disk long before the
 * app can be quit, and the on-screen zoom never waits for it: the store is
 * updated first and this only mirrors it.
 */
let zoomWrite: ReturnType<typeof setTimeout> | null = null
function persistZoom(z: number): void {
  if (zoomWrite) clearTimeout(zoomWrite)
  zoomWrite = setTimeout(() => {
    zoomWrite = null
    void window.vivarium.setChatZoom(z)
  }, 300)
}

export const useStore = create<AppState>((set, get) => ({
  config: { version: 1, projects: [] },
  states: {},
  branches: {},
  docker: null,
  outputTree: [],
  outputExpanded: {},
  outputCollapsed: false,
  outputHeight: 200,
  selectedSessionId: null,
  expanded: {},
  sidebarWidth: 288,
  sidebarCollapsed: false,
  // Adopted from the attribute, never decided here — see the field's note.
  theme: currentTheme(),
  terminalFontSize: 13,
  chatZoom: 1,
  live: {},
  activity: {},
  agentSince: {},
  agentWaitingSince: {},
  notifications: {},
  chats: {},
  containerOps: {},
  containerErrors: {},
  usage: null,
  claude: null,
  claudeChecking: false,
  claudeUpdating: {},
  claudeResults: {},
  appInfo: null,
  volumes: null,
  volumesLoading: false,
  volumesSized: true,
  volumeBusy: {},
  volumeErrors: {},
  transcriptQuery: '',
  transcriptHits: null,
  transcriptSearching: false,
  pendingFind: null,
  dialog: null,
  ap: emptyDraft(),
  st: null,
  addSession: null,
  lastSessionType: 'agent',
  killTarget: null,
  moveTarget: null,
  deleteTarget: null,
  editingSessionId: null,
  editDraft: '',
  contextMenu: null,
  drag: null,
  dropTarget: null,

  init: async () => {
    const [config, docker, appInfo] = await Promise.all([
      window.vivarium.loadConfig(),
      window.vivarium.dockerStatus(),
      window.vivarium.appInfo()
    ])
    const expanded: Record<string, boolean> = {}
    for (const p of config.projects) expanded[p.id] = true
    // Re-clamped on the way in: config.json is a text file, and the value is
    // multiplied into every metric in the chat window.
    set({ config, docker, appInfo, expanded, chatZoom: clampZoom(config.chatZoom ?? 1) })
    await Promise.all([
      get().refreshStates(),
      get().refreshBranches(),
      get().refreshOutputTree()
    ])
    // Unawaited: the version chip is the least urgent thing on screen, and the
    // container probes behind it are slow enough to hold up first paint.
    void get().refreshClaude()
  },

  refreshStates: async () => {
    const states = await window.vivarium.containerStates()
    const map: Record<string, ContainerState> = {}
    for (const s of states) map[s.projectId] = s
    set({ states: map })
  },

  refreshBranches: async () => {
    set({ branches: await window.vivarium.projectBranches() })
  },

  refreshUsage: async () => {
    let next: UsageSnapshot
    try {
      next = await window.vivarium.fetchUsage()
    } catch {
      // A rejected invoke has to land a snapshot too. Leaving `usage` null makes
      // the TitleBar render *nothing* — indistinguishable from "the feature
      // vanished", and permanent, since nothing else ever sets it.
      next = { ok: false, error: 'unreachable', limits: [], fetchedAt: Date.now() }
    }
    // A failed poll must not wipe live chips: keep the last good snapshot and
    // let the countdown keep interpolating off the app clock — the TitleBar
    // surfaces staleness from the old fetchedAt. Errors only land when there
    // is nothing better to show. An ok-but-empty response counts as an error
    // here: the TitleBar renders it as "usage n/a" all the same, so letting it
    // through would blank the chips just as thoroughly as a failure would.
    const shows = (u: UsageSnapshot | null): boolean => !!u && u.ok && u.limits.length > 0
    set((s) => (shows(next) || !shows(s.usage) ? { usage: next } : {}))
  },

  // ---- claude code version / manual update --------------------------------
  // No auto-update anywhere: this only ever *reads* versions. Installing is
  // strictly a user action (updateClaudeIn / updateClaudeAll).
  refreshClaude: async (force = false) => {
    if (get().claudeChecking) return // coalesce overlapping checks
    set({ claudeChecking: true })
    try {
      set({ claude: await window.vivarium.claudeStatus(force) })
    } finally {
      set({ claudeChecking: false })
    }
  },

  // Always force-refresh on open: the dialog is the one place the numbers are
  // read closely, and it's opened rarely enough that a live npm hit is free.
  openClaudeUpdate: () => {
    set({ dialog: 'claudeUpdate', claudeResults: {} })
    void get().refreshClaude(true)
  },

  updateClaudeIn: async (projectId) => {
    if (get().claudeUpdating[projectId]) return
    set((s) => {
      const claudeResults = { ...s.claudeResults }
      delete claudeResults[projectId] // clear a previous failure's message
      return { claudeUpdating: { ...s.claudeUpdating, [projectId]: true }, claudeResults }
    })
    const result = await window.vivarium.claudeUpdate(projectId)
    set((s) => {
      const claudeUpdating = { ...s.claudeUpdating }
      delete claudeUpdating[projectId]
      // Patch the version in place from what the install actually left behind,
      // instead of re-probing every container just to refresh one row.
      const claude = s.claude
        ? {
            ...s.claude,
            containers: s.claude.containers.map((c) =>
              c.projectId === projectId && result.ok && result.version
                ? { projectId, installed: result.version }
                : c
            )
          }
        : s.claude
      return {
        claudeUpdating,
        claude,
        claudeResults: { ...s.claudeResults, [projectId]: result }
      }
    })
  },

  // Sequential on purpose: parallel npm installs would race the same registry
  // for no wall-clock win worth the noisier failure modes, and the rows read
  // better ticking over one at a time.
  updateClaudeAll: async () => {
    for (const id of behindIds(get().claude)) await get().updateClaudeIn(id)
  },

  // ---- docker volume housekeeping -----------------------------------------
  // Nothing else in Vivarium ever removes a volume, so this dialog is the only
  // way the per-mount build caches (and anything left behind by a deleted
  // project) become visible or reclaimable.
  openVolumes: () => {
    set({ dialog: 'volumes', volumeErrors: {} })
    void get().refreshVolumes()
  },

  refreshVolumes: async () => {
    if (get().volumesLoading) return // the sweep is slow; never run two
    set({ volumesLoading: true })
    try {
      const report = await window.vivarium.volumes()
      set({
        volumes: report.volumes,
        volumesSized: report.sized,
        volumesError: report.error
      })
    } finally {
      set({ volumesLoading: false })
    }
  },

  removeVolume: async (name) => {
    if (get().volumeBusy[name]) return
    set((s) => {
      const volumeErrors = { ...s.volumeErrors }
      delete volumeErrors[name] // clear a previous failure's message
      return { volumeBusy: { ...s.volumeBusy, [name]: true }, volumeErrors }
    })
    const res = await window.vivarium.removeVolume(name)
    set((s) => {
      const volumeBusy = { ...s.volumeBusy }
      delete volumeBusy[name]
      // Drop the row on success rather than re-sweeping every volume on disk
      // (that walk costs seconds); a failure keeps the row and shows why.
      return {
        volumeBusy,
        volumes: res.ok ? (s.volumes ?? []).filter((v) => v.name !== name) : s.volumes,
        volumeErrors: res.ok
          ? s.volumeErrors
          : { ...s.volumeErrors, [name]: res.message ?? 'removal failed' }
      }
    })
  },

  // Sequential: docker serialises volume removal anyway, and the rows read
  // better ticking over one at a time (same reasoning as updateClaudeAll).
  removeOrphanVolumes: async () => {
    const orphans = (get().volumes ?? []).filter(
      (v) => !v.locked && v.links === 0 && v.projects.length === 0
    )
    for (const v of orphans) await get().removeVolume(v.name)
  },

  // ---- transcript search ---------------------------------------------------
  // Conversations pile up on the shared creds volume forever — deletion is
  // explicit and there is no sweep — so the archive only grows and nothing could
  // ask it anything. This is the one feature that reaches a `/clear`'d
  // conversation, which is otherwise recoverable only through Claude's own
  // --resume picker.
  openTranscriptSearch: () => {
    // Results are kept, the way the query is: reopening the dialog to check the
    // second hit after visiting the first should not make you search again — the
    // grep reads every transcript on disk.
    set({ dialog: 'searchTranscripts', transcriptError: undefined })
  },

  setTranscriptQuery: (transcriptQuery) => set({ transcriptQuery }),

  runTranscriptSearch: async () => {
    const query = get().transcriptQuery.trim()
    if (!query || get().transcriptSearching) return
    set({ transcriptSearching: true, transcriptError: undefined })
    try {
      const res = await window.vivarium.searchTranscripts(query)
      set({
        transcriptHits: res.ok ? res.hits : null,
        transcriptError: res.ok ? undefined : res.error
      })
    } catch {
      // A rejected invoke has to land something, or the dialog sits on a
      // spinner that never resolves with nothing to say.
      set({ transcriptHits: null, transcriptError: 'the search could not be run' })
    } finally {
      set({ transcriptSearching: false })
    }
  },

  openTranscriptHit: (hit) => {
    if (!hit.sessionId) return
    // The term rides along so the conversation opens with the find bar already
    // on it — global search says *which* conversation, find-in-chat says where
    // in it, and picking a result should not make you type the term twice.
    set({
      dialog: null,
      pendingFind: { sessionId: hit.sessionId, term: get().transcriptQuery.trim() }
    })
    get().select(hit.sessionId)
  },

  takePendingFind: (sessionId) => {
    const p = get().pendingFind
    if (!p || p.sessionId !== sessionId) return null
    // Consumed on read: coming back to this session tomorrow should not reopen
    // a search that was finished with today.
    set({ pendingFind: null })
    return p.term
  },

  setSharedOutput: async (folder) => {
    const config = await window.vivarium.setSharedOutput(folder)
    set({ config })
    await Promise.all([get().refreshOutputTree(), get().refreshStates()])
  },

  refreshOutputTree: async () => {
    set({ outputTree: await window.vivarium.outputTree() })
  },

  openOutputFile: (abs) => {
    void window.vivarium.openOutputFile(abs)
  },

  openOutputFolder: () => {
    void window.vivarium.openOutputFolder()
  },

  deleteOutputPath: async (abs) => {
    // Moves to the Recycle Bin (reversible). The fs.watch usually refreshes the
    // tree on its own, but refresh explicitly so the row disappears immediately.
    await window.vivarium.deleteOutputFile(abs)
    void get().refreshOutputTree()
  },

  toggleOutputDir: (path) =>
    set((s) => ({ outputExpanded: { ...s.outputExpanded, [path]: !s.outputExpanded[path] } })),

  toggleOutputPanel: () => set((s) => ({ outputCollapsed: !s.outputCollapsed })),
  // Clamp: never smaller than a few rows, never starving the project list —
  // the render-side maxHeight keeps it sane if the window shrinks afterwards.
  setOutputHeight: (n) =>
    set({ outputHeight: Math.max(96, Math.min(Math.round(window.innerHeight * 0.7), n)) }),

  setDiffBase: async (value) => {
    const config = await window.vivarium.setDiffBase(value)
    set({ config })
  },

  runProjectDiff: async (projectId) => {
    // Fire-and-forget; the output-folder watcher refreshes the tree when
    // changes.txt lands.
    await window.vivarium.projectDiff(projectId)
  },

  select: (sessionId) => {
    set((s) => {
      // ensure the owning project is expanded
      const proj = s.config.projects.find((p) => p.sessions.some((x) => x.id === sessionId))
      // opening a session acknowledges its finished-agent notification (the other
      // half of that rule is acknowledgeSelected, for the one already open)
      const notifications = { ...s.notifications }
      delete notifications[sessionId]
      return {
        selectedSessionId: sessionId,
        notifications,
        expanded: proj ? { ...s.expanded, [proj.id]: true } : s.expanded
      }
    })
    pushBadge(get().notifications, false)
  },

  toggle: (projectId) =>
    set((s) => ({ expanded: { ...s.expanded, [projectId]: !s.expanded[projectId] } })),

  setSidebarWidth: (n) => set({ sidebarWidth: Math.max(232, Math.min(460, n)) }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // The attribute (which the CSS reads and localStorage remembers) and the
  // store field (which React re-renders off) always move together, in that
  // order — see the `theme` field's note for why there are two of them.
  //
  // The window's own background colour goes with them. It is painted by Chromium
  // underneath the document — during a resize, and for the frame before the
  // renderer has drawn anything — so a `paper` window without this flashes a
  // near-black band down whichever edge you are dragging.
  setTheme: (name) => {
    applyTheme(name)
    set({ theme: name })
    window.vivarium.setWindowBackground(tokensFor(name).bg)
  },
  cycleTheme: () => {
    const i = THEMES.findIndex((t) => t.name === get().theme)
    // `i + 1` off a -1 lands on 0, which is the default theme — the right answer
    // for a `theme` that somehow is not in the list.
    get().setTheme(THEMES[(i + 1) % THEMES.length].name)
  },
  zoomTerminal: (delta) =>
    set((s) => ({ terminalFontSize: Math.max(8, Math.min(32, s.terminalFontSize + delta)) })),
  resetTerminalZoom: () => set({ terminalFontSize: 13 }),
  // 10% a step, floored at 70% and capped at 220%. The range is wider at the
  // top than the terminal's because prose is what people zoom *into*.
  // Computed off `get()` rather than inside the `set` updater: the write to disk
  // is a side effect, and a state updater is the one place that must stay pure.
  zoomChat: (delta) => {
    const chatZoom = clampZoom(Math.round((get().chatZoom + delta * 0.1) * 100) / 100)
    persistZoom(chatZoom)
    set({ chatZoom })
  },
  resetChatZoom: () => {
    persistZoom(1)
    set({ chatZoom: 1 })
  },
  setLive: (sessionId, live) => set((s) => ({ live: { ...s.live, [sessionId]: live } })),

  setActivity: (sessionId, a, at) =>
    set((s) => {
      // Only stamp real transitions. A pty exit reports 'idle' for an agent that
      // was already idle, and re-stamping there would claim its last turn just
      // ended — the one thing the duration must never lie about.
      if (s.activity[sessionId] === a) return {}
      const stamp = at ?? Date.now()
      const activity = { ...s.activity, [sessionId]: a }
      const waitedFrom = s.agentWaitingSince[sessionId]
      const agentWaitingSince = { ...s.agentWaitingSince }

      // Blocking on the user starts no new clock: the turn is the same turn, so
      // `agentSince` stays put and this timestamp is only the point the reading
      // freezes at.
      if (a === 'waiting') {
        agentWaitingSince[sessionId] = stamp
        return { activity, agentWaitingSince }
      }

      delete agentWaitingSince[sessionId]
      const agentSince = { ...s.agentSince }
      const turnStart = s.agentSince[sessionId]
      if (a === 'working' && waitedFrom !== undefined && turnStart !== undefined) {
        // Coming back from a wait, mid-turn: push the start forward by however
        // long the agent sat blocked, so the clock picks up from the frozen
        // reading rather than jumping by the time the user took to answer.
        agentSince[sessionId] = turnStart + (stamp - waitedFrom)
      } else {
        agentSince[sessionId] = stamp
      }
      return { activity, agentSince, agentWaitingSince }
    }),

  resumeAgent: (sessionId, at) => {
    // Guarded: every caller is a "probably answered" signal (the PostToolUse
    // hook, a keystroke), and outside 'waiting' none of them mean anything.
    if (get().activity[sessionId] !== 'waiting') return
    get().setActivity(sessionId, 'working', at)
    // The "?" said an agent was waiting on you; it isn't any more. Only that
    // flag is stale — a 'finished' one belongs to a turn that really did end,
    // and stays until the session is opened.
    if (get().notifications[sessionId] === 'question') {
      set((s) => {
        const notifications = { ...s.notifications }
        delete notifications[sessionId]
        return { notifications }
      })
      pushBadge(get().notifications, false)
    }
  },

  notifyAgentAttention: (sessionId, kind) => {
    // Only the two agent kinds get the "!" — host/container shells never do (a
    // stray event for a shell session, if one ever arrived, must not light one
    // up). This type guard is the *only* edit chat needed anywhere in this path:
    // select, acknowledgeSelected, windowFocused and pushBadge are all keyed on
    // selectedSessionId / notifications and never look at a session type.
    const proj = get().config.projects.find((p) => p.sessions.some((x) => x.id === sessionId))
    const sess = proj?.sessions.find((x) => x.id === sessionId)
    if (sess?.type !== 'agent' && sess?.type !== 'chat') return
    const focused = document.hasFocus()
    // Already watching this session in a focused window → nothing to flag.
    if (focused && get().selectedSessionId === sessionId) return
    // A later Stop overwrites a stale question flag — latest state wins.
    set((s) => ({ notifications: { ...s.notifications, [sessionId]: kind } }))
    // Badge always shows the outstanding count; flashing is reserved for
    // events that arrive while the app is in the background.
    pushBadge(get().notifications, !focused)
  },

  acknowledgeSelected: () => {
    // Viewing a session acknowledges its flag, and clicking its row is only one way
    // to view it: the other is the app becoming active on a session that is already
    // selected — the one case `select` cannot cover, since nobody clicks the row
    // they are already on. Without this, an agent that finished while the app sat in
    // the background kept its "!" and its taskbar number *while being watched*.
    // Only the selected one: the count is not a "seen the app" flag.
    const id = get().selectedSessionId
    if (!id || !get().notifications[id]) return
    set((s) => {
      const notifications = { ...s.notifications }
      delete notifications[id]
      return { notifications }
    })
    pushBadge(get().notifications, false)
  },

  /**
   * One handler, two producers. `bridge.ts` maps Claude Code hooks for pty
   * agents and `chat.ts` derives the same triple from stream-json; this cannot
   * tell them apart, which is the point — the attention rules live here once
   * rather than once per source.
   */
  handleAgentActivity: (e) => {
    const s = get()
    // Ignore events for sessions that were killed while the turn was running.
    const exists = s.config.projects.some((p) => p.sessions.some((x) => x.id === e.sessionId))
    if (!exists) return
    if (e.activity === 'working') {
      // Coming back from a wait is not a new turn: resumeAgent is guarded on
      // 'waiting' and preserves the clock, pushing agentSince forward by the
      // whole wait so the reading always means work done, not wall time.
      if (s.activity[e.sessionId] === 'waiting') s.resumeAgent(e.sessionId, e.at)
      else s.setActivity(e.sessionId, 'working', e.at)
      // A queued prompt lands while the indicator is already 'working', where
      // setActivity deliberately no-ops — restart the clock explicitly so the
      // duration always means "this turn", not "this busy streak".
      if (e.turnStart) set((st) => ({ agentSince: { ...st.agentSince, [e.sessionId]: e.at } }))
    } else if (e.activity === 'waiting') {
      // Blocked on the user — a question, a plan waiting for approval, or (chat
      // only) an ordinary permission prompt. All are mid-turn but nothing is
      // running, so this is its own state: the row shows "?" instead of the
      // working ellipsis, and the turn clock stops until the answer arrives.
      s.setActivity(e.sessionId, 'waiting', e.at)
      s.notifyAgentAttention(e.sessionId, 'question')
    } else {
      s.setActivity(e.sessionId, 'idle', e.at)
      // `quiet` is set for the idle that follows an interrupt: you ended the
      // turn, so being told it finished is noise.
      if (!e.quiet) s.notifyAgentAttention(e.sessionId, 'finished')
    }
  },

  // ---- chat sessions ------------------------------------------------------
  handleChatEvent: (e) => {
    const patch = (fn: (c: ChatSessionState) => ChatSessionState): void =>
      set((s) => {
        const cur = s.chats[e.sessionId]
        if (!cur) return {}
        return { chats: { ...s.chats, [e.sessionId]: fn(cur) } }
      })

    switch (e.kind) {
      // `total` is main's count, which is only larger than what is mounted when
      // history was clipped to the tail at open — so it grows with the log but
      // never shrinks to it, or `load earlier` would vanish the moment a new turn
      // landed on a long conversation.
      case 'entries-appended':
        patch((c) => {
          const entries = applyEntries(c.entries, e.entries)
          return { ...c, entries, total: Math.max(c.total, entries.length) }
        })
        break
      case 'turn-settled':
        // The transcript-derived replacement for one whole turn. Anything more
        // than a few seconds old is therefore always the same bytes a restart
        // would render — and a mapper disagreement shows up as a visible twitch
        // here rather than as a bug report after a restart weeks later.
        patch((c) => {
          // By id as well as by turn — main filters the same two ways and for
          // the same reason (see settleTurn). A row mapped under one turn and
          // re-mapped under another would otherwise appear twice, and a
          // duplicate key is the one inconsistency this list cannot render:
          // React drops or duplicates the row rather than erroring.
          const ids = new Set(e.entries.map((x) => x.id))
          const entries = [
            ...c.entries.filter((x) => x.turn !== e.turn && !ids.has(x.id)),
            ...e.entries
          ]
          return { ...c, entries, total: Math.max(c.total, entries.length) }
        })
        break
      case 'blocking':
        patch((c) => ({ ...c, blocking: e.card }))
        break
      case 'blocking-cleared':
        patch((c) => (c.blocking?.requestId === e.requestId ? { ...c, blocking: null } : c))
        break
      case 'task':
        // Merged by id, not concatenated — a sub-log's rows are revised as well
        // as added (a tool_result completes the card its tool_use opened, under
        // the same id), and this list is rendered with `key={e.id}`.
        patch((c) => ({
          ...c,
          subagents: {
            ...c.subagents,
            [e.toolUseId]: mergeEntriesById(c.subagents[e.toolUseId] ?? [], e.entries)
          }
        }))
        break
      case 'todo':
        patch((c) => ({ ...c, todos: e.todos }))
        break
      case 'context':
        patch((c) => ({ ...c, context: e.context }))
        break
      case 'reset':
        // `/clear` landed. Live and reopened views stay identical the instant the
        // reset does: the log is dropped and the todo fold goes with it.
        //
        // `bodies` and `images` go too, and they are the reason this list is the
        // same five main's `ChatService.reset` drops. Both are caches keyed by an
        // id belonging to a row that no longer exists — nothing will ever read
        // them again, ids from the new conversation cannot collide with them, and
        // they are the two entries here that hold *bulk*: a full tool body and a
        // `data:` URL of a pasted screenshot. Left behind they are pure leak, for
        // the life of the mounted chat, one `/clear` at a time.
        patch((c) => ({
          ...c,
          entries: [],
          total: 0,
          todos: [],
          blocking: null,
          subagents: {},
          bodies: {},
          images: {}
        }))
        break
      case 'rewound':
        // A revert landed. The **one** event on this channel that replaces the log
        // rather than upserting into it: `applyEntries` can only add and update,
        // and what a revert did is *remove*. Main sends a whole window for the
        // same reason it does at open — the renderer holds a clipped tail, so
        // "truncate at this id" has a case where the id was never mounted.
        //
        // `total` is taken, not maxed: it is the only number here that can go
        // down, and `load earlier` reads it to decide whether an "earlier" exists
        // at all.
        patch((c) => ({ ...c, entries: e.entries, total: e.total, blocking: null }))
        break
      case 'error':
        patch((c) => ({ ...c, error: e.error }))
        break
      case 'exit':
        patch((c) => ({ ...c, open: false }))
        set((s) => {
          const live = { ...s.live }
          delete live[e.sessionId]
          return { live }
        })
        break
      case 'meta':
        patch((c) => ({
          ...c,
          model: e.model ?? c.model,
          mode: e.mode ?? c.mode,
          commands: e.commands ?? c.commands
        }))
        break
    }
  },

  openChat: async (projectId, sessionId, retry = false) => {
    const cur = get().chats[sessionId]
    if (cur?.opening) return
    set((s) => ({
      chats: {
        ...s.chats,
        [sessionId]: { ...(s.chats[sessionId] ?? emptyChat()), opening: true, error: undefined }
      }
    }))
    const res = await window.vivarium.chatOpen(projectId, sessionId, retry)
    set((s) => {
      const base = s.chats[sessionId] ?? emptyChat()
      if (!res.ok || !res.state) {
        return {
          chats: { ...s.chats, [sessionId]: { ...base, opening: false, open: false, reason: res.reason } }
        }
      }
      const st = res.state
      return {
        chats: {
          ...s.chats,
          [sessionId]: {
            ...base,
            entries: st.entries,
            total: st.total,
            todos: st.todos,
            blocking: st.blocking,
            context: st.context,
            commands: st.commands,
            model: st.model,
            mode: st.mode,
            open: true,
            opening: false,
            reason: undefined,
            historyError: st.historyError
          }
        },
        // A chat with a live process counts as live, exactly as a pty does: it is
        // what the sidebar's working indicator and TerminalHost's third render
        // clause read.
        live: { ...s.live, [sessionId]: true }
      }
    })
  },

  closeChat: (sessionId) => {
    window.vivarium.chatClose(sessionId)
    set((s) => {
      const live = { ...s.live }
      delete live[sessionId]
      const chats = { ...s.chats }
      if (chats[sessionId]) chats[sessionId] = { ...chats[sessionId], open: false }
      return { live, chats }
    })
  },

  sendChat: async (sessionId, text, attachments) => {
    return window.vivarium.chatSend(sessionId, text, attachments)
  },

  interruptChat: async (sessionId) => {
    await window.vivarium.chatInterrupt(sessionId)
  },

  // Not optimistic, unlike answerChat: what comes off the log is decided by how
  // many messages the CLI actually popped, and it can pop fewer than were asked
  // for. Main emits `rewound` with the truth and the caller shows what happened.
  rewindChat: async (sessionId, entryId) => {
    return window.vivarium.chatRewind(sessionId, entryId)
  },

  answerChat: async (sessionId, requestId, answer) => {
    // Optimistic: the card's buttons must not sit there looking pressable while
    // the round trip happens. main echoes a blocking-cleared either way.
    set((s) => {
      const c = s.chats[sessionId]
      if (!c || c.blocking?.requestId !== requestId) return {}
      return { chats: { ...s.chats, [sessionId]: { ...c, blocking: null } } }
    })
    await window.vivarium.chatAnswer(sessionId, requestId, answer)
  },

  setChatMode: async (sessionId, mode) => {
    set((s) => {
      const c = s.chats[sessionId]
      return c ? { chats: { ...s.chats, [sessionId]: { ...c, mode } } } : {}
    })
    const config = await window.vivarium.chatSetMode(sessionId, mode)
    set({ config })
  },

  setChatModel: async (sessionId, model) => {
    set((s) => {
      const c = s.chats[sessionId]
      return c ? { chats: { ...s.chats, [sessionId]: { ...c, model } } } : {}
    })
    const config = await window.vivarium.chatSetModel(sessionId, model)
    set({ config })
  },

  loadEarlier: async (sessionId) => {
    const c = get().chats[sessionId]
    if (!c) return
    // The topmost row is the anchor: main slices what sits above *it*, which is
    // the only reading that stays right when this list is not an exact tail of
    // main's (see ChatService.earlier).
    const res = await window.vivarium.chatEarlier(sessionId, c.entries.length, c.entries[0]?.id)
    set((s) => {
      const cur = s.chats[sessionId]
      if (!cur) return {}
      // Deduped on the way in. Prepending blind is what the count-based ask made
      // safe by construction and the anchored one does not: an entry that came
      // back while the same id is still mounted would give the log two rows under
      // one key, which React answers by dropping or duplicating a row rather than
      // erroring. `total` is taken, not maxed — main is the authority on how many
      // entries exist, and this is the one call that asks it.
      const held = new Set(cur.entries.map((e) => e.id))
      const add = res.entries.filter((e) => !held.has(e.id))
      return {
        chats: {
          ...s.chats,
          [sessionId]: { ...cur, entries: [...add, ...cur.entries], total: res.total }
        }
      }
    })
  },

  // Expanding a clipped card asks main for the rest — the whole point of keeping
  // full bodies there is that a 10 MB transcript is never a 10 MB resident store.
  loadBody: async (sessionId, entryId) => {
    if (get().chats[sessionId]?.bodies[entryId] !== undefined) return
    const body = await window.vivarium.chatBody(sessionId, entryId)
    if (body === null) return
    set((s) => {
      const c = s.chats[sessionId]
      if (!c) return {}
      return { chats: { ...s.chats, [sessionId]: { ...c, bodies: { ...c.bodies, [entryId]: body } } } }
    })
  },

  // Asked for once per picture and then remembered — including the miss. Main
  // holds a bounded store (IMAGE_BUDGET), so an old picture in a very
  // image-heavy conversation can genuinely be gone, and a chip that re-asked on
  // every render would be an IPC call per frame for an answer that will not
  // change.
  loadImage: async (sessionId, imageId) => {
    if (get().chats[sessionId]?.images[imageId] !== undefined) return
    const url = await window.vivarium.chatImage(sessionId, imageId)
    set((s) => {
      const c = s.chats[sessionId]
      if (!c) return {}
      return {
        chats: { ...s.chats, [sessionId]: { ...c, images: { ...c.images, [imageId]: url } } }
      }
    })
  },

  loadSubagent: async (sessionId, toolUseId, agentId) => {
    // Asked every time the row is opened, deliberately. The guard that used to
    // sit here — "we already have rows, so don't" — is what made an agent
    // expanded while it ran keep its half-written sub-log for good: the rows it
    // had were the live buffer, and the complete version only exists in the
    // sibling file. Main is the one that knows which of the two is current and
    // memoises the file read, so this costs an IPC round trip and, at most once
    // per task, one docker exec.
    const entries = await window.vivarium.chatSubagent(sessionId, toolUseId, agentId)
    if (!entries.length) return
    set((s) => {
      const c = s.chats[sessionId]
      if (!c) return {}
      return {
        chats: { ...s.chats, [sessionId]: { ...c, subagents: { ...c.subagents, [toolUseId]: entries } } }
      }
    })
  },

  openAddProject: () => set({ dialog: 'addProject', ap: emptyDraft() }),

  openSettings: (projectId) => {
    const s = get()
    const p = s.config.projects.find((x) => x.id === projectId)
    if (!p) return
    const running = !!s.states[projectId]?.running
    set({
      dialog: 'settings',
      st: {
        id: p.id,
        name: p.name,
        basePath: p.basePath,
        mounts: [...p.mounts], // absolute paths; displayed relative in the dialog
        mountDraft: '',
        image: p.image,
        port: p.publishedPort ? String(p.publishedPort) : '',
        locked: running
      }
    })
  },

  openAddSession: (projectId, anchor) => {
    const p = get().config.projects.find((x) => x.id === projectId)
    // Keep the whole panel on screen: below the title bar, and clear of the
    // right/bottom edges by its own size (ADD_SESSION_POPOVER, so the two can't
    // drift apart).
    const { width, height } = ADD_SESSION_POPOVER
    const top = Math.max(40, Math.min(anchor.top, window.innerHeight - height - 8))
    const left = Math.min(anchor.right + 8, window.innerWidth - width - 16)
    const type = get().lastSessionType
    set({
      dialog: 'addSession',
      addSession: {
        projectId,
        top,
        left,
        type,
        name: defaultSessionName(p, type)
      }
    })
  },

  closeDialog: () =>
    set({
      dialog: null,
      addSession: null,
      killTarget: null,
      moveTarget: null,
      deleteTarget: null,
      st: null,
      claudeResults: {}
    }),

  // Main intercepted a window-close and is asking to confirm (see ipc.ts). Don't
  // clobber a dialog that's already open — a modal being up doesn't change that
  // the user wants to quit, and stacking over e.g. unsaved settings is fine.
  requestQuit: () => set({ dialog: 'confirmQuit' }),

  // User accepted the quit prompt: tell main to let the close through. Clearing
  // the dialog is cosmetic — the window is about to go away.
  confirmQuit: () => {
    set({ dialog: null })
    window.vivarium.confirmQuit()
  },

  setAp: (patch) => set((s) => ({ ap: { ...s.ap, ...patch } })),
  setSt: (patch) => set((s) => (s.st ? { st: { ...s.st, ...patch } } : {})),
  setAddSession: (patch) => set((s) => (s.addSession ? { addSession: { ...s.addSession, ...patch } } : {})),

  createProject: async () => {
    const { ap } = get()
    const config = await window.vivarium.createProject({
      name: ap.name,
      basePath: ap.basePath,
      // draft.mounts already hold absolute paths (converted at add-time)
      mounts: ap.mounts,
      image: ap.image,
      publishedPort: ap.image === 'full' ? parsePort(ap.port) : undefined
    })
    const created = config.projects[config.projects.length - 1]
    set((s) => ({
      config,
      dialog: null,
      expanded: { ...s.expanded, [created.id]: true }
    }))
    await get().refreshStates()
  },

  saveSettings: async () => {
    const { st, states } = get()
    if (!st) return
    const wasRunning = !!states[st.id]?.running
    const config = await window.vivarium.updateProject({
      id: st.id,
      name: st.name,
      basePath: st.basePath,
      mounts: st.mounts, // already absolute
      image: st.image,
      publishedPort: st.image === 'full' ? parsePort(st.port) : undefined
    })
    set({ config, dialog: null, st: null })
    // Settings changes only take effect on a fresh container. Recreate if it was
    // running so the new mounts/image/port apply immediately.
    if (wasRunning) {
      await window.vivarium.recreateContainer(st.id)
    }
    await get().refreshStates()
  },

  deleteProject: async (projectId) => {
    const config = await window.vivarium.deleteProject(projectId)
    set((s) => {
      // drop notifications + turn clocks for sessions that no longer exist
      const alive = new Set(config.projects.flatMap((p) => p.sessions.map((x) => x.id)))
      const notifications: Record<string, AttentionKind> = {}
      for (const id of Object.keys(s.notifications)) if (alive.has(id)) notifications[id] = s.notifications[id]
      const agentSince: Record<string, number> = {}
      for (const id of Object.keys(s.agentSince)) if (alive.has(id)) agentSince[id] = s.agentSince[id]
      const agentWaitingSince: Record<string, number> = {}
      for (const id of Object.keys(s.agentWaitingSince))
        if (alive.has(id)) agentWaitingSince[id] = s.agentWaitingSince[id]
      const chats: Record<string, ChatSessionState> = {}
      for (const id of Object.keys(s.chats)) if (alive.has(id)) chats[id] = s.chats[id]
      return {
        config,
        notifications,
        agentSince,
        agentWaitingSince,
        chats,
        selectedSessionId:
          s.selectedSessionId && !alive.has(s.selectedSessionId) ? null : s.selectedSessionId
      }
    })
    pushBadge(get().notifications, false)
    await get().refreshStates()
  },

  requestDeleteProject: (projectId, name) =>
    set({ dialog: 'confirmDeleteProject', deleteTarget: { id: projectId, name } }),

  confirmDeleteProject: async () => {
    const t = get().deleteTarget
    if (!t) return
    await get().deleteProject(t.id) // removes container + config + selection cleanup
    set({ dialog: null, deleteTarget: null, st: null })
  },

  openContextMenu: (x, y, items, onClose) => set({ contextMenu: { x, y, items, onClose } }),
  closeContextMenu: () => set({ contextMenu: null }),

  setDrag: (drag) => set({ drag }),
  setDropTarget: (dropTarget) => set({ dropTarget }),

  reorderProjects: async (orderedIds) => {
    const config = await window.vivarium.reorderProjects(orderedIds)
    set({ config, drag: null, dropTarget: null })
  },

  reorderSessions: async (projectId, orderedSessionIds) => {
    const config = await window.vivarium.reorderSessions(projectId, orderedSessionIds)
    set({ config, drag: null, dropTarget: null })
  },

  requestMoveSession: (fromProjectId, toProjectId, sessionId, index) => {
    const s = get()
    const from = s.config.projects.find((p) => p.id === fromProjectId)
    const to = s.config.projects.find((p) => p.id === toProjectId)
    const session = from?.sessions.find((x) => x.id === sessionId)
    if (!from || !to || !session || from === to) return
    // Clear the drag here rather than leaving it to onDragEnd: the confirm dialog
    // takes focus the moment it opens, and a drag whose end event never lands
    // would leave every row still showing its drop indicator.
    set({
      dialog: 'confirmMove',
      drag: null,
      dropTarget: null,
      moveTarget: {
        fromProjectId,
        toProjectId,
        sessionId,
        index,
        sessionName: session.name,
        toProjectName: to.name,
        live: !!s.live[sessionId]
      }
    })
  },

  confirmMoveSession: async () => {
    const { moveTarget } = get()
    if (!moveTarget) return
    const config = await window.vivarium.moveSession(
      moveTarget.fromProjectId,
      moveTarget.toProjectId,
      moveTarget.sessionId,
      moveTarget.index
    )
    // Nothing here is re-keyed: live/activity/agentSince/notifications are all
    // keyed by session id, which the move doesn't change. Main killed the pty
    // silently, and TerminalHost's project-scoped key remounts the terminal, which
    // reopens it against the target container (or leaves it dark until that
    // container starts).
    set((s) => ({
      config,
      dialog: null,
      moveTarget: null,
      expanded: { ...s.expanded, [moveTarget.toProjectId]: true }
    }))
  },

  confirmAddSession: async () => {
    const { addSession, config } = get()
    if (!addSession) return
    const p = config.projects.find((x) => x.id === addSession.projectId)
    const name = addSession.name.trim() || defaultSessionName(p, addSession.type)
    const next = await window.vivarium.addSession(addSession.projectId, addSession.type, name)
    const proj = next.projects.find((x) => x.id === addSession.projectId)
    const created = proj?.sessions[proj.sessions.length - 1]
    set((s) => ({
      config: next,
      dialog: null,
      addSession: null,
      lastSessionType: addSession.type,
      selectedSessionId: created ? created.id : s.selectedSessionId,
      expanded: { ...s.expanded, [addSession.projectId]: true }
    }))
  },

  startRename: (sessionId, name) => set({ editingSessionId: sessionId, editDraft: name }),
  setEditDraft: (v) => set({ editDraft: v }),
  cancelRename: () => set({ editingSessionId: null }),
  commitRename: async (projectId) => {
    const { editingSessionId, editDraft } = get()
    if (!editingSessionId) return
    const config = await window.vivarium.renameSession(projectId, editingSessionId, editDraft)
    set({ config, editingSessionId: null })
  },

  // A name main wrote by itself — today only a chat titling itself. Adopted
  // whole, exactly like the Config every other config action gets back from its
  // invoke, so there is still one way for this store to take a config update.
  //
  // Safe to land under an open rename box: the draft lives in `editDraft`, not
  // in `config`, and main stops titling a session the moment that box commits.
  adoptConfig: (config) => set({ config }),

  retitleChat: (sessionId) => window.vivarium.chatRetitle(sessionId),

  requestKill: (projectId, sessionId, name) =>
    set({ dialog: 'confirmKill', killTarget: { projectId, sessionId, name } }),

  confirmKill: async () => {
    const { killTarget } = get()
    if (!killTarget) return
    const config = await window.vivarium.removeSession(killTarget.projectId, killTarget.sessionId)
    set((s) => {
      const stillExists = config.projects.some((p) =>
        p.sessions.some((x) => x.id === s.selectedSessionId)
      )
      const live = { ...s.live }
      delete live[killTarget.sessionId]
      const notifications = { ...s.notifications }
      delete notifications[killTarget.sessionId]
      const agentSince = { ...s.agentSince }
      delete agentSince[killTarget.sessionId]
      const agentWaitingSince = { ...s.agentWaitingSince }
      delete agentWaitingSince[killTarget.sessionId]
      const chats = { ...s.chats }
      delete chats[killTarget.sessionId]
      return {
        config,
        dialog: null,
        killTarget: null,
        live,
        notifications,
        agentSince,
        agentWaitingSince,
        chats,
        selectedSessionId: stillExists ? s.selectedSessionId : null
      }
    })
    pushBadge(get().notifications, false)
  },

  togglePower: async (projectId) => {
    if (get().containerOps[projectId]) return // an op is already in flight
    const running = !!get().states[projectId]?.running
    await get().runContainerOp(projectId, running ? 'stop' : 'start')
  },

  restart: async (projectId) => {
    if (get().containerOps[projectId]) return
    await get().runContainerOp(projectId, 'restart')
  },

  runContainerOp: async (projectId, op) => {
    // The in-flight op drives the amber pulsing square on the project row —
    // a cold start (image build, mounts) can take minutes, and without it the
    // only feedback was the 3s state poll eventually flipping the indicator.
    set((s) => {
      const containerErrors = { ...s.containerErrors }
      delete containerErrors[projectId]
      return { containerOps: { ...s.containerOps, [projectId]: op }, containerErrors }
    })
    try {
      if (op === 'stop') await window.vivarium.stopContainer(projectId)
      else if (op === 'start') await window.vivarium.startContainer(projectId)
      else await window.vivarium.restartContainer(projectId)
    } catch (err) {
      // ipcRenderer.invoke wraps the real message in boilerplate — strip it.
      const msg = String(err instanceof Error ? err.message : err).replace(
        /^Error invoking remote method '[^']*': (Error: )?/,
        ''
      )
      set((s) => ({ containerErrors: { ...s.containerErrors, [projectId]: msg } }))
      // Transient feedback, not persistent state: revert the red square to the
      // plain running/stopped indicator after a few seconds.
      setTimeout(() => {
        set((s) => {
          if (s.containerErrors[projectId] !== msg) return {}
          const containerErrors = { ...s.containerErrors }
          delete containerErrors[projectId]
          return { containerErrors }
        })
      }, 8000)
    } finally {
      set((s) => {
        const containerOps = { ...s.containerOps }
        delete containerOps[projectId]
        return { containerOps }
      })
      await get().refreshStates()
    }
  }
}))
