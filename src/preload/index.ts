import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc'
import type {
  AgentActivityEvent,
  AppInfo,
  BadgePayload,
  ChatAnswer,
  ChatAttachment,
  ChatEntry,
  ChatEvent,
  ChatMode,
  ChatModelOption,
  ChatOpenResult,
  ChatRewindResult,
  ClaudeStatus,
  ClaudeUpdateResult,
  Config,
  ContainerState,
  DiffResult,
  DockerStatus,
  MountNode,
  NewProjectInput,
  OutputNode,
  PtyDataEvent,
  PtyExitEvent,
  SessionType,
  SpawnResult,
  TranscriptSearchResult,
  UpdateProjectInput,
  UsageSnapshot,
  VolumeRemoveResult,
  VolumeReport
} from '../shared/types'

export interface ContainerOutputEvent {
  projectId: string
  data: string
}

export interface ContainerStateChangedEvent {
  projectId: string
  running: boolean
}

const api = {
  // config / projects / sessions
  loadConfig: (): Promise<Config> => ipcRenderer.invoke(CH.loadConfig),
  createProject: (input: NewProjectInput): Promise<Config> =>
    ipcRenderer.invoke(CH.createProject, input),
  updateProject: (input: UpdateProjectInput): Promise<Config> =>
    ipcRenderer.invoke(CH.updateProject, input),
  deleteProject: (id: string): Promise<Config> => ipcRenderer.invoke(CH.deleteProject, id),
  addSession: (projectId: string, type: SessionType, name: string): Promise<Config> =>
    ipcRenderer.invoke(CH.addSession, projectId, type, name),
  renameSession: (projectId: string, sessionId: string, name: string): Promise<Config> =>
    ipcRenderer.invoke(CH.renameSession, projectId, sessionId, name),
  removeSession: (projectId: string, sessionId: string): Promise<Config> =>
    ipcRenderer.invoke(CH.removeSession, projectId, sessionId),
  /** The chat window's zoom factor — one setting for every chat session. */
  setChatZoom: (value: number): Promise<void> => ipcRenderer.invoke(CH.setChatZoom, value),
  reorderProjects: (orderedIds: string[]): Promise<Config> =>
    ipcRenderer.invoke(CH.reorderProjects, orderedIds),
  reorderSessions: (projectId: string, orderedSessionIds: string[]): Promise<Config> =>
    ipcRenderer.invoke(CH.reorderSessions, projectId, orderedSessionIds),
  // index = insertion point in the target project's session list; -1 appends.
  moveSession: (
    fromProjectId: string,
    toProjectId: string,
    sessionId: string,
    index: number
  ): Promise<Config> =>
    ipcRenderer.invoke(CH.moveSession, fromProjectId, toProjectId, sessionId, index),

  // git
  projectBranches: (): Promise<Record<string, string | null>> =>
    ipcRenderer.invoke(CH.projectBranches),
  projectDiff: (projectId: string): Promise<DiffResult> =>
    ipcRenderer.invoke(CH.projectDiff, projectId),
  setDiffBase: (value: string): Promise<Config> => ipcRenderer.invoke(CH.setDiffBase, value),

  // shared output folder
  setSharedOutput: (folder: string | null): Promise<Config> =>
    ipcRenderer.invoke(CH.setSharedOutput, folder),
  outputTree: (): Promise<OutputNode[]> => ipcRenderer.invoke(CH.outputTree),
  openOutputFile: (abs: string): Promise<string> => ipcRenderer.invoke(CH.openOutputFile, abs),
  openOutputFolder: (): Promise<string> => ipcRenderer.invoke(CH.openOutputFolder),
  deleteOutputFile: (abs: string): Promise<string> => ipcRenderer.invoke(CH.deleteOutputFile, abs),
  onOutputChanged: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(CH.outputChanged, h)
    return () => ipcRenderer.removeListener(CH.outputChanged, h)
  },

  /** A link in a chat message → the user's browser. Main enforces the scheme. */
  openExternal: (url: string): Promise<string> => ipcRenderer.invoke(CH.openExternal, url),

  // docker / containers
  dockerStatus: (): Promise<DockerStatus> => ipcRenderer.invoke(CH.dockerStatus),
  containerStates: (): Promise<ContainerState[]> => ipcRenderer.invoke(CH.containerStates),
  startContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.startContainer, projectId),
  stopContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.stopContainer, projectId),
  restartContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.restartContainer, projectId),
  recreateContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.recreateContainer, projectId),

  // volume housekeeping (slow: listing measures every volume on disk)
  volumes: (): Promise<VolumeReport> => ipcRenderer.invoke(CH.volumes),
  removeVolume: (name: string): Promise<VolumeRemoveResult> =>
    ipcRenderer.invoke(CH.removeVolume, name),

  // pty / sessions
  openSession: (
    projectId: string,
    sessionId: string,
    cols: number,
    rows: number
  ): Promise<SpawnResult> => ipcRenderer.invoke(CH.openSession, projectId, sessionId, cols, rows),
  writeSession: (sessionId: string, data: string): void =>
    ipcRenderer.send(CH.writeSession, sessionId, data),
  resizeSession: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send(CH.resizeSession, sessionId, cols, rows),
  killSession: (sessionId: string): void => ipcRenderer.send(CH.killSession, sessionId),

  onPtyData: (cb: (e: PtyDataEvent) => void): (() => void) => {
    const h = (_: unknown, p: PtyDataEvent): void => cb(p)
    ipcRenderer.on(CH.ptyData, h)
    return () => ipcRenderer.removeListener(CH.ptyData, h)
  },
  onPtyExit: (cb: (e: PtyExitEvent) => void): (() => void) => {
    const h = (_: unknown, p: PtyExitEvent): void => cb(p)
    ipcRenderer.on(CH.ptyExit, h)
    return () => ipcRenderer.removeListener(CH.ptyExit, h)
  },
  onContainerOutput: (cb: (e: ContainerOutputEvent) => void): (() => void) => {
    const h = (_: unknown, p: ContainerOutputEvent): void => cb(p)
    ipcRenderer.on(CH.containerOutput, h)
    return () => ipcRenderer.removeListener(CH.containerOutput, h)
  },
  onContainerStateChanged: (cb: (e: ContainerStateChangedEvent) => void): (() => void) => {
    const h = (_: unknown, p: ContainerStateChangedEvent): void => cb(p)
    ipcRenderer.on(CH.containerStateChanged, h)
    return () => ipcRenderer.removeListener(CH.containerStateChanged, h)
  },
  // Both producers — the hook bridge for pty agents, the stream reader for chat.
  onAgentActivity: (cb: (e: AgentActivityEvent) => void): (() => void) => {
    const h = (_: unknown, p: AgentActivityEvent): void => cb(p)
    ipcRenderer.on(CH.agentActivity, h)
    return () => ipcRenderer.removeListener(CH.agentActivity, h)
  },

  // chat sessions
  chatOpen: (projectId: string, sessionId: string, retry = false): Promise<ChatOpenResult> =>
    ipcRenderer.invoke(CH.chatOpen, projectId, sessionId, retry),
  chatSend: (sessionId: string, text: string, attachments: ChatAttachment[]): Promise<boolean> =>
    ipcRenderer.invoke(CH.chatSend, sessionId, text, attachments),
  chatInterrupt: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(CH.chatInterrupt, sessionId),
  chatRewind: (sessionId: string, entryId: string): Promise<ChatRewindResult> =>
    ipcRenderer.invoke(CH.chatRewind, sessionId, entryId),
  chatAnswer: (sessionId: string, requestId: string, answer: ChatAnswer): Promise<void> =>
    ipcRenderer.invoke(CH.chatAnswer, sessionId, requestId, answer),
  chatSetMode: (sessionId: string, mode: ChatMode): Promise<Config> =>
    ipcRenderer.invoke(CH.chatSetMode, sessionId, mode),
  chatSetModel: (sessionId: string, model: string): Promise<Config> =>
    ipcRenderer.invoke(CH.chatSetModel, sessionId, model),
  chatModels: (sessionId: string): Promise<ChatModelOption[]> =>
    ipcRenderer.invoke(CH.chatModels, sessionId),
  chatClose: (sessionId: string): void => ipcRenderer.send(CH.chatClose, sessionId),
  chatBody: (sessionId: string, entryId: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.chatBody, sessionId, entryId),
  chatEarlier: (
    sessionId: string,
    mounted: number
  ): Promise<{ entries: ChatEntry[]; total: number }> =>
    ipcRenderer.invoke(CH.chatEarlier, sessionId, mounted),
  chatSubagent: (
    sessionId: string,
    toolUseId: string,
    agentId: string | null
  ): Promise<ChatEntry[]> => ipcRenderer.invoke(CH.chatSubagent, sessionId, toolUseId, agentId),
  chatMountTree: (projectId: string): Promise<MountNode[]> =>
    ipcRenderer.invoke(CH.chatMountTree, projectId),

  // Grep every conversation on the shared creds volume. App-wide rather than
  // per-session: it answers with no chat open and reaches conversations whose
  // session has been deleted.
  searchTranscripts: (query: string): Promise<TranscriptSearchResult> =>
    ipcRenderer.invoke(CH.searchTranscripts, query),
  /** Re-scan what `/` can expand; the fresh list arrives as a `meta` event. */
  chatRefreshCommands: (sessionId: string): void =>
    ipcRenderer.send(CH.chatRefreshCommands, sessionId),
  /** Regenerate this chat's name from what it has actually been about. */
  chatRetitle: (sessionId: string): void => ipcRenderer.send(CH.chatRetitle, sessionId),
  // The one union channel — see the ChatEvent doc comment for why it is one.
  onChatEvent: (cb: (e: ChatEvent) => void): (() => void) => {
    const h = (_: unknown, p: ChatEvent): void => cb(p)
    ipcRenderer.on(CH.chatEvent, h)
    return () => ipcRenderer.removeListener(CH.chatEvent, h)
  },

  // clipboard
  pasteImage: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.pasteImage, projectId),
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke(CH.clipboardReadText),
  clipboardWriteText: (text: string): void => ipcRenderer.send(CH.clipboardWriteText, text),

  // dialogs / window
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.appInfo),
  browseFolder: (): Promise<string | null> => ipcRenderer.invoke(CH.browseFolder),
  /** The same picker, multi-select — several mounts from one trip through it. */
  browseFolders: (): Promise<string[]> => ipcRenderer.invoke(CH.browseFolders),
  /** A base folder's immediate subfolders, absolute, for the mount quick-picks. */
  subfolders: (basePath: string): Promise<string[]> =>
    ipcRenderer.invoke(CH.subfolders, basePath),
  fetchUsage: (): Promise<UsageSnapshot> => ipcRenderer.invoke(CH.fetchUsage),

  // claude code version / manual update (force skips main's npm-registry cache)
  claudeStatus: (force = false): Promise<ClaudeStatus> =>
    ipcRenderer.invoke(CH.claudeStatus, force),
  claudeUpdate: (projectId: string): Promise<ClaudeUpdateResult> =>
    ipcRenderer.invoke(CH.claudeUpdate, projectId),

  setBadge: (b: BadgePayload): void => ipcRenderer.send(CH.setBadge, b),
  windowMinimize: (): void => ipcRenderer.send(CH.windowMinimize),
  windowMaximize: (): void => ipcRenderer.send(CH.windowMaximize),
  windowClose: (): void => ipcRenderer.send(CH.windowClose),
  /** The active theme's `--bg`, so Chromium paints the window the same colour. */
  setWindowBackground: (color: string): void => ipcRenderer.send(CH.setWindowBackground, color),
  // Confirm-on-quit: main asks (quitRequested), renderer confirms (confirmQuit).
  onQuitRequested: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(CH.quitRequested, h)
    return () => ipcRenderer.removeListener(CH.quitRequested, h)
  },
  // The window became the active one (taskbar/start-menu click, alt-tab, restore).
  /** Main renamed a session by itself (the chat auto-titler). */
  onSessionRenamed: (cb: (config: Config) => void): (() => void) => {
    const h = (_: unknown, p: Config): void => cb(p)
    ipcRenderer.on(CH.sessionRenamed, h)
    return () => ipcRenderer.removeListener(CH.sessionRenamed, h)
  },
  onWindowFocused: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(CH.windowFocused, h)
    return () => ipcRenderer.removeListener(CH.windowFocused, h)
  },
  confirmQuit: (): void => ipcRenderer.send(CH.confirmQuit)
}

export type VivariumApi = typeof api

contextBridge.exposeInMainWorld('vivarium', api)
