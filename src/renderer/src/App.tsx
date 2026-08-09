import React from 'react'
import { useStore } from './state/store'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { TerminalHost } from './components/TerminalHost'
import { AddProject } from './components/dialogs/AddProject'
import { ProjectSettings } from './components/dialogs/ProjectSettings'
import { AddSessionPopover } from './components/dialogs/AddSessionPopover'
import { ConfirmKill } from './components/dialogs/ConfirmKill'
import { ConfirmMove } from './components/dialogs/ConfirmMove'
import { ConfirmDeleteProject } from './components/dialogs/ConfirmDeleteProject'
import { ConfirmQuit } from './components/dialogs/ConfirmQuit'
import { ClaudeUpdate } from './components/dialogs/ClaudeUpdate'
import { Volumes } from './components/dialogs/Volumes'
import { ContextMenu } from './components/ContextMenu'

export function App(): React.ReactElement {
  const init = useStore((s) => s.init)
  const refreshStates = useStore((s) => s.refreshStates)
  const refreshBranches = useStore((s) => s.refreshBranches)
  const refreshUsage = useStore((s) => s.refreshUsage)
  const refreshClaude = useStore((s) => s.refreshClaude)
  const refreshOutputTree = useStore((s) => s.refreshOutputTree)
  const handleAgentActivity = useStore((s) => s.handleAgentActivity)
  const handleChatEvent = useStore((s) => s.handleChatEvent)
  const adoptConfig = useStore((s) => s.adoptConfig)
  const acknowledgeSelected = useStore((s) => s.acknowledgeSelected)
  const requestQuit = useStore((s) => s.requestQuit)
  const dialog = useStore((s) => s.dialog)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const cycleTheme = useStore((s) => s.cycleTheme)

  // Ctrl/Cmd+Shift+T — cycle midnight → graphite → paper → midnight.
  //
  // On `window` in the **capture** phase, which is the only place it works from
  // everywhere: a focused xterm swallows key events in the bubble phase (its
  // textarea is the target and its own handler runs first), and the chat
  // composer is a textarea that would otherwise just insert nothing and move on.
  // Capture runs before either of them see it.
  //
  // `preventDefault` because Chromium binds Ctrl+Shift+T to "reopen closed tab":
  // inert in an Electron window with no tabs, but it is a documented default and
  // leaving it unclaimed is how a future Electron picks it up again.
  //
  // Its own effect rather than a line in the big one below: that effect's
  // dependency list is the app's whole boot, and re-running it to change a key
  // handler would tear down every IPC subscription with it.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // `e.code`, not `e.key`: with Shift held, `key` is 'T' on a US layout but
      // whatever the layout puts on that key elsewhere, and the shortcut is
      // about the physical key.
      if (e.code !== 'KeyT' || !e.shiftKey || !(e.ctrlKey || e.metaKey) || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      cycleTheme()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycleTheme])

  React.useEffect(() => {
    // debug handle for automated smoke tests / DevTools inspection
    ;(window as unknown as { __vivStore?: typeof useStore }).__vivStore = useStore
    init()
    // Keep the running/stopped indicators + git branches fresh. One `docker ps`
    // per tick now rather than two `docker inspect` per project (see
    // DockerService.containerStates), which is what makes a 3s cadence
    // reasonable at all.
    //
    // Skipped while the window is hidden: nothing on screen is reading these,
    // and a minimized app has no business spawning a docker client every three
    // seconds for hours. Chromium throttles hidden-window timers to roughly once
    // a minute on its own, but that is a heuristic about *timers*, not a promise
    // about this one — and the first tick after a restore refreshes anyway,
    // because becoming visible fires the listener below.
    const tick = (): void => {
      if (document.visibilityState === 'hidden') return
      refreshStates()
      refreshBranches()
    }
    const poll = setInterval(tick, 3000)
    // Coming back into view should not wait out the rest of the interval — the
    // indicators are the first thing looked at, and they are up to 3s stale.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    // Plan usage: the endpoint allows ~5 requests per 5 minutes (measured
    // 2026-07-22; tripping it = ~5 min lockout), so poll every 3 minutes —
    // two per window, leaving headroom for this startup fetch and restarts.
    // Between syncs the TitleBar countdown interpolates off the app clock.
    refreshUsage()
    const usagePoll = setInterval(() => refreshUsage(), 180_000)
    // A container that just came up (or was recreated, which reverts Claude Code
    // to the image's version) is the only time the installed version can change
    // behind our back — re-read it, debounced so a burst of starts costs one
    // sweep. The npm side is cached in main, so this is cheap.
    let claudeDebounce: ReturnType<typeof setTimeout> | null = null
    const off = window.vivarium.onContainerStateChanged(() => {
      refreshStates()
      if (claudeDebounce) clearTimeout(claudeDebounce)
      claudeDebounce = setTimeout(() => refreshClaude(), 2000)
    })
    const offOutput = window.vivarium.onOutputChanged(() => refreshOutputTree())
    // One channel, two producers: the hook bridge for pty agents, the stream
    // reader for chat sessions. This side cannot tell them apart.
    const offActivity = window.vivarium.onAgentActivity((e) => handleAgentActivity(e))
    // …and one union channel in, because a chat turn's appended rows, its
    // turn-end replacement, its blocking cards and its exit are strictly ordered
    // and Electron only guarantees ordering *within* a channel.
    const offChat = window.vivarium.onChatEvent((e) => handleChatEvent(e))
    // The one config change this side did not start: a chat that has named
    // itself. Not on `chat:event` — a session name is sidebar state, and it has
    // to land for chats that are not the one on screen.
    const offRenamed = window.vivarium.onSessionRenamed((c) => adoptConfig(c))
    // Bringing the app to the front means looking at the selected session, so its
    // attention flag (and its share of the taskbar number) is answered for.
    const offFocus = window.vivarium.onWindowFocused(() => acknowledgeSelected())
    // Main intercepts every window-close path and asks us to confirm first.
    const offQuit = window.vivarium.onQuitRequested(() => requestQuit())
    return () => {
      clearInterval(poll)
      clearInterval(usagePoll)
      document.removeEventListener('visibilitychange', onVisible)
      if (claudeDebounce) clearTimeout(claudeDebounce)
      off()
      offOutput()
      offActivity()
      offChat()
      offRenamed()
      offFocus()
      offQuit()
    }
  }, [
    init,
    refreshStates,
    refreshBranches,
    refreshOutputTree,
    refreshUsage,
    refreshClaude,
    handleAgentActivity,
    handleChatEvent,
    adoptConfig,
    acknowledgeSelected,
    requestQuit
  ])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: 'var(--bg)',
        color: 'var(--fg)',
        // The face and the base size are `body`'s (theme.ts) and are not restated
        // here — this element used to declare a second one, which is how the app
        // ended up with a sans chrome wrapped around mono content.
        overflow: 'hidden',
        position: 'relative',
        lineHeight: 1.45
      }}
    >
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!sidebarCollapsed && <Sidebar />}
        <TerminalHost />
      </div>

      {dialog === 'addProject' && <AddProject />}
      {dialog === 'settings' && <ProjectSettings />}
      {dialog === 'addSession' && <AddSessionPopover />}
      {dialog === 'confirmKill' && <ConfirmKill />}
      {dialog === 'confirmMove' && <ConfirmMove />}
      {dialog === 'confirmDeleteProject' && <ConfirmDeleteProject />}
      {dialog === 'confirmQuit' && <ConfirmQuit />}
      {dialog === 'claudeUpdate' && <ClaudeUpdate />}
      {dialog === 'volumes' && <Volumes />}
      <ContextMenu />
    </div>
  )
}
