import React from 'react'
import type {
  ChatAnswer,
  ChatBlockingCard,
  ChatContextUsage,
  ChatEntry,
  ChatMode,
  ChatModelOption,
  ChatQuestion,
  ChatTodo,
  MountNode,
  Project,
  Session
} from '@shared/types'
import { modelName, modelOptionLabel } from '@shared/models'
import { useStore } from '../../state/store'
import { CHAT, CHAT_EDGE as EDGE, CHAT_TEXT as TYPE, MONO, ctxColor } from '../../theme'
import { formatElapsed } from '../Elapsed'
import {
  Check,
  Chevron,
  Close,
  Copy,
  PanelToggle,
  Refresh,
  Search,
  Undo,
  ZoomIn,
  ZoomOut
} from '../Icons'
import { LogRow, type LogHandlers } from './ChatLog'
import { FindContext, matcherFor, searchTextOf, type FindQuery } from './find'
import { Preview, clock as clockOf } from './Markdown'
import { chipForNode, flattenTree, routeFile, type PendingChip } from './attach'

// The chat window, built to `docs/redisign/Chat Terminal.html`: a 34px header of
// readings, a log that fills the window, and a composer that is a raised panel
// with a status line inside it.
//
// **The composer is no longer "only a box".** The earlier version had no send
// button and no `⏎ send` hint on the argument that every affordance already had a
// free home — Enter sends, Esc interrupts, Ctrl+V attaches. That argument is
// sound about *capability* and wrong about *discoverability*: none of it is on
// screen, so none of it is findable, and the mode and model you are about to send
// under were only readable by looking back up at the header. The footer row
// carries all of it — `plan · haiku-4` on the left, `⏎ send · ⇧⏎ newline` and a
// send button on the right — inside the box, which costs one line and no chrome
// anywhere else. Attaching stays gesture-only (Ctrl+V, drag-drop, `@`), and Esc
// is still taught on the live working row where it is the only thing that helps.

/**
 * How long a second Esc still counts as the pair that opens the revert picker.
 *
 * Generous rather than tight, because the two presses are not one gesture: the
 * first one *does something* (stops the turn) and you may well watch it land
 * before deciding to go further. Too short and the chord only works if you already
 * knew it was a chord. The cost of being generous is bounded in a way the usual
 * double-click trade-off is not — a stray second Esc opens a picker that Esc
 * closes again, and the picker changes nothing until a row is chosen.
 */
const DOUBLE_ESC_MS = 500

/**
 * How tall the composer may grow before it starts scrolling instead.
 *
 * It was a flat 180px, which is about six lines — and six lines is nothing for
 * the kind of message this box actually receives: a pasted stack trace, a spec
 * paragraph, a list of files. Past that the box stopped growing and you were
 * writing through a letterbox, unable to see the top of your own prompt.
 *
 * A *fraction of the window* rather than a bigger constant, because the
 * complaint scales with the monitor: 180px on a 2160px-tall window is a sliver,
 * and 600px on a short one would leave no log at all. Half the view keeps the
 * conversation on screen — the log is what you are writing *to* — and the floor
 * is the old ceiling, so this can only ever be an improvement on a small window.
 *
 * Divided back out by the zoom at the point of use: the composer lives inside a
 * zoomed column, so a height set here is multiplied by `zoom` on screen, and
 * without that division zooming in would eat the log.
 */
const COMPOSER_MAX_FRACTION = 0.5
const COMPOSER_MIN_MAX = 180

// There was a `columnMax(zoom)` here: the reading column's 880px `max-width`,
// divided back out below 1× because a `max-width` on a zoomed box is in *zoomed*
// pixels, so zooming out used to pull both edges of the page in from the window.
// The measure is gone (see CHAT_EDGE) and the whole problem goes with it — the
// log and the composer are plain auto-width blocks now, which fill their
// scroller at every factor exactly the way browser zoom behaves, and the only
// thing `zoom` still changes is the size of the type. All that is left to keep
// in step is the side padding, and both take it from EDGE.

export function ChatView({
  project,
  session,
  visible
}: {
  project: Project
  session: Session
  visible: boolean
}): React.ReactElement {
  const chat = useStore((s) => s.chats[session.id])
  const running = useStore((s) => !!s.states[project.id]?.running)
  const openChat = useStore((s) => s.openChat)
  const closeChat = useStore((s) => s.closeChat)
  const sendChat = useStore((s) => s.sendChat)
  const interruptChat = useStore((s) => s.interruptChat)
  const rewindChat = useStore((s) => s.rewindChat)
  const answerChat = useStore((s) => s.answerChat)
  const setChatMode = useStore((s) => s.setChatMode)
  const setChatModel = useStore((s) => s.setChatModel)
  const loadEarlier = useStore((s) => s.loadEarlier)
  const loadBody = useStore((s) => s.loadBody)
  const loadSubagent = useStore((s) => s.loadSubagent)
  const loadImage = useStore((s) => s.loadImage)
  const takePendingFind = useStore((s) => s.takePendingFind)

  // Draft and pending chips live here, not in the store: they are meant to die
  // with the view. A cross-project move remounts this component (TerminalHost
  // keys on project:session), and buying a half-written message the right to
  // outlive a deliberate destructive act is not worth state that has to survive a
  // remount. The confirm dialog says so.
  const [draft, setDraft] = React.useState('')
  const [chips, setChips] = React.useState<PendingChip[]>([])
  const [tree, setTree] = React.useState<MountNode[]>([])
  const [focus, setFocus] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [menu, setMenu] = React.useState<null | { kind: 'slash' | 'at'; query: string }>(null)
  /**
   * Which typeahead row is highlighted, or `null` for "none yet".
   *
   * **`/` opens with row 0 already highlighted; `@` still opens with none.**
   * The two are not the same kind of menu. A `/` is only a menu at all when it
   * is the composer's first character, so the list is unambiguously what you
   * are doing and a list nobody has pointed at yet reads as inert. An `@`, by
   * contrast, occurs in ordinary prose — `mail me at foo@bar.com` opens the
   * file list against `bar.com` — so a default highlight there would put a
   * completion under Enter in the middle of a sentence.
   *
   * What the old null bought for `/` (Enter still meaning "send `/clear`
   * rather than complete it") is kept by the exact-match rule in `onKeyDown`,
   * which is the sharper statement of it: Enter completes, unless there is
   * nothing left to complete.
   */
  const [pick, setPick] = React.useState<number | null>(null)
  const [models, setModels] = React.useState<ChatModelOption[] | null>(null)
  const [modelMenu, setModelMenu] = React.useState(false)
  /**
   * The revert picker: open, mid-flight, or holding a refusal to show. Local like
   * the draft, and for the same reason — nothing in it is worth surviving a
   * remount, and a stale one would offer messages that are no longer on screen.
   */
  const [rewind, setRewind] = React.useState<null | { busy: boolean; error?: string }>(null)
  /**
   * The find bar: closed, or open with a term and a position in the hit list.
   *
   * Local like the draft and the revert picker — a search is about the reading
   * you are doing right now, and carrying it across a remount would restore a
   * highlight over a conversation you have since left.
   */
  const [find, setFind] = React.useState<null | (FindQuery & { at: number })>(null)
  /** The turn outline rail, open or not. */
  const [outline, setOutline] = React.useState(false)

  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const findInputRef = React.useRef<HTMLInputElement>(null)
  /** the view root — what the composer's height ceiling is measured against */
  const rootRef = React.useRef<HTMLDivElement>(null)
  const logRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  /**
   * `pinned`, mirrored into state so the jump control can render off it.
   *
   * The ref stays the authority: it is read inside a ResizeObserver and a scroll
   * handler, neither of which may wait for a render. This is written **only on a
   * transition** — a scroll event lands on every wheel notch and on every row a
   * streaming turn grows, and a setState per event would repaint the whole log,
   * which is the exact cost `LogRow`'s memo exists to avoid.
   */
  const [atTail, setAtTail] = React.useState(true)
  /** when the last Esc landed, for the pair that opens the revert picker */
  const escAt = React.useRef(0)
  const zoom = useStore((s) => s.chatZoom)

  // Eager open, at container start, alongside terminal sessions — a session is
  // live whenever it can be, not when it was last clicked. The first message is
  // then answered with no cold-start wait.
  React.useEffect(() => {
    if (!running) return
    void openChat(project.id, session.id)
    return () => closeChat(session.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, project.id, session.id])

  // Retried while the store still says the container is running: a project's
  // sessions all open at once and that burst is exactly what makes `docker
  // inspect` answer non-zero, which isRunning() reads as "container stopped".
  React.useEffect(() => {
    if (!running || !chat) return
    if (chat.open || chat.opening) return
    if (chat.reason !== 'container-stopped' && chat.reason !== 'spawn-failed') return
    const t = setTimeout(() => void openChat(project.id, session.id, true), 900)
    return () => clearTimeout(t)
  }, [running, chat, openChat, project.id, session.id])

  React.useEffect(() => {
    void window.vivarium.chatMountTree(project.id).then(setTree)
  }, [project.id])

  // Follow the tail unless the user has scrolled up to read something.
  //
  // A ResizeObserver on the content, not an effect on `entries.length`: a turn
  // streaming its answer *grows the last row* rather than adding one, so the
  // length never changed, the effect never ran, and the sentence being written
  // slid off the bottom of a log that was supposed to be following it. Height
  // is what actually moves, so height is what to watch — and watching it covers
  // the other three cases for free (a tool card expanded, a settle replacing a
  // turn with taller rows, the composer growing under the log).
  React.useEffect(() => {
    const el = logRef.current
    const content = contentRef.current
    if (!el || !content) return
    const stick = (): void => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(stick)
    ro.observe(content)
    // The scroller too, not only its content: a composer growing to three lines
    // takes height *away* from the log without changing anything inside it, and
    // the tail would slide out from under the box you are typing in.
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Put the newest row on screen and re-arm the tail pin.
   *
   * The one gesture that is not a guess about what the reader wants: you just
   * sent a message, so you are looking at the bottom.
   */
  const stickToBottom = React.useCallback((): void => {
    pinned.current = true
    // Set here as well as from the scroll handler: assigning `scrollTop` to a
    // value it already holds fires no scroll event, so a re-arm that does not
    // move the log would otherwise leave the control on screen saying there is
    // something below when there is not.
    setAtTail(true)
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Becoming visible is not a resize (the view is hidden with `visibility`, so
  // it keeps its layout the whole time), and a chat that was at the bottom when
  // you left it should be at the bottom when you come back.
  React.useEffect(() => {
    const el = logRef.current
    if (visible && el && pinned.current) el.scrollTop = el.scrollHeight
  }, [visible])

  /**
   * A term handed over by the conversation search, consumed on arrival.
   *
   * The dialog answers "which conversation", this answers "where in it" — so
   * picking a result selects the session and the find bar is already on the term
   * when it appears, rather than making you type it a second time.
   *
   * Gated on `visible` because every chat that has been opened stays mounted
   * (see TerminalHost): without it the first mounted view would swallow a term
   * meant for a different session. `takePendingFind` checks the id as well, so
   * the two guards agree.
   */
  React.useEffect(() => {
    if (!visible) return
    const term = takePendingFind(session.id)
    if (term === null) return
    setFind({ term, caseSensitive: false, at: 0 })
  }, [visible, session.id, takePendingFind])

  // Ctrl + wheel zooms, the terminal's convention. A native listener because it
  // has to be non-passive: React registers wheel at the root as passive, where
  // preventDefault is ignored and the page zooms *and* scrolls.
  React.useEffect(() => {
    const el = logRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      useStore.getState().zoomChat(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // The composer grows with the draft to a ceiling, then scrolls. A textarea
  // cannot do this itself — `rows` is a fixed count and `height:auto` measures to
  // one line — so the height is set from scrollHeight, and reset to `auto` first
  // or it can only ever grow. Layout effect, not effect: measuring after paint
  // shows one frame of the wrong height on every keystroke.
  //
  // The ceiling is measured rather than constant (see COMPOSER_MAX_FRACTION), so
  // it is also re-applied on a window resize — a draft written on a maximised
  // window and then restored down would otherwise keep a height the window no
  // longer has room for.
  const fitComposer = React.useCallback((): void => {
    const el = inputRef.current
    if (!el) return
    const view = rootRef.current?.clientHeight ?? 0
    const cap = Math.max(COMPOSER_MIN_MAX, Math.round((view * COMPOSER_MAX_FRACTION) / zoom))
    el.style.maxHeight = `${cap}px`
    el.style.height = 'auto'
    el.style.height = `${Math.min(cap, Math.max(26, el.scrollHeight))}px`
  }, [zoom])

  React.useLayoutEffect(fitComposer, [fitComposer, draft, visible])

  React.useEffect(() => {
    window.addEventListener('resize', fitComposer)
    return () => window.removeEventListener('resize', fitComposer)
  }, [fitComposer])

  /**
   * Stable while the log is: `?? []` mints a fresh array on every render of a
   * chat that has not opened yet, and half a dozen `useMemo`s downstream take
   * this as a dependency — the row order, the revert targets, the outline, the
   * turn clocks and the find hit list, which walks every row's searchable text.
   * Unmemoised, all of them recompute on every keystroke in the composer.
   */
  const entries = React.useMemo(() => chat?.entries ?? [], [chat?.entries])
  const blocking = chat?.blocking ?? null
  const todos = chat?.todos ?? []
  const mode: ChatMode = chat?.mode ?? session.mode ?? 'bypassPermissions'
  const working = isWorking(entries)
  const canSend = draft.trim().length > 0 || chips.some((c) => c.ok)

  // The row the turn is writing into right now — the only one revealed at a
  // steady rate rather than painted the instant its bytes arrive (see
  // REVEAL_CATCHUP in ChatLog). Everything else, including the paragraphs above
  // it in the same turn, is finished text and paints whole.
  //
  // **Scoped to the running turn, and that is the whole point.** A turn is
  // `working` from the moment the message is sent, which is seconds before the
  // model writes its first word — so "the last claude row in the log" is the
  // *previous* answer for that whole window. Flagging it re-opened it to the
  // reveal, which restarted from wherever the reveal had been frozen at the end
  // of its own turn: the finished paragraph vanished and typed itself out again
  // every time you sent a follow-up. Matching on the turn means a turn that has
  // not produced a word yet has no streaming row at all, which is the truth.
  const streamingId = React.useMemo(() => {
    if (!working) return null
    // The clock row is appended at send, so it exists before any prose does and
    // carries the running turn's number. Found by scanning rather than by taking
    // the last one: a settle for the *previous* turn re-appends that turn's rows
    // (clock included) at the end of the list, and it can land after this one.
    let turn: number | null = null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'turn' && e.durationMs === undefined) {
        turn = e.turn
        break
      }
    }
    if (turn === null) return null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'text' && e.role === 'claude' && e.turn === turn) return e.id
    }
    return null
  }, [working, entries])

  /**
   * The rows in the order they are drawn: everything else, then the clock of
   * whichever turn is still running.
   *
   * The clock row is appended the moment you press send, which is *before* the
   * answer exists — so in list order it lands directly under your message and
   * the entire turn then grows underneath the row reporting on it. `working ·
   * 4s` is a reading about right now, and right now is the bottom of the log,
   * where the tail is and where the eye already is.
   *
   * Only the *running* clock moves, and the test is `durationMs` rather than
   * position: a frozen clock is a fact about a turn that finished, so it stays
   * in its place in time — at the end of the turn it timed, which is where main
   * puts it (see `settleTurn`) and where every clock in reloaded history already
   * is.
   */
  const rows = React.useMemo(() => {
    const running = (e: ChatEntry): boolean => e.kind === 'turn' && e.durationMs === undefined
    if (!entries.some(running)) return entries
    return [...entries.filter((e) => !running(e)), ...entries.filter(running)]
  }, [entries])

  /**
   * Follow the tail when a **row is added**, synchronously with the commit that
   * added it.
   *
   * The ResizeObserver above is still the general mechanism and still earns its
   * place — it is the only thing that catches growth which adds no row, which is
   * every frame of a streaming answer. What it is not is *guaranteed*: it
   * delivers on its own schedule, after layout, and a send whose row lands in a
   * frame where the observation does not fire leaves the message you just typed
   * below the fold. That was reported and I could not reproduce it in a real
   * engine — the observer fires in every layout I could build, wrapper rows,
   * zoom and all — so rather than keep guessing at the trigger this stops the
   * question mattering: a new row is scrolled to as part of the same commit,
   * with nothing to be delivered late.
   *
   * `useLayoutEffect`, not `useEffect`: it runs after the DOM is written and
   * before paint, so reading `scrollHeight` here forces a fresh layout and the
   * jump is never one frame behind.
   *
   * Guarded by `pinned` exactly as the observer is, so none of this yanks a
   * reader who has scrolled up.
   */
  const lastRowId = rows.length > 0 ? rows[rows.length - 1].id : null
  React.useLayoutEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lastRowId, rows.length])

  /**
   * The messages a revert can be aimed at, newest first.
   *
   * Derived from the log rather than fetched, which is also the honest boundary:
   * the picker reaches exactly as far back as the conversation is loaded, and
   * `load earlier` widens it.
   *
   * Two filters carry weight. `id.includes('#')` keeps only *settled* rows — a
   * message main painted optimistically is `you:<turn>` and carries no transcript
   * uuid, so there is nothing to aim the CLI at yet. And the rows are deduped by
   * uuid because one send can produce several text blocks (an attachment forces a
   * block array, a split-send writes two lines): they are one message and must
   * read as one row, or reverting "the last message" would offer half of it.
   */
  const revertTargets = React.useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; uuid: string; at: number; text: string }[] = []
    for (const e of entries) {
      if (e.role !== 'you' || e.kind !== 'text' || !e.id.includes('#')) continue
      const uuid = e.id.slice(0, e.id.indexOf('#'))
      if (seen.has(uuid)) continue
      seen.add(uuid)
      out.push({ id: e.id, uuid, at: e.at, text: e.md })
    }
    return out.reverse()
  }, [entries])

  /**
   * The conversation's turns, oldest first — what the outline rail lists.
   *
   * Built off the same two filters `revertTargets` argues for (settled rows
   * only, deduped by transcript uuid, because one send can write several text
   * blocks) but *not* derived from it: an outline is a reading aid and wants
   * every turn including the one still running, where a revert target has to be
   * something the CLI can actually be aimed at. The optimistic `you:<turn>` row
   * of a live turn belongs in the first list and not the second.
   */
  const outlineTurns = React.useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; at: number; text: string; turn: number }[] = []
    for (const e of entries) {
      if (e.role !== 'you' || e.kind !== 'text') continue
      const key = e.id.includes('#') ? e.id.slice(0, e.id.indexOf('#')) : e.id
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: e.id, at: e.at, text: e.md, turn: e.turn })
    }
    return out
  }, [entries])

  /** What each turn's clock settled on, so the rail can report it. */
  const turnClocks = React.useMemo(() => {
    const byTurn = new Map<number, { durationMs?: number; tokens?: number }>()
    for (const e of entries) {
      if (e.kind !== 'turn') continue
      byTurn.set(e.turn, { durationMs: e.durationMs, tokens: e.tokens?.output })
    }
    return byTurn
  }, [entries])

  const matcher = React.useMemo(() => (find ? matcherFor(find) : null), [find])

  /**
   * The ids of the rows the term appears in, in log order.
   *
   * Computed over `entries` rather than `rows` on purpose: `rows` hoists a
   * *running* turn clock to the bottom, and a clock has no text to match, so the
   * two orders only ever differ by a row that can never be a hit.
   */
  const hits = React.useMemo(() => {
    if (!matcher) return []
    return entries.filter((e) => matcher.test(searchTextOf(e))).map((e) => e.id)
  }, [entries, matcher])

  // The position is clamped rather than reset: typing another character usually
  // narrows the same hit list, and jumping back to the first match on every
  // keystroke is what makes a find bar feel like it is fighting you.
  const at = hits.length === 0 ? 0 : Math.min(find?.at ?? 0, hits.length - 1)
  const activeHit = hits[at] ?? null

  const stepFind = React.useCallback(
    (back: boolean) => {
      setFind((f) => {
        if (!f || hits.length === 0) return f
        const next = (at + (back ? -1 : 1) + hits.length) % hits.length
        return { ...f, at: next }
      })
    },
    [at, hits.length]
  )

  const openFind = React.useCallback(() => {
    // Reopening keeps the term, as a browser's find does — and selects it, so
    // the next keystroke replaces it and Enter alone steps through what is
    // already there.
    setFind((f) => f ?? { term: '', caseSensitive: false, at: 0 })
    // After the bar exists: the input mounts on this render.
    requestAnimationFrame(() => findInputRef.current?.select())
  }, [])

  const closeFind = React.useCallback(() => {
    setFind(null)
    inputRef.current?.focus()
  }, [])

  /**
   * Ctrl+F / Ctrl+Shift+F opens the find bar, the terminal's chord exactly.
   *
   * On the view root in the **capture** phase, and scoped to the visible chat.
   * Capture, because the composer is a textarea that would otherwise see the key
   * first and Chromium would open its own find; scoped, because every chat that
   * has ever been opened stays mounted behind this one (see TerminalHost), and a
   * bubbling handler on all of them would open several bars at once.
   */
  React.useEffect(() => {
    if (!visible) return
    const el = rootRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      e.stopPropagation()
      openFind()
    }
    el.addEventListener('keydown', onKey, true)
    return () => el.removeEventListener('keydown', onKey, true)
  }, [visible, openFind])

  /**
   * Bring the current hit into view.
   *
   * `block: 'center'` rather than `nearest`: a match at the very bottom of the
   * scroller is legible but gives no context, and the row above it is usually
   * what says which conversation you are in.
   *
   * It also drops the tail pin. Scrolling away to read a hit is exactly the
   * gesture `pinned` exists to respect, and leaving it set means the next
   * streamed token yanks you back to the bottom mid-read.
   */
  React.useEffect(() => {
    if (!activeHit) return
    const el = logRef.current?.querySelector(`[data-row="${CSS.escape(activeHit)}"]`)
    if (!el) return
    pinned.current = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeHit])

  const revert = async (entryId: string): Promise<void> => {
    setRewind({ busy: true })
    const r = await rewindChat(session.id, entryId)
    if (!r.ok) {
      setRewind({ busy: false, error: r.message ?? 'the conversation could not be reverted' })
      return
    }
    // Only into an empty box. The rule that Esc must never destroy a half-written
    // prompt is not about Esc — it is about that text being the one unrecoverable
    // thing in this window — and a revert reached *by pressing Esc twice* is
    // exactly where it would otherwise get eaten.
    if (r.prefill) setDraft((d) => (d.trim() ? d : r.prefill ?? ''))
    // A revert that came back with a message still worked, it just did not get all
    // the way: the CLI pops one message per call, so a refusal partway leaves the
    // newest few off and the rest on. The log is re-derived either way and is
    // telling the truth, but closing the picker on that would leave the user
    // believing their pick landed — so it stays up, says what stopped it, and the
    // list under it is already the new one.
    if (r.message) {
      setRewind({ busy: false, error: `reverted ${r.removed} — ${r.message}` })
      return
    }
    setRewind(null)
    pinned.current = true
    inputRef.current?.focus()
  }

  // Memoised because `LogRow` is memoised: a new handlers object every render
  // would defeat it, and defeating it is what made a streaming turn re-render
  // every row in the log for every token that arrived.
  const handlers: LogHandlers = React.useMemo(
    () => ({
      onExpand: (id: string) => void loadBody(session.id, id),
      onExpandTask: (toolUseId: string, agentId: string | null) =>
        void loadSubagent(session.id, toolUseId, agentId),
      bodies: chat?.bodies ?? {},
      images: chat?.images ?? {},
      onImage: (imageId: string) => void loadImage(session.id, imageId),
      subagents: chat?.subagents ?? {},
      onRetry: () => void openChat(project.id, session.id, true)
    }),
    [
      chat?.bodies,
      chat?.images,
      chat?.subagents,
      loadBody,
      loadImage,
      loadSubagent,
      openChat,
      project.id,
      session.id
    ]
  )

  /**
   * The typeahead's rows, computed here rather than inside the component that
   * draws them: the keyboard has to move a selection through the same list the
   * mouse clicks, and two copies of the filter would disagree the moment either
   * one grew a rule.
   */
  const menuRows = React.useMemo(
    () => (menu ? typeaheadRows(menu, chat?.commands ?? [], tree) : []),
    [menu, chat?.commands, tree]
  )

  /**
   * Does Enter send rather than complete?
   *
   * True exactly when the highlighted `/` row is already what is in the box, to
   * the letter. One computation, read by the key handler *and* by the menu's
   * footer, so what the hint promises and what the key does cannot drift — and
   * the footer changing to `⏎ send` on the last character of `/clear` is what
   * teaches the exception at the one moment it is ambiguous.
   */
  const enterSends = React.useMemo(() => {
    if (menu?.kind !== 'slash' || pick === null) return false
    return menuRows[pick]?.name.toLowerCase() === draft.trim().toLowerCase()
  }, [menu?.kind, pick, menuRows, draft])

  // A new query is a new list, so the highlight starts over — at the top for
  // `/` and nowhere for `@`. Without this, a narrowing filter leaves you
  // pointing at whatever now sits at that index, which after two more
  // characters is a different command with the same row number.
  React.useEffect(() => {
    setPick(menu?.kind === 'slash' ? 0 : null)
  }, [menu?.kind, menu?.query])

  /**
   * Opening the command menu is the moment to go and look at the disk again.
   *
   * Claude Code only tells us what `/` can expand in a `system/init`, and it only
   * emits one at the first turn of a process — so a chat opened before you wrote
   * a skill offers a list that predates it, even though the CLI itself would run
   * it (see ChatService.refreshCommands, which is also where the throttle lives).
   * Keyed on the *kind* and not the query, so this is once per open rather than
   * once per keystroke, and no state here waits on it: the answer lands as a
   * `meta` event and the rows below re-derive.
   */
  React.useEffect(() => {
    if (menu?.kind !== 'slash') return
    window.vivarium.chatRefreshCommands(session.id)
  }, [menu?.kind, session.id])

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const next: PendingChip[] = []
    for (const f of Array.from(files)) {
      // Electron 31 still puts the real path on the File; past 32 this becomes
      // webUtils.getPathForFile in the preload.
      const hostPath = (f as File & { path?: string }).path
      next.push(await routeFile(f, hostPath, tree))
    }
    setChips((c) => [...c, ...next])
  }

  const send = (): void => {
    const text = draft.trim()
    // A refusal cannot be sent — it is the same chip in a failed state, carrying
    // its reason, attached to the thing that caused it rather than to a toast
    // that disappears while you are reading it.
    const ready = chips.flatMap((c) => (c.ok ? [c.attachment] : []))
    if (!text && ready.length === 0) return
    const sentDraft = draft
    const sentChips = chips
    setDraft('')
    setChips([])
    setMenu(null)
    // Jump now *and* re-arm the pin: the row for this message arrives an IPC
    // round trip later, so this scrolls the composer's own reflow into place and
    // the layout effect above catches the row when it lands.
    stickToBottom()
    void sendChat(session.id, text, ready).then((ok) => {
      // The process was gone — nothing was written and no row will ever appear
      // for it. Clearing the box optimistically is right (the send all but always
      // works, and a box that empties on Enter is the whole feel of a composer),
      // but *keeping* it cleared here would silently eat the message.
      if (ok) return
      setDraft((d) => (d ? d : sentDraft))
      setChips((c) => (c.length ? c : sentChips))
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu && menuRows.length > 0) {
      const move = (d: number): void => {
        e.preventDefault()
        setPick((p) =>
          p === null ? (d > 0 ? 0 : menuRows.length - 1) : (p + d + menuRows.length) % menuRows.length
        )
      }
      if (e.key === 'ArrowDown') return move(1)
      if (e.key === 'ArrowUp') return move(-1)
      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) return move(-1)
        // One press takes the highlighted row. The old two-press dance (first
        // press highlights, second takes) only existed because `/` opened with
        // nothing highlighted, and it still applies to `@`, which does.
        if (pick === null) return setPick(0)
        const row = menuRows[pick]
        if (row) return acceptRow(row)
        return
      }
      // Enter completes the highlighted row, except where `enterSends` says
      // there is nothing left to complete.
      if (e.key === 'Enter' && !e.shiftKey && pick !== null && !enterSends) {
        // A `meta` event can re-derive the rows under a keystroke (the disk
        // scan that opening the menu kicks off lands whenever it lands), so the
        // index is checked against the list rather than trusted.
        const row = menuRows[pick]
        if (row) {
          e.preventDefault()
          return acceptRow(row)
        }
      }
      if (e.key === 'Escape') {
        // preventDefault, so the window-level Esc does not read a dismissed
        // menu as "interrupt the turn".
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const acceptRow = (row: TypeaheadRow): void => {
    if (row.node) pickNode(row.node)
    else pickCommand(row.name)
  }

  // Esc keeps the single meaning it has everywhere else in the app: stop this
  // turn. With nothing running it is a no-op, and it must never clear the draft —
  // a stray Esc destroying a half-written prompt is the only genuinely
  // unrecoverable outcome in this area.
  //
  // It listens on the **window**, not on the chat container, and that is the fix
  // rather than a preference: React delivers keydown by bubbling from the focused
  // element, and this view spends most of its life with focus on `document.body`
  // — every click on the log, on a tool card's body, on the scrollbar, and the
  // whole time after a send lands and blurs nothing. Those events never enter the
  // container's subtree at all, so the handler that lived there fired only while
  // the caret was in the composer, which reads as "esc does nothing".
  //
  // Guarded twice over: only the visible view (one chat is mounted per opened
  // session, all but one hidden), and never while a dialog or a context menu is
  // up, where Esc means dismiss and the owner of that surface handles it.
  //
  // The zoom chords ride along on the same listener, for the same reason: the
  // composer is the only focused element most of the time, and a chord bound to
  // the container would be dead everywhere else in the window.
  //
  // **Esc Esc opens the revert picker, and the first Esc keeps its meaning.** That
  // ordering is not a compromise, it is the requirement: the pair is typed while a
  // turn is running as often as not, so a first press that waited to find out
  // whether a second was coming would make "stop" feel broken for half a second
  // exactly when it matters. So the first press interrupts, always, and the second
  // opens the picker on top of a turn that is already stopping — which is what the
  // CLI does too. `defaultPrevented` above then does the rest for free: the
  // composer's typeahead Escape preventDefaults, so dismissing a menu neither
  // interrupts nor counts toward the pair.
  React.useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const s = useStore.getState()
      if (s.dialog || s.contextMenu) return
      // Ctrl +/-/0 — the chords TerminalView already binds. The two panes of
      // this app must not disagree about how you make the text bigger.
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          return s.zoomChat(1)
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          return s.zoomChat(-1)
        }
        if (e.key === '0') {
          e.preventDefault()
          return s.resetChatZoom()
        }
      }
      if (e.key !== 'Escape') return
      // The picker owns Esc while it is up — dismiss, and never also interrupt or
      // re-arm the pair. It is a chat-local overlay rather than a store dialog, so
      // the `s.dialog` guard above cannot do this for it.
      if (rewind) {
        escAt.current = 0
        setRewind(null)
        return
      }
      const now = Date.now()
      const again = now - escAt.current < DOUBLE_ESC_MS
      // Zeroed on the second press rather than re-stamped, or a third Esc would
      // pair with the second and re-open what it just closed.
      escAt.current = again ? 0 : now
      if (again) {
        setRewind({ busy: false })
        return
      }
      void interruptChat(session.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, interruptChat, session.id, rewind])

  const onDraft = (v: string, caret: number): void => {
    setDraft(v)
    // `/` opens only when it is the composer's first character — the sole
    // position the CLI expands one — so the menu can never offer a completion
    // that would be sent as prose.
    if (v.startsWith('/') && caret <= v.length && !v.slice(0, caret).includes(' ')) {
      setMenu({ kind: 'slash', query: v.slice(1, caret) })
      return
    }
    const before = v.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at >= 0 && !/\s/.test(before.slice(at + 1))) {
      setMenu({ kind: 'at', query: before.slice(at + 1) })
      return
    }
    setMenu(null)
  }

  const pickCommand = (name: string): void => {
    setDraft(`${name} `)
    setMenu(null)
    setPick(null)
    inputRef.current?.focus()
  }

  const pickNode = (node: MountNode): void => {
    setChips((c) => [...c, chipForNode(node)])
    // The `@` token itself is dropped — you picked from the tree and never have
    // to see either kind of path.
    const caret = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, caret)
    const at = before.lastIndexOf('@')
    setDraft(at >= 0 ? before.slice(0, at) + draft.slice(caret) : draft)
    setMenu(null)
    setPick(null)
    inputRef.current?.focus()
  }

  /**
   * The leading `/command` when it is one the CLI actually has — what the
   * composer tints. Checked against `chat.commands` rather than against a
   * pattern, so a typo stays plain text and the highlight means "this will
   * expand", not "this begins with a slash".
   */
  const commandToken = React.useMemo(() => {
    if (!draft.startsWith('/')) return null
    const token = /^\/\S*/.exec(draft)?.[0] ?? ''
    const name = token.slice(1).toLowerCase()
    if (!name) return null
    const known = (chat?.commands ?? []).some(
      (c) => c.replace(/^\//, '').toLowerCase() === name
    )
    return known ? token : null
  }, [draft, chat?.commands])

  // The twin follows the box it sits under on `scroll`, which covers scrolling
  // but not *arriving* scrolled: it mounts at 0, and a draft can land already
  // past the fold — paste a long message that happens to start with `/clear`
  // and the caret is at the end of it. That used to misplace a tint by a few
  // lines; now that the twin paints the glyphs themselves it would show the top
  // of the message while the box is looking at the bottom. Layout, not effect,
  // so the correction is never on screen for a frame.
  React.useLayoutEffect(() => {
    if (overlayRef.current && inputRef.current) {
      overlayRef.current.scrollTop = inputRef.current.scrollTop
    }
  }, [draft, commandToken])

  const openModelMenu = async (): Promise<void> => {
    const opening = !modelMenu
    setModelMenu(opening)
    if (!opening) return
    // Asked again on every open, rather than once and kept.
    //
    // The first answer for a chat whose process has not finished spawning is the
    // hardcoded fallback list — four bare aliases with no generation on them —
    // and caching *that* pinned a menu with no Opus 5 in it for the life of the
    // view, on exactly the sessions most likely to hit it: the ones in a project
    // you have just created. Main caches the real answer per project, so a
    // re-ask costs an IPC round trip and no docker call once one has landed.
    //
    // The previous list stays on screen while this resolves, so re-opening never
    // flashes an empty menu.
    setModels(await window.vivarium.chatModels(session.id))
  }

  return (
    <div
      ref={rootRef}
      // The scope for every chat rule in GLOBAL_CSS — the control radius and the
      // scrollbar. It is a class rather than a wrapper selector so the rules die
      // with this subtree and can never reach the slate chrome around it.
      className="vchat"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
      }}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: CHAT.bg,
        color: CHAT.text,
        // **The whole window is mono, and it is set once, here.** `body` is IBM
        // Plex Sans and everything inherits from it, so one declaration on the
        // root turns the log, the markdown, the composer and every control mono
        // at once — including the textarea, which `input,button,textarea{font-
        // family:inherit}` in GLOBAL_CSS already wires to its parent. The
        // explicit `fontFamily: MONO` further down are now saying again what
        // this says; they are left alone rather than swept, because each of them
        // is also what stops a *future* wrapper from quietly restyling a chip.
        fontFamily: MONO,
        // Hidden rather than unmounted, like a terminal — but for a weaker
        // reason: nothing in a chat is unrecoverable, so terminals *must* stay
        // mounted while a chat merely *may*. What it buys is scroll position,
        // which cards are expanded, and the draft.
        visibility: visible ? 'visible' : 'hidden',
        outline: dragOver ? `1px dashed ${CHAT.you}` : 'none'
      }}
    >
      <Header
        session={session}
        project={project}
        mode={mode}
        model={chat?.model ?? null}
        context={chat?.context ?? null}
        live={!!chat?.open}
        onMode={(m) => void setChatMode(session.id, m)}
        onModelClick={() => void openModelMenu()}
        onCloseModelMenu={() => setModelMenu(false)}
        modelMenu={modelMenu}
        models={models}
        onPickModel={(m) => {
          setModelMenu(false)
          void setChatModel(session.id, m)
        }}
      />

      {/* Not a gutter row: the gutter is a timeline and a failed read is not an
          event in time. The chat stays usable — the process spawns fine, only the
          history is missing — so this is a banner, and it clears on a successful
          read rather than on a dismiss. */}
      {chat?.historyError && (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 20px',
            background: CHAT.card,
            borderBottom: `1px solid ${CHAT.borderSoft}`,
            fontSize: 12.5,
            color: CHAT.dim
          }}
        >
          <span>Could not read this conversation’s history — {chat.historyError}</span>
          <button
            onClick={() => void openChat(project.id, session.id, true)}
            style={{
              fontFamily: MONO,
              fontSize: 11.5,
              border: `1px solid ${CHAT.border}`,
              background: 'transparent',
              color: CHAT.dim2,
              padding: '2px 10px',
              cursor: 'pointer'
            }}
          >
            retry
          </button>
        </div>
      )}

      {find && (
        <ChatFindBar
          query={find}
          inputRef={findInputRef}
          hits={hits.length}
          at={at}
          /* Tool bodies are clipped on the way out of main and fetched on
             expand, so a match inside an unexpanded one is genuinely not
             searchable — the bar says so rather than quietly missing it. */
          clipped={entries.some((e) => e.kind === 'tool' && e.body.truncated)}
          earlier={chat ? Math.max(0, chat.total - entries.length) : 0}
          onLoadEarlier={() => void loadEarlier(session.id)}
          onTerm={(term) => setFind((f) => (f ? { ...f, term, at: 0 } : f))}
          onToggleCase={() =>
            setFind((f) => (f ? { ...f, caseSensitive: !f.caseSensitive, at: 0 } : f))
          }
          onStep={stepFind}
          onClose={closeFind}
        />
      )}

      {/* The log and the outline rail sit in a row inside the column, so the
          rail takes width from the log rather than floating over the messages it
          is an index of. `minHeight: 0` because a flex child's default
          `min-height: auto` refuses to shrink below its content, which in a
          scroller means the composer gets pushed off the bottom of the window. */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* The scroller and the jump control, in a box of their own so the control
          is centred over the *log* rather than over the log plus the outline
          rail. It cannot live inside the scroller: an absolutely positioned
          child of a scroll container still scrolls with the content, and this
          one has to stay put.

          **`minWidth: 0` is what keeps the log the width of the window**, and it
          is not optional here. A flex item's `min-width: auto` is its content's
          minimum size, and this box is the one link in the chain that is not
          itself a scroller — the log below *is* one, so its own automatic minimum
          is zero and the row above it used to hold this box's job. Without it the
          widest unbreakable thing in the conversation (a `white-space: pre` diff
          row, a long line in a fenced block) became the floor for this box, the
          log stretched to match, and every paragraph in the window then wrapped
          at a column wider than the window — text cut off at the right edge with
          nothing to scroll, because the overflow is up here where nothing
          scrolls, not inside the log. */}
      <div style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0, position: 'relative' }}>
      <div
        ref={logRef}
        className="vchat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget
          const tail = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          pinned.current = tail
          // The same 40px, deliberately: the control means "tail-follow is off",
          // so it has to appear at the instant following stops and not a pixel
          // either side of it. A second threshold would make it lie for the gap
          // between them.
          setAtTail((v) => (v === tail ? v : tail))
        }}
        // The one place the zoom chords are written down. Same argument as the
        // terminal's menu, which is where Ctrl+F and Ctrl+± are taught: a chord
        // nothing on screen mentions may as well not exist.
        onContextMenu={(e) => {
          e.preventDefault()
          const z = useStore.getState()
          const selection = window.getSelection()?.toString() ?? ''
          z.openContextMenu(e.clientX, e.clientY, [
            {
              label: 'Copy',
              icon: <Copy size={14} />,
              hint: 'Ctrl+C',
              disabled: !selection,
              onSelect: () => void window.vivarium.clipboardWriteText(selection)
            },
            { label: '---' },
            {
              label: 'Find…',
              icon: <Search size={14} />,
              hint: 'Ctrl+F',
              onSelect: () => openFind()
            },
            {
              label: outline ? 'Hide outline' : 'Show outline',
              icon: <PanelToggle size={14} />,
              disabled: outlineTurns.length === 0,
              onSelect: () => setOutline((o) => !o)
            },
            { label: '---' },
            {
              label: 'Revert to a message…',
              icon: <Undo size={14} />,
              hint: 'Esc Esc',
              disabled: revertTargets.length === 0,
              onSelect: () => setRewind({ busy: false })
            },
            { label: '---' },
            { label: 'Zoom in', icon: <ZoomIn size={14} />, hint: 'Ctrl++', onSelect: () => z.zoomChat(1) },
            { label: 'Zoom out', icon: <ZoomOut size={14} />, hint: 'Ctrl+-', onSelect: () => z.zoomChat(-1) },
            {
              label: 'Reset zoom',
              icon: <Refresh size={14} />,
              hint: 'Ctrl+0',
              onSelect: () => z.resetChatZoom()
            }
          ])
        }}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {/* The log column. The composer's carries the same zoom and the same
            EDGE, so a message and the box you answer in share both edges.

            `zoom` rather than a font size threaded through thirty components:
            the chat is a whole layout (a gutter, cards, a composer) and scaling
            only the type would leave every one of those behind at its 1×
            proportions. It sits on the *column* and not on the view root because
            a zoomed `position:absolute; inset:0` box scales its own edges, while
            the column is a plain auto-width block that fills the scroller at any
            factor. */}
        <div ref={contentRef} style={{ zoom, padding: `20px ${EDGE}px 40px` }}>
          {chat && chat.total > entries.length && (
            <button
              onClick={() => void loadEarlier(session.id)}
              style={{
                display: 'block',
                margin: '0 auto 18px',
                fontFamily: MONO,
                fontSize: 11.5,
                border: `1px solid ${CHAT.border}`,
                background: 'transparent',
                color: CHAT.dim3,
                padding: '4px 12px',
                cursor: 'pointer'
              }}
            >
              load earlier ({chat.total - entries.length})
            </button>
          )}
          {/* Every row gets a plain block wrapper carrying its id, which is what
              `scrollIntoView` and the outline both aim at. Layout-neutral: the
              column is a block container and `Line` spaces itself with padding
              rather than margins, so there is no collapsing to disturb.

              The current hit takes a rail in the `you` hue — the same left-edge
              idiom the sidebar's active item uses — rather than a second wash.
              Every match in the log is already washed, and washing one of them
              *harder* is not a difference you can find by eye; an edge is. */}
          <FindContext.Provider value={matcher}>
            {rows.map((e) => (
              <div
                key={e.id}
                data-row={e.id}
                style={
                  e.id === activeHit
                    ? { borderLeft: `2px solid ${CHAT.you}`, marginLeft: -2, scrollMarginBlock: 24 }
                    : undefined
                }
              >
                <LogRow entry={e} handlers={handlers} streaming={e.id === streamingId} />
              </div>
            ))}
          </FindContext.Provider>
          {entries.length === 0 && chat?.open && (
            <div
              style={{
                padding: '48px 10px',
                fontSize: TYPE.prose,
                lineHeight: TYPE.proseLine,
                color: CHAT.dim3
              }}
            >
              Nothing said yet — ask something below.
            </div>
          )}
          {/* The question card. It is the last row of the conversation rather
              than a surface over it, so it scrolls with the messages it is
              asking about — see QuestionCard. Keyed on the request for the same
              reason the bar is: two `can_use_tool` requests can arrive back to
              back without passing through null, and half-ticked options carried
              into the next question are an answer nobody gave. */}
          {blocking?.kind === 'question' && (
            <QuestionCard
              key={blocking.requestId}
              questions={blocking.questions ?? []}
              onAnswer={(answer) => void answerChat(session.id, blocking.requestId, answer)}
            />
          )}
        </div>
      </div>
      {/* Jump to latest. The log stops following the tail the moment you scroll
          away — right for reading history while a turn is still writing, but it
          left the way back as "scroll by hand until it catches", which in a long
          transcript is a long way. Shown whenever the pin is off, not only when
          something new has landed: the pin is off either way, and a control that
          appeared halfway through reading would be its own interruption.

          `stickToBottom` is the click, unchanged — this is the same gesture as
          sending a message, and re-arming the pin is the half that matters. */}
      {!atTail && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 10,
            display: 'flex',
            justifyContent: 'center',
            // The strip spans the log so the button can centre in it; only the
            // button itself may take a click, or this would swallow the text
            // selection and the context menu of the last rows underneath.
            pointerEvents: 'none'
          }}
        >
          <button
            onClick={stickToBottom}
            title="Scroll to the newest message"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: MONO,
              fontSize: TYPE.gutter,
              padding: '4px 12px',
              color: CHAT.dim2,
              background: CHAT.composer,
              border: `1px solid ${CHAT.borderComposer}`,
              boxShadow: '0 6px 20px -10px var(--shadow)',
              cursor: 'pointer'
            }}
          >
            <Chevron size={11} style={{ transform: 'rotate(90deg)' }} />
            latest
          </button>
        </div>
      )}
      </div>
        {outline && (
          <Outline
            turns={outlineTurns}
            clocks={turnClocks}
            activeId={activeHit}
            zoom={zoom}
            onPick={(id) => {
              const el = logRef.current?.querySelector(`[data-row="${CSS.escape(id)}"]`)
              if (!el) return
              // Same reasoning as the find bar's jump: deliberately going
              // somewhere in the log drops the tail pin, or the next streamed
              // token drags you straight back to the bottom.
              pinned.current = false
              el.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }}
            onClose={() => setOutline(false)}
          />
        )}
      </div>

      {/* The composer region floats over the end of the log rather than sitting
          below it: the gradient is what makes the last row fade out under the box
          instead of stopping at a hard rule. */}
      <div
        style={{
          flex: 'none',
          padding: `0 ${EDGE}px 18px`,
          background: `linear-gradient(to top, ${CHAT.bg} 70%, ${CHAT.bg}00)`
        }}
      >
        <div style={{ zoom, position: 'relative' }}>
          {/* The pinned bands, widest scope to narrowest, each absent entirely
              when empty. Nothing is ever hidden by something else — letting a
              pending card displace the todo strip was rejected, because it does
              not make the buttons more visible (they are adjacent either way) and
              it costs a disappearance the user did not cause. */}
          {todos.length > 0 && <TodoStrip todos={todos} />}
          {/* A question is the one blocking card that is *not* a bar and not
              here at all — it is a row at the end of the log (see QuestionCard).
              Everything else is one line of chrome with two buttons on it, which
              a band carries better than a card in the flow would: a plan's
              approval must not scroll away behind the plan body it is about. */}
          {blocking && blocking.kind !== 'question' && (
            // Keyed on the request, so a card *replaced* rather than answered
            // starts empty. Answering unmounts the bar and takes its state with
            // it, but two `can_use_tool` requests arriving back to back never
            // pass through null — and half-ticked options carried into the next
            // question are an answer nobody gave.
            <BlockingBar
              key={blocking.requestId}
              card={blocking}
              onAnswer={(answer) => void answerChat(session.id, blocking.requestId, answer)}
            />
          )}
          {chips.length > 0 && (
            <ChipStrip
              chips={chips}
              onRemove={(id) => setChips((c) => c.filter((x) => x.id !== id))}
            />
          )}
          {menu && menuRows.length > 0 && (
            <Typeahead
              rows={menuRows}
              active={pick}
              enterSends={enterSends}
              onHover={setPick}
              onPick={acceptRow}
            />
          )}

          <div
            style={{
              padding: '14px 16px 12px',
              background: CHAT.composer,
              // --border-strong at rest and --accent on focus. The box you type
              // into is the one edge in this window that is meant to be seen
              // without being looked for, which is what --border-strong is for.
              border: `1px solid ${focus ? 'var(--accent)' : CHAT.borderComposer}`,
              borderRadius: CHAT.radiusCard,
              boxShadow: '0 8px 30px -18px var(--shadow)',
              transition: 'border-color .16s'
            }}
          >
            {/* The command colour.
                A textarea holds one flat string and paints it in one flat
                colour, so colouring a *run* of it means the glyphs you can see
                have to come from somewhere else: a twin, laid out behind with
                the same metrics. While a known `/command` leads the draft the
                two swap jobs — the textarea keeps the caret, the selection,
                the scrolling and the editing but paints nothing, and the twin
                paints every glyph, the command in coral and the rest in
                exactly the `CHAT.text` the textarea itself would have used, so
                the swap is invisible.

                Three things make that safe rather than clever. The twin may
                differ from the textarea in **colour only** — a weight, size,
                family or spacing of its own moves the glyphs out from under
                the caret that is still the textarea's. The swap is scoped to
                the case that needs it, so ordinary prose is drawn by the
                textarea exactly as it always was. And the app's `::selection`
                is 32% alpha (APP_CSS), which is what keeps selected text
                readable through a band painted over glyphs that are no longer
                there. The placeholder never collides with any of this: the
                draft starts with `/`, so it is by construction not empty.

                The alternative (a contenteditable composer) buys the same
                pixel at the price of owning caret and paste behaviour by
                hand. */}
            <div style={{ position: 'relative' }}>
              {commandToken && (
                <div
                  ref={overlayRef}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    pointerEvents: 'none',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'break-word',
                    fontSize: TYPE.prose,
                    lineHeight: TYPE.proseLine,
                    color: CHAT.text
                  }}
                >
                  {/* Heavier as well as coloured — a slash command is the one
                      thing you can type here that the CLI executes rather than
                      reads. **Not `fontWeight`.** The twin may differ from the
                      textarea in colour only: a bold run is wider than the
                      regular run the textarea is still laying out underneath,
                      so every glyph after the command would slide out from
                      under the real caret. A text stroke is painted, not laid
                      out — the advance widths are untouched, and the weight is
                      the same weight. */}
                  <span style={{ color: CHAT.cmd, WebkitTextStroke: '.4px currentColor' }}>
                    {commandToken}
                  </span>
                  {draft.slice(commandToken.length)}
                </div>
              )}
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => onDraft(e.target.value, e.target.selectionStart)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocus(true)}
                onBlur={() => setFocus(false)}
                // The twin has to follow the box it sits under once the draft is
                // long enough to scroll, or the tint stays at the top while the
                // command it marks has moved off screen.
                onScroll={(e) => {
                  if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop
                }}
                onPaste={(e) => {
                  const items = Array.from(e.clipboardData.files)
                  if (items.length) {
                    e.preventDefault()
                    void addFiles(items)
                  }
                }}
                placeholder={placeholderFor(chat?.open ?? false, !!blocking, working)}
                // Chromium's spellchecker has nothing useful to say about what is
                // typed here — a prompt is paths, flags, identifiers, model ids and
                // code — so it underlined most of every message, and a red squiggle
                // is the loudest thing this window can draw. The same reasoning the
                // find bar and the output-folder field already applied
                // (`spellCheck={false}` in TerminalView and OutputPanel), and it is
                // set per field rather than once on the view root because inheriting
                // it through the tree is a rule nothing here states out loud.
                spellCheck={false}
                style={{
                  display: 'block',
                  position: 'relative',
                  width: '100%',
                  minHeight: 26,
                  // Height *and* the cap are both driven by the layout effect
                  // above (`fitComposer`) — the cap is a fraction of the window
                  // now, so it cannot be written here as a number. What it buys
                  // is unchanged: a 200-line paste scrolls inside the box
                  // instead of eating the log.
                  overflowY: 'auto',
                  border: 0,
                  background: 'transparent',
                  // Transparent only while the twin above is painting the text
                  // in its place. The caret is not covered by that swap — it
                  // takes its colour from `color` unless told otherwise, and a
                  // composer with no visible caret is a broken one.
                  color: commandToken ? 'transparent' : CHAT.text,
                  caretColor: CHAT.text,
                  fontSize: TYPE.prose,
                  lineHeight: TYPE.proseLine,
                  padding: 0,
                  resize: 'none',
                  outline: 'none',
                  // The find-bar precedent: a control focused for as long as it
                  // exists has no business lighting the global focus ring.
                  boxShadow: 'none'
                }}
              />
            </div>

            {/* The status line. What you are about to send under, and how to send
                it — both readings the header used to be the only home for. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontFamily: MONO,
                  fontSize: TYPE.gutter,
                  color: CHAT.dim3
                }}
              >
                {/* Drawn exactly like the header's active chip — same hue on the
                    border and the word, same radius, no fill. The two readings
                    of the mode are far apart on screen, so looking the same is
                    what makes them read as one fact rather than two controls.
                    `plan` is the quiet one: a --border-strong outline and a
                    --muted word, which is the same "outlined, not shouting"
                    treatment every inert control in the app wears. `bypass`
                    takes --accent2 on both, because it is the state worth
                    noticing. */}
                <span
                  style={{
                    padding: '2px 6px',
                    border: `1px solid ${mode === 'plan' ? 'var(--border-strong)' : CHAT.bypass}`,
                    borderRadius: CHAT.radius,
                    color: mode === 'plan' ? CHAT.mode : CHAT.bypass
                  }}
                >
                  {mode === 'plan' ? 'plan' : 'bypass'}
                </span>
                <span>·</span>
                <span>{modelName(chat?.model ?? null)}</span>
              </div>
              <div
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: TYPE.gutter, color: CHAT.dim4 }}>
                  {working ? 'esc interrupt · ⏎ queue' : '⏎ send · ⇧⏎ newline'}
                </span>
                {/* Mirrors Enter, and the only reason it exists is that Enter is
                    invisible. Interrupt deliberately did *not* take this slot: a
                    button that changes what it does under your cursor mid-turn is
                    how you cancel a turn you meant to send. */}
                <button
                  onClick={send}
                  disabled={!canSend}
                  // The one control that opts out of the window's 1.32 hover
                  // (see GLOBAL_CSS): that number is tuned for the transparent
                  // chips it mostly lands on, and on a saturated fill it reads
                  // as the button changing colour rather than lighting up.
                  data-send=""
                  style={{
                    padding: '6px 16px',
                    border: 0,
                    fontFamily: MONO,
                    fontSize: TYPE.code,
                    fontWeight: 500,
                    transition: '.14s',
                    // The one filled warm control in the window. Disabled drops
                    // to the well rather than dimming the fill — a 40%-opacity
                    // red still reads as a red button you are allowed to press.
                    background: canSend ? CHAT.send : CHAT.well,
                    color: canSend ? CHAT.onAccent : CHAT.dim2,
                    cursor: canSend ? 'pointer' : 'default'
                  }}
                >
                  send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The revert picker. Still a *dialog* at the view root, and the contrast
          with the question card above is the point: this one is a detour you
          chose, it covers a conversation you are not reading right now, and its
          backdrop dismisses. A question card blocks the CLI, so it may not take
          the conversation away from you. */}
      {rewind && (
        <RewindOverlay
          targets={revertTargets}
          zoom={zoom}
          busy={rewind.busy}
          error={rewind.error}
          onPick={(id) => void revert(id)}
          onClose={() => setRewind(null)}
        />
      )}
    </div>
  )
}

/**
 * `41200` → `41.2k`, `126000` → `126k`. One decimal below 100k, none above: the
 * header reading is a *rate* you watch climb, and rounding 41 200 to `41k` hides
 * every change until the next thousand lands.
 */
function tok(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return k < 100 ? `${Math.round(k * 10) / 10}k` : `${Math.round(k)}k`
}

/** A turn is in flight while its clock row has no frozen duration yet. */
function isWorking(entries: ChatEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'turn') return e.durationMs === undefined
  }
  return false
}

/** The placeholder is the only thing that follows the stage. */
function placeholderFor(open: boolean, blocking: boolean, working: boolean): string {
  if (!open) return 'Connecting…'
  if (blocking) return 'Answer above, or type to redirect…'
  if (working) return 'Type to queue a follow-up…'
  return 'Ask, or paste an image with Ctrl+V…'
}

// ---- chrome ---------------------------------------------------------------
/**
 * Four readings and two controls, all on one 52px line: the session name and its
 * project on the left, then the context meter, the mode toggle and the model
 * chip on the right.
 *
 * The context reading is three sights of one number — `41.2k / 200k`, a bar, and
 * the percentage the bar's tint is keyed to — because the header is glanced at
 * rather than read: the numbers answer "how much room is left" exactly, the bar
 * answers it in a shape, and the percentage is the one both of the others are
 * approximating. The bar alone is what shipped first and it was unreadable, at
 * 3px against a 1px rule with no scale beside it. It is still not clickable: a
 * click sending /context was genuinely cheap, but it would make a header click
 * *write to the transcript*, which nothing else in the header does.
 *
 * The model chip carries a liveness dot, and that dot is the only green in the
 * chat. It means the CLI process is up — the same fact the app's running
 * indicator means elsewhere, so the colour is not overloaded, it is reused.
 */
function Header({
  session,
  project,
  mode,
  model,
  context,
  live,
  onMode,
  onModelClick,
  onCloseModelMenu,
  modelMenu,
  models,
  onPickModel
}: {
  session: Session
  project: Project
  mode: ChatMode
  model: string | null
  context: ChatContextUsage | null
  /** the chat's process is running — what the dot on the model chip reports */
  live: boolean
  onMode: (m: ChatMode) => void
  onModelClick: () => void
  onCloseModelMenu: () => void
  modelMenu: boolean
  models: ChatModelOption[] | null
  onPickModel: (m: string) => void
}): React.ReactElement {
  const pct = context?.percentage ?? null
  const contextTitle = context
    ? `${tok(context.totalTokens)} / ${tok(context.maxTokens)} tokens · ${context.percentage}% of the context window${context.approximate ? ' (approximate — derived from the turn’s usage)' : ''}`
    : 'Context usage unavailable'

  return (
    <div
      style={{
        flex: 'none',
        // 34, which is `TerminalHost`'s header to the pixel. The two headers
        // occupy the same strip of the window and you switch between them with
        // one click in the sidebar — at 52 the whole page jumped 18px on every
        // switch, and the chat's row was the one that looked wrong, because
        // there is nothing in it a terminal's row does not also carry.
        height: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        // --border's weight, not a hairline: the terminal header takes the same
        // rule for the same reason — the header and the page under it are one
        // surface, and a fainter line simply disappears against them.
        borderBottom: `1px solid ${CHAT.border}`,
        background: CHAT.header
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12.5,
            color: CHAT.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {session.name}
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: CHAT.dim3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {project.name}
        </span>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          title={contextTitle}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: MONO,
            fontSize: TYPE.gutter,
            color: CHAT.dim2
          }}
        >
          <span style={{ color: CHAT.dim }}>
            {context ? `${tok(context.totalTokens)} / ${tok(context.maxTokens)}` : '— / —'}
          </span>
          {/* 84×5 on --track: wider and thinner than the title bar's quota pills,
              because this one is read continuously while the other two are
              glanced at, and length is what a percentage is easiest to judge by.
              No border — --track carries the empty half on its own, where the
              hairline this used to have made a 4% fill compete with a rule.
              The fill keeps a minimum sliver for the same reason: "a little"
              must never render as "none". */}
          <span
            style={{
              width: 84,
              height: 5,
              display: 'block',
              background: 'var(--track)',
              borderRadius: 4,
              overflow: 'hidden'
            }}
          >
            {pct !== null && (
              <span
                // data-meter: out of the global theme transition (GLOBAL_CSS).
                // This fill already animates its own `width` and escalates
                // through three hues; cross-fading the colour on top of that
                // smears the escalation while the bar is moving.
                data-meter=""
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.max(pct > 0 ? 6 : 0, Math.min(100, pct))}%`,
                  background: ctxColor(pct),
                  borderRadius: 4,
                  transition: 'width .4s'
                }}
              />
            )}
          </span>
          {/* The percentage in words as well as in length. The bar answers "how
              full" at a glance and this answers "how full exactly" without a
              hover, which is the reading the escalating tint is keyed to. */}
          <span style={{ color: pct === null ? CHAT.dim3 : ctxColor(pct) }}>
            {pct === null ? '—' : `${Math.round(Math.min(100, pct))}%`}
          </span>
        </div>

        {/* Two modes, live — set_permission_mode is accepted mid-conversation and
            even mid-turn. Plain "plan" / "bypass": no warning chrome and no
            explanatory tooltip. Plan mode being advisory here is a known accepted
            property of this tool (terminal agents already run
            --dangerously-skip-permissions), not something the UI argues with the
            user about every time they look at it. */}
        {/* Two separate outlined chips, not a segmented control.
            The hue is carried by the *border and the label*, and nothing is
            filled: a filled chip on this page is a much heavier mark than the
            reading deserves, and it also forced dark ink onto a saturated hue,
            which is the one text colour in the window that could not be read at
            11.5px. Outlining means the two states differ by hue, weight and edge
            at once, and the composer's status chip — outlined already — is drawn
            the same way, so the two places that report the mode now *look* the
            same and not merely agree. Losing the shared box costs nothing: they
            are adjacent, so the gap reads as a pair. */}
        <div style={{ display: 'flex', gap: 6 }}>
          {(['plan', 'bypassPermissions'] as const).map((m) => {
            const active = mode === m
            // A hue per mode, not one hue for "whichever is on". The toggle used
            // the same blue either way, so the only thing telling you which mode
            // you were in was reading the two five-letter words — which is the
            // same failure the log rows had. `plan` is the quiet register
            // (--border-strong edge, --muted word) and `bypass` is --accent2 on
            // both; the composer's status chip is drawn from the same two, so
            // the two places that report the mode agree by construction.
            const edge = m === 'plan' ? 'var(--border-strong)' : CHAT.bypass
            const ink = m === 'plan' ? CHAT.mode : CHAT.bypass
            return (
              <button
                key={m}
                title={m === 'plan' ? 'Plan first, then approve' : 'Run without asking'}
                onClick={() => onMode(m)}
                style={{
                  padding: '2px 10px',
                  border: `1px solid ${active ? edge : CHAT.border}`,
                  borderRadius: CHAT.radius,
                  cursor: 'pointer',
                  fontFamily: MONO,
                  fontSize: TYPE.gutter,
                  transition: '.14s',
                  background: 'transparent',
                  color: active ? ink : CHAT.dim2,
                  fontWeight: active ? 500 : 400
                }}
              >
                {m === 'plan' ? 'plan' : 'bypass'}
              </button>
            )
          })}
        </div>

        {/* Anchored to the button it belongs to, not to the header's right edge. */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={onModelClick}
            title={model ? `Model: ${model}` : 'The CLI has not reported a model yet'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              // Sized to the 34px header: every control in this row clears it
              // with a little air, so nothing has to be clipped or centred by eye.
              // Outlined and unfilled like the two mode chips beside it — the
              // model is a reading, not a state, so it gets --fg rather than a hue.
              padding: '2px 8px',
              background: 'transparent',
              border: '1px solid var(--border-strong)',
              borderRadius: CHAT.radius,
              color: CHAT.model,
              fontFamily: MONO,
              fontSize: TYPE.gutter,
              cursor: 'pointer',
              transition: 'border-color .14s'
            }}
          >
            <span
              title={live ? 'The CLI process is running' : 'No process — the chat is not open'}
              style={{
                width: 6,
                height: 6,
                flex: 'none',
                borderRadius: '50%',
                background: live ? CHAT.live : CHAT.dim4
              }}
            />
            <span>{modelName(model)}</span>
            <span style={{ color: CHAT.dim3, fontSize: 9 }}>{modelMenu ? '▲' : '▼'}</span>
          </button>

          {modelMenu && (
            <>
              {/* Click-anywhere-else closes it. A menu you can only dismiss by
                  re-pressing its own button is half of "looks broken". */}
              <div onMouseDown={onCloseModelMenu} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
              <div
                style={{
                  position: 'absolute',
                  top: 34,
                  right: 0,
                  zIndex: 20,
                  background: CHAT.card,
                  border: `1px solid ${CHAT.border}`,
                  borderRadius: CHAT.radiusCard,
                  boxShadow: '0 18px 44px -16px var(--shadow)',
                  minWidth: 232,
                  maxHeight: 300,
                  overflowY: 'auto',
                  animation: 'vpop .12s ease-out'
                }}
              >
                {models === null && (
                  <div style={{ padding: '9px 12px', fontSize: 11.5, fontFamily: MONO, color: CHAT.dim3 }}>
                    loading…
                  </div>
                )}
                {models?.map((m) => {
                  // The chip shows whatever the CLI last reported, which is a
                  // resolved id; the list offers aliases. Matching on either keeps
                  // the tick honest instead of never lighting up.
                  const on = model !== null && (m.value === model || m.detail === model)
                  return (
                    <button
                      key={m.value}
                      onClick={() => onPickModel(m.value)}
                      title={m.detail ?? m.value}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 9,
                        width: '100%',
                        textAlign: 'left',
                        border: 0,
                        borderLeft: `2px solid ${on ? CHAT.model : 'transparent'}`,
                        background: on ? CHAT.hover : 'transparent',
                        color: on ? CHAT.text : CHAT.prose,
                        fontSize: 12.5,
                        padding: '8px 12px',
                        cursor: 'pointer'
                      }}
                    >
                      {/* Derived from the *resolved* id where there is one:
                          `list_models` labels the aliases `Opus` / `Sonnet`,
                          which names the family and hides the generation — the
                          one thing you open this menu to choose between. */}
                      <span style={{ flex: 'none' }}>
                        {modelOptionLabel(m.value, m.label, m.detail)}
                      </span>
                      {m.detail && (
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 11.5,
                            color: CHAT.dim3,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {m.detail}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- the three pinned bands ------------------------------------------------
/**
 * Present whenever the list is non-empty, gone only when every task has been
 * deleted — an all-completed list keeps showing its ticks, because those tasks
 * really are still on the agent's list and it may reopen one. The strip cannot
 * disagree with what the agent believes.
 */
function TodoStrip({ todos }: { todos: ChatTodo[] }): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: '8px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        fontFamily: MONO,
        fontSize: 11.5,
        color: CHAT.dim3
      }}
    >
      {todos.map((t) => (
        <span key={t.id} style={{ color: t.status === 'in_progress' ? CHAT.text : undefined }}>
          {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}{' '}
          {t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject}
        </span>
      ))}
    </div>
  )
}

/**
 * Blocking keeps two surfaces, not one: the plan body renders in the log, in its
 * place in time, so the transcript stays a complete record — and the buttons are
 * pinned here, so a decision cannot scroll away behind twenty tool calls.
 *
 * A `question` never reaches this component — it is a card in the log itself
 * (QuestionCard), being a form rather than a sentence with two buttons after it.
 * What is left is the two one-line cases, which is all a bar was ever the right
 * shape for — and the two whose buttons genuinely must not scroll away.
 */
function BlockingBar({
  card,
  onAnswer
}: {
  card: ChatBlockingCard
  onAnswer: (a: ChatAnswer) => void
}): React.ReactElement {
  const [notes, setNotes] = React.useState('')

  if (card.kind === 'plan') {
    return (
      <Bar hue={CHAT.hold}>
        <span style={{ fontSize: TYPE.prose, color: CHAT.text }}>Plan awaiting approval</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="revision notes (optional)"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 80,
            height: 30,
            background: CHAT.well,
            border: `1px solid ${CHAT.border}`,
            color: CHAT.text,
            fontSize: 12.5,
            padding: '0 10px',
            outline: 'none'
          }}
        />
        {/* Approving leaves plan mode for the mode the session came *from*, which
            this app makes sure is bypass by launching there and transitioning in
            (main/chat.ts). With two modes there is nothing else approval could
            mean — so the toggle visibly moves to bypass, and this time it takes. */}
        <button
          data-fill=""
          onClick={() => onAnswer({ behavior: 'plan-approve' })}
          style={primaryButton(false)}
        >
          Approve &amp; run
        </button>
        <button
          onClick={() =>
            onAnswer({ behavior: 'plan-deny', message: notes.trim() || 'Keep planning.' })
          }
          style={secondaryButton}
        >
          Keep planning
        </button>
      </Bar>
    )
  }

  return (
    <Bar hue={CHAT.hold}>
      {/* The title of a permission card *is* the call — a bash line, a URL, a
          path — so it is long as often as not, and a flex item's automatic
          minimum size is its content: without these two it pushed the two
          buttons off the right edge of the bar. */}
      <span
        style={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: TYPE.prose, color: CHAT.text }}
      >
        {card.title}
      </span>
      <div style={{ flex: 1 }} />
      <button
        data-fill=""
        onClick={() => onAnswer({ behavior: 'allow' })}
        style={primaryButton(false)}
      >
        Allow
      </button>
      <button onClick={() => onAnswer({ behavior: 'deny' })} style={secondaryButton}>
        Deny
      </button>
    </Bar>
  )
}

/**
 * `AskUserQuestion`'s card — the whole tool, not a row of labels.
 *
 * The first version drew the labels as chips and nothing else, which dropped
 * four of the tool's five affordances on the floor: the option **descriptions**
 * (tooltip-only, so unreadable), the **previews** the model wrote for you to
 * compare, whether the question takes **one answer or several**, the **Other**
 * free-text escape the CLI adds to every question automatically, and **Chat
 * about this**, which is the only way out of a question you would rather talk
 * about than answer. All five are the reason the tool exists; a chip row is the
 * one part of it a plain sentence could have done instead.
 *
 * **The last row of the conversation — not a band, not a dialog, and no longer
 * a surface over the log.** All four have been built and the three that are gone
 * failed in three different directions. Pinned *in* the band above the composer
 * it was a 46vh scroller wedged into the gap between the log and the box,
 * competing with both for height — every pixel it gained came out of the log's
 * scroller. As a modal *dialog* it had all the room it wanted and took the
 * conversation away to get it: a scrim over the log, no scrolling, and a question
 * you cannot answer without re-reading the last three tool calls is exactly the
 * question this tool asks. Floating over the tail of the log fixed the scrim and
 * kept the scrolling, but it still *covered* the last few messages — the ones the
 * question is almost always about — and it read as something the app had put on
 * top of the chat rather than as something Claude had said in it.
 *
 * So it is simply a row: the last child of the log column, in the flow, after
 * every message and after the turn clock. It scrolls with the conversation
 * because it is part of it, it can be as tall as it likes (the log is a scroller
 * already, and it needs no cap and no measurement of the room above the
 * composer), nothing is covered, and the answer you give lands directly under
 * the messages that prompted it. Scrolling up to re-read is the ordinary gesture
 * it always was, and the card is still there when you come back down.
 *
 * The cost is the one thing a band buys and this does not: it can scroll out of
 * sight. That is why the *other* two blocking cards stay pinned — a plan's
 * approve/reject must not disappear behind the plan body — while this one can
 * afford it, being both tall enough to be hard to lose and the thing the tail
 * follows to on arrival. The composer's placeholder says "Answer above" for the
 * case where you have scrolled away from it anyway.
 *
 * The way out of a question you would rather not answer is still "Chat about
 * this", which is a real answer to the tool rather than a cancel — there is no
 * dismiss, because dismissing would leave the CLI blocked with nothing on screen
 * saying so. Esc keeps its single meaning, interrupt the turn, served by
 * ChatView's window-level handler.
 *
 * Layout still follows the CLI's own dialog: a vertical option list, and — for a
 * single-select question whose options carry previews — the focused option's
 * preview beside it, with a notes field under it. `focus` is the option the
 * preview is showing and is deliberately *not* the selection: you move through
 * the list to compare, and picking is a separate act.
 *
 * It is set in **sans**, alone in this window. Everything else here is mono
 * because it is a transcript of a terminal-shaped conversation; this is a form,
 * with checkboxes and radio buttons and prose descriptions, and mono made it
 * read as terminal output you were somehow expected to click. The preview pane
 * is the exception and stays mono — see the note on it.
 */
function QuestionCard({
  questions,
  onAnswer
}: {
  questions: ChatQuestion[]
  onAnswer: (a: ChatAnswer) => void
}): React.ReactElement {
  /** ticked option labels, per question */
  const [picks, setPicks] = React.useState<Record<string, string[]>>({})
  /** the "Other" free text, per question, and whether it is armed */
  const [other, setOther] = React.useState<Record<string, string>>({})
  const [otherOn, setOtherOn] = React.useState<Record<string, boolean>>({})
  /** notes, offered only where the CLI offers them: preview questions */
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  /** which option's preview is on screen — cursor, not selection */
  const [focus, setFocus] = React.useState<Record<string, string>>({})

  const pick = (q: ChatQuestion, label: string): void => {
    setFocus((f) => ({ ...f, [q.question]: label }))
    setPicks((p) => {
      const cur = p[q.question] ?? []
      if (!q.multiSelect) return { ...p, [q.question]: [label] }
      return {
        ...p,
        [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
      }
    })
    // Single-select is exclusive with Other in both directions, or picking an
    // option would silently send a second answer nobody can see.
    if (!q.multiSelect) setOtherOn((o) => ({ ...o, [q.question]: false }))
  }

  const armOther = (q: ChatQuestion): void => {
    setOtherOn((o) => ({ ...o, [q.question]: !o[q.question] }))
    if (!q.multiSelect) setPicks((p) => ({ ...p, [q.question]: [] }))
  }

  /** What this question will send: ticked labels plus a non-empty Other. */
  const valuesFor = (q: ChatQuestion): string[] => {
    const v = [...(picks[q.question] ?? [])]
    const t = (other[q.question] ?? '').trim()
    if (otherOn[q.question] && t) v.push(t)
    return v
  }

  const answersFor = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of questions) {
      const v = valuesFor(q)
      // Joined with `", "` rather than sent as an array: that is what the CLI's
      // own dialog submits, and its result builder splits on exactly that
      // string to decide whether every pick was a real option.
      if (v.length > 0) out[q.question] = v.join(', ')
    }
    return out
  }

  const notesFor = (): Record<string, string> | undefined => {
    const out: Record<string, string> = {}
    for (const q of questions) {
      const n = (notes[q.question] ?? '').trim()
      if (n) out[q.question] = n
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  const ready = questions.every((q) => valuesFor(q).length > 0)
  const answer = (clarify?: true): void =>
    onAnswer({ behavior: 'question', answers: answersFor(), notes: notesFor(), clarify })

  // Focus the card on mount, so Enter and Esc reach it without the user having
  // to click into it first. It cannot light the global focus ring — that rule is
  // a `box-shadow`, and the inline shadow below wins. Focus is the *only* thing
  // this card takes from the page, and it gives it back the moment you click
  // anywhere else, which is the difference between this and the modal it used to
  // be. `preventScroll` because focusing an element inside a scroller scrolls it
  // into view: the log's own tail-follow decides whether to move, and it already
  // knows not to yank someone who has scrolled up to read.
  const panelRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      // Enter answers, from anywhere in the card including the two text fields —
      // one handler rather than one per input, which is also what keeps "the
      // button is disabled but Enter still sends" from happening.
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && ready) {
          e.preventDefault()
          answer()
        }
      }}
      style={{
        // No `maxHeight` and no inner scroller: the log is the scroller, and a
        // card in the flow that capped itself would put a second one inside it —
        // the wheel dying halfway down a preview is exactly the thing this
        // window keeps being bitten by.
        marginTop: 14,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        // The `hold` edge every blocking surface wears, so a question and a plan
        // awaiting approval are visibly the same kind of moment.
        borderTop: `2px solid ${CHAT.hold}`,
        borderRadius: CHAT.radiusCard,
        // A row's shadow, not a floating panel's — enough to lift it off the
        // page, nothing that claims to be above it.
        boxShadow: '0 6px 20px -10px var(--shadow)',
        animation: 'vdlg .16s ease',
        // No `fontFamily` of its own. This card used to be the app's one sans
        // exception — a form with checkboxes and prose descriptions, which in
        // mono read as terminal output that happened to be clickable. The app is
        // one face now, so the exception is gone with the second face; what tells
        // the form apart from the log is its border, its `hold` edge and its
        // fields, which is enough and was always doing most of the work.
        outline: 'none'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '13px 18px',
          borderBottom: `1px solid ${CHAT.borderSoft}`
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 700, color: CHAT.text }}>Claude is asking</span>
        {questions.length > 1 && (
          <span style={{ fontSize: 11.5, color: CHAT.dim3 }}>{questions.length} questions</span>
        )}
        <div style={{ flex: 1 }} />
        {/* The one place Esc is taught while a card is up. It does here what it
            does everywhere else in the chat: ends the turn. */}
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: CHAT.dim4 }}>esc interrupts</span>
      </div>

      <div
        style={{
          padding: '16px 18px',
          display: 'grid',
          gap: 22,
          alignContent: 'start'
        }}
      >
        {questions.map((q) => {
          const withPreview = !q.multiSelect && q.options.some((o) => o.preview)
          const shown = focus[q.question] ?? q.options[0]?.label
          const chosen = picks[q.question] ?? []
          const list = (
            <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              {q.options.map((o) => (
                <OptionRow
                  key={o.label}
                  label={o.label}
                  description={o.description}
                  multi={q.multiSelect}
                  on={chosen.includes(o.label)}
                  focused={withPreview && shown === o.label}
                  onFocus={() => setFocus((f) => ({ ...f, [q.question]: o.label }))}
                  onClick={() => pick(q, o.label)}
                />
              ))}
              {/* Always present, because the CLI always adds it: "There should be
                  no 'Other' option, that will be provided automatically" is in
                  the schema the model is handed. Its text *is* the answer — the
                  dialog files it under the question like any label. */}
              <OptionRow
                label="Other"
                description="answer in your own words"
                multi={q.multiSelect}
                on={!!otherOn[q.question]}
                focused={false}
                onClick={() => armOther(q)}
              />
              {otherOn[q.question] && (
                // Enter is the panel's, not this field's — see the dialog's own
                // onKeyDown. Indented to the marker's text column, so it reads as
                // belonging to the row above rather than as a sixth option.
                <input
                  autoFocus
                  value={other[q.question] ?? ''}
                  onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
                  placeholder="Type your answer…"
                  spellCheck={false}
                  style={{
                    marginLeft: 27,
                    height: 32,
                    background: CHAT.well,
                    border: `1px solid ${CHAT.border}`,
                    color: CHAT.text,
                    fontSize: 12.5,
                    padding: '0 10px',
                    outline: 'none'
                  }}
                />
              )}
            </div>
          )

          return (
            <div key={q.question}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 9,
                  marginBottom: 8,
                  flexWrap: 'wrap'
                }}
              >
                {q.header && (
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11.5,
                      letterSpacing: '.04em',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      borderRadius: CHAT.radius,
                      border: `1px solid ${CHAT.border}`,
                      color: CHAT.hold,
                      flex: 'none'
                    }}
                  >
                    {q.header}
                  </span>
                )}
                <span
                  style={{
                    fontSize: TYPE.prose + 0.5,
                    color: CHAT.text,
                    flex: 1,
                    minWidth: 0,
                    overflowWrap: 'anywhere'
                  }}
                >
                  {q.question}
                </span>
                {/* Whether more than one answer is allowed is not derivable from
                    the options, and getting it wrong is a silently wrong answer
                    rather than a visible error. A pill rather than the mono hint
                    it was: it is a *rule about this control*, and it sits beside
                    controls that now look like controls. */}
                <span
                  style={{
                    flex: 'none',
                    fontSize: 11.5,
                    padding: '2px 9px',
                    borderRadius: 999,
                    background: CHAT.well,
                    border: `1px solid ${CHAT.borderCard}`,
                    color: CHAT.dim2
                  }}
                >
                  {q.multiSelect ? 'choose any' : 'choose one'}
                </span>
              </div>

              {withPreview ? (
                <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 14 }}>
                  {list}
                  <div style={{ minWidth: 0, display: 'grid', gap: 8, alignContent: 'start' }}>
                    {/* Markdown in a **monospace** box. The window root already
                        declares mono; this says it again on purpose, because
                        the CLI's own preview pane is Ink — a terminal grid
                        whatever the model wrote — and the tool's schema promises
                        the model that grid. A wrapper that ever restyles this
                        window must not quietly reflow an ASCII mockup. */}
                    {/* **Every option's preview is laid out, in one grid cell,
                        and all but the focused one are hidden.** The box is
                        therefore as tall and as wide as the *tallest* preview
                        from the moment it appears, and moving down the list
                        cannot change its size by a pixel.

                        This is load-bearing, and it is load-bearing again for
                        the reason it was written: the card is back **in** the
                        log's flow, so its height is the scroller's content
                        height. A five-line preview after a twenty-line one
                        would shrink the card, the log's ResizeObserver would
                        read that as the content changing height and re-pin the
                        tail — and merely *hovering* the options would jump the
                        conversation under the pointer. It survived a spell as a
                        floating card, which could not resize the scroller at
                        all, because it is also just better: a card that resizes
                        while you compare four options is its own bug, and
                        reserving the space costs nothing and needs no
                        arithmetic against the font metrics.

                        Sideways it scrolls; vertically it simply grows, and the
                        *log* takes it — the card has no scroller of its own, so
                        there is nothing here for a wheel to die in halfway down
                        a mockup. */}
                    <div
                      style={{
                        display: 'grid',
                        overflowX: 'auto',
                        padding: '8px 12px',
                        background: CHAT.well,
                        border: `1px solid ${CHAT.borderCard}`,
                        borderRadius: CHAT.radiusCard
                      }}
                    >
                      {q.options.map((o) => (
                        <div
                          key={o.label}
                          style={{
                            gridArea: '1 / 1',
                            visibility: shown === o.label ? 'visible' : 'hidden'
                          }}
                        >
                          {o.preview ? (
                            <Preview src={o.preview} />
                          ) : (
                            <span style={{ fontFamily: MONO, fontSize: 11.5, color: CHAT.dim3 }}>
                              no preview for this option
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <input
                      value={notes[q.question] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [q.question]: e.target.value }))}
                      placeholder="Notes on this option (optional)…"
                      spellCheck={false}
                      style={{
                        height: 32,
                        background: CHAT.well,
                        border: `1px solid ${CHAT.border}`,
                        color: CHAT.text,
                        fontSize: 12.5,
                        padding: '0 10px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>
              ) : (
                list
              )}
            </div>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 18px',
          borderTop: `1px solid ${CHAT.borderSoft}`
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: CHAT.dim4 }}>
          {ready ? '⏎ answer' : 'pick an option to answer'}
        </span>
        <div style={{ flex: 1 }} />
        {/* Not a cancel. It denies the tool with the questions attached and a
            note that the user wants to talk first, so the composer message you
            type next lands in a turn that is already listening. */}
        <button onClick={() => answer(true)} style={secondaryButton}>
          Chat about this
        </button>
        {/* The answers map is keyed by question *text*: an `allow` without one
            yields "The user did not answer the questions." with no error
            raised anywhere, which would silently break the card. */}
        <button
          data-fill=""
          disabled={!ready}
          onClick={() => answer()}
          style={primaryButton(!ready)}
        >
          Answer
        </button>
      </div>
    </div>
  )
}

/**
 * The revert picker: your own messages, newest first, and choosing one winds the
 * conversation back to just before it.
 *
 * This is the one real **dialog** in the chat — root-mounted over the whole view,
 * behind a scrim, zoomed panel, focused on mount so the keyboard reaches it. The
 * question card was built the same way and is now a row in the log (see
 * QuestionCard), and the difference between the two is the whole argument: a
 * question is asked *about* the conversation and belongs in it, while this one
 * asks you to pick a message out of a list it prints for you — the conversation
 * behind it is not what you are reading.
 *
 * It stays **mono**. The sans exception exists for a *form*: checkboxes, radios,
 * prose written by the model. This is a list of sentences you typed, quoted back,
 * and a transcript excerpt set in sans stops looking like the thing it quotes.
 *
 * And the **backdrop dismisses**, where the question card has no dismiss at all.
 * That is the same distinction again: nothing is blocked here, nothing has
 * happened yet, and a picker you cannot click your way out of is a trap. Same
 * reason it has no Cancel button: Esc and the backdrop are both already there.
 *
 * What it does *not* do is warn. The list is the confirmation — you are choosing a
 * specific message by reading it — and a second dialog on top of a deliberate pick
 * from a list of quotes would be asking the same question twice.
 */
function RewindOverlay({
  targets,
  zoom,
  busy,
  error,
  onPick,
  onClose
}: {
  /** newest first, which is also the order the rows are drawn in */
  targets: { id: string; uuid: string; at: number; text: string }[]
  zoom: number
  /** a revert is in flight: several control round trips, not one */
  busy: boolean
  error?: string
  onPick: (entryId: string) => void
  onClose: () => void
}): React.ReactElement {
  // Starts at 0, like the composer's `/` list and unlike its `@` one: the top
  // row — go back one message — is the case this is opened for, and Enter has
  // no other meaning here that a default selection could take away.
  const [active, setActive] = React.useState(0)
  const panelRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const move = (d: number): void =>
    setActive((i) => (targets.length === 0 ? 0 : (i + d + targets.length) % targets.length))

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 31,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 22,
        background: 'var(--overlay)',
        animation: 'vover .12s ease'
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        // The panel swallows the backdrop's dismiss, so a click on a row is not
        // also a click on the way out.
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (busy) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            return move(1)
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            return move(-1)
          }
          if (e.key === 'Enter' && targets[active]) {
            e.preventDefault()
            onPick(targets[active].id)
          }
        }}
        style={{
          zoom,
          display: 'flex',
          flexDirection: 'column',
          width: 720,
          maxWidth: '100%',
          maxHeight: '100%',
          background: CHAT.card,
          border: `1px solid ${CHAT.borderCard}`,
          // Coral, not the `hold` amber: this is the `you` edge, and every row
          // under it is one of your messages.
          borderTop: `2px solid ${CHAT.you}`,
          borderRadius: CHAT.radiusCard,
          boxShadow: '0 28px 70px -22px var(--shadow)',
          animation: 'vdlg .16s ease',
          fontFamily: MONO,
          outline: 'none'
        }}
      >
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '13px 18px',
            borderBottom: `1px solid ${CHAT.borderSoft}`
          }}
        >
          <span style={{ fontSize: 12.5, color: CHAT.text }}>Revert to a message</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: CHAT.dim4 }}>
            {busy ? 'reverting…' : '↑↓ · ⏎ revert · esc cancel'}
          </span>
        </div>

        <div style={{ overflowY: 'auto', opacity: busy ? 0.5 : 1 }}>
          {targets.length === 0 && (
            <div style={{ padding: '16px 18px', fontSize: 11.5, color: CHAT.dim3 }}>
              Nothing to revert to yet.
            </div>
          )}
          {targets.map((t, i) => {
            const on = i === active
            return (
              <button
                key={t.uuid}
                disabled={busy}
                onMouseMove={() => !busy && setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!busy) onPick(t.id)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  width: '100%',
                  textAlign: 'left',
                  border: 0,
                  borderLeft: `2px solid ${on ? CHAT.you : 'transparent'}`,
                  background: on ? CHAT.hover : 'transparent',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  padding: '7px 16px',
                  cursor: busy ? 'default' : 'pointer'
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    color: on ? CHAT.text : CHAT.prose,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {firstLine(t.text)}
                </span>
                {/* What it costs, in the unit the user is actually deciding in.
                    The top row drops one message — itself — and each row below
                    drops one more, so the number is the row's own index + 1. */}
                <span style={{ flex: 'none', fontSize: 11.5, color: CHAT.dim4 }}>
                  {i === 0 ? 'last' : `−${i + 1} msgs`}
                </span>
                <span style={{ flex: 'none', fontSize: 11.5, color: CHAT.dim4 }}>
                  {formatElapsed(Date.now() - t.at)} ago
                </span>
              </button>
            )
          })}
        </div>

        <div
          style={{
            flex: 'none',
            borderTop: `1px solid ${CHAT.borderSoft}`,
            padding: '8px 18px',
            fontSize: 11.5,
            color: error ? CHAT.danger : CHAT.dim4
          }}
        >
          {error ??
            'The message comes off the conversation and back into the composer. Files Claude changed are not restored.'}
        </div>
      </div>
    </div>
  )
}

/** The first line of a message, for a one-row quote of it. */
function firstLine(md: string): string {
  const line = md
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return line ? (line.length > 140 ? `${line.slice(0, 139)}…` : line) : '(attachment only)'
}

/**
 * One selectable option: a real row you click, with a real control on it.
 *
 * It used to be a transparent line of text with `[x]` / `( )` typed in front of
 * it in mono — the CLI's own drawing, reproduced in a window that is not a
 * terminal. It read as terminal *output*: nothing about it said it could be
 * clicked, the arity was three ASCII characters wide, and the description
 * trailed off the end of the label as a second grey sentence. Now the row is a
 * filled surface with an edge, the marker is drawn (a rounded box with a tick, a
 * circle with a dot), and the description sits under the label where a line of
 * prose belongs.
 *
 * The marker still carries the *arity* — box for multi-select, radio for single
 * — so "choose any" is legible from the control as well as from the pill beside
 * the question.
 */
function OptionRow({
  label,
  description,
  multi,
  on,
  focused,
  onFocus,
  onClick
}: {
  label: string
  description?: string
  multi: boolean
  on: boolean
  /** the option whose preview is showing — a cursor, not the selection */
  focused: boolean
  onFocus?: () => void
  onClick: () => void
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const lit = hover || focused
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => {
        setHover(true)
        onFocus?.()
      }}
      onMouseLeave={() => setHover(false)}
      onFocus={onFocus}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 11,
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        border: `1px solid ${on ? CHAT.hold : lit ? CHAT.border : CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        // A ticked row is tinted in the hold hue at low alpha — the same hue the
        // marker and the dialog's top edge carry, so one colour means "this is
        // the decision" throughout the card.
        background: on ? 'var(--accent2-soft)' : lit ? CHAT.hover : CHAT.well,
        cursor: 'pointer',
        transition: 'background .12s, border-color .12s'
      }}
    >
      <Marker multi={multi} on={on} />
      <span style={{ display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: on ? CHAT.text : CHAT.prose }}>
          {label}
        </span>
        {description && (
          <span style={{ fontSize: 11.5, lineHeight: 1.45, color: CHAT.dim2 }}>{description}</span>
        )}
      </span>
    </button>
  )
}

/**
 * The checkbox or the radio, drawn rather than typed.
 *
 * A native `<input type=checkbox>` was the other option and loses on the same
 * ground everything else in this window does: it would arrive wearing the OS's
 * blue against a palette that has no blue in it, and `accent-color` styles the
 * fill and nothing else. Sixteen pixels of border and a tick is the whole
 * control, and it can then be tinted with `CHAT.hold` like the row it sits on.
 *
 * (The "a palette that has no blue in it" argument that used to be here is no
 * longer true — the app has exactly one blue and it is `--accent`. What is still
 * true is the rest of it: `accent-color` styles the fill and nothing else, so a
 * native control could not carry the `hold` hue this card is built around.)
 */
function Marker({ multi, on }: { multi: boolean; on: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        flex: 'none',
        width: 16,
        height: 16,
        // The label's cap-height, not its line box — a marker centred on a
        // two-line option floats between the two lines.
        marginTop: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: multi ? CHAT.radius : '50%',
        border: `1.5px solid ${on ? CHAT.hold : CHAT.dim4}`,
        // Filled for a tick, hollow for a dot: a filled circle with a dot in it
        // is unreadable at 16px, and a hollow box with a tick floating in it is
        // the weaker of the two checkbox drawings.
        background: on && multi ? CHAT.hold : 'transparent',
        transition: '.12s'
      }}
    >
      {on &&
        (multi ? (
          // Dark ink, not `onAccent`. The box is filled with `hold`, which is a
          // *light* warm hue — the white a filled `--send` or `--accent` takes
          // has nothing to sit against here.
          <Check size={11} color="var(--on-accent2)" />
        ) : (
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: CHAT.hold }} />
        ))}
    </span>
  )
}

/**
 * One line of chrome above the composer: a sentence, then its buttons.
 *
 * It used to take a `column` prop for the question card to stack itself in.
 * That card is a dialog now and this is a row again — which is all it was ever
 * good at, and the reason the question outgrew it.
 */
function Bar({ hue, children }: { hue: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '11px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderTop: `2px solid ${hue}`,
        borderRadius: CHAT.radiusCard
      }}
    >
      {children}
    </div>
  )
}

// The app's one filled blue, same as "Add project" — this is the button that
// commits an answer, and there is no second primary anywhere in the window for
// it to be confused with.
function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    flex: 'none',
    height: 32,
    padding: '0 16px',
    border: 0,
    borderRadius: CHAT.radius,
    background: disabled ? CHAT.well : 'var(--accent)',
    color: disabled ? CHAT.dim2 : 'var(--accent-fg)',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer'
  }
}

const secondaryButton: React.CSSProperties = {
  flex: 'none',
  height: 32,
  padding: '0 16px',
  border: '1px solid var(--border-strong)',
  borderRadius: CHAT.radius,
  background: 'transparent',
  color: CHAT.dim,
  fontSize: 12.5,
  cursor: 'pointer'
}

/**
 * Pending chips and refusals share one surface. A refusal is the same chip in a
 * failed state, carrying its reason, and cannot be sent — the error attaches to
 * the thing that caused it, rather than to a toast that disappears while you are
 * reading it or a log row that never went to the model.
 */
function ChipStrip({
  chips,
  onRemove
}: {
  chips: PendingChip[]
  onRemove: (id: string) => void
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '8px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard
      }}
    >
      {chips.map((c) => (
        <div
          key={c.id}
          style={{
            display: 'flex',
            // `center`, not `baseline`: a thumbnail has no baseline to sit on, and
            // on a baseline row it hangs the whole line off its bottom edge.
            alignItems: 'center',
            gap: 9,
            fontFamily: MONO,
            fontSize: 11.5,
            color: c.ok ? CHAT.dim : CHAT.danger
          }}
        >
          {/* The picture rather than a glyph, and free: the composer already read
              the file to build the attachment, so the bytes are right here — no
              fetch, no handle, nothing to evict. This is the half of the preview
              that answers "did I attach the right screenshot", which is the
              question you have *before* pressing Enter. */}
          {c.ok && c.attachment.kind === 'image' ? (
            <img
              src={`data:${c.attachment.mediaType};base64,${c.attachment.data}`}
              alt=""
              style={{
                flex: 'none',
                width: 34,
                height: 34,
                objectFit: 'cover',
                borderRadius: CHAT.radius,
                border: `1px solid ${CHAT.borderCard}`,
                background: CHAT.inset
              }}
            />
          ) : (
            <span style={{ flex: 'none' }}>{c.ok ? '≡' : '⚠'}</span>
          )}
          <span style={{ color: CHAT.text }}>{c.ok ? c.attachment.name : c.name}</span>
          <span style={{ flex: 1, minWidth: 0, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.ok ? c.detail : c.reason}
          </span>
          <button
            onClick={() => onRemove(c.id)}
            style={{
              flex: 'none',
              border: 0,
              background: 'transparent',
              color: CHAT.dim3,
              cursor: 'pointer',
              padding: '0 4px'
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

/** One row of either typeahead. `node` is what marks it as a file rather than a command. */
export interface TypeaheadRow {
  key: string
  /** what is inserted, and what is shown in the bright column */
  name: string
  detail?: string
  node?: MountNode
}

/**
 * The rows behind the composer's two typeaheads.
 *
 * The `/` list is `slash_commands[]` + `skills[]`, showing **name and source
 * only** — `init` carries names and nothing else, so there are no descriptions,
 * no argument-hints, no per-command forms. Picking inserts `/name ` and
 * dismisses; everything after is free text, including the second `/foo` in
 * `/loop 5m /foo`. The composer never parses a command: every `/…` is forwarded
 * verbatim and whatever happens next is Claude Code's business, which is what
 * keeps this from rotting as the CLI ships new commands.
 *
 * Prefix matches sort first. Typing `co` means you are reaching for something
 * that *starts* `co`, and burying `compact` under `add-dir` because the latter
 * happens to contain the letters is what makes a list feel like it is not
 * listening.
 */
function typeaheadRows(
  menu: { kind: 'slash' | 'at'; query: string },
  commands: string[],
  tree: MountNode[]
): TypeaheadRow[] {
  const q = menu.query.toLowerCase()
  if (menu.kind === 'slash') {
    // Deduped: `init` reports `slash_commands[]` and `skills[]` separately and
    // the two overlap (`code-review`, `update-config` are both), so the raw
    // concatenation lists them twice — and React, keying on the name, warns
    // about it. One name is one row whichever list it came from; the CLI
    // decides what it means, exactly as the never-parse rule says.
    return [...new Set(commands.map((c) => c.replace(/^\//, '')))]
      .filter((c) => c.toLowerCase().includes(q))
      .sort((a, b) => {
        const rank = (s: string): number => (s.toLowerCase().startsWith(q) ? 0 : 1)
        return rank(a) - rank(b) || a.localeCompare(b)
      })
      .slice(0, 12)
      .map((c) => ({ key: c, name: `/${c}` }))
  }
  return flattenTree(tree)
    .filter((n) => n.type === 'file' && n.name.toLowerCase().includes(q))
    .slice(0, 12)
    .map((n) => ({ key: n.containerPath, name: n.name, detail: n.containerPath, node: n }))
}

/**
 * The list itself: rows, one highlight, and a line saying how to drive it.
 *
 * The highlight is `active`, which the composer owns — the keyboard and the
 * mouse move the same selection, so hovering row four and pressing Tab twice
 * takes row four rather than whatever the keyboard was pointing at privately.
 */
function Typeahead({
  rows,
  active,
  enterSends,
  onHover,
  onPick
}: {
  rows: TypeaheadRow[]
  active: number | null
  /** the highlighted row is already typed out, so Enter sends it as it stands */
  enterSends: boolean
  onHover: (i: number) => void
  onPick: (row: TypeaheadRow) => void
}): React.ReactElement {
  const activeRef = React.useRef<HTMLButtonElement>(null)
  // Twelve rows do not fit in 240px, so the highlight can be driven off the
  // bottom of the list — which reads as the arrows having stopped working. Only
  // `nearest`: a row already on screen must not move, or every mouse-move over
  // the list would jog it under the pointer.
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div
      style={{
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        overflow: 'hidden'
      }}
    >
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {rows.map((r, i) => {
          const on = i === active
          return (
            <button
              key={r.key}
              ref={on ? activeRef : undefined}
              onMouseMove={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown, not click: a blur would close this before the click.
                e.preventDefault()
                onPick(r)
              }}
              style={{
                display: 'flex',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                border: 0,
                borderLeft: `2px solid ${on ? CHAT.you : 'transparent'}`,
                background: on ? CHAT.hover : 'transparent',
                color: CHAT.dim,
                fontFamily: MONO,
                fontSize: 11.5,
                padding: '6px 14px',
                cursor: 'pointer'
              }}
            >
              <span style={{ color: on ? CHAT.text : CHAT.prose }}>{r.name}</span>
              {r.detail && (
                <span
                  style={{
                    color: CHAT.dim3,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {r.detail}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {/* The same argument as the composer's own footer: Tab and the arrows are
          free affordances that nobody can find, so they are written down once
          where they apply. */}
      <div
        style={{
          borderTop: `1px solid ${CHAT.borderSoft}`,
          padding: '4px 14px',
          fontFamily: MONO,
          fontSize: 11.5,
          color: CHAT.dim4
        }}
      >
        {active === null
          ? 'tab · ↑↓ select'
          : enterSends
            ? 'tab insert · ⏎ send · ↑↓ next · esc dismiss'
            : 'tab · ⏎ insert · ↑↓ next · esc dismiss'}
      </div>
    </div>
  )
}

/**
 * The chat's find bar.
 *
 * Its own component rather than a reuse of TerminalView's, because the two share
 * a shape and nothing else: that one drives an xterm addon over a canvas and
 * reports the addon's own occurrence index, this one drives a list of DOM rows
 * and reports a position in it. What they *do* share is the chord, the counter's
 * place, Enter / Shift+Enter and Esc — the muscle memory, which is the part worth
 * keeping identical.
 *
 * It takes layout at the top of the log rather than floating over it. The
 * terminal's has to float, because anything taking space there resizes the pty
 * and makes the TUI repaint; a chat has no such constraint, and a bar that
 * covers the first row of what you searched is a worse trade than 34 pixels.
 */
function ChatFindBar({
  query,
  inputRef,
  hits,
  at,
  clipped,
  earlier,
  onLoadEarlier,
  onTerm,
  onToggleCase,
  onStep,
  onClose
}: {
  query: FindQuery
  inputRef: React.RefObject<HTMLInputElement>
  hits: number
  at: number
  /** some tool body in the log is clipped, so its full text was not searched */
  clipped: boolean
  /** how many entries main holds that the renderer has not mounted */
  earlier: number
  onLoadEarlier: () => void
  onTerm: (term: string) => void
  onToggleCase: () => void
  onStep: (back: boolean) => void
  onClose: () => void
}): React.ReactElement {
  const empty = !query.term
  const none = !empty && hits === 0
  const counter = empty ? '' : none ? 'no matches' : `${at + 1}/${hits}`

  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `0 ${EDGE}px`,
        height: 34,
        background: CHAT.header,
        borderBottom: `1px solid ${CHAT.border}`
      }}
    >
      <span style={{ display: 'flex', color: CHAT.dim3, flex: 'none' }}>
        <Search size={13} />
      </span>
      <input
        ref={inputRef}
        value={query.term}
        autoFocus
        spellCheck={false}
        placeholder="Find in conversation"
        onChange={(e) => onTerm(e.target.value)}
        onKeyDown={(e) => {
          // Kept off the view root's capture handler and off the composer: while
          // this input has focus it owns every key it names.
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
          if (e.ctrlKey && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            inputRef.current?.select()
          }
        }}
        style={{
          width: 200,
          height: 24,
          background: 'transparent',
          border: 0,
          color: CHAT.text,
          fontFamily: MONO,
          fontSize: 12.5,
          padding: 0,
          outline: 'none',
          boxShadow: 'none'
        }}
      />
      <span
        style={{
          minWidth: 62,
          fontFamily: MONO,
          fontSize: 11.5,
          color: none ? CHAT.danger : CHAT.dim3,
          flex: 'none'
        }}
      >
        {counter}
      </span>
      <FindBtn title="Match case" active={query.caseSensitive} onClick={onToggleCase}>
        <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '.3px' }}>Aa</span>
      </FindBtn>
      <FindBtn title="Previous match (Shift+Enter)" onClick={() => onStep(true)}>
        <Chevron size={13} style={{ transform: 'rotate(-90deg)' }} />
      </FindBtn>
      <FindBtn title="Next match (Enter)" onClick={() => onStep(false)}>
        <Chevron size={13} style={{ transform: 'rotate(90deg)' }} />
      </FindBtn>

      <div style={{ flex: 1 }} />

      {/* What was *not* searched, stated rather than left to be discovered. Both
          notes are about the same thing — the renderer holds a clipped view of a
          conversation main holds whole — and both offer the one action that
          widens it. */}
      {earlier > 0 && (
        <button
          onClick={onLoadEarlier}
          title="Earlier messages are not loaded, so they were not searched"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            border: `1px solid ${CHAT.border}`,
            background: 'transparent',
            color: CHAT.dim3,
            padding: '2px 8px',
            cursor: 'pointer',
            flex: 'none'
          }}
        >
          {earlier} earlier not searched
        </button>
      )}
      {clipped && (
        <span
          title="A long tool result is clipped until you expand it; only the part on screen was
            searched."
          style={{ fontFamily: MONO, fontSize: 11, color: CHAT.dim4, flex: 'none' }}
        >
          clipped bodies skipped
        </span>
      )}
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
      // The bar's input stays focused through a button press, so Enter keeps
      // stepping after you have clicked one.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        border: 0,
        background: active ? CHAT.hover : hover ? CHAT.inset : 'transparent',
        color: active || hover ? CHAT.text : CHAT.dim2,
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

/**
 * The turn outline: what you asked, in order, as a rail you can jump from.
 *
 * `MOUNT_WINDOW` is 300 entries with a "load earlier" behind it, and a long
 * conversation is scrollable but not navigable — the revert picker already
 * proved the useful shape (your own messages, in order, each addressable) and
 * this is that list without the destructive verb.
 *
 * It reaches exactly as far back as the log is loaded, which is the same honest
 * boundary the revert picker draws, and for the same reason: both are derived
 * from `entries` rather than fetched.
 *
 * **Not zoomed.** `chatZoom` scales the log and the composer because they are
 * the thing being read; the rail is chrome, and a 220% index would take half the
 * window to say the same thing. It does take the zoom as a prop to size its own
 * width against — a rail that stayed 240px while the text beside it doubled
 * would read as having shrunk.
 */
function Outline({
  turns,
  clocks,
  activeId,
  zoom,
  onPick,
  onClose
}: {
  turns: { id: string; at: number; text: string; turn: number }[]
  clocks: Map<number, { durationMs?: number; tokens?: number }>
  /** the current find hit, so the rail agrees with the log about where you are */
  activeId: string | null
  zoom: number
  onPick: (id: string) => void
  onClose: () => void
}): React.ReactElement {
  return (
    <div
      className="vchat-scroll"
      style={{
        flex: 'none',
        width: Math.round(248 * Math.min(zoom, 1.4)),
        overflowY: 'auto',
        borderLeft: `1px solid ${CHAT.border}`,
        background: CHAT.header
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 12px',
          height: 34,
          position: 'sticky',
          top: 0,
          background: CHAT.header,
          borderBottom: `1px solid ${CHAT.border}`,
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          color: CHAT.dim3
        }}
      >
        outline
        <span style={{ color: CHAT.dim4, letterSpacing: 0, textTransform: 'none' }}>
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
        </span>
        <div style={{ flex: 1 }} />
        <FindBtn title="Hide outline" onClick={onClose}>
          <Close size={12} />
        </FindBtn>
      </div>
      {turns.map((t) => {
        const clock = clocks.get(t.turn)
        const on = t.id === activeId
        return (
          <button
            key={t.id}
            onClick={() => onPick(t.id)}
            title={t.text}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 0,
              borderLeft: `2px solid ${on ? CHAT.you : 'transparent'}`,
              background: on ? CHAT.hover : 'transparent',
              padding: '7px 10px 8px 12px',
              cursor: 'pointer',
              // A rail is a list of siblings; without this each row's bottom
              // edge is the next one's top edge and the whole thing reads as one
              // block of text.
              borderBottom: `1px solid ${CHAT.borderSoft}`
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: 8,
                fontFamily: MONO,
                fontSize: 10.5,
                color: CHAT.dim4,
                marginBottom: 3
              }}
            >
              <span>{clockOf(t.at)}</span>
              {/* Only once the turn has finished. A running turn has no duration
                  to report and the log's own clock is already saying so. */}
              {clock?.durationMs !== undefined && (
                <span>{Math.round(clock.durationMs / 1000)}s</span>
              )}
              {clock?.tokens ? <span>↓{tok(clock.tokens)}</span> : null}
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                color: on ? CHAT.text : CHAT.dim,
                // Two lines, then an ellipsis: enough to tell two turns apart,
                // never enough for one long prompt to own the rail.
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                overflowWrap: 'anywhere'
              }}
            >
              {t.text.trim() || '(no text)'}
            </div>
          </button>
        )
      })}
      {turns.length === 0 && (
        <div style={{ padding: '18px 12px', fontFamily: MONO, fontSize: 11.5, color: CHAT.dim4 }}>
          Nothing asked yet.
        </div>
      )}
    </div>
  )
}
