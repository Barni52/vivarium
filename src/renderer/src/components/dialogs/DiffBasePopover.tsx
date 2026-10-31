import React from 'react'
import { isDiffBase } from '@shared/projects'
import type { DiffRefs } from '@shared/types'
import { useStore } from '../../state/store'
import { MONO } from '../../theme'
import { Check, Close } from '../Icons'

/** How many `Add <ref>` suggestions a keystroke can raise. */
const MAX_SUGGESTIONS = 6

/**
 * What a project's branch is compared with: opened from the branch name in the
 * sidebar, because that is the thing being compared.
 *
 * **The list is the default plus what you added, and nothing else.** Remote
 * branches are not listed, only offered as `Add <ref>` while you type: every
 * entry but the default has an × that removes it, and an entry that came from
 * `git` would be back the next time this opened. The × only forgets the entry.
 * No branch is touched, so it asks for no confirmation.
 *
 * The default is the repo's own (`origin/HEAD`), not stored and not removable.
 * Having nothing picked is saved as nothing picked, so the project keeps
 * following it if the repo changes its default.
 */
export function DiffBasePopover(): React.ReactElement | null {
  const target = useStore((s) => s.diffBaseTarget)
  const project = useStore((s) => s.config.projects.find((p) => p.id === target?.projectId))
  const branch = useStore((s) => (target ? s.branches[target.projectId] : null))
  const hasOutput = useStore((s) => !!s.config.sharedOutputFolder)
  const closeDialog = useStore((s) => s.closeDialog)
  const setBase = useStore((s) => s.setProjectDiffBase)
  const runProjectDiff = useStore((s) => s.runProjectDiff)
  const [refs, setRefs] = React.useState<DiffRefs | null>(null)
  const [query, setQuery] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const projectId = target?.projectId

  React.useEffect(() => {
    if (!projectId) return
    let alive = true
    void window.vivarium.diffRefs(projectId).then((r) => {
      if (alive) setRefs(r)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  if (!target || !project) return null

  const saved = project.diffBases ?? []
  const fallback = refs?.fallback ?? null
  const selected = project.diffBase ?? fallback
  const typed = query.trim()
  const needle = typed.toLowerCase()
  const listed = [...new Set([...(fallback ? [fallback] : []), ...saved, ...(project.diffBase ? [project.diffBase] : [])])]
  const shown = listed.filter((r) => r.toLowerCase().includes(needle))
  const suggestions = typed
    ? (refs?.remotes ?? [])
        .filter((r) => r.toLowerCase().includes(needle) && !listed.includes(r))
        .slice(0, MAX_SUGGESTIONS)
    : []
  // What was typed is worth its own row only if no row says it already.
  const addTyped = !!typed && isDiffBase(typed) && !listed.includes(typed) && !suggestions.includes(typed)
  const invalid = !!typed && !isDiffBase(typed)

  const pick = (ref: string): void => {
    void setBase(project.id, ref === fallback ? null : ref, saved)
  }
  const add = (ref: string): void => {
    setQuery('')
    void setBase(project.id, ref === fallback ? null : ref, [...saved, ref])
  }
  const remove = (ref: string): void => {
    void setBase(
      project.id,
      project.diffBase === ref ? null : project.diffBase ?? null,
      saved.filter((r) => r !== ref)
    )
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // `dialog` is already null by the time this reaches ChatView's window
      // listener, so only this keeps Esc from also stopping the running turn.
      e.preventDefault()
      closeDialog()
    }
    if (e.key !== 'Enter' || !typed) return
    if (listed.includes(typed)) {
      pick(typed)
      setQuery('')
    } else if (isDiffBase(typed)) add(typed)
  }

  const write = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await runProjectDiff(project.id)
    setBusy(false)
    if (r.ok) closeDialog()
    else setError(r.message)
  }

  return (
    <div onClick={closeDialog} style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
      <div
        className="vchat"
        role="dialog"
        aria-label="Compare branch"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute',
          top: target.top,
          left: target.left,
          width: 320,
          maxHeight: 'calc(100vh - 56px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 18px 44px -16px var(--shadow)',
          animation: 'vpop .13s ease',
          fontSize: 12.5
        }}
      >
        <div style={{ flex: 'none', padding: '10px 12px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
            Compare <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{branch}</span> with
          </div>
          <input
            autoFocus
            aria-label="Find or add a ref"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find or add a ref"
            spellCheck={false}
            style={{
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
        </div>

        <div className="vchat-scroll" style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', paddingBottom: 6 }}>
          {shown.map((ref) => (
            <div key={ref} className="voutput-row" style={rowStyle}>
              <button onClick={() => pick(ref)} aria-pressed={ref === selected} style={rowBtn}>
                <span style={{ flex: 'none', width: 12, display: 'flex', color: 'var(--accent2)' }}>
                  {ref === selected && <Check size={12} />}
                </span>
                <span style={rowName}>{ref}</span>
                {ref === fallback && (
                  <span style={{ flex: 'none', fontSize: 11.5, color: 'var(--muted)' }}>default</span>
                )}
              </button>
              {ref !== fallback && (
                <button
                  title="Remove from this list"
                  aria-label={`Remove ${ref} from this list`}
                  onClick={() => remove(ref)}
                  style={{
                    flex: 'none',
                    width: 22,
                    height: 22,
                    padding: 0,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    alignSelf: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <Close size={11} />
                </button>
              )}
            </div>
          ))}
          {suggestions.map((ref) => (
            <AddRow key={ref} name={ref} onAdd={() => add(ref)} />
          ))}
          {addTyped && <AddRow name={typed} onAdd={() => add(typed)} />}
          {invalid && (
            <div style={{ padding: '6px 12px', fontSize: 11.5, color: 'var(--danger)' }}>
              That is not a branch or ref name.
            </div>
          )}
        </div>

        {error && (
          <div style={{ flex: 'none', padding: '0 12px 8px', fontSize: 11.5, color: 'var(--danger)' }}>{error}</div>
        )}
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderTop: '1px solid var(--border)'
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {hasOutput ? 'Agents use this base too' : 'Set an output folder first'}
          </span>
          <button
            data-fill=""
            disabled={!hasOutput || busy}
            onClick={() => void write()}
            style={{
              flex: 'none',
              height: 26,
              padding: '0 10px',
              border: 0,
              background: hasOutput ? 'var(--accent)' : 'var(--card2)',
              color: hasOutput ? 'var(--accent-fg)' : 'var(--dim)',
              fontFamily: 'inherit',
              fontSize: 11.5,
              fontWeight: 500,
              cursor: hasOutput && !busy ? 'pointer' : 'default'
            }}
          >
            {busy ? 'Writing…' : 'Write diff'}
          </button>
        </div>
      </div>
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  height: 28,
  display: 'flex',
  alignItems: 'stretch',
  gap: 4,
  padding: '0 8px 0 12px'
}

const rowBtn: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'var(--fg)',
  fontFamily: MONO,
  fontSize: 12.5,
  textAlign: 'left',
  cursor: 'pointer'
}

const rowName: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

function AddRow({ name, onAdd }: { name: string; onAdd: () => void }): React.ReactElement {
  return (
    <div className="voutput-row" style={rowStyle}>
      <button onClick={onAdd} style={rowBtn}>
        <span style={{ flex: 'none', width: 12 }} />
        <span style={rowName}>
          <span style={{ color: 'var(--muted)' }}>Add </span>
          {name}
        </span>
      </button>
    </div>
  )
}
