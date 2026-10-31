import React from 'react'
import { useStore } from '../state/store'
import { CHAT, MONO } from '../theme'

// What stands in for a session's controls while another running Vivarium has its
// conversation (see SessionLeases in main/instance.ts): the composer of a chat,
// the terminal of an agent. It states the one thing that matters about moving, and
// it does not ask first. A session this window took by accident goes back the same
// way, and all a handover can cost is a turn that was running over there, which
// is the same thing closing that window costs.
export function HeldElsewhere({
  sessionId,
  kind
}: {
  sessionId: string
  kind: string
}): React.ReactElement {
  const takeSession = useStore((s) => s.takeSession)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: CHAT.radiusCard,
        fontSize: 12.5,
        color: 'var(--muted)'
      }}
    >
      <span>
        This {kind} is running in another Vivarium window. Moving it here stops whatever it is doing
        there.
      </span>
      <button
        onClick={() => takeSession(sessionId)}
        style={{
          flex: 'none',
          fontFamily: MONO,
          fontSize: 11.5,
          padding: '4px 12px',
          border: '1px solid var(--border-strong)',
          background: 'transparent',
          color: 'var(--fg)',
          cursor: 'pointer'
        }}
      >
        Move here
      </button>
    </div>
  )
}
