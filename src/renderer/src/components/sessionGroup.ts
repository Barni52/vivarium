import type { Session } from '@shared/types'
import type { AppState, AttentionKind } from '../state/store'

// What a folded group of sessions still has to say about them: a folded
// project, and a folded folder, both read off the same two rules, so folding
// either can never hide an agent that is waiting for you.

/**
 * The worst outstanding attention among the group's agents. A question beats
 * finished — an agent blocked on an answer is the more urgent state.
 */
export function findAttention(s: AppState, sessions: Session[]): AttentionKind | null {
  let worst: AttentionKind | null = null
  for (const x of sessions) {
    if (x.type !== 'agent' && x.type !== 'chat') continue
    // A live agent blocked on the user counts even when it carries no
    // notification (one you are watching clears its flag but is still
    // waiting) — folding must not hide that nothing is moving.
    if (s.activity[x.id] === 'waiting' && s.live[x.id]) return 'question'
    const k = s.notifications[x.id]
    if (k === 'question') return 'question'
    if (k) worst = k
  }
  return worst
}

/** How many questions the group's chats are waiting on you to answer. */
export function countOpenQuestions(s: AppState, sessions: Session[]): number {
  let n = 0
  for (const x of sessions) n += s.chats[x.id]?.questions.length ?? 0
  return n
}

/** Any of the group's agents actually running (a waiting one reads as "?" above, not as busy). */
export function isAnyWorking(s: AppState, sessions: Session[]): boolean {
  return sessions.some(
    (x) => (x.type === 'agent' || x.type === 'chat') && s.activity[x.id] === 'working' && s.live[x.id]
  )
}
