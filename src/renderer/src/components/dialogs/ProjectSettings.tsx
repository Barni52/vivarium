import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton, ImageToggle, fieldStyle, labelStyle } from '../ui'
import { MountList } from '../MountList'
import { Monitor, Restart, Trash } from '../Icons'
import { mergeMounts } from '../../paths'

export function ProjectSettings(): React.ReactElement | null {
  const st = useStore((s) => s.st)
  const setSt = useStore((s) => s.setSt)
  const closeDialog = useStore((s) => s.closeDialog)
  const saveSettings = useStore((s) => s.saveSettings)
  const restart = useStore((s) => s.restart)
  const requestDeleteProject = useStore((s) => s.requestDeleteProject)
  const [restartHover, setRestartHover] = React.useState(false)
  const [deleteHover, setDeleteHover] = React.useState(false)

  if (!st) return null
  const slim = st.image === 'slim'
  const host = st.kind === 'host'

  const addMounts = (names: string[]): void => {
    setSt({ mounts: mergeMounts(st.basePath, st.mounts, names), mountDraft: '' })
  }

  // Multi-select, like the Add-Project dialog: several mounts, one trip.
  const browseMount = async (): Promise<void> => {
    const dirs = await window.vivarium.browseFolders()
    if (dirs.length) addMounts(dirs)
  }

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
            Project settings
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{st.name}</div>
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
            <label style={labelStyle}>Project name</label>
            <input value={st.name} onChange={(e) => setSt({ name: e.target.value })} style={fieldStyle()} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Base folder</label>
            <input value={st.basePath} onChange={(e) => setSt({ basePath: e.target.value })} style={fieldStyle(true)} />
            {/* The consequence main acts on (see the updateProject handler),
                said before Save rather than discovered after. */}
            {host && (
              <div style={{ fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.5 }}>
                Moving the folder starts its agents on new conversations — Claude only resumes a
                conversation from the folder it began in.
              </div>
            )}
          </div>

          {host && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--muted)',
                fontSize: 11.5,
                lineHeight: 1.5
              }}
            >
              <Monitor size={16} style={{ flex: 'none' }} />
              <span>
                Host project — runs on Windows with no container. A project can’t be converted
                between host and container; create a new one instead.
              </span>
            </div>
          )}

          {/* Everything container-shaped, gone rather than disabled on a host
              project: none of it has a meaning there. */}
          {!host && (
            <>
              <MountList
                mounts={st.mounts}
                basePath={st.basePath}
                draft={st.mountDraft}
                setDraft={(v) => setSt({ mountDraft: v })}
                locked={st.locked}
                lockedNote="Mounts can’t change while a session is live — stop the container to edit them."
                onAdd={addMounts}
                onBrowse={browseMount}
                onRemove={(i) => setSt({ mounts: st.mounts.filter((_, j) => j !== i) })}
              />

              <div style={{ display: 'flex', gap: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <label style={labelStyle}>Image variant</label>
                  <ImageToggle value={st.image} onChange={(image) => setSt({ image })} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <label style={labelStyle}>
                    Published port{' '}
                    <span style={{ color: 'var(--dim)' }}>{slim ? '(Full image only)' : ''}</span>
                  </label>
                  <input
                    value={st.port}
                    disabled={slim}
                    onChange={(e) => setSt({ port: e.target.value })}
                    placeholder={slim ? '—' : '4200'}
                    style={{ ...fieldStyle(true), opacity: slim ? 0.5 : 1, cursor: slim ? 'not-allowed' : 'text' }}
                  />
                </div>
              </div>

              <button
                onClick={() => restart(st.id)}
                onMouseEnter={() => setRestartHover(true)}
                onMouseLeave={() => setRestartHover(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  height: 40,
                  border: '1px solid var(--border)',
                  background: restartHover ? 'var(--input)' : 'transparent',
                  borderColor: restartHover ? 'var(--dim)' : 'var(--border)',
                  color: 'var(--fg)',
                  fontSize: 12.5,
                  cursor: 'pointer'
                }}
              >
                <Restart />
                Restart container
              </button>
            </>
          )}

          <button
            onClick={() => requestDeleteProject(st.id, st.name)}
            onMouseEnter={() => setDeleteHover(true)}
            onMouseLeave={() => setDeleteHover(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 40,
              border: '1px solid',
              borderColor: deleteHover ? 'var(--danger)' : 'var(--border)',
              background: deleteHover ? 'var(--danger-soft)' : 'transparent',
              color: 'var(--danger)',
              fontSize: 12.5,
              cursor: 'pointer'
            }}
          >
            <Trash />
            Delete project
          </button>
        </div>

        <div style={{ flex: 'none', display: 'flex', borderTop: '1px solid var(--border)' }}>
          <FooterButton primary onClick={saveSettings}>
            Save changes
          </FooterButton>
          <FooterButton onClick={closeDialog}>Cancel</FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
