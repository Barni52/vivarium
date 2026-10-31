import React from 'react'
import { useStore } from '../state/store'
import { leaf } from '../paths'
import { Folder, Plus } from './Icons'
import { ProjectRow } from './ProjectRow'

export function Sidebar(): React.ReactElement {
  const width = useStore((s) => s.sidebarWidth)
  const projects = useStore((s) => s.config.projects)
  const openAddProject = useStore((s) => s.openAddProject)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const outputFolder = useStore((s) => s.config.sharedOutputFolder)
  const outputOpen = useStore((s) => s.outputOpen)
  const toggleOutputPanel = useStore((s) => s.toggleOutputPanel)
  const [addHover, setAddHover] = React.useState(false)

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent): void => setSidebarWidth(startW + (ev.clientX - startX))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      style={{
        width,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel)',
        borderRight: '1px solid var(--border)',
        minHeight: 0,
        position: 'relative',
        fontSize: 12.5
      }}
    >
      {/* Adding a project is rare, so it is a quiet + on a header rather than the
          loudest thing on screen. It only earns a filled button in the one state
          where it is the next thing to do: below, when the list is empty. */}
      <div
        style={{
          flex: 'none',
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px 0 12px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <span style={{ fontWeight: 600 }}>Projects</span>
        <button
          onClick={openAddProject}
          title="Add project"
          aria-label="Add project"
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          style={{
            width: 24,
            height: 24,
            padding: 0,
            border: 0,
            borderRadius: 'var(--radius-sm)',
            background: addHover ? 'var(--sel)' : 'transparent',
            color: addHover ? 'var(--fg)' : 'var(--muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer'
          }}
        >
          <Plus size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '2px 0 8px 0' }}>
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
        {projects.length === 0 && (
          <div style={{ padding: 12 }}>
            <button
              onClick={openAddProject}
              style={{
                width: '100%',
                height: 38,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 14px',
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                border: 0,
                borderRadius: 'var(--radius)',
                fontSize: 12.5,
                fontWeight: 500,
                cursor: 'pointer',
                letterSpacing: '.2px'
              }}
            >
              <Plus size={16} />
              Add project
            </button>
          </div>
        )}
      </div>

      {/* The one row Output keeps here: the tree itself is the panel on the right
          of the window, so the project list has the sidebar's whole height. */}
      <button
        onClick={toggleOutputPanel}
        aria-pressed={outputOpen}
        title={outputFolder ?? 'No output folder set'}
        style={{
          flex: 'none',
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          border: 0,
          borderTop: '1px solid var(--border)',
          background: outputOpen ? 'var(--sel)' : 'transparent',
          color: 'var(--fg)',
          fontFamily: 'inherit',
          fontSize: 12.5,
          textAlign: 'left',
          cursor: 'pointer'
        }}
      >
        <span style={{ flex: 'none', display: 'flex', color: 'var(--accent2)' }}>
          <Folder size={15} />
        </span>
        <span style={{ flex: 'none', fontWeight: 600 }}>Output</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            color: 'var(--dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {outputFolder ? leaf(outputFolder) : 'not set'}
        </span>
      </button>

      {/* resize handle */}
      <div
        onMouseDown={startResize}
        style={{ position: 'absolute', top: 0, right: -3, width: 6, height: '100%', cursor: 'col-resize', zIndex: 5 }}
      />
    </div>
  )
}
