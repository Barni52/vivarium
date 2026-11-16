import React from 'react'
import type { Project, Session, SessionFolder } from '@shared/types'
import { canMoveSession } from '@shared/projects'
import { useStore, type AttentionKind } from '../state/store'
import { ACCENT, MONO } from '../theme'
import { AiSpark, Chevron, Folder, Pencil, Plus, ThinkingDots, Trash } from './Icons'
import { AiTag, describeCreator, useCreatorName } from './AiTag'
import { RowBtn, SessionRow } from './SessionRow'
import { findAttention, isAnyWorking } from './sessionGroup'

/**
 * A folder inside a project, and the sessions in it.
 *
 * The geometry is a tree's: the chevron sits in the column the loose sessions'
 * glyphs use, the folder glyph one step in, and the rail under the chevron puts
 * the sessions' glyphs straight under the folder's. Changing the 10 of padding,
 * the 14 of chevron or the 17 of rail margin moves one of those off the others.
 */
export function FolderRow({
  project,
  folder,
  sessions
}: {
  project: Project
  folder: SessionFolder
  sessions: Session[]
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const folded = useStore((s) => !!s.foldedFolders[folder.id])
  const editing = useStore((s) => s.editingFolderId === folder.id)
  const editDraft = useStore((s) => s.editDraft)
  const toggleFolder = useStore((s) => s.toggleFolder)
  const openAddSession = useStore((s) => s.openAddSession)
  const startFolderRename = useStore((s) => s.startFolderRename)
  const setEditDraft = useStore((s) => s.setEditDraft)
  const commitFolderRename = useStore((s) => s.commitFolderRename)
  const cancelRename = useStore((s) => s.cancelRename)
  const requestDeleteFolder = useStore((s) => s.requestDeleteFolder)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const select = useStore((s) => s.select)
  const setDrag = useStore((s) => s.setDrag)
  const setDropTarget = useStore((s) => s.setDropTarget)
  const placeSession = useStore((s) => s.placeSession)
  const reorderFolders = useStore((s) => s.reorderFolders)
  const requestMoveSession = useStore((s) => s.requestMoveSession)
  const dropIndicator = useStore((s) => (s.dropTarget?.id === folder.id ? s.dropTarget.pos : null))
  // Only read while folded, as on the project row: an open folder shows each
  // session's own badge right under it.
  const attention = useStore((s): AttentionKind | null => findAttention(s, sessions))
  const hasWorking = useStore((s) => isAnyWorking(s, sessions))
  const creatorName = useCreatorName(folder.createdBy)

  const addHere = (anchor: DOMRect): void => openAddSession(project.id, anchor, folder.id)

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Add session here',
        icon: <Plus size={14} />,
        onSelect: () => addHere(new DOMRect(e.clientX, e.clientY, 0, 0))
      },
      { label: 'Rename', icon: <Pencil size={13} />, onSelect: () => startFolderRename(folder.id, folder.name) },
      ...(folder.createdBy && creatorName
        ? [
            {
              label: `Go to creator: ${creatorName}`,
              icon: <AiSpark size={12} color="var(--role-agent)" />,
              onSelect: () => select(folder.createdBy as string)
            }
          ]
        : []),
      { label: '---' },
      {
        label:
          sessions.length === 0
            ? 'Delete folder'
            : `Delete folder and its ${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
        icon: <Trash size={14} />,
        danger: true,
        onSelect: () => requestDeleteFolder(project.id, folder.id)
      }
    ])
  }

  // --- drops ----------------------------------------------------------------
  // A session dropped on the row goes into the folder, at its end. A folder of
  // the same project dropped on it reorders the folders. Anything else passes
  // through to the project's own handlers.

  /** the dragged session, when this folder can take it */
  const droppableSession = (): { id: string; projectId: string } | null => {
    const st = useStore.getState()
    const d = st.drag
    if (d?.kind !== 'session' || !d.projectId) return null
    if (d.projectId !== project.id) {
      const from = st.config.projects.find((p) => p.id === d.projectId)
      const moving = from?.sessions.find((x) => x.id === d.id)
      if (!moving || !canMoveSession(from, project, moving.type)) return null
    }
    return { id: d.id, projectId: d.projectId }
  }

  const draggedFolder = (): string | null => {
    const d = useStore.getState().drag
    return d?.kind === 'folder' && d.projectId === project.id && d.id !== folder.id ? d.id : null
  }

  const onDragOver = (e: React.DragEvent): void => {
    if (droppableSession()) {
      e.preventDefault()
      // The project's sessions area accepts session drags too; keep this
      // folder's target from being overwritten as the event bubbles.
      e.stopPropagation()
      setDropTarget({ id: folder.id, pos: 'into' })
      return
    }
    if (draggedFolder()) {
      e.preventDefault()
      e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      setDropTarget({ id: folder.id, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    const d = droppableSession()
    if (d) {
      e.preventDefault()
      e.stopPropagation()
      if (d.projectId !== project.id) {
        requestMoveSession(d.projectId, project.id, d.id, -1, folder.id)
        return
      }
      const ids = project.sessions.map((s) => s.id).filter((id) => id !== d.id)
      void placeSession(project.id, d.id, folder.id, [...ids, d.id])
      return
    }
    const moving = draggedFolder()
    const t = useStore.getState().dropTarget
    if (!moving || !t || t.id !== folder.id) return
    e.preventDefault()
    e.stopPropagation()
    const ids = (project.folders ?? []).map((f) => f.id).filter((id) => id !== moving)
    let idx = ids.indexOf(folder.id)
    if (idx < 0) return
    if (t.pos === 'after') idx += 1
    ids.splice(idx, 0, moving)
    void reorderFolders(project.id, ids)
  }

  const bg = hover ? 'var(--sel)' : 'transparent'

  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', folder.id)
          setDrag({ kind: 'folder', id: folder.id, projectId: project.id })
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={() => {
          setDrag(null)
          setDropTarget(null)
        }}
        onContextMenu={showMenu}
        onClick={() => toggleFolder(folder.id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: 30,
          padding: '0 8px 0 10px',
          cursor: 'pointer',
          background: bg,
          transition: 'background-color .1s',
          boxShadow:
            dropIndicator === 'into'
              ? 'inset 0 0 0 2px var(--accent)'
              : dropIndicator === 'before'
                ? 'inset 0 2px 0 0 var(--accent)'
                : dropIndicator === 'after'
                  ? 'inset 0 -2px 0 0 var(--accent)'
                  : 'none'
        }}
      >
        <span
          style={{
            width: 14,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--dim)',
            transform: `rotate(${folded ? 0 : 90}deg)`,
            transition: 'transform .12s'
          }}
        >
          <Chevron size={12} />
        </span>
        <span
          title={describeCreator(creatorName)}
          style={{
            position: 'relative',
            width: 16,
            flex: 'none',
            marginRight: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--muted)'
          }}
        >
          <Folder />
          {folder.createdBy && <AiTag ground={bg === 'transparent' ? 'var(--panel)' : bg} />}
        </span>

        {editing ? (
          <input
            value={editDraft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setEditDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => commitFolderRename(project.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitFolderRename(project.id)
              if (e.key === 'Escape') {
                // ChatView reads an unclaimed Esc as "stop the turn".
                e.preventDefault()
                cancelRename()
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'var(--input)',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg)',
              fontSize: 12.5,
              height: 24,
              padding: '0 6px',
              outline: 'none'
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {folder.name}
          </span>
        )}

        {hover && !editing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <RowBtn
              title="Add session here"
              onClick={(e) => {
                e.stopPropagation()
                addHere((e.currentTarget as HTMLElement).getBoundingClientRect())
              }}
            >
              <Plus size={14} />
            </RowBtn>
            <RowBtn
              title={sessions.length > 0 ? 'Delete folder and its sessions' : 'Delete folder'}
              danger
              onClick={(e) => {
                e.stopPropagation()
                requestDeleteFolder(project.id, folder.id)
              }}
            >
              <Trash size={13} />
            </RowBtn>
          </div>
        )}

        {!hover && !editing && folded && hasWorking && !attention && (
          <ThinkingDots color={ACCENT.agent} title="An agent in this folder is working" />
        )}

        {!hover && !editing && folded && attention && (
          <span
            title={
              attention === 'question'
                ? 'An agent in this folder is waiting for you'
                : 'An agent in this folder finished'
            }
            // Fill and ink move together — see the same pair on ProjectRow.
            style={{
              width: 15,
              height: 15,
              flex: 'none',
              borderRadius: '50%',
              background: attention === 'question' ? 'var(--accent2)' : 'var(--danger)',
              color: attention === 'question' ? 'var(--on-accent2)' : 'var(--danger-fg)',
              fontSize: 10.5,
              fontWeight: 700,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {attention === 'question' ? '?' : '!'}
          </span>
        )}

        {!hover && !editing && (
          <span style={{ flex: 'none', minWidth: 14, textAlign: 'right', fontFamily: MONO, fontSize: 11, color: 'var(--dim)' }}>
            {sessions.length}
          </span>
        )}
      </div>

      {!folded && (
        <div style={{ marginLeft: 17, borderLeft: '1px solid var(--border)' }}>
          {sessions.map((s) => (
            <SessionRow key={s.id} project={project} session={s} />
          ))}
          {sessions.length === 0 && (
            <div style={{ padding: '6px 10px 8px 10px', fontSize: 11.5, color: 'var(--dim)' }}>Empty</div>
          )}
        </div>
      )}
    </div>
  )
}
