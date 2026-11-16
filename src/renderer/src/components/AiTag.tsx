import React from 'react'
import { useStore } from '../state/store'
import { AiSpark } from './Icons'

/**
 * The creator's name as it is now, `null` once that chat is gone, `undefined`
 * for something nobody's agent made. Read through a selector so a rename of the
 * creator re-reads the tooltip.
 */
export function useCreatorName(createdBy: string | undefined): string | null | undefined {
  return useStore((s) => {
    if (!createdBy) return undefined
    for (const p of s.config.projects) {
      const creator = p.sessions.find((x) => x.id === createdBy)
      if (creator) return creator.name
    }
    return null
  })
}

/** The tooltip a tagged row's glyph carries. */
export function describeCreator(name: string | null | undefined): string | undefined {
  if (name === undefined) return undefined
  return name === null ? 'Created by an agent (its chat has been deleted)' : `Created by chat "${name}"`
}

/**
 * The spark on the corner of a row's glyph that says an agent made the row.
 * Its parent must be `position: relative`.
 *
 * `--role-agent` violet because that hue already means "an agent did this, not
 * you" in the log (the `from <name>` rows), and because the glyph under it keeps
 * its own type hue — type and origin never share one colour. The disc behind
 * the star is filled with the row's own ground (`ground`), which cuts it out of
 * the glyph instead of drawing the star on top of a stroke.
 */
export function AiTag({ ground }: { ground: string }): React.ReactElement {
  return (
    <span
      style={{
        position: 'absolute',
        right: -4,
        bottom: -3,
        width: 11,
        height: 11,
        borderRadius: '50%',
        background: ground,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none'
      }}
    >
      <AiSpark color="var(--role-agent)" />
    </span>
  )
}
