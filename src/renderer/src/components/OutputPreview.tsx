import React from 'react'
import type { OutputFileRead } from '@shared/types'
import { useStore } from '../state/store'
import { MONO } from '../theme'
import { isDiffFile, parseDiff, type DiffFile, type ParsedDiff } from '../diffParse'
import { formatSize, outputFileFrom, outputRelative } from '../outputPaths'
import { leaf } from '../paths'
import { ImageViewer } from './chat/ChatLog'
import { Md } from './chat/Markdown'
import { Chevron, Close, Trash } from './Icons'
import { LineCounts } from './LineCounts'
import { PanelBtn } from './ui'

/**
 * A file past this many rows opens collapsed: its header still reports its size,
 * and a 40,000-line lockfile does not get 40,000 divs until someone asks.
 */
const DIFF_AUTO_OPEN = 400

const smallBtn: React.CSSProperties = {
  height: 26,
  padding: '0 9px',
  border: '1px solid var(--border-strong)',
  background: 'transparent',
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 11.5,
  whiteSpace: 'nowrap',
  cursor: 'pointer'
}

/**
 * Which chat wrote this file, by name, if any chat on screen did.
 *
 * Read off the log rows the store already holds, so it is memory only and needs
 * nothing persisted: a file written through `Bash`, or by a chat whose row has
 * scrolled out of what is loaded, simply says nothing. The newest writer wins.
 * Asked once per read rather than through a selector, because a selector would
 * walk every row of every chat on each token of a running turn.
 */
function writerOf(abs: string): string | null {
  const { config, chats } = useStore.getState()
  const root = config.sharedOutputFolder
  let found: { name: string; at: number } | null = null
  for (const project of config.projects) {
    for (const session of project.sessions) {
      for (const e of chats[session.id]?.entries ?? []) {
        if (e.kind !== 'tool' || !e.file || e.status !== 'ok') continue
        if (found && e.at < found.at) continue
        const file = outputFileFrom(root, e.file)
        if (file?.toLowerCase() === abs.toLowerCase()) found = { name: session.name, at: e.at }
      }
    }
  }
  return found?.name ?? null
}

/** Secondary to opening a file: reached from the eye on a row, or a chat card. */
export function OutputPreview({ path }: { path: string }): React.ReactElement {
  const root = useStore((s) => s.config.sharedOutputFolder) ?? ''
  // Any refresh of the tree re-reads the file, which is how an agent rewriting
  // it, or removing it, reaches an open preview.
  const tree = useStore((s) => s.outputTree)
  const close = useStore((s) => s.closeOutputPreview)
  const closePanel = useStore((s) => s.closeOutputPanel)
  const openFile = useStore((s) => s.openOutputFile)
  const reveal = useStore((s) => s.revealOutput)
  const copyPath = useStore((s) => s.copyOutputPath)
  const reference = useStore((s) => s.referenceOutput)
  const canReference = useStore((s) => s.canReferenceOutput())
  const deleteOutputPath = useStore((s) => s.deleteOutputPath)
  const [read, setRead] = React.useState<OutputFileRead | null>(null)

  React.useEffect(() => {
    let alive = true
    void window.vivarium.readOutputFile(path).then((next) => {
      if (!alive) return
      // Same bytes, same object: a busy folder must not re-parse an unchanged file.
      setRead((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    })
    return () => {
      alive = false
    }
  }, [path, tree])

  const name = leaf(path)
  const text = read?.kind === 'text' ? read.text : ''
  const diff = React.useMemo(
    () => (read?.kind === 'text' && isDiffFile(name, text) ? parseDiff(text) : null),
    [read, name, text]
  )
  const writer = React.useMemo(() => writerOf(path), [path, read]) // eslint-disable-line react-hooks/exhaustive-deps
  const rel = outputRelative(root, path) ?? name
  const dir = `/${rel.slice(0, rel.length - name.length)}`
  const size = read && read.kind !== 'missing' ? formatSize(read.size) : ''

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel)'
      }}
    >
      <div
        style={{
          flex: 'none',
          height: 38,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <PanelBtn title="Back to Output" onClick={close}>
          <Chevron size={13} style={{ transform: 'rotate(180deg)' }} />
        </PanelBtn>
        <span
          title={path}
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {name}
        </span>
        <PanelBtn title="Close" onClick={closePanel}>
          <Close size={12} />
        </PanelBtn>
      </div>

      {read?.kind === 'missing' ? (
        <Centered>
          <span style={{ color: 'var(--muted)' }}>{name} is no longer in the folder</span>
          <button onClick={close} style={smallBtn}>
            Back to Output
          </button>
        </Centered>
      ) : (
        <>
          <div
            style={{
              flex: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              fontSize: 11.5
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--muted)' }}>
              <div style={{ fontFamily: MONO, overflowWrap: 'anywhere' }}>{dir}</div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {diff && diff.files.length > 0 ? (
                  <DiffDetail diff={diff} />
                ) : (
                  [writer && `by ${writer}`, size].filter(Boolean).join(' · ')
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <button
                data-fill=""
                disabled={!canReference}
                onClick={() => reference(path)}
                title={canReference ? undefined : 'Select a chat to reference this in'}
                style={{
                  ...smallBtn,
                  padding: '0 10px',
                  border: 0,
                  background: canReference ? 'var(--accent)' : 'var(--card2)',
                  color: canReference ? 'var(--accent-fg)' : 'var(--dim)',
                  fontWeight: 500,
                  cursor: canReference ? 'pointer' : 'default'
                }}
              >
                Reference in chat
              </button>
              <button onClick={() => openFile(path)} style={smallBtn}>
                Open
              </button>
              <button onClick={() => reveal(path)} style={smallBtn}>
                Reveal
              </button>
              <button onClick={() => copyPath(path)} style={smallBtn}>
                Copy path
              </button>
              <button
                title="Move to Recycle Bin"
                aria-label="Move to Recycle Bin"
                onClick={() => {
                  close()
                  void deleteOutputPath(path)
                }}
                style={{
                  marginLeft: 'auto',
                  width: 26,
                  height: 26,
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
                <Trash size={14} />
              </button>
            </div>
          </div>

          {read && (
            <PreviewBody read={read} name={name} diff={diff} onOpen={() => openFile(path)} />
          )}

          {read?.kind === 'text' && read.truncated && (
            <div
              style={{
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 14px',
                borderTop: '1px solid var(--border)',
                fontSize: 11.5
              }}
            >
              <span style={{ flex: 1, color: 'var(--warn)' }}>
                Showing the first {formatSize(text.length)} of {size}
              </span>
              <button onClick={() => openFile(path)} style={smallBtn}>
                Open in app
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DiffDetail({ diff }: { diff: ParsedDiff }): React.ReactElement {
  const { stats, base } = diff
  return (
    <>
      <LineCounts counts={stats} /> · {stats.files} {stats.files === 1 ? 'file' : 'files'}
      {base ? ` · vs ${base}` : ''}
    </>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
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
      {children}
    </div>
  )
}

/**
 * What a file looks like in here. Everything that comes out is text nodes: an
 * HTML file shows its source and is never rendered, and markdown goes through
 * the chat's own `Md`, which sets nothing as HTML.
 */
function PreviewBody({
  read,
  name,
  diff,
  onOpen
}: {
  read: OutputFileRead
  name: string
  diff: ParsedDiff | null
  onOpen: () => void
}): React.ReactElement | null {
  const [viewing, setViewing] = React.useState(false)
  if (read.kind === 'missing') return null
  if (read.kind === 'none') {
    return (
      <Centered>
        <span style={{ color: 'var(--muted)' }}>
          {name} · {formatSize(read.size)}
        </span>
        <button onClick={onOpen} style={smallBtn}>
          Open
        </button>
      </Centered>
    )
  }
  const body: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }
  if (read.kind === 'image') {
    return (
      <div className="vchat-scroll" style={body}>
        <img
          src={read.dataUrl}
          alt={name}
          onClick={() => setViewing(true)}
          title="Click to view"
          style={{
            display: 'block',
            maxWidth: '100%',
            border: '1px solid var(--border)',
            // A transparent PNG needs a ground of its own.
            background: 'var(--card2)',
            cursor: 'zoom-in'
          }}
        />
        {viewing && <ImageViewer src={read.dataUrl} onClose={() => setViewing(false)} />}
      </div>
    )
  }
  if (diff && diff.files.length > 0) {
    return (
      <div className="vchat-scroll" style={{ ...body, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {diff.files.map((f) => (
          <DiffCard key={f.path} file={f} />
        ))}
      </div>
    )
  }
  if (/\.(md|markdown)$/i.test(name)) {
    return (
      <div className="vchat-scroll" style={body}>
        <Md src={read.text} />
      </div>
    )
  }
  return (
    <div
      className="vchat-scroll"
      style={{
        ...body,
        fontFamily: MONO,
        fontSize: 11.5,
        lineHeight: '18px',
        color: 'var(--fg)',
        // A file keeps its lines. A diff that has no diff in it is one sentence
        // saying so, and that should wrap rather than scroll sideways.
        whiteSpace: diff ? 'pre-wrap' : 'pre'
      }}
    >
      {diff ? diff.message || read.text : read.text}
    </div>
  )
}

/** One file of a diff, folded by clicking its header. */
function DiffCard({ file }: { file: DiffFile }): React.ReactElement {
  const [open, setOpen] = React.useState(file.lines.length <= DIFF_AUTO_OPEN)
  return (
    <div style={{ flex: 'none', border: '1px solid var(--border)', background: 'var(--card2)', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(!open)}
        title={file.path}
        style={{
          width: '100%',
          height: 30,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          border: 0,
          borderBottom: open ? '1px solid var(--border)' : 0,
          background: 'transparent',
          color: 'var(--fg)',
          fontFamily: MONO,
          fontSize: 11.5,
          textAlign: 'left',
          cursor: 'pointer'
        }}
      >
        <Chevron
          size={11}
          style={{ flex: 'none', transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .12s' }}
        />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {file.path}
        </span>
        <LineCounts counts={file} />
      </button>
      {open && (
        <div style={{ overflowX: 'auto', fontFamily: MONO, fontSize: 11.5, lineHeight: '18px' }}>
          {file.lines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  )
}

function DiffLine({ line }: { line: string }): React.ReactElement {
  const sign = line[0] === '+' ? '+' : line[0] === '-' ? '−' : ''
  return (
    <div
      style={{
        display: 'flex',
        // As wide as the widest row, so a tint runs the whole length of a long
        // line once it is scrolled. The tool card's diff makes the same point.
        width: 'max-content',
        minWidth: '100%',
        background: sign === '+' ? 'var(--ins-soft)' : sign === '−' ? 'var(--del-soft)' : 'transparent',
        color: sign ? 'var(--fg)' : 'var(--muted)'
      }}
    >
      <span style={{ width: 18, flex: 'none', textAlign: 'center' }}>{sign}</span>
      {/* Context keeps its leading space and a blank line still takes a row. */}
      <span style={{ whiteSpace: 'pre', paddingRight: 10 }}>{(sign ? line.slice(1) : line) || ' '}</span>
    </div>
  )
}
