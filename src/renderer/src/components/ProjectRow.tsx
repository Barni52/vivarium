import React from 'react'
import type { Project } from '@shared/types'
import { useStore, type AttentionKind } from '../state/store'
import { ACCENT, MONO } from '../theme'
import {
  Chevron,
  Disks,
  Folder,
  Gear,
  GitBranch,
  Plus,
  Power,
  Search,
  Sparkle,
  Stop,
  ThinkingDots,
  Trash
} from './Icons'
import { SessionRow } from './SessionRow'

function HeaderBtn({
  title,
  color,
  onClick,
  children
}: {
  title: string
  color?: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26,
        height: 26,
        border: 0,
        borderRadius: 'var(--radius-sm)',
        background: hover ? 'var(--card2)' : 'transparent',
        color: color ?? (hover ? 'var(--fg)' : 'var(--muted)'),
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

export function ProjectRow({ project }: { project: Project }): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const expanded = useStore((s) => !!s.expanded[project.id])
  const running = useStore((s) => !!s.states[project.id]?.running)
  const branch = useStore((s) => s.branches[project.id])
  const toggle = useStore((s) => s.toggle)
  const openAddSession = useStore((s) => s.openAddSession)
  const openSettings = useStore((s) => s.openSettings)
  const togglePower = useStore((s) => s.togglePower)
  const requestDeleteProject = useStore((s) => s.requestDeleteProject)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const hasOutput = useStore((s) => !!s.config.sharedOutputFolder)
  const runProjectDiff = useStore((s) => s.runProjectDiff)
  const openClaudeUpdate = useStore((s) => s.openClaudeUpdate)
  const openVolumes = useStore((s) => s.openVolumes)
  const openTranscriptSearch = useStore((s) => s.openTranscriptSearch)
  // aggregate: worst outstanding attention among child agents (shown when the
  // project is collapsed, so a notification isn't hidden with its session
  // rows); a question beats finished — an agent blocked on an answer is the
  // more urgent state
  const attention = useStore((s): AttentionKind | null => {
    let worst: AttentionKind | null = null
    for (const x of project.sessions) {
      if (x.type !== 'agent' && x.type !== 'chat') continue
      // A live agent blocked on the user counts even when it carries no
      // notification (one you are watching clears its flag but is still
      // waiting) — collapsing the project must not hide that nothing is moving.
      if (s.activity[x.id] === 'waiting' && s.live[x.id]) return 'question'
      const k = s.notifications[x.id]
      if (k === 'question') return 'question'
      if (k) worst = k
    }
    return worst
  })
  const op = useStore((s) => s.containerOps[project.id])
  const opError = useStore((s) => s.containerErrors[project.id])
  // aggregate: any child agent actually running (same collapsed-only rule as
  // attention; a waiting one is mid-turn but reads as "?" above, not as busy)
  const hasWorking = useStore((s) =>
    project.sessions.some(
      (x) =>
        (x.type === 'agent' || x.type === 'chat') &&
        s.activity[x.id] === 'working' &&
        s.live[x.id]
    )
  )
  const projectIds = useStore((s) => s.config.projects.map((p) => p.id))
  // No kind check: this row is the drop target both for a project being reordered
  // ('before'/'after') and for a session being dropped into it ('into'), and
  // dropTarget.id only ever holds a project id in those two cases.
  const dropIndicator = useStore((s) =>
    s.dropTarget?.id === project.id ? s.dropTarget.pos : null
  )
  const setDrag = useStore((s) => s.setDrag)
  const setDropTarget = useStore((s) => s.setDropTarget)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const requestMoveSession = useStore((s) => s.requestMoveSession)

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Add session',
        icon: <Plus size={14} />,
        onSelect: () => openAddSession(project.id, new DOMRect(e.clientX, e.clientY, 0, 0))
      },
      { label: 'Project settings', icon: <Gear size={14} />, onSelect: () => openSettings(project.id) },
      {
        label:
          op === 'start'
            ? 'Starting container…'
            : op === 'stop'
              ? 'Stopping container…'
              : running
                ? 'Stop container'
                : 'Start container',
        // outline power ring when it's off, solid square when it's on — the icon
        // shows the current state, the label says what the click does
        // Stop only inks the middle half of its 16-box, so size 16 puts an 8px
        // filled square next to the 14px outline glyphs — a solid shape reads
        // heavier, so it wants to be the smaller one.
        icon: running ? <Stop size={16} /> : <Power size={14} />,
        disabled: !!op,
        onSelect: () => togglePower(project.id)
      },
      // No "Restart container" here on purpose: stop-then-start is two clicks
      // away, Project settings still has the button, and every *needed* restart
      // (a mount or image change) already happens implicitly on save.
      { label: '---' },
      // Second way into the manual-update dialog (the title-bar version chip is
      // the first) — this is where you'd look when *this* project's agent seems
      // to be on an old Claude Code.
      { label: 'Claude Code version…', icon: <Sparkle size={13} />, onSelect: openClaudeUpdate },
      // App-wide rather than per-project, like the item above it: the build
      // caches a project's mounts create outlive the project, so the dialog has
      // to be reachable from any of them (and this is where you'd look after
      // deleting one).
      { label: 'Docker volumes…', icon: <Disks size={14} />, onSelect: openVolumes },
      // App-wide for the same reason, and one step further: it reaches
      // conversations whose *session* no longer exists, so it cannot belong to
      // any project's menu in particular.
      {
        label: 'Search conversations…',
        icon: <Search size={14} />,
        onSelect: openTranscriptSearch
      },
      { label: '---' },
      {
        label: hasOutput
          ? 'Write branch diff → changes.txt'
          : 'Write branch diff (set an output folder first)',
        icon: <GitBranch size={14} />,
        disabled: !hasOutput,
        onSelect: () => void runProjectDiff(project.id)
      },
      { label: '---' },
      {
        label: 'Delete project',
        icon: <Trash size={14} />,
        danger: true,
        onSelect: () => requestDeleteProject(project.id, project.name)
      }
    ])
  }

  const onDrop = (): void => {
    const st = useStore.getState()
    const d = st.drag
    const t = st.dropTarget
    if (!d || d.kind !== 'project' || !t) return
    const ids = projectIds.filter((id) => id !== d.id)
    let idx = ids.indexOf(t.id)
    if (idx < 0) return
    if (t.pos === 'after') idx += 1
    ids.splice(idx, 0, d.id)
    void reorderProjects(ids)
  }

  // --- accepting a session dragged in from another project ------------------
  // A project row has no meaningful midpoint for a session (there is no "before
  // this project" place to put one), so the whole row is one target and the drop
  // appends. Dropping onto the session's *own* project is not a move, so it sets
  // nothing and the cursor stays no-drop. This is also what makes a collapsed —
  // or empty — project reachable: no expansion needed, the drop expands it after
  // the fact.
  const foreignSessionDrag = (): { id: string; projectId: string } | null => {
    const d = useStore.getState().drag
    if (!d || d.kind !== 'session' || !d.projectId || d.projectId === project.id) return null
    return { id: d.id, projectId: d.projectId }
  }

  const onSessionDragOver = (e: React.DragEvent): void => {
    if (!foreignSessionDrag()) {
      // A session over the project it already belongs to. Clear the last target as
      // well as refusing the drop, or some row further up keeps drawing an
      // indicator for a place the cursor has left. (A *project* drag lands here too
      // — via a session row that ignored it — and must keep its target.)
      const st = useStore.getState()
      if (st.drag?.kind === 'session' && st.dropTarget) setDropTarget(null)
      return
    }
    e.preventDefault()
    setDropTarget({ id: project.id, pos: 'into' })
  }

  const onSessionDrop = (e: React.DragEvent): void => {
    const d = foreignSessionDrag()
    if (!d) return
    e.preventDefault()
    requestMoveSession(d.projectId, project.id, d.id, -1)
  }

  return (
    <div>
      {/* header */}
      <div
        // **The hover handlers belong to the header, not to the wrapper.** They
        // used to sit on the div above, which encloses the session rows as well
        // — so pointing at a session lit up its project and swapped the
        // container status chip for the "+" button, two rows away from the
        // cursor. `mouseenter`/`mouseleave` do not fire for movement between an
        // element and its own descendants, which is exactly why it read as a
        // single sticky highlight rather than an obvious bug.
        //
        // Both readings of `hover` are the header's own (its fill, and which
        // control it shows on the right), so there is nothing the wrapper needed
        // it for. A session row draws its own hover; the project draws its own.
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', project.id)
          setDrag({ kind: 'project', id: project.id })
        }}
        onDragOver={(e) => {
          if (useStore.getState().drag?.kind !== 'project') return onSessionDragOver(e)
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDropTarget({ id: project.id, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
        }}
        onDrop={(e) => {
          if (useStore.getState().drag?.kind !== 'project') return onSessionDrop(e)
          e.preventDefault()
          onDrop()
        }}
        onDragEnd={() => {
          setDrag(null)
          setDropTarget(null)
        }}
        onContextMenu={showMenu}
        onClick={() => toggle(project.id)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          // `minHeight`, not `height`: the branch line is a third line and the
          // three of them come to ~45.4px at the stated line-heights — inside
          // 46, but by too little to bet a clipped descender on across fonts.
          // A project with no branch is still exactly 46. The drop indicator
          // measures the row with `getBoundingClientRect`, so growth is free.
          minHeight: 46,
          padding: '2px 8px 2px 10px',
          cursor: 'pointer',
          background: hover ? 'var(--sel)' : 'transparent',
          transition: 'background-color .1s',
          boxShadow:
            dropIndicator === 'before'
              ? 'inset 0 2px 0 0 var(--accent)'
              : dropIndicator === 'after'
                ? 'inset 0 -2px 0 0 var(--accent)'
                : // 'into' is not a position between two rows, so it gets a ring
                  // around the whole row instead of an edge line
                  dropIndicator === 'into'
                  ? 'inset 0 0 0 2px var(--accent)'
                  : 'none'
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--dim)',
            transform: `rotate(${expanded ? 90 : 0}deg)`,
            transition: 'transform .12s'
          }}
        >
          <Chevron />
        </span>
        <span style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center' }}>
          <Folder />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 12.5,
              // Bold, not medium. It is the only bold thing in the sidebar, and
              // that is what separates a project from the sessions under it now
              // that they are the same face at nearly the same size.
              fontWeight: 700,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.2
            }}
          >
            {project.name}
          </span>

          {/* Path and branch are stacked, not side by side: sharing one line
              meant a long path and a long branch each ate the other's room, and
              both ellipsised while half the sidebar sat empty. Stacked, each
              gets the full width. Both line-heights are stated so the three
              lines add up to a known height — see `minHeight` on the header. */}
          <span
            title={project.basePath}
            style={{
              minWidth: 0,
              fontFamily: MONO,
              fontSize: 11,
              lineHeight: 1.2,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {project.basePath}
          </span>

          {branch && (
            <span
              title={`git branch: ${branch}`}
              style={{
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--accent2)',
                fontSize: 11,
                lineHeight: 1.2,
                overflow: 'hidden'
              }}
            >
              <GitBranch size={10} style={{ flex: 'none' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {branch}
              </span>
            </span>
          )}
        </div>

        {!expanded && hasWorking && !attention && (
          <ThinkingDots color={ACCENT.agent} title="An agent in this project is working" />
        )}

        {!expanded && attention && (
          <span
            title={
              attention === 'question'
                ? 'An agent in this project is waiting for you'
                : 'An agent in this project finished'
            }
            // **Fill and ink move together.** A glyph on a filled disc is the one
            // shape in the app where a single ink colour cannot serve two fills:
            // `--accent2` is a light orange on midnight, a light amber on
            // graphite and a dark rust on paper, so "white on it" is wrong on at
            // least one theme in every direction. Each branch names its own pair.
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

        {hover ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <HeaderBtn
              title="Add session"
              onClick={(e) => {
                e.stopPropagation()
                openAddSession(project.id, (e.currentTarget as HTMLElement).getBoundingClientRect())
              }}
            >
              <Plus size={15} />
            </HeaderBtn>
          </div>
        ) : (
          /* a container is a box: rounded square (vs the circular session
             dots), green with a steady soft glow while running — no animation,
             infrastructure hums rather than thinks. Amber pulse while a
             start/stop/restart is in flight (a cold start can take minutes);
             stopped is a hollow red ring, a failed op a solid red fill (with
             the message in its tooltip) — same hue, different weight. */
          <span
            title={
              op === 'start'
                ? 'Starting container…'
                : op === 'stop'
                  ? 'Stopping container…'
                  : op === 'restart'
                    ? 'Restarting container…'
                    : opError
                      ? `Container operation failed: ${opError}`
                      : running
                        ? 'Container running'
                        : 'Container stopped'
            }
            style={{
              width: 8,
              height: 8,
              flex: 'none',
              marginRight: 4,
              borderRadius: 2,
              background: op ? 'var(--warn)' : opError ? 'var(--danger)' : running ? 'var(--ok)' : 'transparent',
              border: `1.5px solid ${op ? 'var(--warn)' : opError ? 'var(--danger)' : running ? 'var(--ok)' : 'var(--danger)'}`,
              boxShadow: !op && !opError && running ? '0 0 6px var(--ok-soft)' : 'none',
              animation: op ? 'vpending 1.2s ease-in-out infinite' : 'none'
            }}
          />
        )}
      </div>

      {/* sessions */}
      {expanded && (
        <div
          // The rows handle their own before/after targeting; this catches the
          // space around them — below the last row, and the whole "No sessions
          // yet" block, which is the only droppable surface an empty project has.
          onDragOver={onSessionDragOver}
          onDrop={onSessionDrop}
          // The rail sits at 20 and the rows carry their own 10 of padding, so a
          // session's glyph starts at exactly 30 — one indent step in from the
          // project name above it, and the only number that decides it.
          style={{ paddingLeft: 0, marginLeft: 20, borderLeft: '1px solid var(--border)' }}
        >
          {project.sessions.map((s) => (
            <SessionRow key={s.id} project={project} session={s} />
          ))}
          {project.sessions.length === 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px 12px 10px',
                color: 'var(--dim)'
              }}
            >
              <span style={{ fontSize: 11.5 }}>No sessions yet</span>
              <button
                onClick={(e) =>
                  openAddSession(project.id, (e.currentTarget as HTMLElement).getBoundingClientRect())
                }
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'var(--role-you)',
                  fontSize: 11.5,
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                Add one
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
