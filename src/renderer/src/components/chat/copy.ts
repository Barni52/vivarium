import { blockSource } from './Markdown'

// Copying out of the log should hand back the markdown Claude wrote, not the
// text it rendered to — a table you paste into a doc as `| a | b |` is worth
// something, and the same table pasted as three words on a line is not.
//
// The rule is per **block**, and it is deliberately not per character. A
// rendered block knows exactly which source lines produced it (`blockSource`),
// so a block the selection covers *completely* can be replaced by those lines
// with no reconstruction and no guessing. A block only partly covered has no
// honest markdown answer — half a fenced block is not a fenced block — so it
// contributes the text the user actually highlighted, which is what they were
// pointing at anyway.
//
// Everything between the blocks (a `you` message, a card's body, a tool result)
// goes through `Range.toString()` rather than a hand-rolled text walk: the
// browser already knows where the line breaks in a rendered selection are, and
// re-deriving that from `display` values is a second renderer nobody asked for.

/** Is every part of `el`'s content inside `range`? */
function encloses(range: Range, el: Element): boolean {
  const own = document.createRange()
  own.selectNodeContents(el)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, own) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, own) >= 0
  )
}

/**
 * The markdown for the current selection, or `null` when there is nothing
 * better to offer than what the browser would already copy.
 *
 * `null` rather than the plain text, so callers can leave the default copy
 * alone instead of re-implementing it — the clipboard write is skipped
 * entirely, which also keeps `text/html` and any other flavour the browser
 * would have put there.
 */
export function selectionMarkdown(root: HTMLElement): string | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  // Only the first range: Chromium gives exactly one for a drag or a
  // select-all, and the multi-range case does not arise in this window.
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const covered = Array.from(root.querySelectorAll<HTMLElement>('[data-md-from]'))
    .filter((el) => range.intersectsNode(el) && encloses(range, el) && blockSource(el) !== null)
    // A tagged block never nests inside another today — the block components do
    // not render `Md` — but if one ever does, the outer block already carries
    // the inner one's source and emitting both would duplicate it.
    .filter((el, _, all) => !all.some((other) => other !== el && other.contains(el)))

  if (covered.length === 0) return null

  const parts: string[] = []
  const gap = (from: HTMLElement | null, to: HTMLElement | null): void => {
    const r = range.cloneRange()
    if (from) r.setStartAfter(from)
    if (to) r.setEndBefore(to)
    const text = r.toString().trim()
    if (text) parts.push(text)
  }

  let prev: HTMLElement | null = null
  for (const el of covered) {
    gap(prev, el)
    parts.push(blockSource(el) as string)
    prev = el
  }
  gap(prev, null)

  return parts.join('\n\n')
}
