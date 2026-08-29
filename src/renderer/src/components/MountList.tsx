import React from 'react'
import { Folder, Plus, Close, Lock, Check } from './Icons'
import { mountTargets } from '@shared/mounts'
import { useStore } from '../state/store'
import { leaf, relLabel, samePath, splitEntries } from '../paths'
import { MONO } from '../theme'

export function MountList({
  mounts,
  basePath,
  draft,
  setDraft,
  onAdd,
  onBrowse,
  onRemove,
  locked,
  lockedNote
}: {
  /** absolute host paths */
  mounts: string[]
  /** base folder, used only to display mounts relative to it */
  basePath: string
  draft?: string
  setDraft?: (v: string) => void
  /** takes a batch: the field splits on commas, the picker is multi-select */
  onAdd?: (names: string[]) => void
  onBrowse?: () => void
  onRemove?: (index: number) => void
  locked?: boolean
  lockedNote?: string
}): React.ReactElement {
  const editable = !locked && !!onAdd
  const add = (): void => {
    const names = splitEntries(draft ?? '')
    if (names.length && onAdd) onAdd(names)
  }

  // Where each of these folders actually lands, computed by the same rule
  // `docker.ts` builds its `--mount` targets with (`@shared/mounts`) rather than
  // from the folder's own name. It has to be the whole list at once: the leaf is
  // sanitized, the shared output folder reserves `/workspace/output` ahead of
  // everything, and a leaf already claimed by a mount above it gets a hash
  // suffix — so a mount's target is a fact about the list, not about the mount.
  // The shared entry is dropped again: this dialog lists the project's own
  // folders, and what is left lines up with `mounts` one for one.
  const sharedOutput = useStore((s) => s.config.sharedOutputFolder)
  const targets = mountTargets(mounts, sharedOutput).filter((t) => !t.shared)

  // The base folder's immediate subfolders, offered as one-click chips. This is
  // the quick path for the case the dialog is actually for — a new project whose
  // mounts are four of its own subfolders — where typing each name or walking
  // the native picker four times is the slow way to say something obvious.
  //
  // Fetched here rather than passed in: both dialogs would otherwise carry the
  // same effect, and the answer depends on nothing but `basePath`.
  const [subs, setSubs] = React.useState<string[]>([])
  React.useEffect(() => {
    const base = basePath.trim()
    if (!editable || !base) {
      setSubs([])
      return
    }
    // The base folder is typed a character at a time in the Add-Project dialog,
    // and every character would otherwise be a readdir of whatever prefix
    // happens to exist ("C:\proj" while heading for "C:\projects").
    let alive = true
    const t = setTimeout(() => {
      void window.vivarium.subfolders(base).then((dirs) => {
        if (alive) setSubs(dirs)
      })
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [basePath, editable])

  const indexOf = (abs: string): number => mounts.findIndex((m) => samePath(m, abs))
  const toggle = (abs: string): void => {
    const i = indexOf(abs)
    if (i >= 0) onRemove?.(i)
    else onAdd?.([abs])
  }
  const unmounted = subs.filter((d) => indexOf(d) < 0)

  // Hover is a per-chip state rather than a CSS rule: the app-wide hover/press
  // filter is scoped to `.vchat`, and every surface in this dialog is styled
  // inline, where a sheet rule would lose anyway.
  const [hover, setHover] = React.useState<string | null>(null)

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--input)', opacity: locked ? 0.62 : 1 }}>
      <div style={{ padding: '13px 16px 12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--accent)', display: 'flex' }}>
            <Folder />
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Mount folders</span>
          {locked ? (
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--dim)',
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 5
              }}
            >
              <Lock /> Locked
            </span>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--dim)', marginLeft: 'auto' }}>
              {mounts.length} {mounts.length === 1 ? 'folder' : 'folders'}
            </span>
          )}
        </div>
        {locked ? (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6, lineHeight: 1.5 }}>
            {lockedNote ?? 'Mounts can’t change while the container is running — stop it to edit them.'}
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--dim)', marginTop: 5, lineHeight: 1.5 }}>
            Only these subfolders are mounted into the container. Everything else in the base
            folder stays on the host. Several at once: type{' '}
            <span style={{ color: 'var(--fg)' }}>frontend, backend</span>, or Ctrl-click in
            Browse….
          </div>
        )}
      </div>

      {editable && (
        <div style={{ display: 'flex', padding: '12px 16px 10px 16px' }}>
          <input
            value={draft ?? ''}
            onChange={(e) => setDraft?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="e.g. frontend, backend, libs"
            style={{
              flex: 1,
              height: 36,
              background: 'var(--card2)',
              border: 0,
              borderBottom: '1px solid var(--dim)',
              color: 'var(--fg)',
              fontFamily: MONO,
              fontSize: 12.5,
              padding: '0 12px',
              outline: 'none'
            }}
          />
          {onBrowse && (
            <button
              onClick={onBrowse}
              title="Choose folders… (Ctrl-click for several)"
              style={{
                height: 36,
                padding: '0 14px',
                background: 'var(--card2)',
                border: 0,
                borderBottom: '1px solid var(--dim)',
                color: 'var(--fg)',
                fontSize: 12.5,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                whiteSpace: 'nowrap'
              }}
            >
              <Folder size={13} />
              Browse…
            </button>
          )}
          <button
            onClick={add}
            style={{
              height: 36,
              padding: '0 16px',
              background: 'var(--accent)',
              border: 0,
              color: 'var(--accent-fg)',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      )}

      {editable && subs.length > 0 && (
        <div style={{ padding: '0 16px 10px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
            <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
              In the base folder — click to mount
            </span>
            {unmounted.length > 1 && (
              <button
                onClick={() => onAdd?.(unmounted)}
                style={{
                  marginLeft: 'auto',
                  height: 22,
                  padding: '0 9px',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--dim)',
                  fontSize: 11.5,
                  cursor: 'pointer'
                }}
              >
                Add all {unmounted.length}
              </button>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              // Enough for three rows of chips before it scrolls — a folder with
              // forty subdirectories must not push the mount list itself off
              // the bottom of the dialog.
              maxHeight: 96,
              overflowY: 'auto'
            }}
          >
            {subs.map((d) => {
              const on = indexOf(d) >= 0
              const lit = hover === d
              return (
                <button
                  key={d}
                  onClick={() => toggle(d)}
                  onMouseEnter={() => setHover(d)}
                  onMouseLeave={() => setHover((h) => (h === d ? null : h))}
                  title={on ? `Mounted — click to remove` : `Mount ${leaf(d)}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    height: 26,
                    padding: '0 9px',
                    // `--sel` is the app's "this row is selected" fill, which is
                    // exactly what a mounted chip is.
                    background: on ? 'var(--sel)' : lit ? 'var(--card2)' : 'transparent',
                    border: '1px solid',
                    borderColor: on ? 'var(--accent)' : lit ? 'var(--dim)' : 'var(--border)',
                    color: on ? 'var(--accent)' : 'var(--fg)',
                    fontFamily: MONO,
                    fontSize: 11.5,
                    cursor: 'pointer'
                  }}
                >
                  {on ? <Check size={11} /> : <Plus size={11} />}
                  {leaf(d)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div
        style={{
          padding: editable ? '0 16px 14px 16px' : '12px 16px 14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 96
        }}
      >
        {mounts.length === 0 ? (
          <div
            style={{
              flex: 1,
              minHeight: 88,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              border: '1px dashed var(--border)',
              color: 'var(--dim)'
            }}
          >
            <span style={{ fontSize: 12.5 }}>No folders mounted yet</span>
            <span style={{ fontSize: 11.5 }}>Add the subfolders your agent should see.</span>
          </div>
        ) : (
          mounts.map((m, i) => (
            <div
              key={`${m}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 38,
                padding: '0 6px 0 12px',
                background: 'var(--card2)',
                borderLeft: '2px solid var(--accent)'
              }}
            >
              <span style={{ color: 'var(--dim)', display: 'flex' }}>
                <Folder size={13} />
              </span>
              <span style={{ flex: 1, fontFamily: MONO, fontSize: 12.5, color: 'var(--fg)' }}>
                {relLabel(basePath, m)}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--dim)', fontFamily: MONO }}>
                → {targets[i]?.target}
              </span>
              {editable && onRemove && (
                <button
                  onClick={() => onRemove(i)}
                  style={{
                    width: 28,
                    height: 28,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--dim)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <Close size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
