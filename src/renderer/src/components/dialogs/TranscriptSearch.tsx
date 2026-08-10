import React from 'react'
import type { TranscriptHit } from '@shared/types'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { ChatBubble, Search } from '../Icons'
import { MONO } from '../../theme'

// "Which conversation was that in."
//
// Every chat this app has ever had is still on the shared creds volume —
// deletion is explicit and there is deliberately no sweep — so the archive only
// grows, and until now nothing could ask it a question. Opening sessions one at
// a time was the only way to find where something was said.
//
// The result is a *conversation*, not a line, and that is the whole design: this
// says which chat, and the find bar inside that chat says where in it. So
// picking a row selects the session and hands the term across (see
// `openTranscriptHit` / `pendingFind`), and the two features compose instead of
// each half-solving the other's problem.
//
// Three kinds of row, because a uuid maps three ways. A session's current
// conversation is the ordinary case. An **archived** one was retired by a
// `/clear` — its session has moved on, and this is the only place in the app
// that surfaces those at all. A **foreign** one belongs to nothing in
// config.json: the volume is shared with the user's claude-box setup on purpose,
// and a deleted session's transcript may still be sitting there awaiting a
// drain. Foreign rows are shown and not clickable, because "9 matches somewhere
// outside Vivarium" is a true answer and hiding it would make the totals lie.

function Row({ hit }: { hit: TranscriptHit }): React.ReactElement {
  const openTranscriptHit = useStore((s) => s.openTranscriptHit)
  const [hover, setHover] = React.useState(false)
  const reachable = !hit.foreign && !!hit.sessionId

  const title = hit.foreign
    ? 'Outside Vivarium'
    : `${hit.projectName} / ${hit.sessionName}`
  const detail = hit.foreign
    ? 'a claude-box conversation, or one whose session was deleted'
    : hit.archived
      ? 'an earlier conversation in this chat, retired by /clear'
      : 'this chat’s current conversation'

  return (
    <div
      onClick={() => reachable && openTranscriptHit(hit)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...(reachable ? { 'data-click': true, role: 'button', tabIndex: 0 } : {})}
      onKeyDown={(e) => {
        if (!reachable) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openTranscriptHit(hit)
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 12px',
        borderBottom: '1px solid var(--border)',
        background: reachable && hover ? 'var(--sel)' : 'transparent',
        cursor: reachable ? 'pointer' : 'default',
        opacity: reachable ? 1 : 0.66
      }}
    >
      <span style={{ display: 'flex', flex: 'none', color: reachable ? 'var(--accent2)' : 'var(--dim)' }}>
        <ChatBubble size={14} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {title}
          {hit.archived && (
            <span
              style={{
                marginLeft: 8,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                color: 'var(--warn)'
              }}
            >
              cleared
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--dim)', marginTop: 1 }}>{detail}</div>
      </div>
      <span
        title={`${hit.matches} transcript ${hit.matches === 1 ? 'line' : 'lines'} match`}
        style={{
          fontFamily: MONO,
          fontSize: 11.5,
          color: 'var(--muted)',
          flex: 'none',
          // The counts are the ranking, so they line up as a column rather than
          // ragging against each row's title length.
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {hit.matches}
      </span>
    </div>
  )
}

export function TranscriptSearch(): React.ReactElement {
  const query = useStore((s) => s.transcriptQuery)
  const hits = useStore((s) => s.transcriptHits)
  const searching = useStore((s) => s.transcriptSearching)
  const error = useStore((s) => s.transcriptError)
  const setQuery = useStore((s) => s.setTranscriptQuery)
  const run = useStore((s) => s.runTranscriptSearch)
  const close = useStore((s) => s.closeDialog)

  const reachable = (hits ?? []).filter((h) => !h.foreign)
  const foreign = (hits ?? []).filter((h) => h.foreign)

  return (
    <Overlay onClose={close}>
      <Panel width={620}>
        <div style={{ padding: '20px 24px 18px 24px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          <div
            style={{
              fontSize: 11.5,
              letterSpacing: '.6px',
              textTransform: 'uppercase',
              color: 'var(--dim)',
              display: 'flex',
              alignItems: 'center',
              gap: 7
            }}
          >
            <Search size={13} />
            Search conversations
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
            Greps every conversation on the shared Claude volume — this project’s and every
            other’s, including ones a <code style={{ fontFamily: MONO }}>/clear</code> retired.
            Needs Docker running; it reads each transcript in full, so a large archive takes a
            few seconds.
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              value={query}
              spellCheck={false}
              placeholder="Text to look for"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void run()
                }
              }}
              style={{
                flex: 1,
                height: 32,
                background: 'var(--input)',
                border: '1px solid var(--border-strong)',
                color: 'var(--fg)',
                fontFamily: MONO,
                fontSize: 12.5,
                padding: '0 10px',
                outline: 'none'
              }}
            />
            <FooterButton primary disabled={!query.trim() || searching} onClick={() => void run()}>
              {searching ? 'Searching…' : 'Search'}
            </FooterButton>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--danger)' }}>
              {error === 'docker-missing'
                ? 'Docker is not on PATH — start Docker or Rancher Desktop.'
                : error === 'no-volume'
                  ? 'There is no Claude volume yet, so there are no conversations to search.'
                  : error === 'timed-out'
                    ? 'The search took too long and was stopped.'
                    : error}
            </div>
          )}

          {/* `null` is "nothing has been searched yet"; an empty array is a real
              answer and has to read differently from an empty screen. */}
          {hits !== null && !searching && (
            <div
              style={{
                border: '1px solid var(--border)',
                maxHeight: 320,
                overflowY: 'auto',
                background: 'var(--card2)'
              }}
            >
              {reachable.map((h) => (
                <Row key={h.uuid} hit={h} />
              ))}
              {foreign.length > 0 && (
                <div
                  style={{
                    padding: '7px 12px',
                    fontFamily: MONO,
                    fontSize: 10.5,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: 'var(--dim)',
                    background: 'var(--panel)',
                    borderBottom: '1px solid var(--border)'
                  }}
                >
                  not in Vivarium
                </div>
              )}
              {foreign.map((h) => (
                <Row key={h.uuid} hit={h} />
              ))}
              {hits.length === 0 && (
                <div style={{ padding: '22px 12px', fontSize: 12.5, color: 'var(--dim)' }}>
                  No conversation contains that.
                </div>
              )}
            </div>
          )}

          {hits !== null && reachable.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>
              Pick one to open it with the find bar already on this term.
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <FooterButton onClick={close}>Close</FooterButton>
          </div>
        </div>
      </Panel>
    </Overlay>
  )
}
