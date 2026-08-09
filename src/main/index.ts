import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpc } from './ipc'
import { DEFAULT_THEME, THEME_BG } from '@shared/theme'
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

function createWindow(): void {
  // Dev/taskbar icon. Packaged builds get their icon from the exe (electron-
  // builder reads build/icon.ico), which isn't inside the asar, so guard it.
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

  registerIpc(mainWindow)

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

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
