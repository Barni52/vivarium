import React from 'react'
import type { OutputNode } from '@shared/types'
import { useStore } from '../state/store'
import { MONO } from '../theme'
import { FileIcon, FolderIcon } from './FileIcon'
import { Chevron, Eye, Copy, OpenExternal, Trash } from './Icons'

/** One indent level. A guide runs down the middle of each. */
const INDENT = 14
/** Left of the first chevron. */
const GUTTER = 10

interface Row {
  /** the deepest folder of a folded chain, so expansion survives it unfolding */
  node: OutputNode
  label: string
  depth: number
  open: boolean
  /** a top-level folder holding a branch's `changes.txt` */
  branch: boolean
}

/**
 * The tree as a flat list of rows, which is what lets the indent guides meet
 * from row to row, and what filtering has to work on anyway.
 *
 * **A folder holding only a folder folds into one row** (`reports / 2026 /
 * october`), because a chain of single-child folders is a lot of clicking for
 * no information. Expansion is keyed on the deepest path: a second folder
 * appearing at any level unfolds the chain, and the row you left open stays open.
 *
 * Filtering keeps everything where it is and forces parents open, so a match is
 * still seen in its place. A folder that matches by name brings all of its
 * contents with it, since that is what filtering on a folder is asking for.
 */
function buildRows(nodes: OutputNode[], expanded: Record<string, boolean>, query: string): Row[] {
  const q = query.trim().toLowerCase()
  const hit = (name: string): boolean => name.toLowerCase().includes(q)
  const shows = (n: OutputNode): boolean => hit(n.name) || (n.children ?? []).some(shows)
  const rows: Row[] = []

  const walk = (list: OutputNode[], depth: number, keep: boolean): void => {
    for (const n of list) {
      if (q && !keep && !shows(n)) continue
      if (n.type === 'file') {
        rows.push({ node: n, label: n.name, depth, open: false, branch: false })
        continue
      }
      const chain = [n]
      let tail = n
      while (tail.children?.length === 1 && tail.children[0].type === 'dir') {
        tail = tail.children[0]
        chain.push(tail)
      }
      const open = q ? true : !!expanded[tail.path]
      rows.push({
        node: tail,
        label: chain.map((c) => c.name).join(' / '),
        depth,
        open,
        branch: depth === 0 && !!tail.children?.some((c) => c.name === 'changes.txt')
      })
      if (open) walk(tail.children ?? [], depth + 1, keep || chain.some((c) => hit(c.name)))
    }
  }
  walk(nodes, 0, false)
  return rows
}

/** A label with the filter's first match washed in `--find`. Text nodes only. */
function Marked({ text, query }: { text: string; query: string }): React.ReactElement {
  const q = query.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <span style={{ background: 'var(--find)' }}>{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  )
}

function RowAction({
  title,
  disabled = false,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        width: 22,
        height: 22,
        flex: 'none',
        padding: 0,
        border: 0,
        background: 'transparent',
        color: disabled ? 'var(--dim)' : 'var(--muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: MONO,
        fontSize: 12.5,
        cursor: disabled ? 'default' : 'pointer'
      }}
    >
      {children}
    </button>
  )
}

function TreeRow({
  row,
  query,
  canReference
}: {
  row: Row
  query: string
  canReference: boolean
}): React.ReactElement {
  const { node, depth, open } = row
  const isDir = node.type === 'dir'
  const toggleDir = useStore((s) => s.toggleOutputDir)
  const openFile = useStore((s) => s.openOutputFile)
  const previewOutput = useStore((s) => s.previewOutput)
  const referenceOutput = useStore((s) => s.referenceOutput)
  const revealOutput = useStore((s) => s.revealOutput)
  const copyOutputPath = useStore((s) => s.copyOutputPath)
  const deleteOutputPath = useStore((s) => s.deleteOutputPath)
  const openContextMenu = useStore((s) => s.openContextMenu)

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      ...(isDir
        ? []
        : [
            { label: 'Open', icon: <OpenExternal size={14} />, onSelect: () => openFile(node.path) },
            { label: 'Preview', icon: <Eye size={14} />, onSelect: () => previewOutput(node.path) },
            {
              label: 'Reference in chat',
              disabled: !canReference,
              onSelect: () => referenceOutput(node.path)
            }
          ]),
      { label: 'Reveal in Explorer', icon: <OpenExternal size={14} />, onSelect: () => revealOutput(node.path) },
      { label: 'Copy path', icon: <Copy size={14} />, onSelect: () => copyOutputPath(node.path) },
      { label: '---' },
      {
        label: 'Move to Recycle Bin',
        icon: <Trash size={14} />,
        danger: true,
        onSelect: () => void deleteOutputPath(node.path)
      }
    ])
  }

  return (
    <div
      className="voutput-row"
      role="treeitem"
      aria-expanded={isDir ? open : undefined}
      onContextMenu={showMenu}
      style={{ position: 'relative', height: 28, display: 'flex', alignItems: 'stretch', paddingRight: 6 }}
    >
      {/* Drawn on each row rather than as one long line, so a guide is only ever
          as tall as the rows that are really under that folder. */}
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: GUTTER + i * INDENT + 6,
            width: 1,
            background: 'var(--border)'
          }}
        />
      ))}
      {/* A real button for the whole row: Enter works from the keyboard, and it
          is what `voutput-row:has(:focus-visible)` reveals the actions off. */}
      <button
        onClick={() => (isDir ? toggleDir(node.path) : openFile(node.path))}
        title={node.path}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: `0 0 0 ${GUTTER + depth * INDENT}px`,
          border: 0,
          background: 'transparent',
          color: 'var(--fg)',
          fontFamily: 'inherit',
          fontSize: 12.5,
          textAlign: 'left',
          cursor: 'pointer'
        }}
      >
        <span
          style={{
            width: 12,
            flex: 'none',
            display: 'flex',
            justifyContent: 'center',
            color: 'var(--dim)',
            visibility: isDir ? 'visible' : 'hidden',
            transform: `rotate(${open ? 90 : 0}deg)`,
            transition: 'transform .12s'
          }}
        >
          <Chevron size={12} />
        </span>
        {isDir ? <FolderIcon open={open} branch={row.branch} /> : <FileIcon name={node.name} />}
        {/* Always plain `--fg`. Tinted names are what made this tree read as a
            page of links; the icon is what carries the colour. */}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Marked text={row.label} query={query} />
        </span>
      </button>
      {!isDir && (
        <span className="voutput-acts" style={{ flex: 'none', alignItems: 'center', gap: 2, marginLeft: 4 }}>
          <RowAction title="Preview" onClick={() => previewOutput(node.path)}>
            <Eye size={14} />
          </RowAction>
          <RowAction
            title={canReference ? 'Reference in chat' : 'Select a chat to reference this in'}
            disabled={!canReference}
            onClick={() => referenceOutput(node.path)}
          >
            @
          </RowAction>
        </span>
      )}
    </div>
  )
}

export function OutputTree({ query }: { query: string }): React.ReactElement {
  const tree = useStore((s) => s.outputTree)
  const expanded = useStore((s) => s.outputExpanded)
  // Here rather than in each row: a selector runs on every store update, and a
  // streaming turn is 25 of those a second.
  const canReference = useStore((s) => s.canReferenceOutput())
  const rows = React.useMemo(() => buildRows(tree, expanded, query), [tree, expanded, query])

  if (tree.length === 0) {
    return (
      <div style={{ padding: '18px 14px', textAlign: 'center', color: 'var(--muted)', fontSize: 11.5 }}>
        No files yet. Artifacts written to this folder appear here.
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: '18px 14px', textAlign: 'center', color: 'var(--muted)', fontSize: 11.5 }}>
        No files match that filter.
      </div>
    )
  }
  return (
    <div role="tree" aria-label="Output files">
      {rows.map((r) => (
        <TreeRow key={r.node.path} row={r} query={query} canReference={canReference} />
      ))}
    </div>
  )
}
