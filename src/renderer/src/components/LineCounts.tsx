import React from 'react'
import type { ChatLineCounts } from '@shared/types'
import { Hi } from './chat/find'

/**
 * `+412 −87`, the plus green and the minus red.
 *
 * The one drawing of a line count: tool cards, the output preview and the
 * write-diff confirmation all use it. It used to be a single string in a single
 * status colour, which is why the numbers travel apart now. Each sign is its own
 * `Hi` so the find bar can land on either, and outside a chat `Hi` draws plain
 * text. `flex: none` because a count is short and must never wrap in half.
 */
export function LineCounts({ counts }: { counts: ChatLineCounts }): React.ReactElement {
  return (
    <span style={{ flex: 'none', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--code-ins)' }}>
        <Hi>{`+${counts.added}`}</Hi>
      </span>{' '}
      <span style={{ color: 'var(--code-del)' }}>
        <Hi>{`−${counts.removed}`}</Hi>
      </span>
    </span>
  )
}
