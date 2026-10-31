import React from 'react'
import { AGENT_PANEL_MIN, useStore } from '../state/store'
import { leaf } from '../paths'
import { MONO } from '../theme'
import { CollapseAll, Close, Dots, Folder, OpenExternal } from './Icons'
import { LineCounts } from './LineCounts'
import { OutputPreview } from './OutputPreview'
import { OutputTree } from './OutputTree'
import { PanelBtn } from './ui'

/** The width it opens at until someone drags it. The agent panel's, on purpose. */
const OUTPUT_WIDTH = 440
/** What the panel always leaves the chat or terminal beside it. */
const OUTPUT_MAIN_MIN = 320
/** How long the line at the foot of the panel stays. */
const NOTICE_MS = 4000

/**
 * The shared output folder, as a panel down the right of the window.
 *
 * It lived in the sidebar, where the tree and the project list took height from
 * each other, and nothing in it could be read without leaving the app. Here it
 * sits beside whatever is on screen, chat or terminal, so it is mounted next to
 * `TerminalHost` rather than inside `ChatView`. It shares the agent panel's slot
 * all the same: one open at a time, the last one opened wins (see `outputOpen`).
 *
 * The tree stays mounted under a preview, hidden rather than removed, because
 * Back has to return to the tree exactly as it was left, scroll and filter
 * included.
 *
 * `vchat` puts it under the chat's hover and radius rules, and is what `Md` in
 * the preview needs to look the way it does in the log.
 */
export function OutputPanel(): React.ReactElement {
  const folder = useStore((s) => s.config.sharedOutputFolder)
  const preview = useStore((s) => s.outputPreview)
  const dragged = useStore((s) => s.outputPanelWidth)
  const sidebar = useStore((s) => (s.sidebarCollapsed ? 0 : s.sidebarWidth))
  const notice = useStore((s) => s.outputNotice)
  const setWidth = useStore((s) => s.setOutputPanelWidth)
  const setNotice = useStore((s) => s.setOutputNotice)
  const close = useStore((s) => s.closeOutputPanel)
  const collapseTree = useStore((s) => s.collapseOutputTree)
  const openOutputFolder = useStore((s) => s.openOutputFolder)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const setSharedOutput = useStore((s) => s.setSharedOutput)
  const [query, setQuery] = React.useState('')
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice, setNotice])

  /** Drag the left edge. Measured off the screen, as the agent panel's is. */
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const el = rootRef.current
    if (!el) return
    const startX = e.clientX
    const startW = el.offsetWidth
    const max = window.innerWidth - sidebar - OUTPUT_MAIN_MIN
    const move = (ev: MouseEvent): void => setWidth(Math.min(max, startW + (startX - ev.clientX)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const browse = async (): Promise<void> => {
    const dir = await window.vivarium.browseFolder()
    if (dir) await setSharedOutput(dir)
  }

  const showMenu = (e: React.MouseEvent): void => {
    const r = e.currentTarget.getBoundingClientRect()
    openContextMenu(r.left, r.bottom + 2, [
      { label: 'Change folder…', icon: <Folder size={14} />, onSelect: () => void browse() },
      { label: '---' },
      {
        // An X, not a trash can: this only forgets the folder and leaves every
        // file in it alone.
        label: 'Clear folder',
        icon: <Close size={13} />,
        danger: true,
        onSelect: () => void setSharedOutput(null)
      }
    ])
  }

  return (
    <div
      ref={rootRef}
      className="vchat"
      style={{
        flex: 'none',
        width: dragged ?? OUTPUT_WIDTH,
        minWidth: AGENT_PANEL_MIN,
        // A window made narrower after the drag must not push the chat out.
        maxWidth: `calc(100vw - ${sidebar + OUTPUT_MAIN_MIN}px)`,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--panel)',
        borderLeft: '1px solid var(--border)',
        fontSize: 12.5
      }}
    >
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 6, cursor: 'col-resize', zIndex: 5 }}
      />

      {!folder ? (
        <NoFolder onChoose={() => void browse()} onClose={close} />
      ) : (
        <>
          {!preview && (
            <>
              <div
                style={{
                  flex: 'none',
                  height: 38,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 8px 0 14px',
                  borderBottom: '1px solid var(--border)'
                }}
              >
                <span style={{ fontWeight: 600 }}>Output</span>
                <span
                  title={folder}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: MONO,
                    fontSize: 11.5,
                    color: 'var(--dim)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {leaf(folder)}
                </span>
                <PanelBtn title="Open in Explorer" onClick={openOutputFolder}>
                  <OpenExternal size={13} />
                </PanelBtn>
                <PanelBtn title="Change folder, clear folder" onClick={showMenu}>
                  <Dots size={13} />
                </PanelBtn>
                <PanelBtn title="Close" onClick={close}>
                  <Close size={12} />
                </PanelBtn>
              </div>
              <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 8px 14px' }}>
                <input
                  aria-label="Filter files"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc in this box means the box. Left to bubble it reaches
                    // ChatView's window listener, which reads it as "stop the turn".
                    if (e.key !== 'Escape') return
                    e.preventDefault()
                    setQuery('')
                  }}
                  placeholder="Filter"
                  spellCheck={false}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 26,
                    padding: '0 8px',
                    background: 'var(--input)',
                    border: '1px solid var(--border-strong)',
                    color: 'var(--fg)',
                    fontFamily: MONO,
                    fontSize: 11.5,
                    outline: 'none'
                  }}
                />
                <PanelBtn title="Collapse all" onClick={collapseTree}>
                  <CollapseAll size={13} />
                </PanelBtn>
              </div>
            </>
          )}
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div
              className="vchat-scroll"
              style={{
                position: 'absolute',
                inset: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingBottom: 8,
                visibility: preview ? 'hidden' : 'visible'
              }}
            >
              <OutputTree query={query} />
            </div>
            {preview && <OutputPreview key={preview} path={preview} />}
          </div>
        </>
      )}

      {notice && (
        <div
          role="status"
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 14px',
            borderTop: '1px solid var(--border)',
            fontSize: 11.5,
            color: 'var(--accent2)',
            minWidth: 0
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {notice.text}
          </span>
          {notice.counts && <LineCounts counts={notice.counts} />}
        </div>
      )}
    </div>
  )
}

function NoFolder({ onChoose, onClose }: { onChoose: () => void; onClose: () => void }): React.ReactElement {
  return (
    <>
      <div
        style={{
          flex: 'none',
          height: 38,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px 0 14px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <span style={{ flex: 1, fontWeight: 600 }}>Output</span>
        <PanelBtn title="Close" onClick={onClose}>
          <Close size={12} />
        </PanelBtn>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: 16,
          textAlign: 'center'
        }}
      >
        <div style={{ fontWeight: 600 }}>Pick where agents leave their work</div>
        <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>Containers see it at /workspace/output.</div>
        <button
          data-fill=""
          onClick={onChoose}
          style={{
            height: 30,
            padding: '0 14px',
            border: 0,
            background: 'var(--accent)',
            color: 'var(--accent-fg)',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: 'pointer'
          }}
        >
          Choose folder
        </button>
      </div>
    </>
  )
}
