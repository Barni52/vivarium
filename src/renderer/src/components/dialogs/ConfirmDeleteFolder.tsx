import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { MONO } from '../../theme'

/**
 * Deleting a folder deletes every session in it, by the user's decision — it is
 * how a finished orchestration run is cleared in one go. So the dialog names the
 * count, and says "conversation" only when there is a chat among them, on the
 * same terms as ConfirmKill. An empty folder never gets here (see
 * requestDeleteFolder).
 */
export function ConfirmDeleteFolder(): React.ReactElement | null {
  const target = useStore((s) => s.folderTarget)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmDeleteFolder = useStore((s) => s.confirmDeleteFolder)

  if (!target) return null
  const sessions = `${target.count} session${target.count === 1 ? '' : 's'}`

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={410}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Delete folder?</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            This removes <span style={{ color: 'var(--fg)', fontFamily: MONO }}>{target.name}</span> and
            the {sessions} in it.
            {target.chats > 0 && (
              <>
                {' '}
                {target.chats === 1 ? 'The chat’s ' : `All ${target.chats} chats’ `}
                <b style={{ color: 'var(--fg)' }}>
                  {target.chats === 1 ? 'conversation is deleted' : 'conversations are deleted'}
                </b>{' '}
                with it.
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
          <FooterButton height={48} danger onClick={confirmDeleteFolder}>
            Delete folder
          </FooterButton>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
