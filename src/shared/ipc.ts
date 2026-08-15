// Channel names shared between preload and main. The renderer never uses these
// directly — it goes through the typed `window.vivarium` API from the preload.

export const CH = {
  // config / projects / sessions
  loadConfig: 'config:load',
  createProject: 'project:create',
  updateProject: 'project:update',
  deleteProject: 'project:delete',
  addSession: 'session:add',
  renameSession: 'session:rename',
  removeSession: 'session:remove',
  // A session renamed by *main* rather than by the sidebar — today only the chat
  // auto-titler. The one config channel that pushes: every other config change
  // starts in the renderer and adopts the Config it gets back, but a generated
  // title starts in ChatService, so main is the writer and the renderer adopts.
  // The whole Config rides along, exactly like an invoke's return value, so the
  // store keeps having one way to take a config update.
  sessionRenamed: 'session:renamed',
  // The chat window's zoom factor. A setting rather than a chat channel: it is
  // global to the app and outlives every session, so it is written straight to
  // config.json and read back at launch.
  setChatZoom: 'config:set-chat-zoom',
  reorderProjects: 'project:reorder',
  reorderSessions: 'session:reorder',
  // Cross-project move (drag a session onto another project). Separate from
  // reorderSessions because it spans two projects and has to end the session's
  // pty — the old container's exec client can't follow it.
  moveSession: 'session:move',

  // git
  projectBranches: 'git:branches',
  projectDiff: 'git:diff',
  setDiffBase: 'git:set-diff-base',

  // shared output folder
  setSharedOutput: 'output:set-folder',
  outputTree: 'output:tree',
  openOutputFile: 'output:open-file',
  openOutputFolder: 'output:open-folder',
  deleteOutputFile: 'output:delete-file',
  outputChanged: 'output:changed',

  // docker / containers
  dockerStatus: 'docker:status',
  volumes: 'docker:volumes',
  removeVolume: 'docker:volume-remove',
  containerStates: 'container:states',
  startContainer: 'container:start',
  stopContainer: 'container:stop',
  restartContainer: 'container:restart',
  recreateContainer: 'container:recreate',

  // pty / sessions
  openSession: 'pty:open',
  writeSession: 'pty:write',
  resizeSession: 'pty:resize',
  killSession: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  containerOutput: 'container:output',
  containerStateChanged: 'container:state-changed',
  // Both agent producers — the hook bridge for pty `agent` sessions, the
  // stream reader for `chat` — emit AgentActivityEvent here. The store cannot
  // tell them apart, which is the point.
  agentActivity: 'agent:activity',

  // chat sessions — granular out, ONE union in. `chat:event` is the only channel
  // in this object that carries a discriminated union rather than one kind of
  // payload, and it is deliberate: entry-append, turn-end replacement, blocking
  // cards, task/todo, reset and exit are strictly ordered, and Electron
  // guarantees ordering only *within* a channel. Split them and a blocking card
  // can overtake the text it refers to — a question rendered above the sentence
  // asking it. See the ChatEvent doc comment.
  chatOpen: 'chat:open',
  chatSend: 'chat:send',
  chatInterrupt: 'chat:interrupt',
  chatRewind: 'chat:rewind',
  chatAnswer: 'chat:answer',
  chatSetMode: 'chat:set-mode',
  chatSetModel: 'chat:set-model',
  chatModels: 'chat:models',
  chatClose: 'chat:close',
  chatBody: 'chat:body',
  // The bytes behind an image chip, by the handle the chip carries. A sibling of
  // chatBody in every respect: main holds the heavy thing, the renderer asks for
  // the one it is drawing.
  chatImage: 'chat:image',
  chatEarlier: 'chat:earlier',
  chatSubagent: 'chat:subagent',
  chatMountTree: 'chat:mount-tree',
  // "Look again at what `/` can expand." A send rather than an invoke, and the
  // answer comes back on `chat:event` as a `meta` — the renderer is asking main
  // to refresh a reading it already subscribes to, not fetching one.
  chatRefreshCommands: 'chat:refresh-commands',
  // "Name this chat after what it is actually about." A send, not an invoke: the
  // answer is a model call away and arrives on `session:renamed` like every
  // other generated title, rather than being awaited by a context menu.
  chatRetitle: 'chat:retitle',
  chatEvent: 'chat:event',
  // Grep every conversation on the shared creds volume. Not a chat channel
  // despite the name's family: it is answered without any chat session being
  // open, spans every project at once, and reaches conversations whose session
  // was deleted — so it belongs to the app, not to a session.
  searchTranscripts: 'transcripts:search',

  // A link in a chat message, opened in the user's own browser. The renderer
  // never navigates: this window has no new-window handler, so an <a> would
  // open the page *inside* the app with node integration a preload away.
  openExternal: 'shell:open-external',

  // clipboard
  pasteImage: 'clipboard:paste-image',
  clipboardReadText: 'clipboard:read-text',
  clipboardWriteText: 'clipboard:write-text',

  // claude plan usage
  fetchUsage: 'usage:fetch',

  // claude code version / manual update
  claudeStatus: 'claude:status',
  claudeUpdate: 'claude:update',

  // dialogs / window
  appInfo: 'app:info',
  browseFolder: 'dialog:browse-folder',
  // The same picker with multiSelections on, for the mount list: adding six
  // folders should cost one trip through the Windows dialog, not six. A second
  // channel rather than a flag on the first because the return type differs and
  // every other caller (base folder, shared output) wants exactly one path.
  browseFolders: 'dialog:browse-folders',
  // The immediate subfolders of a base folder, absolute, for the mount picker's
  // quick-add chips. A host-side readdir — nothing here touches docker, and it
  // is deliberately one level deep: this answers "which of these do I want
  // mounted", which is a flat question, not "browse my disk".
  subfolders: 'dialog:subfolders',
  setBadge: 'window:set-badge',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  // The theme's page colour, pushed down so Chromium paints the same thing the
  // document does. `BrowserWindow.backgroundColor` shows through wherever the
  // renderer has not drawn yet — the frame before first paint, and the edge you
  // are dragging during a resize — and main has no way to know which theme is on
  // (it is in the renderer's localStorage). So the renderer tells it, at boot
  // and on every switch.
  setWindowBackground: 'window:set-background',
  // Confirm-on-quit handshake: main intercepts every close path and emits
  // quitRequested; the renderer shows its dialog and sends confirmQuit back once
  // the user accepts, which lets the real close through.
  quitRequested: 'window:quit-requested',
  confirmQuit: 'window:confirm-quit',
  // Window activation — a taskbar/start-menu click, an alt-tab, a restore from
  // minimized. Main is the side Windows tells about it, and it is where the
  // attention flash already stops; the renderer takes it as "whatever session is
  // on screen has now been seen".
  windowFocused: 'window:focused'
} as const
