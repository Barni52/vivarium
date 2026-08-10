import React from 'react'
import type { ChatEntry, ChatToolStatus, ChatTurnTokens } from '@shared/types'
import { CHAT, CHAT_TEXT as TYPE, MONO } from '../../theme'
import { Hi } from './find'
import { Elapsed } from '../Elapsed'
import { Md, Preview, clock } from './Markdown'
import { langForPath, tokenize } from './highlight'

// The transcript, built to `docs/redisign/Chat Terminal.html`.
//
// **Stacked rows**: `hh:mm  role` on its own line, then the message at the full
// width of the column. It was a two-column grid — an 84px gutter and the message
// beside it — and the column cost every row of every message 98px of left margin
// so that two words could sit in the first line of it. On a paragraph that wraps
// four times, the other three lines paid for nothing at all. Stacking is also
// what makes the row width the *window's* width, which is the same argument
// CHAT_EDGE already made against the 880px reading measure this used to sit in:
// the horizontal space belongs to the content, and how much of it there is is
// the user's call, made by sizing the window.
//
// The cost is a line of height per row, and it is paid where it is cheapest: the
// meta line is the smallest type in the window and it replaces the vertical
// padding a row used to need to be told apart from its neighbour (ROW_PAD).
//
// **The three families are told apart by treatment, not by the role word.** That
// was the bug: one grey mono line each, differing only in a word most of which
// are five characters long.
//
//   you     — a raised `--card` bubble across the full row width, `--role-you`
//             role word. It is what the eye finds when scrolling back.
//   claude  — no bubble at all: bare `--bg`, `--accent2` role word, 1.55 leading.
//             The page itself, which is what most of the log is.
//   the rest — bordered mono cards on `CHAT.inset`. Tool calls, command output,
//             plans, clocks and stops all live in that one family, so a burst of
//             twelve of them reads as one block of machinery.

/**
 * Row padding, and the meta line → content gap.
 *
 * Tighter than the mockup's `16px 18px` in both directions. Horizontally every
 * one of these numbers is spent *twice* before a word of prose appears — the page
 * padding, then the row's — and it used to be four times, because a gutter column
 * and its gap came next.
 *
 * Vertically it is 6, padding on *both* sides of every row, so the space between
 * two rows is 12. It was 9 (and 16 before that, which read as a document rather
 * than a conversation) while the row was one line tall at the top; now every row
 * opens with its own meta line, and *that* is what separates it from the row
 * above — so the padding that used to do the job can come back out. The tool
 * cards carry their own edges too.
 */
const ROW_PAD = '6px 10px'
const META_GAP = 3

/**
 * How far a subagent's sub-log is inset from the row that spawned it.
 *
 * It used to be the gutter's width plus a bit — the rail sat under the boundary
 * the two columns shared. With no column there is no boundary to hang it off, and
 * the indent only has to say "these rows belong to the card above": 12 clears the
 * row's own 10px padding by enough for the rail to read as a step in rather than
 * as a second left edge.
 */
const SUB_INDENT = 12

const mono: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: TYPE.mono,
  lineHeight: 1.5
}

/**
 * One log row: the meta line, then the message under it at full width.
 *
 * `band` is what a `you` row wears — a real `--card` bubble now, one step up
 * from the page. It used to be a white lift at 4%, chosen so it would read the
 * same whatever hue the role word was set to; with a palette that has a surface
 * *for* this, the lift is just a weaker way of drawing the same thing.
 *
 * Everything else sits on bare `--bg` with no surface at all, which is the whole
 * of the treatment: what Claude said is the page, what you said is on top of it,
 * and the machinery is in bordered cards. Role words are 500 weight in their own
 * hue, behind a `--dim` timestamp — the one place in the log where colour and
 * weight are both spent on four characters.
 */
function Line({
  at,
  role,
  color,
  band = false,
  children
}: {
  at: number
  role: string
  color?: string
  /** the raised bubble that marks a turn you started */
  band?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      style={{
        padding: ROW_PAD,
        background: band ? CHAT.band : undefined,
        // Only the bubble has an edge to round; every other row is a transparent
        // block on the page and a radius on it would draw nothing.
        borderRadius: band ? CHAT.radiusCard : undefined
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          marginBottom: META_GAP,
          fontFamily: MONO,
          fontSize: TYPE.gutter,
          // Its own leading, not the block's: this line is a label on the row
          // below it, and the 1.5 the mono scale carries put visible air between
          // the two that read as a gap rather than as a pair.
          lineHeight: 1.2,
          userSelect: 'none'
        }}
      >
        <span style={{ color: CHAT.dim4 }}>{clock(at)}</span>
        <span style={{ color: color ?? CHAT.dim2, fontWeight: 500 }}>{role}</span>
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}

/**
 * The machinery card: a bordered mono box on the panel fill.
 *
 * Everything that is not a person talking renders in one of these — the mockup
 * draws it once, for `model set to haiku-4 (…)`, and the argument generalises:
 * a tool call, a command's output and a turn clock are all the app reporting on
 * itself, and giving each its own chrome is how the log stopped being readable.
 */
function Card({
  children,
  tone,
  onClick,
  title
}: {
  children: React.ReactNode
  /** left marker colour; omitted for the ordinary case */
  tone?: string
  onClick?: () => void
  title?: string
}): React.ReactElement {
  return (
    <div
      onClick={onClick}
      title={title}
      // What makes a card that can be opened light up under the pointer. A div
      // rather than a button because it wraps block content (a diff, a body) a
      // button may not contain, so it misses the `.vchat button:hover` rule and
      // has to opt in by hand. Never set when there is nothing to click.
      data-click={onClick ? '' : undefined}
      style={{
        ...mono,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        // **Nothing in this row may be `flex: none` *and* long.** A flex item's
        // automatic minimum size is its own content, so a child that cannot
        // break — a 200-character error, a path with no spaces — used to push
        // the row wider than the card and paint straight through its border.
        // Every long child below therefore carries `minWidth: 0` and wraps
        // (`overflowWrap: anywhere`) or ellipsises; this one is for the case
        // where the card is itself a flex item in some future wrapper.
        minWidth: 0,
        padding: '8px 12px',
        // `--card2`, not `--card`: the `you` bubble is the raised surface in this
        // log and a tool card is an *inset* one, so they must not be the same
        // fill. The hairline is what makes it a card at all.
        background: CHAT.inset,
        border: `1px solid ${tone ?? CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        color: CHAT.dim,
        cursor: onClick ? 'pointer' : undefined
      }}
    >
      {children}
    </div>
  )
}

export interface LogHandlers {
  /** expand a clipped tool body (main holds the full text) */
  onExpand: (entryId: string) => void
  /** expand a subagent row into its own sub-log */
  onExpandTask: (toolUseId: string, agentId: string | null) => void
  /** full bodies that have already been fetched */
  bodies: Record<string, string>
  subagents: Record<string, ChatEntry[]>
  /** the one Retry, offered by a crash / timeout row and by the read banner */
  onRetry: () => void
}

/**
 * Memoised, and that is not a micro-optimisation.
 *
 * A streaming turn upserts the row it is filling ~25 times a second, and every
 * one of those is a new `entries` array in the store. Without this, each of them
 * re-rendered *every* row in the log — including the settled markdown above,
 * which now costs a parse — and the answer arrived in visible steps. Rows are
 * value objects the store replaces rather than mutates, so identity is an exact
 * test for "did this row change", and `handlers` is memoised in ChatView for
 * this to have anything to hold on to.
 */
export const LogRow = React.memo(function LogRow({
  entry,
  handlers,
  depth = 0,
  streaming = false
}: {
  entry: ChatEntry
  handlers: LogHandlers
  depth?: number
  /** this is the row the running turn is writing into — reveal it smoothly */
  streaming?: boolean
}): React.ReactElement | null {
  switch (entry.kind) {
    case 'text':
      if (entry.role === 'you') {
        return (
          <Line at={entry.at} role="you" color={CHAT.you} band>
            {entry.md && (
              <div
                style={{
                  fontSize: TYPE.prose,
                  lineHeight: TYPE.proseLine,
                  color: CHAT.text,
                  whiteSpace: 'pre-wrap',
                  // `pre-wrap` breaks at spaces and nowhere else, and half of
                  // what gets pasted into a composer has none — a URL, a
                  // Windows path, a stack frame — so the message ran straight
                  // out through the right edge of its own tinted band. This
                  // breaks only what would not fit, so ordinary prose is
                  // untouched.
                  overflowWrap: 'anywhere'
                }}
              >
                <Hi>{entry.md}</Hi>
              </div>
            )}
            {entry.chips && entry.chips.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  flexWrap: 'wrap',
                  marginTop: entry.md ? 10 : 0,
                  fontFamily: MONO,
                  fontSize: TYPE.gutter,
                  color: CHAT.dim3
                }}
              >
                {entry.chips.map((c, i) => (
                  <span key={`${c.name}-${i}`} title={c.detail}>
                    {c.kind === 'image' ? '▣' : c.kind === 'path' ? '≡' : '⌘'} {c.name}
                  </span>
                ))}
              </div>
            )}
          </Line>
        )
      }
      return <ClaudeText entry={entry} streaming={streaming} />

    case 'thinking':
      return <Thinking at={entry.at} md={entry.md} />

    case 'tool':
      return <ToolCard entry={entry} handlers={handlers} />

    case 'cmd':
      // A Skill's body (`/name`) is markdown the model wrote; a *local* command's
      // stdout has no title and is terminal output — `/context` draws an ASCII
      // meter, and reflowing that into a paragraph is how it used to render.
      return (
        <Line at={entry.at} role="cmd" color={CHAT.dim2}>
          {entry.title ? (
            <>
              <Card>{entry.title}</Card>
              <Md src={entry.md} />
            </>
          ) : (
            <Card>
              {/* Terminal output, so it keeps its own line breaks — but a
                  `/context` meter or a `git log --oneline` line is routinely
                  wider than the card, and `pre-wrap` alone would carry it out
                  through the border. */}
              <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                <Hi>{entry.md}</Hi>
              </span>
            </Card>
          )}
          {entry.truncated && <div style={{ ...mono, color: CHAT.dim3, marginTop: 4 }}>…</div>}
        </Line>
      )

    case 'ask':
      // Once answered the chosen option keeps a tick while the rest go grey: the
      // options not taken are the record of what the decision was between.
      //
      // Three things the chips alone leave out, and all three are decisions the
      // record has to keep: whether the question took one answer or several
      // (`choose any` vs a single tick reads as a *failed* multi-select
      // otherwise), an **Other** answer, which is a value matching no option and
      // so ticks nothing at all, and the notes typed against it. The chosen
      // option's **preview** is here too, because it is what the model was
      // shown — it travels back in `annotations[question].preview`.
      return (
        <Line at={entry.at} role="ask" color={CHAT.hold}>
          {entry.questions.map((q, qi) => {
            const answer = entry.answers.find((a) => a.question === q.question)
            const values = answer?.values ?? []
            const typed = values.filter((v) => !q.options.some((o) => o.label === v))
            const preview = q.options.find((o) => values.includes(o.label))?.preview
            return (
              <div key={qi} style={{ marginBottom: 10 }}>
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
                        fontSize: 10,
                        letterSpacing: '.04em',
                        textTransform: 'uppercase',
                        padding: '2px 6px',
                        border: `1px solid ${CHAT.border}`,
                        borderRadius: CHAT.radius,
                        color: CHAT.hold,
                        flex: 'none'
                      }}
                    >
                      {q.header}
                    </span>
                  )}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflowWrap: 'anywhere',
                      fontSize: TYPE.prose,
                      lineHeight: TYPE.proseLine,
                      color: CHAT.prose
                    }}
                  >
                    {q.question}
                  </span>
                  <span style={{ ...mono, fontSize: TYPE.gutter, color: CHAT.dim4 }}>
                    {q.multiSelect ? 'choose any' : 'choose one'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {q.options.map((o) => {
                    const picked = values.includes(o.label)
                    return (
                      <span
                        key={o.label}
                        title={o.description}
                        style={{
                          fontFamily: MONO,
                          fontSize: TYPE.mono,
                          padding: '5px 11px',
                          border: `1px solid ${picked ? CHAT.hold : CHAT.border}`,
                          borderRadius: CHAT.radius,
                          color: picked ? CHAT.text : CHAT.dim3,
                          background: picked ? CHAT.inset : 'transparent'
                        }}
                      >
                        {picked ? '✓ ' : ''}
                        {o.label}
                      </span>
                    )
                  })}
                  {typed.map((t) => (
                    <span
                      key={t}
                      title="answered in the user's own words"
                      style={{
                        fontFamily: MONO,
                        fontSize: TYPE.mono,
                        padding: '5px 11px',
                        border: `1px dashed ${CHAT.hold}`,
                        borderRadius: CHAT.radius,
                        color: CHAT.text,
                        background: CHAT.inset
                      }}
                    >
                      ✓ {t}
                    </span>
                  ))}
                </div>
                {answer?.notes && (
                  <div style={{ ...mono, color: CHAT.dim3, marginTop: 6 }}>
                    notes: {answer.notes}
                  </div>
                )}
                {preview && (
                  // Capped here, unlike in the pinned card: this is history, and
                  // a 28-line mockup would otherwise own the log every time you
                  // scrolled past the decision it belongs to.
                  <div
                    style={{
                      marginTop: 8,
                      maxHeight: 300,
                      overflow: 'auto',
                      padding: '6px 12px',
                      background: CHAT.inset,
                      border: `1px solid ${CHAT.borderCard}`,
                      borderRadius: CHAT.radiusCard
                    }}
                  >
                    <Preview src={preview} />
                  </div>
                )}
              </div>
            )
          })}
        </Line>
      )

    case 'plan':
      // The body renders here, in its place in time, so the transcript stays a
      // complete record; the *buttons* are pinned above the composer, so a
      // decision cannot scroll away behind twenty tool calls.
      return (
        <Line at={entry.at} role="plan" color={CHAT.hold}>
          <div
            style={{
              background: CHAT.inset,
              border: `1px solid ${CHAT.borderCard}`,
              borderLeft: `2px solid ${CHAT.hold}`,
              borderRadius: CHAT.radiusCard,
              padding: '4px 15px 12px',
              opacity: entry.state === 'cancelled' ? 0.7 : 1
            }}
          >
            <Md src={entry.md} />
            {entry.state !== 'pending' && (
              <div style={{ ...mono, color: CHAT.dim3, marginTop: 6 }}>{entry.state}</div>
            )}
          </div>
        </Line>
      )

    case 'task':
      return <TaskRow entry={entry} handlers={handlers} depth={depth} />

    case 'todo':
      // Always one line — it changed nothing on disk; the *fold* (current state)
      // is the strip above the composer.
      return (
        <Line at={entry.at} role="todo" color={CHAT.dim2}>
          <div style={{ ...mono, color: CHAT.dim3, paddingTop: 3 }}>
            <Hi>{entry.text}</Hi>
          </div>
        </Line>
      )

    case 'stop':
      // Muted for an interrupt, red for a crash. Colour in this chrome means
      // *attend to this*; an interrupt is something the user just did, so it
      // earns a role word and nothing more.
      return (
        <Line
          at={entry.at}
          role="stop"
          color={entry.tone === 'alert' ? CHAT.danger : CHAT.stop}
        >
          <Card tone={entry.tone === 'alert' ? CHAT.danger : undefined}>
            {/* A crash row carries the CLI's own message, which can be a whole
                paragraph with a path in it — it wraps inside the card rather
                than running past the retry button. */}
            <span
              style={{
                minWidth: 0,
                overflowWrap: 'anywhere',
                color: entry.tone === 'alert' ? CHAT.danger : CHAT.dim
              }}
            >
              <Hi>{entry.text}</Hi>
            </span>
            {entry.retry && (
              // Never automatic: a respawn costs a process and a 14.6 MB-class
              // transcript read, and a crash loop that retried itself would be
              // invisible. The 60s-timeout row especially — a genuinely wedged
              // CLI would otherwise be respawned every minute all day.
              <button
                onClick={handlers.onRetry}
                style={{
                  ...mono,
                  marginLeft: 'auto',
                  border: `1px solid ${CHAT.border}`,
                  background: 'transparent',
                  color: CHAT.dim2,
                  padding: '2px 10px',
                  cursor: 'pointer'
                }}
              >
                retry
              </button>
            )}
          </Card>
        </Line>
      )

    case 'divider':
      // No meta line and no `Line`: a divider is not something anybody said, and
      // it now starts where every row's text starts without a spacer column to
      // hold it there.
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px' }}>
          <span style={{ ...mono, color: CHAT.dim3, flex: 'none' }}>{entry.text}</span>
          <span style={{ flex: 1, height: 1, background: CHAT.borderSoft }} />
        </div>
      )

    case 'turn':
      // The turn clock, in the log where the eye already is — live while the turn
      // runs, frozen in place at `result`. Not a header chip: the header is three
      // readings and no fourth, and a separate activity lane was the thing an
      // earlier variant lost on.
      return (
        <Line at={entry.at} role="run" color={CHAT.dim2}>
          <Card>
            {entry.durationMs === undefined ? (
              <>
                <Dots />
                <span>working ·</span>
                <Elapsed since={entry.startedAt} />
                <Tokens tokens={entry.tokens} />
                {/* Discoverability for interrupt, on screen exactly when it is
                    usable and nowhere else. */}
                <span style={{ color: CHAT.dim3 }}>· esc interrupts</span>
              </>
            ) : (
              <span>
                done · <Elapsed since={0} until={entry.durationMs} />{' '}
                <Tokens tokens={entry.tokens} />
              </span>
            )}
          </Card>
        </Line>
      )
  }
})

/** How often the reveal advances. 30 fps — text has no motion to alias. */
const REVEAL_TICK = 33
/**
 * How long the reveal takes to catch up with whatever is outstanding.
 *
 * Measured on the host against `claude -p --include-partial-messages`: prose
 * arrives in **~68-character jumps about every 460 ms**, nine paint steps for a
 * 554-character paragraph. That cadence is Claude Code's, not this app's — the
 * frames really do land that far apart — and it is the whole of "streaming feels
 * choppy": the log lurches a line and a half at a time and then sits still.
 * Coalescing on main cannot help, because the source is already coarser than any
 * window worth batching over.
 *
 * So the buffer is drained at a steady rate instead. 420 ms is deliberately just
 * under the observed arrival interval: each chunk finishes revealing a moment
 * before the next one lands, which is continuous motion rather than a typewriter
 * that visibly falls behind. It is a *rate*, not a delay — a big chunk drains
 * proportionally faster, so the text on screen can never lag the model by more
 * than one interval however fast the model goes.
 */
const REVEAL_CATCHUP = 420

/**
 * The one row a running turn is writing into, revealed at a steady rate.
 *
 * It starts from whatever the row already held when it mounted and smooths only
 * what arrives *after* — so a chat reopened mid-turn, a settle, and every row of
 * history paint instantly, and nothing ever re-types itself.
 */
function ClaudeText({
  entry,
  streaming
}: {
  entry: Extract<ChatEntry, { kind: 'text' }>
  streaming: boolean
}): React.ReactElement {
  const target = entry.md
  const [shown, setShown] = React.useState(target.length)

  React.useEffect(() => {
    // The turn ended (or this was never the live row): everything is on screen.
    // A typewriter still running after the answer is finished is worse than no
    // smoothing at all.
    //
    // `shown` is caught up rather than just left alone, because it outlives the
    // turn. The reveal is a *rate*, so it is always a little behind when the
    // answer lands — freezing it there left the row holding a count from the
    // middle of a paragraph it has since painted whole, and anything that
    // flagged the row `streaming` again read that count as "start from here" and
    // re-typed the rest. Nothing may re-type itself; this is what makes that
    // true after the first render as well as at it.
    if (!streaming) {
      if (shown < target.length) setShown(target.length)
      return
    }
    if (shown >= target.length) return
    const t = setInterval(() => {
      setShown((n) => {
        if (n >= target.length) return target.length
        const behind = target.length - n
        return Math.min(target.length, n + Math.max(1, Math.ceil((behind * REVEAL_TICK) / REVEAL_CATCHUP)))
      })
    }, REVEAL_TICK)
    return () => clearInterval(t)
  }, [streaming, target, shown])

  const md = streaming ? target.slice(0, Math.min(shown, target.length)) : target
  return (
    <Line at={entry.at} role="claude" color={CHAT.claude}>
      <Md src={md} />
    </Line>
  )
}

/** Three-dot working indicator, reusing the app's existing vthink keyframes. */
export function Dots({ color = CHAT.you }: { color?: string }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', flex: 'none' }}>
      {[0, 1, 2].map((n) => (
        <span
          key={n}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: color,
            animation: `vthink 1.1s ${n * 0.16}s infinite ease-in-out`
          }}
        />
      ))}
    </span>
  )
}

/**
 * Thinking sits on the `claude` row in the mockup — one italic line with a
 * `show` on the right, above the prose it led to. It keeps its own row here
 * because main emits it as its own entry, but it wears the same clothes.
 */
function Thinking({ at, md }: { at: number; md: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const first = md.trim().split('\n')[0] ?? ''
  return (
    <Line at={at} role="claude" color={CHAT.claude}>
      <div
        onClick={() => setOpen(!open)}
        data-click
        style={{ display: 'flex', alignItems: 'baseline', gap: 9, cursor: 'pointer', userSelect: 'none' }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: TYPE.prose - 1,
            fontStyle: 'italic',
            // A token, not a hex: this was the one colour in the log mixed by
            // eye against the old page, so it was also the only one that did
            // not move when the page did.
            color: CHAT.dim3,
            lineHeight: 1.6,
            whiteSpace: open ? 'pre-wrap' : 'nowrap',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {open ? md : first}
        </div>
        <div style={{ flex: 'none', fontFamily: MONO, fontSize: TYPE.gutter, color: CHAT.dim3 }}>
          {open ? 'hide' : 'show'}
        </div>
      </div>
    </Line>
  )
}

function statusColor(status: ChatToolStatus): string {
  if (status === 'error') return CHAT.danger
  return CHAT.dim2
}

/**
 * How tall a body may be and still open itself.
 *
 * The rule below is "show me what changed, don't bury the conversation", and
 * past about fifteen lines a card stops doing the first and starts doing the
 * second: one 300-line diff pushes the answer that explains it off the top of
 * the window, and scrolling back through a turn becomes scrolling through its
 * machinery. Fifteen is roughly a card that still reads as an inset in a page
 * rather than as a page of its own.
 */
const AUTO_OPEN_LINES = 15

/** Lines in a body, without splitting the whole string to count them. */
function lineCount(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * **Open by default and truncated — inverted from the obvious default.** An edit
 * shows its diff and a command shows the tail of its output; a read and a search
 * collapse to their card. A read changed nothing; a diff is what you scrolled
 * back for. Collapse-everything was rejected for making the common case a click.
 *
 * The exception is size (AUTO_OPEN_LINES), and it is the same argument rather
 * than a retreat from it: a body only shows what changed while it is small
 * enough to be read in place.
 */
function ToolCard({
  entry,
  handlers
}: {
  entry: Extract<ChatEntry, { kind: 'tool' }>
  handlers: LogHandlers
}): React.ReactElement {
  const full = handlers.bodies[entry.id]
  const text = full ?? entry.body.text
  const expandable = entry.body.kind !== 'none' && !!entry.body.text
  const lines = lineCount(entry.body.text)
  const quiet =
    entry.role === 'read' ||
    entry.body.kind === 'none' ||
    // A cancelled card collapses: its synthetic result carries only the refusal
    // sentence, so an open card would be a card showing nothing.
    entry.status === 'cancelled' ||
    // `truncated` means main already clipped it, so it is longer than whatever
    // this counts — a body that long is never opened for you.
    entry.body.truncated ||
    lines > AUTO_OPEN_LINES

  /**
   * `null` until you touch it, and that is what makes the size rule work at all.
   *
   * A tool card mounts while the call is still *running*, with no body and no
   * length to judge — `useState(!quiet)` read that empty body once and kept the
   * answer, so every card that finished after it appeared opened itself however
   * long the output turned out to be. Deriving the default instead lets the
   * result decide when it lands, while a click still wins for good: the entry is
   * replaced wholesale at the turn's settle, and a flag on the entry would have
   * been thrown away with it.
   */
  const [choice, setChoice] = React.useState<boolean | null>(null)
  const open = choice ?? !quiet

  /**
   * A diff's rows, with the `+`/`-`/` ` sign split off and the rest highlighted.
   *
   * The language comes off `entry.title`, which for `Edit`/`Write`/`MultiEdit`/
   * `NotebookEdit` **is** the file path (see `toolTitle` in `chatMapper`), so
   * nothing new has to cross the wire to know that a body is Java.
   *
   * Each line is tokenized on its own rather than the body being treated as one
   * document, and that is the honest reading: a diff is non-contiguous hunks, so
   * a `/*` opened in one hunk has no business colouring the next. The cost is
   * that a genuinely multi-line string inside a single hunk loses its colour
   * after the first row, which is the smaller of the two wrongs.
   *
   * The sign keeps its own span so the columns still line up — it is structure,
   * not code, and feeding it to the tokenizer would make `-foo` a subtraction.
   */
  const rows = React.useMemo(() => {
    if (entry.body.kind !== 'diff') return []
    const lang = langForPath(entry.title)
    return text.split('\n').map((l) => {
      const sign = l[0] === '+' || l[0] === '-' ? l[0] : ''
      return { sign, toks: tokenize(sign ? l.slice(1) : l, lang) }
    })
  }, [entry.body.kind, entry.title, text])

  const toggle = (): void => {
    if (!expandable) return
    if (!open && entry.body.truncated) handlers.onExpand(entry.id)
    setChoice(!open)
  }

  return (
    <Line at={entry.at} role={entry.role} color={CHAT.dim2}>
      <Card onClick={expandable ? toggle : undefined}>
        <span
          style={{
            color: CHAT.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          <Hi>{entry.title}</Hi>
        </span>
        {entry.status === 'running' ? (
          <>
            <Dots />
            {/* A tool running past ~2s shows a number, so a fast Read never
                flickers one. */}
            <SlowClock since={entry.at} />
          </>
        ) : (
          // Allowed to shrink and to wrap, unlike the two chips beside it: a
          // result is usually `12 lines` but on a failure it is the tool's own
          // error sentence, which is as long as it is and has no reason to fit.
          <span
            style={{
              color: statusColor(entry.status),
              flex: '0 1 auto',
              minWidth: 0,
              overflowWrap: 'anywhere'
            }}
          >
            <Hi>{entry.result}</Hi>
          </span>
        )}
        {expandable && (
          <span style={{ marginLeft: 'auto', flex: 'none', fontSize: TYPE.gutter, color: CHAT.dim3 }}>
            {/* A card that closed itself says how much it is holding, or the
                size rule reads as the app having lost the output. `+` where main
                clipped the body: this counts what arrived, not what exists. */}
            {open
              ? 'hide'
              : lines > AUTO_OPEN_LINES
                ? `show ${lines}${entry.body.truncated ? '+' : ''} lines`
                : 'show'}
          </span>
        )}
      </Card>

      {open && entry.body.kind === 'diff' && (
        <div
          style={{
            ...mono,
            marginTop: 6,
            border: `1px solid ${CHAT.borderCard}`,
            background: CHAT.inset,
            borderRadius: CHAT.radiusCard,
            // The rounded corner has to clip the tinted rows, or a `+` line at
            // the top of a diff paints its green back into the square corner.
            overflow: 'hidden',
            overflowX: 'auto'
          }}
        >
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                whiteSpace: 'pre',
                // **A row is as wide as the widest row, not as wide as the
                // box.** These are blocks inside a horizontal scroller, so left
                // alone each one is exactly the *visible* width — scroll right
                // along a long changed line and its green stopped dead at the
                // fold, with the code continuing over bare card. `max-content`
                // sizes the row to its own text and `minWidth: 100%` keeps the
                // short ones spanning the box, so the tint always runs the full
                // length of the line it marks.
                width: 'max-content',
                minWidth: '100%',
                background:
                  r.sign === '+'
                    ? 'var(--ins-soft)'
                    : r.sign === '-'
                      ? 'var(--del-soft)'
                      : 'transparent',
                // What the sign and any uncoloured token inherit — full prose on a
                // changed line, dim on the context around it, the same two greys
                // the rows had before any of them were highlighted.
                color: r.sign ? CHAT.prose : CHAT.dim3,
                padding: '0 10px'
              }}
            >
              {/* A blank line still needs a space, or the row collapses and the
                  diff loses the gap between hunks. */}
              {r.sign || (r.toks.length ? null : ' ')}
              {r.toks.map((t, n) =>
                t.color ? (
                  <span key={n} style={{ color: t.color }}>
                    {t.text}
                  </span>
                ) : (
                  t.text
                )
              )}
            </div>
          ))}
          {entry.body.truncated && !full && (
            <div style={{ padding: '2px 10px', color: CHAT.dim3 }}>…</div>
          )}
        </div>
      )}

      {open && entry.body.kind === 'text' && (
        <div
          style={{
            ...mono,
            marginTop: 6,
            padding: '9px 12px',
            border: `1px solid ${CHAT.borderCard}`,
            background: CHAT.inset,
            borderRadius: CHAT.radiusCard,
            color: CHAT.dim,
            whiteSpace: 'pre-wrap',
            overflowX: 'auto'
          }}
        >
          <Hi>{text}</Hi>
        </div>
      )}
    </Line>
  )
}

/**
 * `41200` → `41.2k`. One decimal below 100k, none above — the same rule the
 * header meter's reading uses, and for the same reason: these are numbers you
 * watch climb, and rounding 41 200 to `41k` hides every change until the next
 * thousand lands.
 */
function tok(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return k < 100 ? `${Math.round(k * 10) / 10}k` : `${Math.round(k)}k`
}

/**
 * What the turn has cost, beside the clock that is already reporting on it.
 *
 * **Output tokens, and the arrow says so.** The other three readings are in the
 * tooltip because they cannot be added into one number honestly: the whole
 * context is re-sent with every message of a turn, so a summed input reads as a
 * cost the turn did not incur, and the context meter in the header is already the
 * answer to "how full is the window". Output is the one that only ever means work
 * this turn produced.
 *
 * Absent until the first message of the turn reports (`ChatTurnTokens` explains
 * why that is per message and not per token), and it renders nothing at all
 * rather than a `0` — a zero would read as a claim, where nothing reads as "not
 * yet", which is what it is.
 */
function Tokens({ tokens }: { tokens?: ChatTurnTokens }): React.ReactElement | null {
  if (!tokens || tokens.output === 0) return null
  const title = [
    `${tok(tokens.output)} output`,
    `${tok(tokens.input)} input`,
    `${tok(tokens.cacheRead)} cache read`,
    `${tok(tokens.cacheCreation)} cache write`
  ].join(' · ')
  // The separator is the span's own, exactly like the `· esc interrupts` sibling
  // beside it: inside `Card` these are flex children with a 10px gap, so a leading
  // space of its own would set this one reading further out than that one.
  return <span title={`${title} — this turn, subagents excluded`}>{`· ↓ ${tok(tokens.output)} tokens`}</span>
}

/** A duration that appears only once the call is genuinely slow. */
function SlowClock({ since }: { since: number }): React.ReactElement | null {
  const [show, setShow] = React.useState(Date.now() - since > 2000)
  React.useEffect(() => {
    if (show) return
    const t = setTimeout(() => setShow(true), 2000)
    return () => clearTimeout(t)
  }, [show])
  if (!show) return null
  return <Elapsed since={since} style={{ ...mono, color: CHAT.dim3 }} />
}

/**
 * One `task` row that expands into its own sub-log.
 *
 * The filesystem hands us exactly this shape, which is the reason to trust it:
 * the parent transcript already *is* the collapsed view, and the sibling file
 * already *is* the expansion. The sub-log nests — a subagent's own subagent is
 * another task row that expands the same way, with no depth cap.
 */
function TaskRow({
  entry,
  handlers,
  depth
}: {
  entry: Extract<ChatEntry, { kind: 'task' }>
  handlers: LogHandlers
  depth: number
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const sub = handlers.subagents[entry.toolUseId] ?? []

  // Through a ref, and the effect below depends on primitives only: `handlers`
  // is rebuilt whenever *any* sub-log changes, so asking for one with `handlers`
  // in the dependency list is a request that triggers the next request.
  const expand = React.useRef(handlers.onExpandTask)
  React.useEffect(() => {
    expand.current = handlers.onExpandTask
  })

  // Asked on open, and **again when the agent stops**. What main can hand back
  // changes at exactly that moment: while a subagent runs the answer is the live
  // buffer of whatever the stream forwarded, and once it finishes the complete
  // sibling file exists. Without the second ask, a task expanded while it ran
  // showed the three rows it had at that instant for good.
  React.useEffect(() => {
    if (open) expand.current(entry.toolUseId, entry.agentId)
  }, [open, entry.running, entry.toolUseId, entry.agentId])

  const toggle = (): void => setOpen(!open)

  const stats = [
    entry.status,
    entry.durationMs !== null ? `${Math.round(entry.durationMs / 1000)}s` : null,
    entry.tools !== null ? `${entry.tools} tools` : null,
    entry.tokens !== null ? `${tok(entry.tokens)} tok` : null
  ].filter(Boolean)

  return (
    <>
      <Line at={entry.at} role="task" color={CHAT.dim2}>
        <Card onClick={toggle}>
          <span style={{ color: CHAT.text, flex: 'none' }}>{entry.agentType}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {entry.description}
          </span>
          {entry.running ? (
            <>
              <Dots />
              <Elapsed since={entry.at} style={{ flex: 'none' }} />
            </>
          ) : (
            <span style={{ flex: 'none', color: CHAT.dim2 }}>{stats.join(' · ')}</span>
          )}
          <span style={{ flex: 'none', fontSize: TYPE.gutter, color: CHAT.dim3 }}>
            {open ? 'hide' : `show${sub.length ? ` ${sub.length}` : ''}`}
          </span>
        </Card>
      </Line>
      {open && (
        <div style={{ borderLeft: `1px solid ${CHAT.borderSoft}`, marginLeft: SUB_INDENT }}>
          {sub.map((e) => (
            <LogRow key={e.id} entry={e} handlers={handlers} depth={depth + 1} />
          ))}
          {sub.length === 0 && (
            <div style={{ ...mono, color: CHAT.dim3, padding: '8px 18px' }}>no steps recorded</div>
          )}
        </div>
      )}
    </>
  )
}
