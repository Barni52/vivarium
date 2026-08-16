import { app, BrowserWindow, Menu, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpc } from './ipc'
import { ConfigStore } from './config'
import { DEFAULT_THEME, THEME_BG } from '@shared/theme'
import type { WindowBounds } from '@shared/types'
import type { PtyManager } from './pty'
import type { ChatService } from './chat'

// Optional smoke-test hook: when VIVARIUM_CDP_PORT is set, expose the Chrome
// DevTools Protocol on that port and keep the window hidden so an automated
// check can confirm the renderer loaded without a visible window popping up.
// VIVARIUM_CDP_SHOW opts back into a visible window, which `npm run dev:cdp`
// sets: a hidden window is never composited, so a screenshot has no frame to
// hand back, and an agent driving the app blind is also an agent nobody can
// watch.
const cdpPort = process.env['VIVARIUM_CDP_PORT']
const cdpShow = Boolean(process.env['VIVARIUM_CDP_SHOW'])
if (cdpPort) {
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
  app.commandLine.appendSwitch('remote-allow-origins', '*')
  // Windows tells Chromium when a window is fully covered by another one, and
  // Chromium then stops compositing it entirely: no frames, so
  // Page.captureScreenshot hangs until it times out, requestAnimationFrame never
  // fires, and a CSS entry animation freezes at its first keyframe — which is
  // opacity 0 for every dialog in this app (`vover`/`vdlg` in ui.tsx). An agent
  // driving the app would open a dialog and be told, correctly, that nothing is
  // on screen. Only ever set under CDP: the throttle is worth having when the
  // window is genuinely out of sight and nobody is driving it.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

let mainWindow: BrowserWindow | null = null

const DEFAULT_BOUNDS = { width: 1200, height: 800 }

/**
 * The saved rectangle, if it still describes somewhere a window can be seen.
 *
 * A remembered position is the one piece of this that can be *wrong* rather than
 * merely stale: unplug the second monitor, or come back from a projector, and
 * yesterday's x/y put the window on a desktop that no longer exists — off screen,
 * unreachable, with no visible way to get it back. So the position is only
 * honoured when a decent piece of the title bar would land inside some display's
 * work area, and otherwise dropped on its own, keeping the size and letting
 * Windows place the window.
 *
 * The size is not validated the same way: `minWidth`/`minHeight` already clamp it
 * from below, and a window wider than the current screen is a nuisance the user
 * can drag out of, not a window they cannot reach.
 */
function restoreBounds(saved: WindowBounds | undefined): {
  width: number
  height: number
  x?: number
  y?: number
} {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return DEFAULT_BOUNDS
  }
  const size = { width: Math.round(saved.width), height: Math.round(saved.height) }
  if (!Number.isFinite(saved.x ?? NaN) || !Number.isFinite(saved.y ?? NaN)) return size

  const x = Math.round(saved.x as number)
  const y = Math.round(saved.y as number)
  // Enough of the top edge to grab, on one display — not the whole rectangle,
  // which would refuse a window the user deliberately left hanging off an edge.
  const GRAB = 120
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) => {
    const overlapX = Math.min(x + size.width, w.x + w.width) - Math.max(x, w.x)
    const overlapY = Math.min(y + 40, w.y + w.height) - Math.max(y, w.y)
    return overlapX >= GRAB && overlapY > 0
  })
  return onScreen ? { ...size, x, y } : size
}

function createWindow(store: ConfigStore): void {
  // Dev/taskbar icon. Packaged builds get their icon from the exe (electron-
  // builder reads build/icon.ico), which isn't inside the asar, so guard it.
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')

  const saved = store.get().window

  mainWindow = new BrowserWindow({
    ...restoreBounds(saved),
    minWidth: 760,
    minHeight: 480,
    show: false,
    frame: false, // custom title bar (see renderer/TitleBar)
    // The one place a `var()` cannot reach that is also in another process: this
    // is painted before the renderer has a document, and main cannot know which
    // theme is on (the choice lives in the renderer's localStorage). So it opens
    // on the default theme's page colour — read from the shared table rather
    // than spelled out, so it cannot drift from the CSS — and the renderer
    // corrects it over `window:set-background` during module eval, long before
    // `ready-to-show` reveals the window.
    backgroundColor: THEME_BG[DEFAULT_THEME],
    title: 'Vivarium',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Only while being driven over CDP: an occluded window has its
      // timers and animation frames throttled, so a click lands and the UI
      // re-renders a second later — which reads to the driver as "the click did
      // nothing". Left on for normal runs, where the cost of a background
      // window ticking is real and the benefit is not.
      ...(cdpPort ? { backgroundThrottling: false } : {})
    }
  })

  // Before `show`, so a window that was maximized comes back maximized rather
  // than restoring at its old size and snapping a frame later.
  if (saved?.maximized) mainWindow.maximize()

  registerIpc(mainWindow, store)

  // Remember the rectangle. Debounced because `resize` and `move` fire per pixel
  // of a drag, and each one would otherwise be a full rewrite of the only durable
  // state this app has. `getNormalBounds` rather than `getBounds`: while
  // maximized the latter reports the screen, which would make un-maximizing after
  // a restart land on a window the size of the monitor with no way back to the
  // size you actually chose.
  let saveTimer: NodeJS.Timeout | null = null
  const rememberBounds = (): void => {
    const win = mainWindow
    if (!win || win.isDestroyed() || win.isMinimized()) return
    const { x, y, width, height } = win.getNormalBounds()
    void store.mutate((cfg) => {
      cfg.window = { x, y, width, height, maximized: win.isMaximized() }
      return cfg
    })
  }
  const rememberSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(rememberBounds, 500)
  }
  mainWindow.on('resize', rememberSoon)
  mainWindow.on('move', rememberSoon)
  // Not debounced: these are single deliberate acts, and the flag they change is
  // not recoverable from the geometry afterwards.
  mainWindow.on('maximize', rememberBounds)
  mainWindow.on('unmaximize', rememberBounds)
  // The last resize before an Alt+F4 can still be inside the debounce window.
  // Best effort by nature — the write is async and the process is on its way out
  // — but the queue is empty by this point in all but the tightest race.
  mainWindow.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    rememberBounds()
  })

  // **The renderer never navigates, and never opens a window.** Every link in a
  // chat message goes out through CH.openExternal, which validates the scheme
  // before handing anything to Windows — and the reason that design is safe at
  // all is that this window has nowhere to navigate *to*. That was asserted in
  // CLAUDE.md and enforced nowhere: the only preventDefault in this process was
  // the quit interceptor.
  //
  // The live path is drag-and-drop. ChatView's root handles onDrop, but it only
  // covers the chat surface — a file dropped on the sidebar, the title bar or the
  // empty state hit Chromium's default and navigated the renderer to file:///…,
  // taking the app with it, into a page that still has the preload and
  // `window.vivarium` attached under `sandbox: false`.
  const wc = mainWindow.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, url) => {
    // Only a navigation *away*. Vite's dev server reloads the same URL on HMR
    // recovery, and blocking that would break `npm run dev`.
    if (url !== wc.getURL()) e.preventDefault()
  })

  // The default menu is hidden (frame: false) but its accelerators still fire,
  // and they hijack keys terminals need — Ctrl+W (Close) would kill the window
  // instead of doing a word-delete, Ctrl+R (reload) would clobber shell reverse-
  // search, etc. Drop the menu entirely so every keystroke reaches the terminal.
  // Clipboard is handled in the renderer (TerminalView), not via menu roles.
  Menu.setApplicationMenu(null)

  // Menu removal also drops the DevTools accelerator, so keep F12 as a toggle
  // (unused by terminals, so no conflict) for debugging.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools()
  })

  mainWindow.on('ready-to-show', () => {
    if (!cdpPort || cdpShow) mainWindow?.show()
  })

  // electron-vite exposes the dev server URL in dev, the built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // The store is created *here* and handed to both halves, rather than made
  // inside registerIpc as it used to be: the window's own size is now in
  // config.json, and it has to be read before `new BrowserWindow`, not after.
  // Sizing the window afterwards would mean opening at 1200×800 and jumping —
  // `show` waits for the renderer, which is long after this file is done.
  //
  // A failed load is not fatal to the window: `load` never throws, and a config
  // it could not read comes back empty, which is the same "no saved size" case
  // as a first run.
  const store = new ConfigStore()
  await store.load()
  createWindow(store)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(store)
  })
})

// On quit: kill only local processes — never stop containers. A chat's CLI
// process is a `docker exec -i` client, so ending it costs exactly what ending a
// pty costs: an in-flight turn, and nothing else. The *conversation* is on the
// creds volume and comes back on the next open.
app.on('before-quit', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    const w = win as unknown as { __pty?: PtyManager; __chat?: ChatService }
    w.__pty?.killAll()
    w.__chat?.closeAll()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
