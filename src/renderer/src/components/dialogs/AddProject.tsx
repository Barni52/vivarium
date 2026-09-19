import React from 'react'
import type { ProjectKind } from '@shared/types'
import { useStore } from '../../state/store'
import { MONO } from '../../theme'
import { Overlay, Panel, FooterButton, ImageToggle, fieldStyle, labelStyle } from '../ui'
import { MountList } from '../MountList'
import { ContainerCube, Monitor } from '../Icons'
import { mergeMounts } from '../../paths'

// The first decision in the dialog, and the only one that cannot be taken back
// (Project.kind is fixed at creation), so it is two cards rather than a toggle
// tucked in with the image variant: a glyph each — the same two a project row
// and the chooser share — a one-word name, and what actually runs.
function KindCard({
  kind,
  selected,
  onPick
}: {
  kind: ProjectKind
  selected: boolean
  onPick: () => void
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const host = kind === 'host'
  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        height: 58,
        padding: '0 14px',
        border: '1px solid',
        borderColor: selected ? 'var(--accent)' : 'var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        background: selected || hover ? 'var(--sel)' : 'transparent',
        // The same armed-row bar the session picker draws, so "this one" reads
        // the same way in both places a type is picked.
        boxShadow: selected ? 'inset 3px 0 0 var(--accent)' : 'none',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--radius-sm)',
          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
          background: selected ? 'var(--card2)' : 'var(--input)',
          color: selected ? 'var(--fg)' : 'var(--muted)'
        }}
      >
        {host ? <Monitor size={17} /> : <ContainerCube size={17} />}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: selected ? 'var(--fg)' : 'var(--muted)',
            lineHeight: 1.1
          }}
        >
          {host ? 'Host' : 'Container'}
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontFamily: MONO,
            color: 'var(--dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {host ? 'on Windows · no Docker' : 'Docker · mounted folders'}
        </span>
      </span>
    </button>
  )
}

export function AddProject(): React.ReactElement {
  const ap = useStore((s) => s.ap)
  const setAp = useStore((s) => s.setAp)
  const closeDialog = useStore((s) => s.closeDialog)
  const createProject = useStore((s) => s.createProject)

  const browse = async (): Promise<void> => {
    const dir = await window.vivarium.browseFolder()
    if (dir) setAp({ basePath: dir })
  }

  const addMounts = (names: string[]): void => {
    setAp({ mounts: mergeMounts(ap.basePath, ap.mounts, names), mountDraft: '' })
  }

  // Multi-select: Ctrl-click four packages in the picker and they all land.
  const browseMount = async (): Promise<void> => {
    const dirs = await window.vivarium.browseFolders()
    if (dirs.length) addMounts(dirs)
  }

  const slim = ap.image === 'slim'
  const host = ap.kind === 'host'

  return (
    <Overlay onClose={closeDialog}>
      <Panel>
        <div style={{ padding: '20px 24px 4px 24px', flex: 'none' }}>
          <div
            style={{
              fontSize: 11.5,
              letterSpacing: '.6px',
              textTransform: 'uppercase',
              color: 'var(--dim)',
              marginBottom: 6
            }}
          >
            New project
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Add project</div>
        </div>

        <div
          style={{
            padding: '16px 24px',
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 18
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Runs in</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <KindCard kind="container" selected={!host} onPick={() => setAp({ kind: 'container' })} />
              <KindCard kind="host" selected={host} onPick={() => setAp({ kind: 'host' })} />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.5, marginTop: 2 }}>
              {host
                ? 'Claude Code and PowerShell, run straight in the base folder with your own Windows account. No container and no mounts — and Claude asks before it acts, as it does in any terminal.'
                : 'Agents, chats and both terminals, sandboxed in a Docker container that sees only the folders you mount.'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Project name</label>
            <input
              value={ap.name}
              onChange={(e) => setAp({ name: e.target.value })}
              placeholder="my-service"
              style={fieldStyle()}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Base folder</label>
            <div style={{ display: 'flex' }}>
              <input
                value={ap.basePath}
                onChange={(e) => setAp({ basePath: e.target.value })}
                placeholder="C:\projects\my-service"
                style={{ ...fieldStyle(true), flex: 1 }}
              />
              <button
                onClick={browse}
                style={{
                  height: 40,
                  padding: '0 16px',
                  background: 'var(--card2)',
                  border: 0,
                  borderBottom: '1px solid var(--dim)',
                  color: 'var(--fg)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                Browse…
              </button>
            </div>
          </div>

          {/* Hidden rather than disabled on a host project: none of it has a
              meaning there, and the draft keeps what was typed so flipping back
              to Container loses nothing. */}
          {!host && (
            <MountList
              mounts={ap.mounts}
              basePath={ap.basePath}
              draft={ap.mountDraft}
              setDraft={(v) => setAp({ mountDraft: v })}
              onAdd={addMounts}
              onBrowse={browseMount}
              onRemove={(i) => setAp({ mounts: ap.mounts.filter((_, j) => j !== i) })}
            />
          )}

          {!host && (
            <div style={{ display: 'flex', gap: 20 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <label style={labelStyle}>Image variant</label>
                <ImageToggle value={ap.image} onChange={(image) => setAp({ image })} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <label style={labelStyle}>
                  Published port{' '}
                  <span style={{ color: 'var(--dim)' }}>{slim ? '(Full image only)' : '(optional)'}</span>
                </label>
                <input
                  value={ap.port}
                  disabled={slim}
                  onChange={(e) => setAp({ port: e.target.value })}
                  placeholder={slim ? '—' : '4200'}
                  style={{ ...fieldStyle(true), opacity: slim ? 0.5 : 1, cursor: slim ? 'not-allowed' : 'text' }}
                />
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 'none', display: 'flex', borderTop: '1px solid var(--border)' }}>
          {/* Names what it will create, like the session picker's button. */}
          <FooterButton primary onClick={createProject}>
            {host ? 'Create host project' : 'Create project'}
          </FooterButton>
          <FooterButton onClick={closeDialog}>Cancel</FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
