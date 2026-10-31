import React from 'react'
import { MONO } from '../theme'

// Small shared dialog primitives styled from the mockup.

export const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--overlay)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: 64,
  zIndex: 40,
  animation: 'vover .12s ease'
}

export function Overlay({
  onClose,
  children,
  center
}: {
  onClose: () => void
  children: React.ReactNode
  center?: boolean
}): React.ReactElement {
  return (
    <div
      onClick={onClose}
      style={{
        ...overlayStyle,
        alignItems: center ? 'center' : 'flex-start',
        paddingTop: center ? 0 : 64
      }}
    >
      {children}
    </div>
  )
}

export function Panel({
  width = 560,
  children
}: {
  width?: number
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width,
        maxWidth: 'calc(100vw - 40px)',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: '0 24px 60px -20px var(--shadow)',
        animation: 'vdlg .16s ease',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'calc(100vh - 110px)'
      }}
    >
      {children}
    </div>
  )
}

export const labelStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--muted)' }

// `mono` is now only about *size*: the app is one face throughout, so a path
// field and a label field differ by the weight of what they hold, not by family.
export function fieldStyle(mono?: boolean): React.CSSProperties {
  return {
    height: 38,
    background: 'var(--input)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--fg)',
    fontFamily: MONO,
    fontSize: mono ? 11.5 : 12.5,
    padding: '0 10px',
    outline: 'none'
  }
}

export function FooterButton({
  primary,
  danger,
  disabled,
  onClick,
  children,
  height = 52
}: {
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  height?: number
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const lit = hover && !disabled
  // A filled button brightens; an unfilled one takes the row fill. Neither has a
  // second colour of its own — see the "Add project" button for the argument.
  const filled = primary || danger
  const bg = danger ? 'var(--danger)' : primary ? 'var(--accent)' : lit ? 'var(--sel)' : 'transparent'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        height,
        border: 0,
        borderRadius: 0,
        background: bg,
        filter: lit && filled ? 'brightness(1.12)' : 'none',
        transition: 'filter .12s,background-color .12s',
        color: danger ? 'var(--danger-fg)' : primary ? 'var(--accent-fg)' : 'var(--muted)',
        fontSize: 12.5,
        fontWeight: filled ? 500 : 400,
        // Dim rather than grey out: the label still has to be readable, since
        // it's usually explaining *why* it's unavailable.
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer'
      }}
    >
      {children}
    </button>
  )
}

export function ImageToggle({
  value,
  onChange
}: {
  value: 'slim' | 'full'
  onChange: (v: 'slim' | 'full') => void
}): React.ReactElement {
  const cell = (active: boolean): React.CSSProperties => ({
    flex: 1,
    border: 0,
    borderRadius: 0,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? 'var(--accent-fg)' : 'var(--muted)',
    fontSize: 12.5,
    cursor: 'pointer',
    fontWeight: 500
  })
  return (
    <div
      style={{
        display: 'flex',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        height: 38
      }}
    >
      <button style={cell(value === 'slim')} onClick={() => onChange('slim')}>
        Slim
      </button>
      <button style={{ ...cell(value === 'full'), borderLeft: '1px solid var(--border-strong)' }} onClick={() => onChange('full')}>
        Full
      </button>
    </div>
  )
}

/** The small icon button on the Output panel's headers. */
export function PanelBtn({
  title,
  onClick,
  children
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'var(--muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
