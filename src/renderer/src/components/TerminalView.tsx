import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'
import { Chevron, Close, Copy, Paste, Refresh, Search, SelectAll, ZoomIn, ZoomOut } from './Icons'
import { MONO, themeFor, tokensFor, type ThemeName } from '../theme'

/**
 * The terminal's own copy of the theme.
 *
 * xterm renders into a canvas it paints itself and cannot resolve a custom
 * property, so this reads the token map by name — which is what stops it
 * drifting from the `var(--bg)` gutter padding TerminalView/TerminalHost draw
 * around the same canvas. A drift there shows up as a visible seam at the edges
 * of the terminal.
 *
 * Being a function rather than a constant is the whole of the theme support
 * here: a `var()` re-resolves itself on a theme swap and a canvas does not, so
 * every live terminal has to be handed a new object (see the effect below).
 */
function xtermTheme(name: ThemeName): Record<string, string> {
  const t = tokensFor(name)
  return {
    background: t.bg,
    foreground: t.fg,
    cursor: t.fg,
    selectionBackground: t.selection,
    ...themeFor(name).ansi
  }
}

/**
 * Match highlighting for the find bar, per theme.
 *
 * The fussiest of the non-CSS consumers: xterm composites these itself and
 * accepts **plain #RRGGBB only — no alpha**, so `--selection` (translucent by
 * design) cannot be reused here. The inactive match is `--sel`, the app's
 * row-highlight fill, and the active one steps up to `--accent` with an
 * `--accent-fg` edge — the same "this is the selected one" language the
 * sidebar's 3px bar speaks.
 *
 * The overview-ruler entries are required by the type but inert: that ruler only
 * draws when `overviewRulerWidth` is set, which it isn't.
 */
function searchOpts(name: ThemeName): ISearchOptions {
  const t = tokensFor(name)
  return {
    decorations: {
      matchBackground: t.sel,
      matchBorder: t['border-strong'],
      matchOverviewRuler: t.accent,
      activeMatchBackground: t.accent,
      activeMatchBorder: t['accent-fg'],
      activeMatchColorOverviewRuler: t.fg
    }
  }
}

// The bits of xterm's internals we have to reach for: its scrollbar geometry and
// its wheel-delta maths. Both are explained where they're used below; neither is
// reachable through the public API in 5.5.
type XtermCore = {
  viewport?: {
    syncScrollArea?(immediate: boolean): void
    getLinesScrolled?(ev: WheelEvent): number
    _lastRecordedBufferLength?: number
  }
}
const core = (term: Terminal): XtermCore | undefined =>
  (term as unknown as { _core?: XtermCore })._core

/**
 * Recompute the scrollbar geometry from scratch, right now.
 *
 * xterm's scrollback bar is a real DOM scrollbar — `.xterm-scroll-area` sized to
 * the whole buffer, the wheel moving the viewport's own scrollTop — and its height
 * is recalculated inside a requestAnimationFrame. No frames run while the window
 * is minimized or fully covered, which is exactly when an agent streams output
 * nobody is watching, and xterm records "accounted for this buffer length"
 * *before* queueing that frame: come back to a terminal that has since fallen
 * silent and the scroll area is one screen tall in front of thousands of
 * unreachable lines, with nothing left to notice.
 *
 * Its own `syncScrollArea` can't get us out of that — it is change *detection*
 * (buffer length, canvas height, scroll position, cell height, against what it
 * last recorded) and here every one matches. So spoil a record first: -1 can
 * never equal a real length. `immediate` skips the frame that got us here. A real
 * resize does the same via `_afterResize`, which is why zooming appeared to fix it.
 */
function forceScrollAreaSync(term: Terminal): void {
  const vp = core(term)?.viewport
  if (!vp) return
  vp._lastRecordedBufferLength = -1
  vp.syncScrollArea?.(true)
}

/**
 * The height of one row, measured off the DOM instead of read from xterm.
 *
 * xterm's own copy lives on the *renderer's* dimensions object, which the viewport
 * caches by reference and replaces only when an onDimensionsChange fires. Swap the
 * renderer (WebGL context loss → the DOM fallback below) at an unchanged size and
 * none is emitted, so the viewport keeps sizing the scrollbar from a dead object.
 * `.xterm-screen` is sized to rows × cell height by whichever renderer is live.
 */
function rowHeight(term: Terminal): number {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || term.rows < 1) return 0
  return screen.clientHeight / term.rows
}

/**
 * Repair the scroll geometry, but only when it is provably broken: the DOM
 * scrollbar cannot reach every line the buffer is holding above the view. A no-op
 * in the healthy case, so it is cheap enough for every wheel gesture and can't
 * fight a scroll that is working. Belt to forceScrollAreaSync's braces: Windows
 * doesn't necessarily mark a merely *occluded* window as hidden, so there may be
 * no visibilitychange to hang the repair on — but there is always the notch the
 * user is about to waste.
 *
 * The test is "short of the buffer", not "cannot scroll at all", because a stale
 * scroll area is not only ever one screen tall: shrink a window whose bar has gone
 * stale and a bar reappears, reaching exactly as far back as the taller window had
 * shown and no further, which the old zero-range test called healthy. When it
 * really is healthy the two sides are equal — a full buffer is baseY + rows lines,
 * the area baseY rows taller than the viewport — so the slack is one row of
 * rounding.
 */
function repairIfStuck(term: Terminal): boolean {
  const vpEl = term.element?.querySelector('.xterm-viewport')
  const px = rowHeight(term)
  if (!vpEl || !px) return false
  const needed = term.buffer.active.baseY * px
  const reachable = vpEl.scrollHeight - vpEl.clientHeight
  if (reachable >= needed - px) return false
  forceScrollAreaSync(term)
  return true
}

/** xterm's own wheel-delta → lines math (it accumulates sub-line touchpad
 *  deltas, so a slow trackpad still scrolls). ~3 lines a notch if it ever goes. */
function wheelLines(term: Terminal, ev: WheelEvent): number {
  const n = core(term)?.viewport?.getLinesScrolled?.(ev)
  return typeof n === 'number' && !Number.isNaN(n) ? n : Math.sign(ev.deltaY) * 3
}

// A terminal narrower/shorter than this isn't a terminal, it's a collapsed box
// mid-layout. FitAddon clamps to 2x1 rather than refusing, so it has to be us
// who refuses (see fitNow).
const MIN_FIT_W = 40
const MIN_FIT_H = 30

// One long-lived xterm bound to a single session's pty. It is created once and
// never destroyed on selection change — only hidden — so scrollback survives
// switching (plan: TerminalHost). Visibility is driven by `visible`.
export function TerminalView({
  project,
  session,
  visible
}: {
  project: Project
  session: Session
  visible: boolean
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  // the guarded fit (see fitNow below) — every resize path goes through it
  const fitNowRef = React.useRef<() => void>(() => {})
  const visibleRef = React.useRef(visible)
  visibleRef.current = visible
  const setLive = useStore((s) => s.setLive)
  const setActivity = useStore((s) => s.setActivity)
  // Subscribed, not read once: this canvas has to be repainted by hand when the
  // theme changes (see the effect further down).
  const theme = useStore((s) => s.theme)

  // --- find bar (Ctrl+F) ---
  // The addon is reached through a ref because the key handler that opens the
  // bar is installed once, inside the mount effect; only the bar's own state has
  // to live in React.
  const searchRef = React.useRef<SearchAddon | null>(null)
  const findInputRef = React.useRef<HTMLInputElement>(null)
  const [find, setFind] = React.useState({ open: false, term: '', caseSensitive: false })
  const [results, setResults] = React.useState({ index: -1, count: 0 })
  // Mirror, so the callbacks below and the key handler installed once at mount
  // can read the current term without being rebuilt on every keystroke.
  const findRef = React.useRef(find)
  findRef.current = find

  const closeFind = React.useCallback((): void => {
    setFind((f) => ({ ...f, open: false }))
    searchRef.current?.clearDecorations() // don't leave highlights behind
    termRef.current?.focus()
  }, [])

  /** Jump to the next/previous match for the current term. */
  const stepFind = React.useCallback((back: boolean): void => {
    const search = searchRef.current
    const { term, caseSensitive } = findRef.current
    if (!search || !term) return
    // Read at call time, not captured: a theme swap has to reach the next
    // jump without this callback being rebuilt.
    const opts = { ...searchOpts(useStore.getState().theme), caseSensitive }
    if (back) search.findPrevious(term, opts)
    else search.findNext(term, opts)
  }, [])

  // --- create the terminal + pty once ---
  React.useEffect(() => {
    const term = new Terminal({
      fontFamily: MONO,
      fontSize: useStore.getState().terminalFontSize,
      // Keep lineHeight at the default 1.0 so the WebGL cell height stays
      // integer-aligned — a fractional line height left the last row partially
      // clipped at the bottom edge.
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'bar',
      scrollback: 50000,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      // Real JetBrains Mono weights (preloaded in main.tsx) so the renderer never
      // fakes a weight by double-drawing glyphs (smeared text). Back to 400 now
      // that the face is JetBrains rather than Plex: the 500 here existed because
      // Plex Mono's regular reads thin at 13px, and JetBrains Mono is drawn with
      // a heavier stem to begin with — 500 on top of that is chunky. 500 is still
      // bundled; it is what the mono bits of the UI chrome ask for.
      fontWeight: 400,
      fontWeightBold: 700,
      theme: xtermTheme(useStore.getState().theme)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)

    // Search over the scrollback. The match highlighting — and the counter that
    // rides on its onDidChangeResults event — is proposed API, which this
    // terminal already opts into (allowProposedApi above).
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    const resultsSub = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount })
    )

    // Ctrl+F, from the key handler installed further down or the context menu.
    const openFind = (): void => {
      // Seed from the selection: the common case is "I highlighted this, now
      // show me the next one". Multi-line selections aren't search terms.
      const sel = term.getSelection()
      setFind((f) => ({ ...f, open: true, term: sel && !sel.includes('\n') ? sel : f.term }))
      // If the bar was already open its input is mounted, so select the term the
      // way a browser's find does; if it wasn't, autoFocus handles the first
      // frame and this is a no-op.
      requestAnimationFrame(() => findInputRef.current?.select())
    }

    // --- the one way to resize this terminal -------------------------------
    // Two guards have to hold on every resize path, so they all come through
    // here:
    //
    //  1. Never fit a box with no usable size. FitAddon clamps to its own
    //     MINIMUM_COLS/ROWS (2x1) instead of refusing, so a momentarily collapsed
    //     container — output panel dragged to the top, a very short window, a
    //     layout pass mid-drag — tells the pty it has one row, enough to make an
    //     agent's TUI redraw into that sliver and stay corrupt. A collapsed
    //     *width* is worse: 2 columns reflows the entire 50k-line scrollback and
    //     the buffer never gets its line structure back.
    //
    //  2. Only tell the pty when the size really changed. fit() no-ops on matching
    //     dimensions but resizeSession doesn't, and calling it unconditionally
    //     meant five SIGWINCHes (and five TUI repaints) per zoom.
    let sent = { cols: 0, rows: 0 }
    const fitNow = (): void => {
      const host = hostRef.current
      if (!host || host.clientWidth < MIN_FIT_W || host.clientHeight < MIN_FIT_H) return
      try {
        fit.fit()
      } catch {
        /* cell metrics not measurable yet */
      }
      if (term.cols !== sent.cols || term.rows !== sent.rows) {
        sent = { cols: term.cols, rows: term.rows }
        window.vivarium.resizeSession(session.id, term.cols, term.rows)
      }
      // a resize is also the moment the scrollbar geometry has to be right
      forceScrollAreaSync(term)
    }
    fitNowRef.current = fitNow

    // WebGL gives one GL context per terminal and they are not free: Chromium drops
    // the *oldest* once a page holds too many (reachable now that every session of
    // a running container is mounted, not just the clicked ones — a couple of dozen
    // and the earliest lose theirs), and a GPU driver reset, routine on Windows,
    // takes them all at once. xterm waits 3s for a restore then gives up via
    // onContextLoss, and a renderer that has given up simply stops painting: that
    // is the terminal that "breaks" and never comes back. Dropping the addon falls
    // back to the DOM renderer — slower, but it always draws.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        fitNow()
        term.refresh(0, term.rows - 1)
      })
      term.loadAddon(webgl)
    } catch {
      /* WebGL unavailable — fall back to the DOM renderer */
    }
    fitNow()
    termRef.current = term
    // debug handle for automated smoke tests (read scrollback via xterm's API)
    const terms = ((window as unknown as { __vivTerms?: Record<string, Terminal> }).__vivTerms ??= {})
    terms[session.id] = term

    // keystrokes → pty
    const dataSub = term.onData((data) => window.vivarium.writeSession(session.id, data))

    // pty → terminal (also carries container build/create output before the pty exists)
    const offData = window.vivarium.onPtyData((e) => {
      if (e.sessionId === session.id) term.write(e.data)
    })
    const offExit = window.vivarium.onPtyExit((e) => {
      if (e.sessionId === session.id) {
        setLive(session.id, false)
        setActivity(session.id, 'idle')
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
      }
    })
    // container lifecycle output (from the project power button) — only the
    // visible terminal of the matching project surfaces it.
    const offCO = window.vivarium.onContainerOutput((e) => {
      if (e.projectId === project.id && visibleRef.current) term.write(e.data)
    })

    // --- clipboard: copy / paste / SIGINT -------------------------------
    // xterm does none of this on its own, so wire it explicitly (the Electron
    // default menu has no clipboard roles on Windows). Conventions match
    // Windows Terminal: Ctrl+C copies when there's a selection else sends
    // SIGINT; Ctrl+V / Shift+Insert paste; Ctrl+Shift+C/V force copy/paste.
    const doCopy = (): void => {
      const sel = term.getSelection()
      if (sel) {
        window.vivarium.clipboardWriteText(sel)
        term.clearSelection()
      }
    }
    const doPaste = async (): Promise<void> => {
      // agents: a clipboard image becomes a mounted file path (replaces the
      // reference TCP bridge); otherwise paste text.
      if (session.type === 'agent') {
        const imgPath = await window.vivarium.pasteImage(project.id)
        if (imgPath) {
          window.vivarium.writeSession(session.id, imgPath + ' ')
          return
        }
      }
      const text = await window.vivarium.clipboardReadText()
      if (text) term.paste(text) // routes through onData → pty, honoring bracketed paste
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      // The working/idle indicator is driven by Claude Code hook events (see
      // main/bridge.ts), but the Stop hook does not fire on a user interrupt —
      // so an Esc in an agent terminal optimistically resets the indicator
      // (no notification; the user is right here). Esc still reaches the pty.
      if (session.type === 'agent' && e.key === 'Escape') {
        setActivity(session.id, 'idle')
        return true
      }
      // Answering a blocking prompt restarts the paused turn clock. The
      // PostToolUse hook reports this properly, but only when the tool actually
      // ran: picking "No, keep planning" *denies* ExitPlanMode, so Claude Code
      // fires nothing and the agent goes back to work with the UI still showing
      // "waiting". Enter is the key that commits any of those choices, so treat
      // it as the answer — resumeAgent is a no-op in every other state, which is
      // why this can't disturb a normal turn. Falls through: Enter is the pty's.
      //
      // A digit is the other key that commits one: the TUI's option lists take
      // `1`–`9` as "pick this one" with no Enter after it. That matters most for
      // a host project's agent, which is plain `claude` and stops at permission
      // prompts all day — the PermissionRequest hook reports the wait, nothing
      // reports the answer (see bridge.ts), and "2" is how those are usually
      // answered. Digits typed into an ordinary prompt reach here too, and are
      // harmless for the same no-op reason.
      if (session.type === 'agent' && (e.key === 'Enter' || /^[1-9]$/.test(e.key))) {
        useStore.getState().resumeAgent(session.id)
      }
      // Claude Code: Shift+Enter and Ctrl+Enter insert a newline instead of
      // submitting. xterm sends a bare CR for Enter regardless of modifiers, so
      // translate these chords to ESC+CR — the sequence Claude Code treats as
      // "insert newline" (the same one `claude`'s /terminal-setup installs for
      // Shift+Enter). Plain Enter still submits.
      //
      // preventDefault is essential for Shift+Enter specifically: returning false
      // makes xterm skip its default but doesn't mark the event handled, so the
      // browser still fires a `keypress` (charCode 13) that xterm sends as a second
      // bare CR — appending our newline AND submitting. Ctrl+Enter emits no
      // keypress, which is why it already worked.
      if (session.type === 'agent' && e.key === 'Enter' && (e.shiftKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault()
        window.vivarium.writeSession(session.id, '\x1b\r')
        return false
      }
      // zoom: Ctrl +/-/0 (Windows Terminal / VS Code convention)
      if (e.ctrlKey && !e.altKey) {
        if (e.key === '=' || e.key === '+') {
          useStore.getState().zoomTerminal(1)
          return false
        }
        if (e.key === '-') {
          useStore.getState().zoomTerminal(-1)
          return false
        }
        if (e.key === '0') {
          useStore.getState().resetTerminalZoom()
          return false
        }
      }
      // Ctrl+F opens the find bar. This does take the chord from the shell
      // (readline's forward-char, which the arrow keys already cover) — a
      // deliberate trade against 50k lines of agent scrollback that previously
      // had no way to be searched at all. Ctrl+Shift+F does the same, for
      // Windows Terminal muscle memory.
      if (e.ctrlKey && !e.altKey && k === 'f') {
        openFind()
        return false
      }
      // Ctrl+Backspace → delete the previous word. xterm emits nothing useful
      // for this chord on its own, so translate it to the byte each shell's
      // line editor treats as backward-kill-word:
      //   • bash (readline): ESC+DEL (M-DEL) → backward-kill-word, which stops
      //     at punctuation (nicer than Ctrl+W's whitespace-only unix-word-rubout).
      //   • PowerShell (PSReadLine) + Claude Code: Ctrl+W (0x17) → BackwardKillWord.
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Backspace') {
        window.vivarium.writeSession(session.id, session.type === 'container-shell' ? '\x1b\x7f' : '\x17')
        return false
      }
      // force copy / paste
      if (e.ctrlKey && e.shiftKey && k === 'c') {
        doCopy()
        return false
      }
      if ((e.ctrlKey && e.shiftKey && k === 'v') || (e.shiftKey && e.key === 'Insert')) {
        // preventDefault, or the browser's own paste action still fires a native
        // `paste` event on xterm's hidden textarea, which xterm forwards to the
        // pty as a second copy (same trap as Shift+Enter above). Chromium treats
        // Ctrl+Shift+V ("paste as plain text") and Shift+Insert as paste too.
        e.preventDefault()
        void doPaste()
        return false
      }
      if (e.ctrlKey && e.key === 'Insert') {
        doCopy()
        return false
      }
      // Ctrl+C: copy a selection, else fall through so ^C reaches the pty (SIGINT)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'c') {
        if (term.hasSelection()) {
          doCopy()
          return false
        }
        return true
      }
      // Ctrl+V: paste (preventDefault — see the Ctrl+Shift+V branch above)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'v') {
        e.preventDefault()
        void doPaste()
        return false
      }
      return true
    })

    // right-click: show a context menu
    const el = term.element
    const onContext = (ev: MouseEvent): void => {
      ev.preventDefault()
      const z = useStore.getState()
      z.openContextMenu(
        ev.clientX,
        ev.clientY,
        [
          {
            label: 'Copy',
            icon: <Copy size={14} />,
            hint: 'Ctrl+C',
            disabled: !term.hasSelection(),
            onSelect: () => doCopy()
          },
          { label: 'Paste', icon: <Paste size={14} />, hint: 'Ctrl+V', onSelect: () => void doPaste() },
          { label: 'Select all', icon: <SelectAll size={14} />, onSelect: () => term.selectAll() },
          { label: '---' },
          // The plain lens of the magnifier family the zoom items use below.
          { label: 'Find…', icon: <Search size={14} />, hint: 'Ctrl+F', onSelect: () => openFind() },
          { label: '---' },
          { label: 'Zoom in', icon: <ZoomIn size={14} />, hint: 'Ctrl++', onSelect: () => z.zoomTerminal(1) },
          { label: 'Zoom out', icon: <ZoomOut size={14} />, hint: 'Ctrl+-', onSelect: () => z.zoomTerminal(-1) },
          // a circular arrow rather than a third magnifier: "back to the default"
          // is the action, and a magnifier with nothing in it now means Find
          {
            label: 'Reset zoom',
            icon: <Refresh size={14} />,
            hint: 'Ctrl+0',
            onSelect: () => z.resetTerminalZoom()
          }
          // No "Clear" here: xterm's clear() drops the entire 50k-line
          // scrollback, which made it the only irreversible action in a menu of
          // harmless ones — one row below Paste, with no confirmation. The
          // shell's own `clear`/`cls` is still right there for anyone who wants
          // a clean screen.
        ],
        // restore focus to this terminal when the menu closes (item / Escape),
        // so pasting or any action leaves the user able to type immediately
        () => term.focus()
      )
    }
    el?.addEventListener('contextmenu', onContext)

    // Ctrl + mouse wheel zooms the terminal
    const onWheel = (ev: WheelEvent): void => {
      if (!ev.ctrlKey) return
      ev.preventDefault()
      useStore.getState().zoomTerminal(ev.deltaY < 0 ? 1 : -1)
    }
    el?.addEventListener('wheel', onWheel, { passive: false })

    // --- who owns the wheel ------------------------------------------------
    // The moment an application turns on mouse tracking (`CSI ?1000h` and friends)
    // xterm stops scrolling its viewport and forwards wheel notches to that
    // application as button reports — decided *before* any custom wheel handler, so
    // the only way in is a capture listener above it. Claude Code ships
    // `?1000h`/`?1006h`, which is why an agent terminal can suddenly refuse to
    // scroll back however much scrollback it has.
    //
    // So in the NORMAL buffer the wheel is the user's, tracking or not: a wheel over
    // a log of output means scroll the log, and an app that only wanted clicks loses
    // nothing. In the ALTERNATE buffer (vim, less, htop) it stays the application's —
    // there is no scrollback to reach there and those apps really do use it.
    const onWheelCapture = (ev: WheelEvent): void => {
      if (ev.ctrlKey) return // zoom, handled above
      // A wasted notch is how the user discovers a stale scrollbar, so this is
      // the place to notice it. Having just repaired the geometry we also scroll
      // this notch ourselves: the repair snaps the viewport back to the buffer
      // position, and the browser would coalesce that with the user's own scroll
      // into one event which xterm then ignores — losing the notch that found
      // the bug.
      const repaired = repairIfStuck(term)
      if (!repaired) {
        if (term.modes.mouseTrackingMode === 'none') return // xterm scrolls it fine
        if (term.buffer.active.type === 'alternate') return // the app's wheel
      }
      ev.preventDefault()
      ev.stopPropagation() // keep it away from xterm's mouse reporting
      term.scrollLines(wheelLines(term, ev))
    }
    hostRef.current?.addEventListener('wheel', onWheelCapture, {
      capture: true,
      passive: false
    })

    // --- open the pty ------------------------------------------------------
    // This never starts the container: main refuses to (see ipc.ts openSession),
    // the user starts it explicitly and TerminalHost mounts this view once it is
    // up. Container build/create output still streams in through onContainerOutput
    // above, so a cold start is visible here.
    //
    // It retries because mounting is what opens a pty, and a container coming up
    // mounts *every* one of its sessions at once. Main re-checks `docker inspect`
    // per open and isRunning() reads any non-zero exit as "stopped", so under that
    // burst one open can be told the container is stopped when it plainly isn't —
    // and a single attempt left that terminal dark for good, since nothing remounts
    // it while the store still says running.
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const openPty = async (attempt: number): Promise<void> => {
      const res = await window.vivarium.openSession(project.id, session.id, term.cols, term.rows)
      if (cancelled) return
      if (res.ok) {
        setLive(session.id, true)
        return
      }
      const transient = res.reason === 'container-stopped' || res.reason === 'spawn-failed'
      const stillUp = !!useStore.getState().states[project.id]?.running
      if (transient && stillUp && attempt < 3) {
        retry = setTimeout(() => void openPty(attempt + 1), 700 * 2 ** (attempt - 1))
        return
      }
      // Out of attempts: `live` may still be true from the pty this view replaced
      // (a cross-project move kills that one silently), so clear it — otherwise
      // TerminalHost keeps a dead terminal mounted on the strength of it.
      setLive(session.id, false)
      if (res.reason === 'docker-missing') {
        term.write('\r\n\x1b[31mdocker not found on PATH — start Docker/Rancher Desktop.\x1b[0m\r\n')
      } else if (res.reason === 'claude-missing') {
        // A host project's agent is the Windows install, not the image's.
        term.write(
          `\r\n\x1b[31mClaude Code for Windows not found — ${res.message ?? 'no claude on PATH'}.\x1b[0m` +
            '\r\n\x1b[2mInstall it, then restart Vivarium so it sees the new PATH.\x1b[0m\r\n'
        )
      } else if (res.reason === 'container-stopped') {
        // The TerminalHost placeholder normally covers this; a state race can
        // still land here.
        term.write('\r\n\x1b[2mcontainer is stopped — start it to open this session.\x1b[0m\r\n')
      } else {
        term.write('\r\n\x1b[31mfailed to open session.\x1b[0m\r\n')
      }
    }
    void openPty(1)

    // debounced resize on element/window size changes (~100ms) — the TUI
    // corrupts without this (plan: Resize papercut).
    let t: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(fitNow, 100)
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(hostRef.current!)
    window.addEventListener('resize', doFit)

    // Coming back from minimized/occluded: the frames xterm's scrollbar sync
    // waits for have not been running (see forceScrollAreaSync), so put the
    // geometry right the moment the window is on screen again rather than
    // leaving the user to find dead scrollback and reach for the zoom.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      fitNow()
      forceScrollAreaSync(term)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      dataSub.dispose()
      resultsSub.dispose()
      searchRef.current = null
      offData()
      offExit()
      offCO()
      el?.removeEventListener('contextmenu', onContext)
      el?.removeEventListener('wheel', onWheel)
      hostRef.current?.removeEventListener('wheel', onWheelCapture, { capture: true })
      ro.disconnect()
      window.removeEventListener('resize', doFit)
      document.removeEventListener('visibilitychange', onVisible)
      if (t) clearTimeout(t)
      term.dispose()
      // …and drop the debug handle with it. Without this, killing a session
      // leaves its *disposed* terminal — and the whole 50k-line scrollback the
      // buffer still holds — referenced from window for the lifetime of the app.
      // Guarded on identity rather than deleting blind: a session moved between
      // projects remounts under the same id (TerminalHost keys the view on
      // project:session), so if the replacement's effect has already registered
      // itself, this cleanup must not delete *its* entry.
      if (terms[session.id] === term) delete terms[session.id]
      termRef.current = null
    }
    // project.id is in here because a session can be moved to another project:
    // TerminalHost keys this view on the pair, so the change remounts and this
    // effect re-execs into the new container.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, project.id])

  // --- on becoming visible: refit + resize the pty + focus ---
  React.useEffect(() => {
    if (!visible) return
    const term = termRef.current
    if (!term) return
    // next frame so the div has non-zero size after visibility flips
    const raf = requestAnimationFrame(() => {
      fitNowRef.current()
      // fitNow syncs the geometry too, but it refuses a box with no usable size
      // and returns before it gets there — and the frame the user starts reading
      // a terminal on is the one frame its scrollbar has to be right. Repairing
      // separately costs nothing when nothing is wrong.
      repairIfStuck(term)
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, session.id])

  // --- run the search as the term / options change ---
  React.useEffect(() => {
    const search = searchRef.current
    if (!search || !find.open) return
    if (!find.term) {
      search.clearDecorations()
      setResults({ index: -1, count: 0 })
      return
    }
    // incremental keeps the current match while the term is being extended,
    // instead of hopping to the next one on every keystroke
    search.findNext(find.term, {
      ...searchOpts(theme),
      caseSensitive: find.caseSensitive,
      incremental: true
    })
    // `theme` is a dependency so a swap re-runs the search and repaints the
    // decorations — xterm has already drawn them in the old palette.
  }, [find.open, find.term, find.caseSensitive, theme])

  // --- repaint the canvas on a theme swap ---
  // The rest of the app gets this for free: a `var()` re-resolves and the
  // browser repaints. xterm does not — it holds a plain object of colours and
  // rebuilds its WebGL glyph atlas from it — so a swap has to be handed over by
  // hand, and until it is, the terminal keeps running the old palette inside a
  // window that has already changed around it. Assigning `options.theme`
  // invalidates the atlas and redraws every cell, including the scrollback.
  //
  // No fit: the palette does not touch cell metrics, so the row/column count is
  // unchanged and the pty must not be resized (every resize makes a TUI repaint).
  React.useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermTheme(theme)
  }, [theme])

  // --- apply terminal zoom (global font size) + refit ---
  const fontSize = useStore((s) => s.terminalFontSize)
  React.useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    // The new cell metrics are available synchronously on the line above — the
    // renderer has already resized its canvas to rows × the *new* cell height,
    // which overflows the container until the fit brings the row count back in
    // line. So fit immediately: this is the gap where a zoom left the terminal
    // drawing outside its box with the bottom rows clipped. (This used to be a
    // spray of five fits over 400ms on the theory that the metrics settled
    // asynchronously — they don't, and each of those fits resized the pty and
    // made the TUI repaint.)
    fitNowRef.current()
    // One more next frame, in case the font itself was still loading and the
    // first measurement was of a fallback face. fitNow is a no-op when nothing
    // changed, so this costs nothing when it wasn't needed.
    const raf = requestAnimationFrame(() => fitNowRef.current())
    return () => cancelAnimationFrame(raf)
  }, [fontSize, session.id])

  // Outer div carries the gutter padding + background; xterm opens into the
  // INNER (unpadded) div so the FitAddon measures the real content area and
  // never overflows into the padding (which overflow:hidden would then clip).
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: '10px 14px 12px 16px',
        overflow: 'hidden',
        background: 'var(--bg)',
        visibility: visible ? 'visible' : 'hidden'
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {find.open && (
        <FindBar
          state={find}
          results={results}
          inputRef={findInputRef}
          onTerm={(term) => setFind((f) => ({ ...f, term }))}
          onToggleCase={() => setFind((f) => ({ ...f, caseSensitive: !f.caseSensitive }))}
          onStep={stepFind}
          onClose={closeFind}
        />
      )}
    </div>
  )
}

/**
 * Floating find bar. Absolutely positioned on purpose: anything that took layout
 * space here would change the terminal's size, and every size change resizes the
 * pty and makes a TUI repaint (see fitNow). It sits clear of xterm's scrollbar,
 * which owns the last ~10px before the right gutter.
 */
function FindBar({
  state,
  results,
  inputRef,
  onTerm,
  onToggleCase,
  onStep,
  onClose
}: {
  state: { term: string; caseSensitive: boolean }
  results: { index: number; count: number }
  inputRef: React.RefObject<HTMLInputElement>
  onTerm: (term: string) => void
  onToggleCase: () => void
  onStep: (back: boolean) => void
  onClose: () => void
}): React.ReactElement {
  const empty = !state.term
  const none = !empty && results.count === 0
  // The addon reports index -1 once the highlight limit is passed — say "1000+"
  // rather than a position it can't actually track.
  const counter = empty
    ? ''
    : none
      ? 'no results'
      : results.index >= 0
        ? `${results.index + 1}/${results.count}`
        : `${results.count}+`

  return (
    <div
      // Wheel/context events here belong to the bar, not to the terminal
      // underneath it.
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 8,
        right: 26,
        zIndex: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 32,
        padding: '0 4px 0 8px',
        background: 'var(--panel)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius)',
        boxShadow: '0 12px 30px -14px var(--shadow)'
      }}
    >
      <span style={{ display: 'flex', color: 'var(--dim)', flex: 'none' }}>
        <Search size={13} />
      </span>
      <input
        ref={inputRef}
        value={state.term}
        autoFocus
        spellCheck={false}
        placeholder="Find in terminal"
        onChange={(e) => onTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
          // Ctrl+F while the bar is already up re-selects the term, as a
          // browser's find does, instead of doing nothing.
          if (e.ctrlKey && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            inputRef.current?.select()
          }
        }}
        style={{
          width: 158,
          height: 24,
          background: 'transparent',
          border: 0,
          color: 'var(--fg)',
          fontFamily: MONO,
          fontSize: 12.5,
          padding: 0,
          outline: 'none',
          // Opts out of the global focus ring: this input is focused for as long
          // as the bar exists, so a ring says nothing, and its bloom crowds a
          // 32px-tall bar. The buttons beside it still ring, so Tab stays
          // traceable.
          boxShadow: 'none'
        }}
      />
      <span
        style={{
          minWidth: 58,
          textAlign: 'right',
          fontSize: 11.5,
          fontFamily: MONO,
          color: none ? 'var(--danger)' : 'var(--dim)',
          flex: 'none'
        }}
      >
        {counter}
      </span>
      <FindBtn title="Match case" active={state.caseSensitive} onClick={onToggleCase}>
        <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '.3px' }}>Aa</span>
      </FindBtn>
      <FindBtn title="Previous match (Shift+Enter)" onClick={() => onStep(true)}>
        <Chevron size={13} style={{ transform: 'rotate(-90deg)' }} />
      </FindBtn>
      <FindBtn title="Next match (Enter)" onClick={() => onStep(false)}>
        <Chevron size={13} style={{ transform: 'rotate(90deg)' }} />
      </FindBtn>
      <FindBtn title="Close (Esc)" onClick={onClose}>
        <Close size={12} />
      </FindBtn>
    </div>
  )
}

function FindBtn({
  title,
  active,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // The bar lives inside the terminal, so a click here must not pull DOM
      // focus off the input the user is typing into.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        border: 0,
        background: active ? 'var(--sel)' : hover ? 'var(--card2)' : 'transparent',
        color: active ? 'var(--fg)' : hover ? 'var(--fg)' : 'var(--muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
