import React from 'react'
import { MONO } from '../theme'

/**
 * How many questions are waiting for your answer: a hollow ring in the "?"
 * badge's `--accent2`, with the number in it.
 *
 * **Hollow, because it is not a flag.** The filled "?" is an attention flag and
 * clears when you look; this stays until you *answer* (see `findOpenQuestions`
 * in the store), so it must read as the same subject in a quieter register —
 * a stroke needs no ink token of its own, which is also why it is the one
 * `--accent2` shape here without an `--on-accent2` beside it.
 */
export function OpenQuestionCount({
  count,
  title,
  size = 16
}: {
  count: number
  title: string
  size?: number
}): React.ReactElement {
  return (
    <span
      title={title}
      style={{
        minWidth: size,
        height: size,
        padding: count > 9 ? '0 3px' : 0,
        flex: 'none',
        boxSizing: 'border-box',
        borderRadius: size / 2,
        border: '1.5px solid var(--accent2)',
        color: 'var(--accent2)',
        fontFamily: MONO,
        fontSize: size - 5.5,
        fontWeight: 700,
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {count}
    </span>
  )
}

/** The violet "→N" on an agent whose turn ended with other chats still working for it. */
export function AwaitingMark({ count }: { count: number }): React.ReactElement {
  return (
    <span
      title={`Waiting on ${count} ${count === 1 ? 'chat' : 'chats'} it handed work to — nothing for you yet`}
      style={{
        flex: 'none',
        marginRight: 1,
        color: 'var(--role-agent)',
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1
      }}
    >
      →{count}
    </span>
  )
}
