// What a project of each kind can hold, and where a session may be moved.
//
// The third piece of *logic* in `@shared`, and it earns the place the way
// `models.ts` and `mounts.ts` do: **both processes enforce it**. The renderer
// decides what the new-session picker offers and which sidebar rows accept a
// drop; main refuses the same things when they arrive over IPC, because
// `addSession` and `moveSession` take a type and a target on trust and
// `moveSession` kills the pty *before* it rewrites config. Two copies of the
// rule is how the picker would offer a container bash that main then quietly
// spawns into a container that does not exist, or a drop would carry a
// conversation to a folder Claude refuses to resume it from.

import type { Project, SessionType } from './types'

/** A project whose sessions run straight on Windows, with no container. */
export function isHostProject(project: Pick<Project, 'kind'> | undefined): boolean {
  return project?.kind === 'host'
}

/**
 * The session types a project can hold, in picker order.
 *
 * A host project gets the three that need no container: an agent (`claude.exe`
 * in the project folder), a chat (the same `claude`, driven over stream-json
 * and reading its transcript off this disk — see ChatRuntime in main/chat.ts)
 * and a PowerShell. Not, obviously, the container's bash.
 */
export function sessionTypesFor(project: Pick<Project, 'kind'> | undefined): SessionType[] {
  return isHostProject(project)
    ? ['agent', 'chat', 'host-shell']
    : ['agent', 'chat', 'host-shell', 'container-shell']
}

export function projectHolds(project: Pick<Project, 'kind'> | undefined, type: SessionType): boolean {
  return sessionTypesFor(project).includes(type)
}

/**
 * May a session of `type` be moved from one project to the other?
 *
 * Holding the type is necessary and not sufficient, because what a move is
 * *for* is carrying the conversation, and a conversation — an agent's or a
 * chat's, they are the same transcript — cannot cross into or out of a host
 * project:
 *
 *  - container ↔ host: the transcript is on the claude-box-creds volume on one
 *    side and in `%USERPROFILE%\.claude` on the other, so the agent would start
 *    over under the same id, silently.
 *  - host ↔ host: both sides can see the file, and that is the trap. Claude Code
 *    files a transcript under the directory it was started in and **refuses** a
 *    `--resume` from anywhere else ("This conversation is from a different
 *    directory"), so the moved agent would die the moment it opened. Container
 *    agents never meet this because every one of them runs in `/workspace`.
 *
 * So both conversation-owning types stay where they are on the host side, and
 * move freely only between containers. A host PowerShell carries no
 * conversation and has nothing to lose — it goes anywhere.
 */
export function canMoveSession(
  from: Pick<Project, 'kind'> | undefined,
  to: Pick<Project, 'kind'> | undefined,
  type: SessionType
): boolean {
  if (!projectHolds(to, type)) return false
  const converses = type === 'agent' || type === 'chat'
  if (converses && (isHostProject(from) || isHostProject(to))) return false
  return true
}

/** The base a diff is taken against when a repo offers nothing better. */
export const DEFAULT_DIFF_BASE = 'origin/master'

/**
 * Whether `base` may go to `git diff` as `<base>...HEAD`. It is an argument of
 * its own (no shell), but git reads one that starts with `-` as an *option* —
 * `--output=<file>` among them — and an agent can pass it, so only the
 * characters a ref name is written with get through.
 *
 * In `@shared` for the reason at the top of this file: the compare popover
 * refuses a bad ref as you type it, and main refuses it again because the value
 * arrives over IPC and through the `write_branch_diff` tool.
 */
export function isDiffBase(base: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/.test(base) && !base.includes('..')
}
