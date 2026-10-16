import React from 'react'
import { isHostProject } from '@shared/projects'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { MONO } from '../../theme'

/**
 * Serves terminals and chats both, so its title and body vary on whether the
 * session **owns a conversation** rather than one sentence straining to cover
 * both. For a chat the old copy was doubly wrong: nothing is killed, there is no
 * terminal, and the thing actually destroyed went unnamed.
 *
 * Delete means delete — and if it does, the delete has to say so. The word is
 * "conversation", never "transcript": nobody deleting a session is thinking
 * about a .jsonl on a named volume. It is honest in both directions, since it
 * also warns that a `--resume` you might have counted on will not work
 * afterwards.
 *
 * No added friction beyond the words. The Volumes dialog removes multi-gigabyte
 * volumes on a single unconfirmed trash click; making one conversation the
 * heaviest destructive gesture in the app would be wildly out of proportion.
 */
export function ConfirmKill(): React.ReactElement | null {
  const target = useStore((s) => s.killTarget)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmKill = useStore((s) => s.confirmKill)
  const project = useStore((s) => s.config.projects.find((p) => p.id === target?.projectId))
  const type = project?.sessions.find((x) => x.id === target?.sessionId)?.type

  if (!target) return null
  const isChat = type === 'chat'
  // A host project has no container to reassure anyone about, so the tail
  // sentence is only said where it is true.
  const tail = isHostProject(project) ? '' : ' The container keeps running.'
  const name = <span style={{ color: 'var(--fg)', fontFamily: MONO }}>{target.name}</span>

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={isChat ? 410 : 380}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            {isChat ? 'Delete chat?' : 'Kill session?'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            {isChat ? (
              <>
                This removes {name} and{' '}
                <b style={{ color: 'var(--fg)' }}>deletes its conversation</b> — you will not be
                able to resume it from a terminal either.{tail}
              </>
            ) : (
              <>This stops {name} and closes its terminal.{tail}</>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
          <FooterButton height={48} danger onClick={confirmKill}>
            {isChat ? 'Delete chat' : 'Kill session'}
          </FooterButton>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
