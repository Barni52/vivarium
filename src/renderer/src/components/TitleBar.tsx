import React from 'react'
import type { UsageLimit } from '@shared/types'
import { PanelToggle } from './Icons'
import { Logo } from './Logo'
import { useStore } from '../state/store'
import { chipSummary } from '../claude'
import { MONO, THEMES } from '../theme'

// Frameless custom title bar (mockup lines 308-322). The bar is draggable via
// -webkit-app-region; buttons opt out so they stay clickable.
const drag: React.CSSProperties = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function WinButton({
  onClick,
  hoverBg,
  hoverColor,
  children
}: {
  onClick: () => void
  hoverBg: string
  hoverColor?: string
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // 42 wide and full-height: the whole strip is the hit area, so the
        // three of them tile the corner with no dead pixel between them.
        width: 42,
        height: '100%',
        border: 0,
        borderRadius: 0,
        background: hover ? hoverBg : 'transparent',
        color: hover && hoverColor ? hoverColor : 'var(--muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
        ...noDrag
      }}
    >
      {children}
    </button>
  )
}

function limitTitle(l: UsageLimit): string {
  const what = l.kind === 'session' ? 'Session (5h) limit' : 'Weekly (7d) limit, all models'
  const reset = l.resetsAt
    ? ` — resets ${new Date(l.resetsAt).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })}`
    : ''
  const sev = l.severity !== 'normal' ? ` (${l.severity})` : ''
  return `${what}: ${Math.round(l.percent)}% used${sev}${reset}`
}

// Time until reset. Derived from the last API response's resets_at against the
// local clock, so it ticks between polls and re-syncs whenever a fresh snapshot
// lands. Clamped at zero — the next poll brings the new window. The session (5h)
// window reads "XXh XXm"; the weekly window can be days out, so `days` switches
// it to "XXd XXh".
function countdown(resetsAt: string | null, now: number, days = false): string | null {
  if (!resetsAt) return null
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms)) return null
  const mins = Math.max(0, Math.floor(ms / 60_000))
  if (days) {
    const hrs = Math.floor(mins / 60)
    return `${Math.floor(hrs / 24)}d ${String(hrs % 24).padStart(2, '0')}h`
  }
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

function UsageChip({
  limit,
  now,
  staleNote
}: {
  limit: UsageLimit
  now: number
  staleNote: string
}): React.ReactElement {
  const pct = Math.max(0, Math.min(100, limit.percent))
  // Green until it matters, then the two escalating tokens. --ok is the same
  // green the container indicator uses, and means the same thing here: there is
  // headroom. --warn and --danger take over only once there isn't.
  const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)'
  const cd = countdown(limit.resetsAt, now, limit.kind !== 'session')
  return (
    <span
      title={limitTitle(limit) + staleNote}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: 'none',
        opacity: staleNote ? 0.55 : 1
      }}
    >
      <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
        {limit.kind === 'session' ? '5h' : '7d'}
      </span>
      {/* 56×7 pill on --track. A quota meter and the chat's context meter are
          the same object at two sizes, and both keep the track visible under an
          empty fill — "none used" has to look different from "no data". */}
      <span
        style={{
          width: 56,
          height: 7,
          borderRadius: 4, // a pill, so half its 7px height rather than a token
          background: 'var(--track)',
          overflow: 'hidden',
          display: 'flex'
        }}
      >
        <span style={{ width: `${pct}%`, background: color }} />
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 28 }}>
        {Math.round(pct)}%
      </span>
      {cd && <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>{cd}</span>}
    </span>
  )
}

// Claude plan usage chips (main/usage.ts via the store's 3-minute poll): the
// 5h session window and the 7d all-models window — per-model limits
// deliberately not rendered, the tooltip carries the detail. Rendered in the
// title bar so limits are visible no matter which session is open.
function UsageChips(): React.ReactElement | null {
  const usage = useStore((s) => s.usage)
  // Local 30s tick: between polls the countdown interpolates off the app
  // clock; the values re-sync whenever refreshUsage lands a fresh snapshot.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!usage) return null // first poll not landed yet
  const shown = usage.limits.filter((l) => l.kind === 'session' || l.kind === 'weekly_all')
  if (!usage.ok || shown.length === 0) {
    const title =
      usage.error === 'no-credentials'
        ? 'No Claude credentials found (host ~/.claude or the claude-box-creds volume)'
        : usage.error === 'auth-expired'
          ? 'Claude sign-in expired — run any agent so claude refreshes the token'
          : usage.error === 'rate-limited'
            ? 'Usage endpoint rate-limited — backing off, retrying automatically'
            : `Could not fetch Claude usage (${usage.error ?? 'empty response'})`
    return <span style={{ fontSize: 11.5, color: 'var(--dim)' }} title={title}>usage n/a</span>
  }
  // The store keeps the last good snapshot through failed polls — flag it once
  // it's older than 1.5 poll intervals (a sync was missed), with the chips
  // dimmed and the age in the tooltip. The countdown stays live regardless.
  const ageMin = Math.round((now - usage.fetchedAt) / 60_000)
  const staleNote = now - usage.fetchedAt > 270_000 ? ` — last synced ${ageMin}m ago` : ''
  return (
    <>
      {shown.map((l, i) => (
        <React.Fragment key={l.kind}>
          {/* thin vertical rule so the 5h and 7d windows read as separate groups */}
          {i > 0 && <span style={{ width: 1, height: 14, background: 'var(--border)', flex: 'none' }} />}
          <UsageChip limit={l} now={now} staleNote={staleNote} />
        </React.Fragment>
      ))}
    </>
  )
}

/**
 * The theme switcher: one 9px swatch per theme, the active one outlined.
 *
 * Three squares rather than a dropdown because there are exactly three and they
 * are their own labels — the choice *is* a colour, so a menu would name what the
 * swatch already shows. It lives at the right-hand end of the wordmark group,
 * with the readings (usage, Claude version) rather than the window controls: it
 * is app state, and nothing here should sit next to a button that closes the app.
 *
 * The outline is drawn as a `box-shadow` ring outside the swatch rather than a
 * border inside it — a 1px border on a 9px square eats a fifth of the colour it
 * is meant to be showing you. The gap between ring and swatch is `--panel`, so
 * the ring reads as separate from the colour at any theme.
 */
function ThemeSwitch(): React.ReactElement {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', ...noDrag }}>
      {THEMES.map((t) => {
        const on = t.name === theme
        return (
          <button
            key={t.name}
            title={`${t.label} theme (Ctrl+Shift+T cycles)`}
            aria-label={`${t.label} theme`}
            aria-pressed={on}
            onClick={() => setTheme(t.name)}
            style={{
              width: 9,
              height: 9,
              padding: 0,
              flex: 'none',
              border: 0,
              borderRadius: 2,
              background: t.swatch,
              cursor: 'pointer',
              // The ring, and a transparent one when off so the swatch never
              // moves or resizes between states — `box-shadow` is outside the
              // box either way, but keeping both branches identical in shape
              // means the row's height cannot change on a click.
              boxShadow: on
                ? '0 0 0 1.5px var(--panel), 0 0 0 3px var(--fg)'
                : '0 0 0 1.5px var(--panel), 0 0 0 3px transparent',
              // A swatch is a colour sample. It must not cross-fade to the next
              // theme's value on a swap — the whole point is that it is fixed
              // while everything around it changes.
              transition: 'box-shadow .12s'
            }}
          />
        )
      })}
    </span>
  )
}

// Which build this is. The app ships as an installer and updates by reinstalling,
// so there was previously no way to tell one build from another — including in a
// bug report. The runtime versions ride along in the tooltip for the same reason.
function AppVersion(): React.ReactElement | null {
  const info = useStore((s) => s.appInfo)
  if (!info) return null
  return (
    <span
      title={`Vivarium ${info.version}\nElectron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`}
      style={{
        fontSize: 11.5,
        color: 'var(--dim)',
        fontFamily: MONO,
        // Sits with the wordmark, not with the live chips on the right — this is
        // identity, not status, and it must never draw the eye.
        opacity: 0.75
      }}
    >
      v{info.version}
      {/* Which window this is, when there is more than one to mix up: the same
          app beside the same app, down to the theme. Silent on the first. */}
      {info.instance > 0 && ` · window ${info.instance + 1}`}
    </span>
  )
}

// Claude Code version chip + the only entry point to the manual-update dialog.
// Updates are rare (months apart), so this stays deliberately quiet: muted grey
// text while every container is current, and it only earns colour + a dot when
// something is actually behind npm's latest. No badge, no toast, no nagging —
// glance at it or don't.
function ClaudeChip(): React.ReactElement | null {
  const status = useStore((s) => s.claude)
  const checking = useStore((s) => s.claudeChecking)
  const openClaudeUpdate = useStore((s) => s.openClaudeUpdate)
  const names = useStore((s) => {
    const out: Record<string, string> = {}
    for (const p of s.config.projects) out[p.id] = p.name
    return out
  })
  const [hover, setHover] = React.useState(false)

  const chip = chipSummary(status, names)
  if (!chip) return null // first check hasn't landed / nothing to say
  const behind = chip.behind > 0

  return (
    <>
      {/* same thin rule the usage windows use, so the two groups read apart */}
      <span style={{ width: 1, height: 14, background: 'var(--border)', flex: 'none' }} />
      <button
        title={chip.tooltip}
        onClick={openClaudeUpdate}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          padding: '0 8px',
          border: 0,
          borderRadius: 'var(--radius-sm)',
          background: hover ? 'var(--sel)' : 'transparent',
          color: behind ? 'var(--fg)' : 'var(--dim)',
          fontSize: 11.5,
          cursor: 'pointer',
          flex: 'none',
          opacity: checking ? 0.6 : 1,
          ...noDrag
        }}
      >
        {behind && (
          <span
            style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', flex: 'none' }}
          />
        )}
        {/* The product's own name for itself, in the warm accent — the one word
            in this bar that is a brand rather than a reading. */}
        <span style={{ color: 'var(--accent2)' }}>claude</span>
        <span style={{ fontFamily: MONO, fontSize: 11.5 }}>
          {chip.label}
          {/* mixed versions across containers: the chip shows the oldest, the
              tooltip lists them all — the marker stops it reading as the truth */}
          {chip.mixed && '+'}
        </span>
        {behind && status?.latest && (
          <span
            style={{
              color: 'var(--str)',
              fontFamily: MONO,
              fontSize: 11.5
            }}
          >
            → {status.latest}
          </span>
        )}
      </button>
    </>
  )
}

export function TitleBar(): React.ReactElement {
  const v = window.vivarium
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const [toggleHover, setToggleHover] = React.useState(false)
  return (
    <div
      style={{
        // 32px, which is what pins every vertical number in here: the window
        // buttons are full-height (so 32 tall, 42 wide), the sidebar toggle sits
        // inside it with 2px to spare, and the chips are 24.
        height: 32,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--panel)',
        borderBottom: '1px solid var(--border)',
        userSelect: 'none',
        paddingLeft: 10,
        ...drag
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={toggleSidebar}
          onMouseEnter={() => setToggleHover(true)}
          onMouseLeave={() => setToggleHover(false)}
          style={{
            width: 28,
            height: 24,
            border: 0,
            background: toggleHover ? 'var(--sel)' : 'transparent',
            color: collapsed ? 'var(--muted)' : 'var(--accent2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            borderRadius: 'var(--radius-sm)',
            ...noDrag
          }}
        >
          <PanelToggle size={18} />
        </button>
        <Logo size={18} style={{ flex: 'none' }} />
        <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '.2px' }}>Vivarium</span>
        <span style={{ fontSize: 11.5, color: 'var(--dim)', fontWeight: 400 }}>session manager</span>
        <AppVersion />
        {/* Its own separator and a little more air: the three swatches are the
            one *control* in this group, and everything to their left is a label. */}
        <span style={{ width: 1, height: 14, background: 'var(--border)', flex: 'none', marginLeft: 2 }} />
        <ThemeSwitch />
      </div>
      <div style={{ display: 'flex', alignItems: 'stretch', alignSelf: 'stretch' }}>
        {/* No noDrag on the wrapper: the usage chips are hover-tooltip-only, so
            the region stays draggable (tooltips still fire over a drag region).
            The version chip opts out on its own — it's the one click target. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginRight: 12 }}>
          {/* usage chips first so their position doesn't shift when the version
              chip appears or disappears — they're the ones read at a glance */}
          <UsageChips />
          <ClaudeChip />
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <WinButton onClick={() => v.windowMinimize()} hoverBg="var(--sel)">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </WinButton>
          <WinButton onClick={() => v.windowMaximize()} hoverBg="var(--sel)">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
            </svg>
          </WinButton>
          {/* The one control in the app that is red before you have done
              anything wrong — it closes the window, and the convention is worth
              more than the consistency.

              **The one literal colour left in the app**, and deliberately so:
              this red is Windows' close-button red, not Vivarium's. It is the
              same on cream as it is on carbon because the thing it belongs to —
              the window frame — is the same on both. Every other colour here is
              a token; this one is a quotation. */}
          <WinButton onClick={() => v.windowClose()} hoverBg="#c2352a" hoverColor="var(--danger-fg)">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </WinButton>
        </div>
      </div>
    </div>
  )
}
