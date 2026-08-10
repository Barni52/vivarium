import React from 'react'
import { Check, Copy } from '../Icons'
import { CHAT, CHAT_TEXT as TYPE, MONO } from '../../theme'
import { Hi } from './find'
import { langFor, tokenize } from './highlight'

// Markdown for a conversation — headings, paragraphs, nested lists, task lists,
// blockquotes, fenced and indented code, tables, rules, and the full inline set
// (code, bold, italic, bold-italic, strikethrough, links, autolinks and bare
// URLs).
//
// **Still no dependency.** The earlier version was deliberately tiny — bold,
// inline code, one level of list, fenced code — on the argument that this is a
// personal tool reading Claude Code's own prose. That argument held right up
// until you read the output: Claude nests bullets constantly, and a nested
// bullet did not match `/^[-*] /` at column 0, so it fell through to the
// paragraph branch and was **joined into the sentence above it**. Italics,
// links and tables printed their own syntax. What shipped did not read as
// "minimal markdown", it read as *no* markdown, which is what the bug says.
//
// The one rule everything below is built around: **it renders text nodes and
// never sets HTML**. A tool result that happens to contain markup is shown
// rather than run, and there is no sanitiser to get wrong because there is
// nothing for one to do. That is a property of the output, not an argument
// about dependencies — `CodeBlock` colours its body with Prism precisely
// because `Prism.tokenize` hands back a *token tree* rather than the HTML
// string `Prism.highlight` would, so the spans are built here and the rule
// still holds. Anything reached for later has to clear the same bar.
//
// Type comes from `CHAT_TEXT` — every size in here is that scale or derived
// from it, so the window has one knob rather than thirty numbers. `CHAT.prose`
// rather than white, and `text-wrap: pretty` so the last line of a paragraph
// never leaves one word alone. Lists drop the browser marker for a coral marker
// in the item's gutter, which is the one place the accent appears inside
// Claude's own prose.

/**
 * Gap between two block-level things. The container cancels the last one.
 *
 * 12 rather than 14, with the type a point smaller and its leading tighter: the
 * gap between blocks has to stay visibly larger than the gap between lines
 * *within* one, and that is a ratio, not a constant.
 */
const BLOCK_GAP = 12

// ---- inline ---------------------------------------------------------------

/** A URL that ends before the punctuation a sentence would put after it. */
const BARE_URL = /^(https?:\/\/[^\s<>()[\]{}"']+)/
const AUTOLINK = /^<((?:https?|mailto):[^>\s]+)>/
/** `[text](href "title")` — the title is parsed so it cannot leak into the href. */
const LINK = /^\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/
const ESCAPABLE = /[\\`*_~[\]()#+\-.!>|]/

function open(url: string): void {
  // Main is the side that enforces the scheme allowlist — the href comes from
  // model output, so the check has to sit where it cannot be reasoned around.
  void window.vivarium.openExternal(url)
}

function Link({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <span
      role="link"
      title={href}
      onClick={(e) => {
        e.stopPropagation()
        open(href)
      }}
      style={{
        color: CHAT.claude,
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        textDecorationColor: `${CHAT.claude}66`,
        cursor: 'pointer'
      }}
    >
      {children}
    </span>
  )
}

function Code({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <code
      style={{
        fontFamily: MONO,
        fontSize: '.86em',
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radius,
        padding: '1px 5px',
        color: CHAT.text,
        // A long identifier in a code span must not push the reading column
        // wider than the measure.
        wordBreak: 'break-word'
      }}
    >
      {children}
    </code>
  )
}

/**
 * Emphasis, delimiter-run rules approximated.
 *
 * Two guards matter and both come from real output: the character after an
 * opening run must not be a space (`2 * 3` is arithmetic, not italics), and a
 * `_` may only open at a word boundary (`snake_case_name` is an identifier).
 * Everything else CommonMark says about flanking is left out — it costs a
 * parser and buys nothing a chat log notices.
 */
function emphasisAt(src: string, i: number): { node: React.ReactNode; end: number } | null {
  const ch = src[i]
  if (ch === '_' && i > 0 && /[\w`]/.test(src[i - 1])) return null
  const run = runLength(src, i, ch)
  const after = src[i + run]
  if (after === undefined || /\s/.test(after)) return null

  // The closing run must be **exactly as long** as the opening one, and a run
  // of a different length is stepped over whole. That is what keeps nesting
  // straight: in `*a **b** c*` the inner pair is length 2 against an opening
  // length of 1, so it is skipped rather than closing the italics early — which
  // is what a "first marker wins" scan does, and it is wrong on ordinary prose.
  let j = i + run
  let close = -1
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] !== ch) {
      j++
      continue
    }
    const len = runLength(src, j, ch)
    // `_foo_bar` is one identifier, not emphasis followed by text.
    const wordish = ch === '_' && /\w/.test(src[j + len] ?? '')
    if (len === run && !/\s/.test(src[j - 1] ?? ' ') && !wordish) {
      close = j
      break
    }
    j += len
  }
  if (close < 0) return null
  const inner = src.slice(i + run, close)
  if (!inner.trim()) return null
  const kids = inlineNodes(inner)
  // Bold is `--str`, the same warm hue a quoted string takes in a code block —
  // one colour for "the part of this the author picked out", whether the author
  // is a model writing prose or a language marking a literal. It carries the
  // weight too: at 12.5px mono, 700 on the page grey is a weaker mark than 500
  // in a hue, and the two together are what a `**bold**` run is asking for.
  const strong: React.CSSProperties = { color: 'var(--str)', fontWeight: 700 }
  const node =
    run === 1 ? (
      <i style={{ color: 'inherit' }}>{kids}</i>
    ) : run === 2 ? (
      <b style={strong}>{kids}</b>
    ) : (
      <b style={strong}>
        <i>{kids}</i>
      </b>
    )
  return { node, end: close + run }
}

/** How many `ch` in a row start at `from`. */
function runLength(src: string, from: number, ch: string): number {
  let n = 0
  while (src[from + n] === ch) n++
  return n
}

/**
 * One run of inline markdown → React nodes.
 *
 * A hand-rolled scanner rather than a chain of `String.split(regex)`: split
 * cannot nest, and `**bold with `code` in it**` is ordinary Claude output.
 */
export function inlineNodes(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let buf = ''
  let key = 0
  /**
   * Every run of plain text leaves here as `<Hi>` rather than as a bare string,
   * which is what makes find-in-chat reach markdown at all.
   *
   * The alternative — walking the tree `Md` returns and splitting the strings in
   * it — was written first and does not work, for a reason worth recording: the
   * block components take their content as *props* (`Paragraph({ lines })` calls
   * this function itself), so from outside, a paragraph is an element with no
   * children and the walk has nothing to descend into. Highlighting has to
   * happen where text becomes nodes, and this is that place — one line, and it
   * covers paragraphs, headings, list items, quotes and table cells at once
   * because all of them come through here.
   *
   * `Hi` reads the find matcher from context and returns its input untouched
   * when there is none, so this costs an extra component per text run and
   * nothing else.
   */
  const flush = (): void => {
    if (!buf) return
    out.push(<Hi key={`t${key++}`}>{buf}</Hi>)
    buf = ''
  }
  const push = (node: React.ReactNode): void => {
    flush()
    out.push(<React.Fragment key={key++}>{node}</React.Fragment>)
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]

    if (c === '\\' && ESCAPABLE.test(src[i + 1] ?? '')) {
      buf += src[i + 1]
      i += 2
      continue
    }

    // Code spans win over everything: whatever is inside one is literal.
    if (c === '`') {
      const fence = /^`+/.exec(src.slice(i))![0]
      const end = src.indexOf(fence, i + fence.length)
      if (end > 0) {
        push(
          <Code>
            <Hi>{src.slice(i + fence.length, end).trim()}</Hi>
          </Code>
        )
        i = end + fence.length
        continue
      }
    }

    if (c === '!' && src[i + 1] === '[') {
      const m = LINK.exec(src.slice(i + 1))
      if (m) {
        // An image renders as its alt text under a marker rather than as an
        // <img>: the renderer would have to reach the network for a remote one,
        // and this window has no business doing that on a model's say-so.
        push(<Link href={m[2]}>{`▣ ${m[1] || 'image'}`}</Link>)
        i += 1 + m[0].length
        continue
      }
    }

    if (c === '[') {
      const m = LINK.exec(src.slice(i))
      if (m) {
        push(<Link href={m[2]}>{inlineNodes(m[1])}</Link>)
        i += m[0].length
        continue
      }
    }

    if (c === '<') {
      const m = AUTOLINK.exec(src.slice(i))
      if (m) {
        push(<Link href={m[1]}>{m[1]}</Link>)
        i += m[0].length
        continue
      }
    }

    if ((c === 'h' && src.startsWith('http', i)) || (c === 'w' && src.startsWith('www.', i))) {
      const m = BARE_URL.exec(src.slice(i)) ?? (c === 'w' ? /^(www\.[^\s<>()[\]{}"']+)/.exec(src.slice(i)) : null)
      if (m) {
        // Trailing sentence punctuation belongs to the sentence, not the URL.
        const url = m[1].replace(/[.,;:!?)]+$/, '')
        push(<Link href={url.startsWith('www.') ? `https://${url}` : url}>{url}</Link>)
        i += url.length
        continue
      }
    }

    if (c === '~' && src[i + 1] === '~') {
      const end = src.indexOf('~~', i + 2)
      if (end > 0) {
        push(
          <s style={{ color: CHAT.dim, textDecorationColor: CHAT.dim2 }}>
            {inlineNodes(src.slice(i + 2, end))}
          </s>
        )
        i = end + 2
        continue
      }
    }

    if (c === '*' || c === '_') {
      const em = emphasisAt(src, i)
      if (em) {
        push(em.node)
        i = em.end
        continue
      }
    }

    buf += c
    i++
  }
  flush()
  return out
}

// ---- blocks ---------------------------------------------------------------

const FENCE = /^ {0,3}(```+|~~~+)\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const TABLE_DIV = /^ {0,3}\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/
const SETEXT = /^ {0,3}=+\s*$/
const TASK = /^\[([ xX])\]\s+/

/** Which side a table column is set to, read off its delimiter cell. */
function alignOf(cell: string): 'left' | 'center' | 'right' {
  const t = cell.trim()
  if (t.startsWith(':') && t.endsWith(':')) return 'center'
  if (t.endsWith(':')) return 'right'
  return 'left'
}

function splitRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let i = 0
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  while (i < body.length) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|'
      i += 2
      continue
    }
    if (body[i] === '|') {
      cells.push(cur)
      cur = ''
      i++
      continue
    }
    cur += body[i++]
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

interface Ctx {
  color: string
  size: number
}

/**
 * A block sequence → React nodes. Recursive: a list item, a blockquote and a
 * table cell all run their contents back through here, which is what makes
 * nesting work at any depth instead of at exactly one level.
 */
function blocks(lines: string[], ctx: Ctx, keyBase = 'b'): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  let k = 0
  const push = (node: React.ReactNode): void => {
    out.push(
      <div key={`${keyBase}${k++}`} style={{ marginBottom: BLOCK_GAP }}>
        {node}
      </div>
    )
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    // fenced code
    const fence = FENCE.exec(line)
    if (fence) {
      const close = fence[1][0].repeat(3)
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(close)) body.push(lines[i++])
      i++
      push(<CodeBlock lang={fence[2]} body={body.join('\n')} />)
      continue
    }

    // indented code — four spaces, and only where a list's continuation lines
    // have already been dedented away, or every nested bullet would land here.
    if (/^ {4}\S/.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === '')) {
        body.push(lines[i].slice(4))
        i++
      }
      while (body.length && body[body.length - 1].trim() === '') body.pop()
      push(<CodeBlock lang="" body={body.join('\n')} />)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      push(
        <div
          style={{
            // A conversation is not a document: h1 and h2 are the same weight
            // as everything else here, one step up in size, and the deeper
            // levels are simply bold. Six sizes in a chat log is a magazine.
            fontSize: ctx.size + (level <= 2 ? 1.5 : level === 3 ? 0.5 : 0),
            fontWeight: 500,
            color: CHAT.text,
            lineHeight: 1.45,
            letterSpacing: level <= 2 ? '-.01em' : undefined
          }}
        >
          {inlineNodes(heading[2])}
        </div>
      )
      i++
      continue
    }

    if (RULE.test(line)) {
      push(<div style={{ height: 1, background: CHAT.borderCard }} />)
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && (QUOTE.test(lines[i]) || (body.length > 0 && lines[i].trim() !== ''))) {
        body.push(lines[i].replace(QUOTE, ''))
        i++
      }
      push(
        <div
          style={{
            borderLeft: `2px solid ${CHAT.border}`,
            paddingLeft: 14,
            color: CHAT.dim
          }}
        >
          {blocks(body, { ...ctx, color: CHAT.dim }, `${keyBase}${k}q`)}
        </div>
      )
      continue
    }

    // table — a header row is only a table if the line under it is a delimiter
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIV.test(lines[i + 1])) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map(alignOf)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]))
        i++
      }
      push(<Table header={header} align={align} rows={rows} ctx={ctx} />)
      continue
    }

    // list
    if (ITEM.test(line)) {
      const list = takeList(lines, i)
      push(<List {...list} ctx={ctx} keyBase={`${keyBase}${k}l`} />)
      i = list.end
      continue
    }

    // paragraph — everything until a blank line or the start of another block
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
      para.push(lines[i])
      i++
    }
    // setext h1: `====` under a paragraph. `----` is deliberately not read this
    // way — it is a thematic break far more often than a heading in this log.
    if (i < lines.length && SETEXT.test(lines[i]) && para.length) {
      push(
        <div style={{ fontSize: ctx.size + 1.5, fontWeight: 500, color: CHAT.text, lineHeight: 1.45 }}>
          {inlineNodes(para.join(' '))}
        </div>
      )
      i++
      continue
    }
    if (para.length) push(<Paragraph lines={para} ctx={ctx} />)
  }

  // The last block owns no trailing margin: the row's own padding is the gap to
  // whatever comes next, and doubling them made every message look orphaned.
  const last = out[out.length - 1]
  if (React.isValidElement<{ style?: React.CSSProperties; children?: React.ReactNode }>(last)) {
    out[out.length - 1] = React.cloneElement(last, {
      style: { ...(last.props.style ?? {}), marginBottom: 0 }
    })
  }
  return out
}

/** Does this line begin a block that a paragraph must stop before? */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line)
  )
}

function Paragraph({ lines, ctx }: { lines: string[]; ctx: Ctx }): React.ReactElement {
  // Soft-wrapped lines join with a space, the way markdown means them to; a
  // line ending in two spaces or a backslash is a hard break and keeps it.
  const nodes: React.ReactNode[] = []
  let broke = true
  lines.forEach((raw, n) => {
    const hard = /( {2,}|\\)$/.test(raw)
    const text = raw.replace(/( {2,}|\\)$/, '').trim()
    nodes.push(...inlineNodes(broke ? text : ` ${text}`))
    broke = hard
    if (hard && n < lines.length - 1) nodes.push(<br key={`br${n}`} />)
  })
  return (
    <div
      style={{ lineHeight: TYPE.proseLine, color: ctx.color, textWrap: 'pretty' } as React.CSSProperties}
    >
      {nodes}
    </div>
  )
}

function CodeBlock({ lang, body }: { lang: string; body: string }): React.ReactElement {
  // Memoised on its own rather than leaning on `Md`'s: during a turn `Md` is
  // handed a growing *prefix* of the answer and re-parses every reveal tick, so
  // its memo never hits — but a settled block above the live row has a body that
  // stops changing, and this is what stops it re-tokenizing 30 times a second
  // for the rest of the conversation.
  const toks = React.useMemo(() => tokenize(body, langFor(lang)), [body, lang])

  const [copied, setCopied] = React.useState(false)
  // The tick has a lifetime, so it is cleared by unmount as well as by time: a
  // log row is dropped and rebuilt whenever its turn settles, and that can land
  // mid-flip like anything else.
  React.useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div
      data-code=""
      style={{
        // The button is absolute against this box rather than in the flow of
        // it: a control that reserved a row would move the code down, and it
        // has to stay put while a wide block scrolls sideways underneath it.
        position: 'relative',
        border: `1px solid ${CHAT.borderCard}`,
        background: CHAT.card,
        borderRadius: CHAT.radiusCard
      }}
    >
      <button
        data-copy=""
        // Reveal is CSS (see GLOBAL_CSS); this is the half of it that outlives
        // the pointer, so the tick is readable after the click that moved on.
        data-copied={copied ? '' : undefined}
        title="Copy"
        aria-label="Copy code"
        onClick={(e) => {
          // Same reason `Link` stops it: a code block can sit inside a card
          // that is itself clickable, and copying is not opening that card.
          e.stopPropagation()
          // What was copied is what is on screen — during a turn `body` is the
          // revealed prefix, and a partial block copying in full would be a
          // different thing to the one the reader pointed at.
          window.vivarium.clipboardWriteText(body)
          setCopied(true)
        }}
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 20,
          padding: 0,
          // Opaque, and the block's own card grey: it overlaps the first line
          // of an unlabelled block, so it has to read as sitting on top rather
          // than as a glyph tangled in the code.
          background: CHAT.card,
          border: `1px solid ${CHAT.borderCard}`,
          cursor: 'pointer'
        }}
      >
        {copied ? <Check size={11} color={CHAT.live} /> : <Copy size={12} color={CHAT.dim2} />}
      </button>
      {lang && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: CHAT.dim3,
            padding: '5px 12px 0',
            userSelect: 'none'
          }}
        >
          {lang}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: lang ? '6px 13px 11px' : '11px 13px',
          fontFamily: MONO,
          fontSize: TYPE.code,
          lineHeight: 1.55,
          // The colour a token with no role of its own inherits, which is every
          // token in a language we do not have — so an unhighlighted block is
          // still exactly the block that was here before highlighting existed.
          color: CHAT.prose,
          // Wide content scrolls inside its own box; the log never scrolls
          // sideways as a whole.
          overflowX: 'auto'
        }}
      >
        {/* Inline spans, never per-line wrappers: they cannot change the box's
            height, and the log re-pins its tail on any height change at all. */}
        {toks.map((t, i) =>
          t.color ? (
            <span key={i} style={{ color: t.color }}>
              {t.text}
            </span>
          ) : (
            t.text
          )
        )}
      </pre>
    </div>
  )
}

function Table({
  header,
  align,
  rows,
  ctx
}: {
  header: string[]
  align: ('left' | 'center' | 'right')[]
  rows: string[][]
  ctx: Ctx
}): React.ReactElement {
  const cell = (text: string, n: number, head: boolean): React.ReactElement => (
    <td
      key={n}
      style={{
        padding: '6px 12px',
        textAlign: align[n] ?? 'left',
        verticalAlign: 'top',
        borderBottom: `1px solid ${CHAT.borderCard}`,
        color: head ? CHAT.text : ctx.color,
        fontWeight: head ? 600 : undefined,
        whiteSpace: 'pre-wrap'
      }}
    >
      {inlineNodes(text)}
    </td>
  )
  return (
    <div
      style={{
        overflowX: 'auto',
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard
      }}
    >
      <table style={{ borderCollapse: 'collapse', fontSize: ctx.size - 1.5, lineHeight: 1.55, minWidth: '100%' }}>
        <thead>
          <tr style={{ background: CHAT.card }}>{header.map((h, n) => cell(h, n, true))}</tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n}>{header.map((_, c) => cell(r[c] ?? '', c, false))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface ListSpec {
  ordered: boolean
  start: number
  items: string[][]
  end: number
}

/**
 * Collect one list, item by item.
 *
 * The rule that matters is what a *deeper* line means: it is content of the
 * item above it, dedented by that item's marker width and run back through the
 * block parser. That single line is what makes nesting work — and its absence
 * is what used to fold a sub-bullet into the sentence above it.
 */
function takeList(lines: string[], from: number): ListSpec {
  const first = ITEM.exec(lines[from])!
  const baseIndent = first[1].length
  const ordered = /\d/.test(first[2])
  const start = ordered ? parseInt(first[2], 10) : 1
  const items: string[][] = []
  let cur: string[] = []
  let width = first[1].length + first[2].length + first[3].length
  let i = from

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      // A blank ends the list unless the next non-blank line is still part of
      // it — a sibling item, or an indented continuation.
      const next = lines[i + 1]
      if (next === undefined) break
      const nm = ITEM.exec(next)
      const indent = next.search(/\S/)
      if ((nm && nm[1].length >= baseIndent) || (next.trim() !== '' && indent > baseIndent)) {
        cur.push('')
        i++
        continue
      }
      break
    }
    const m = ITEM.exec(line)
    const indent = line.search(/\S/)
    if (m && m[1].length <= baseIndent + 1) {
      // A sibling. (Anything deeper falls through to the continuation branch
      // below and becomes a nested list inside the current item.)
      if (i > from) items.push(cur)
      cur = [m[4]]
      width = m[1].length + m[2].length + m[3].length
      i++
      continue
    }
    if (indent > baseIndent) {
      // Content of the item above: dedent by the marker width, but never past
      // the line's own indentation, or a lazily-wrapped line would lose its
      // first characters. Recursion in `List` turns it back into blocks, which
      // is what makes a sub-bullet a sub-bullet and not part of the sentence.
      cur.push(line.slice(Math.min(width, indent)))
      i++
      continue
    }
    // A lazy continuation — an unindented wrapped line — but only when the line
    // is prose. A heading, a fence or a rule at the left margin ends the list;
    // swallowing one folds `## Next` into the last bullet.
    if (cur.length > 0 && !m && !startsBlock(line)) {
      cur.push(line.trim())
      i++
      continue
    }
    break
  }
  items.push(cur)
  return { ordered, start, items, end: i }
}

function List({
  ordered,
  start,
  items,
  ctx,
  keyBase
}: ListSpec & { ctx: Ctx; keyBase: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {items.map((item, n) => {
        const task = TASK.exec(item[0] ?? '')
        const body = task ? [item[0].replace(TASK, ''), ...item.slice(1)] : item
        const marker = task
          ? task[1] === ' '
            ? '☐'
            : '☑'
          : ordered
            ? `${start + n}.`
            : '–'
        return (
          <div key={n} style={{ display: 'flex', gap: 10, lineHeight: TYPE.proseLine }}>
            <span
              style={{
                flex: 'none',
                // The one place the accent appears inside Claude's own prose.
                color: task && task[1] !== ' ' ? CHAT.dim2 : CHAT.you,
                fontFamily: MONO,
                fontSize: TYPE.code,
                paddingTop: 1,
                userSelect: 'none',
                minWidth: ordered ? 18 : undefined,
                textAlign: 'right'
              }}
            >
              {marker}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              {blocks(body, ctx, `${keyBase}${n}`)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * An `AskUserQuestion` option's preview — rendered **verbatim, never through the
 * block parser**.
 *
 * The schema calls it markdown and this deliberately does not treat it as such,
 * because of what models actually put in one: box-drawing mockups, a component
 * in three languages, a colour table — all **unfenced**, all load-bearing on
 * their own line breaks and column alignment. Markdown says consecutive lines
 * are one paragraph, so `Md` folded a 28-line dashboard mockup into a single
 * reflowed sentence, and it re-broke at a different place every time the window
 * changed width. A preview is a thing you *look at* to compare two options; it
 * is the one body of text in this window that is not prose.
 *
 * So: `white-space: pre` and no wrap, scrolling sideways inside its own box
 * (never the log, which must not scroll sideways as a whole). The one piece of
 * markdown honoured is a fence wrapped around the *entire* preview, which is
 * stripped — models write both shapes and the markers are noise either way.
 */
export function Preview({ src }: { src: string }): React.ReactElement {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: MONO,
        fontSize: TYPE.code,
        lineHeight: 1.5,
        color: CHAT.prose,
        whiteSpace: 'pre'
      }}
    >
      {unfence(src)}
    </pre>
  )
}

/** Drop a fence wrapping the whole preview; leave anything else alone. */
function unfence(src: string): string {
  const text = src.replace(/\r\n?/g, '\n').trim()
  if (!text.startsWith('```')) return text
  const lines = text.split('\n')
  if (lines.length < 3 || !lines[lines.length - 1].trim().startsWith('```')) return text
  const inner = lines.slice(1, -1)
  // Two fenced blocks in one preview is a document, not a mockup — leave the
  // markers in rather than silently welding the two together.
  if (inner.some((l) => l.trimStart().startsWith('```'))) return text
  return inner.join('\n')
}

export function Md({
  src,
  color = CHAT.prose,
  size = TYPE.prose
}: {
  src: string
  color?: string
  size?: number
}): React.ReactElement {
  const nodes = React.useMemo(
    () => blocks(src.replace(/\r\n?/g, '\n').split('\n'), { color, size }),
    [src, color, size]
  )
  // No find handling here: the highlight is applied by `inlineNodes`, where text
  // becomes nodes (see the note on `flush` there). That also keeps this memo
  // honest — the parse depends on the source and nothing else, so typing in the
  // find bar never re-parses a row; only the `Hi` leaves re-render.
  return <div style={{ fontSize: size, wordBreak: 'break-word' }}>{nodes}</div>
}

/** hh:mm — the only timestamp format the log uses. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
