import React from 'react'
import type { ChatEntry } from '@shared/types'
import { CHAT } from '../../theme'

// Find-in-chat: the matcher, the text a row is searchable by, and the two ways a
// match gets painted.
//
// The terminal has had a find bar since it had 50k lines of scrollback with no
// way to search them. The chat window is where the *long-lived* content actually
// is — a conversation you can revert to a message but not search through — and
// it is the easier of the two: the log is DOM, so this needs none of the canvas
// gymnastics `searchOpts()` in TerminalView pays for.
//
// **Navigation is row-at-a-time, not occurrence-at-a-time, and that is a
// correctness choice rather than a shortcut.** An occurrence counter has to be
// computed on the same string that gets highlighted, or the bar promises a
// number the log does not show. What is highlighted is the *rendered* tree,
// where markdown syntax is gone (`**bold**` has painted `bold`) — so counting on
// the raw `md` would over- or under-count exactly whenever the search term meets
// markup. Counting the rendered tree instead needs a render pass before the bar
// can draw, for every row, on every keystroke. Rows sidestep the whole problem:
// "3/12" always means the twelve rows that contain the term, every occurrence
// inside them is marked, and the two readings cannot disagree.

/** What the bar is looking for. */
export interface FindQuery {
  term: string
  caseSensitive: boolean
}

/**
 * A compiled query. Built once per keystroke and handed to every row, so the
 * case folding and the empty-term test are not redone per string.
 */
export interface Matcher {
  term: string
  caseSensitive: boolean
  /** does this text contain the term at all */
  test(text: string): boolean
  /** the text split into alternating miss/hit runs, hits at odd indices */
  split(text: string): string[]
}

export function matcherFor(query: FindQuery): Matcher | null {
  const term = query.term
  if (!term) return null
  const needle = query.caseSensitive ? term : term.toLowerCase()
  const fold = (s: string): string => (query.caseSensitive ? s : s.toLowerCase())
  return {
    term,
    caseSensitive: query.caseSensitive,
    test: (text) => text.length > 0 && fold(text).includes(needle),
    split(text) {
      // indexOf rather than a RegExp: the term is whatever was typed, so a
      // regex would either need escaping or would quietly turn `a.b` and `(` into
      // a pattern — and a search box that treats punctuation as syntax is a
      // search box that finds nothing for no visible reason.
      const out: string[] = []
      const hay = fold(text)
      let from = 0
      let at = hay.indexOf(needle)
      while (at >= 0) {
        out.push(text.slice(from, at), text.slice(at, at + needle.length))
        from = at + needle.length
        at = hay.indexOf(needle, from)
      }
      out.push(text.slice(from))
      return out
    }
  }
}

/**
 * Everything in a row a search should look at.
 *
 * Deliberately the row's *visible* surfaces and nothing else: ids, tool_use ids
 * and turn numbers are in the data and are not what anyone is looking for, and a
 * hit on one of them would be a row that highlights nothing.
 *
 * A tool body is only as complete as what the renderer holds — main clips them
 * on the way out and serves the rest on expand (see `wireEntries`) — so a match
 * deep inside an unexpanded 400-line bash result is not found. The bar says so
 * rather than pretending otherwise; searching the full bodies would mean pulling
 * every one of them over IPC to answer a keystroke.
 */
export function searchTextOf(entry: ChatEntry): string {
  switch (entry.kind) {
    case 'text':
      return [entry.md, ...(entry.chips ?? []).map((c) => `${c.name} ${c.detail ?? ''}`)].join('\n')
    case 'thinking':
      return entry.md
    case 'tool':
      return `${entry.title}\n${entry.result}\n${entry.body.text}`
    case 'ask':
      return entry.questions
        .flatMap((q) => [q.header ?? '', q.question, ...q.options.map((o) => `${o.label} ${o.description ?? ''}`)])
        .concat(entry.answers.flatMap((a) => [...a.values, a.notes ?? '']))
        .join('\n')
    case 'plan':
      return entry.md
    case 'cmd':
      return `${entry.title}\n${entry.md}`
    case 'task':
      return `${entry.agentType}\n${entry.description}\n${entry.status}`
    case 'todo':
      return entry.text
    case 'stop':
      return entry.text
    case 'divider':
      return entry.text
    // The turn clock is a duration and a token count. Nothing to find.
    case 'turn':
      return ''
    default:
      return ''
  }
}

/**
 * The active matcher, for the leaves that paint text.
 *
 * A context rather than a prop threaded through the log: every text surface in
 * here is several components deep (`LogRow` → `Line` → `Md` → `inlineNodes`),
 * and half of them are memoised on purpose. Context reaches them all and — the
 * part a prop could not do — re-renders straight through `React.memo`, so
 * `LogRow`'s memoisation goes on protecting a streaming turn while a change of
 * search term still repaints every row.
 */
export const FindContext = React.createContext<Matcher | null>(null)

const markStyle: React.CSSProperties = {
  background: CHAT.find,
  // Inherited, never set: a match inside a code span, a bold run or a link keeps
  // whatever colour that context gave it. The wash is what marks it.
  color: 'inherit',
  borderRadius: 2,
  // `mark` is not a block, and padding on an inline box does not grow the line —
  // so this pads the wash out from the glyphs without moving a single one of
  // them, which is what stops a highlight from reflowing the paragraph under it.
  padding: '0 1px'
}

/**
 * One string, with its matches washed. Renders the string unchanged when idle.
 *
 * This is the *only* place a match is painted, and everything that wants
 * highlighting routes text through it — `inlineNodes` wraps every plain-text run
 * in one, and `ChatLog` uses it directly for the surfaces that are not markdown
 * (the `you` bubble, a command's raw stdout, a tool card's title and result).
 *
 * The rejected alternative is worth keeping written down, because it looks
 * obviously better and is not: walking the React tree `Md` returns and splitting
 * the strings in it needs no changes to the parser at all — and misses almost
 * everything, because the block components take their content as *props*
 * (`Paragraph({ lines })` runs `inlineNodes` itself). From outside, a paragraph
 * is an element with no children. Verified by rendering a real row: the walk
 * marked nothing in Claude's prose while appearing to work on synthetic trees.
 *
 * A fenced code block is still not washed, for the same reason and with no fix
 * worth the cost: `CodeBlock` takes its source as a prop and tokenises it into
 * Prism spans. Such a row is still *found* — `searchTextOf` reads the raw
 * markdown — it just scrolls into view unpainted.
 */
export function Hi({ children }: { children: string }): React.ReactElement {
  const matcher = React.useContext(FindContext)
  if (!matcher || !matcher.test(children)) return <>{children}</>
  return <>{highlightString(children, matcher)}</>
}

/** Split a string on the term and wrap the hits. `Hi` is the only caller. */
function highlightString(text: string, matcher: Matcher): React.ReactNode[] {
  const parts = matcher.split(text)
  const out: React.ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    if (i % 2 === 1) {
      out.push(
        <mark key={i} style={markStyle}>
          {parts[i]}
        </mark>
      )
    } else {
      out.push(parts[i])
    }
  }
  return out
}
