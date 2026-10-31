// The three spellings one file in the output folder has: the Windows path the
// tree and main use, `/workspace/output/…` as a container sees it, and the path
// relative to the folder that the panel shows. Everything that converts between
// them is here, so a chat card, the tree and the composer cannot disagree.

/** Where the shared folder lands in every container (`mountTargets` in @shared). */
const CONTAINER_ROOT = '/workspace/output'

const windows = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '')

/** `abs` relative to the output folder with forward slashes, or null if it is outside. */
export function outputRelative(root: string, abs: string): string | null {
  const base = `${windows(root)}\\`
  const path = windows(abs)
  if (!path.toLowerCase().startsWith(base.toLowerCase())) return null
  return path.slice(base.length).replace(/\\/g, '/')
}

/**
 * The Windows path of a file an agent named, if it is in the output folder.
 *
 * A container chat says `/workspace/output/…` and a host chat says its Windows
 * path, possibly with forward slashes. Main still guards every open and read,
 * so a `..` in here gets refused rather than followed.
 */
export function outputFileFrom(root: string | undefined, seen: string): string | null {
  if (!root) return null
  if (seen.startsWith(`${CONTAINER_ROOT}/`)) {
    return `${windows(root)}\\${windows(seen.slice(CONTAINER_ROOT.length + 1))}`
  }
  const rel = outputRelative(root, seen)
  // Rebuilt on the configured root rather than returned as typed: Windows does
  // not care about the case of `d:\shared`, and main's guard does.
  return rel === null ? null : `${windows(root)}\\${windows(rel)}`
}

/** How a chat should be told about a file: the path that chat can actually open. */
export function outputPathForChat(root: string, abs: string, hostChat: boolean): string {
  const rel = outputRelative(root, abs)
  return hostChat || rel === null ? abs : `${CONTAINER_ROOT}/${rel}`
}

/** A byte count in the units a person reads: `312 B`, `4.1 KB`, `48 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`
}
