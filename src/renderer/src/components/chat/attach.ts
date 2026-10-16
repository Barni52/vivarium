import type { ChatAttachment, MountNode } from '@shared/types'

// Attachment routing: **by reachability, decided here against the mount tree.**
//
// A file under one of the project's mounts becomes a container path; anything
// else becomes inline content. Nothing is copied, /clip is never written to (it
// keeps serving pty agent sessions and retires whenever that type does), and no
// mount is ever changed — which matters, because mounts may only change while
// the container is stopped, so "just add a mount" was never a cheap answer.
//
// Both halves were probed and both work: a native `image` block goes over the
// transport with no file, no mount and no path and lands in the transcript
// inline as base64, and a `Read` of a path outside /workspace raises no
// permission prompt in bypass. So the host↔container boundary is optional, not
// forced.
//
// A **host** chat has no boundary to route across: its CLI runs on this disk
// as you, so every file that has a path is reachable at that path, and the chip
// carries the Windows path verbatim. Only what has no path at all — a picture
// pasted from the clipboard — goes inline, as it does in a container.

/** A chip the composer is holding — either sendable, or a refusal wearing its reason. */
export type PendingChip =
  | { id: string; ok: true; attachment: ChatAttachment; detail: string }
  | { id: string; ok: false; name: string; reason: string }

/** UTF-8 text bigger than this is refused: ~16k tokens, and it only grows. */
const TEXT_LIMIT = 64 * 1024

/**
 * The refusal copy is load-bearing: this is the only place the app ever explains
 * the mount model, in a window with no terminal to print an explanation into. So
 * it has to name the rule *and* the fix in one line.
 */
const UNREACHABLE =
  'outside this project’s mounts — move it under a mounted folder, or add a mount with the container stopped'

let seq = 0
const nextId = (): string => `chip-${seq++}`

/** Windows paths are case-insensitive and mix separators; normalise before comparing. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Translate a host path to its container path, or null when it is not under any
 * mount. Reverses the leaf naming docker.ts already does, via the mount tree's
 * roots, so the two can never drift.
 */
export function toContainerPath(hostPath: string, tree: MountNode[]): string | null {
  const target = norm(hostPath)
  // Longest root first: a project can mount both a folder and something inside it.
  const roots = [...tree].sort((a, b) => norm(b.hostPath).length - norm(a.hostPath).length)
  for (const root of roots) {
    const base = norm(root.hostPath)
    if (target === base) return root.containerPath
    if (target.startsWith(`${base}/`)) {
      return `${root.containerPath}${hostPath.slice(root.hostPath.length).replace(/\\/g, '/')}`
    }
  }
  return null
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on anything
  // bigger than a small icon, and an image has no size cap here on purpose.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function looksBinary(text: string): boolean {
  // A replacement char means the decoder gave up on a byte — good enough, and it
  // costs nothing next to the read we already did.
  return text.includes(String.fromCharCode(0)) || text.includes(String.fromCharCode(0xfffd))
}

/**
 * Route one dropped/pasted file. `hostPath` is Electron's `File.path` (still
 * present on Electron 31; past 32 this becomes `webUtils.getPathForFile` in the
 * preload). A clipboard image has none, so it always goes inline.
 */
export async function routeFile(
  file: File,
  hostPath: string | undefined,
  tree: MountNode[],
  /** a host project's chat, which reads every file where it is */
  host = false
): Promise<PendingChip> {
  const name = file.name || 'pasted-image.png'
  if (hostPath && host) {
    return {
      id: nextId(),
      ok: true,
      attachment: { kind: 'path', name, containerPath: hostPath },
      detail: hostPath
    }
  }
  if (hostPath) {
    const containerPath = toContainerPath(hostPath, tree)
    if (containerPath) {
      // The chip shows the container path, so the translation is never hidden —
      // which also disarms the shadow-volume trap: `<mount>/node_modules` and
      // friends are overlaid by volumes, so a file dragged from there resolves to
      // the copy the *container* installed rather than the one you dragged. That
      // is usually the copy the agent should reason about, and showing the path
      // means you can see what you actually got.
      return {
        id: nextId(),
        ok: true,
        attachment: { kind: 'path', name, containerPath },
        detail: containerPath
      }
    }
  }

  const type = file.type || ''
  try {
    if (type.startsWith('image/')) {
      // Verbatim: no downscale, no size cap. The cap protects the *context
      // window*, not the disk, and an image costs ~1600 tokens whatever the file
      // weighs — while a 3 MB log inlined is ~750k tokens and breaks the turn.
      return {
        id: nextId(),
        ok: true,
        attachment: { kind: 'image', name, mediaType: type, data: base64(await file.arrayBuffer()) },
        detail: 'inline image'
      }
    }
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
      return {
        id: nextId(),
        ok: true,
        attachment: {
          kind: 'document',
          name,
          mediaType: 'application/pdf',
          data: base64(await file.arrayBuffer())
        },
        detail: 'inline document'
      }
    }
    if (file.size > TEXT_LIMIT) {
      return { id: nextId(), ok: false, name, reason: `too large to inline (${Math.round(file.size / 1024)} KB), and ${UNREACHABLE}` }
    }
    const text = await file.text()
    if (looksBinary(text)) {
      return { id: nextId(), ok: false, name, reason: `not readable as text, and ${UNREACHABLE}` }
    }
    // The agent can read it and never edit it — worth saying on the chip.
    return {
      id: nextId(),
      ok: true,
      attachment: { kind: 'text', name, text },
      detail: 'inline copy · read-only'
    }
  } catch {
    return { id: nextId(), ok: false, name, reason: `could not be read, and ${UNREACHABLE}` }
  }
}

/** A folder: a path chip under a mount, refused outside one — nothing inlines a tree. */
export function routeFolder(
  hostPath: string,
  name: string,
  tree: MountNode[],
  host = false
): PendingChip {
  const containerPath = host ? hostPath : toContainerPath(hostPath, tree)
  if (!containerPath) return { id: nextId(), ok: false, name, reason: UNREACHABLE }
  return {
    id: nextId(),
    ok: true,
    attachment: { kind: 'path', name, containerPath },
    detail: containerPath
  }
}

/** A pick from the `@` typeahead — already a container path, by construction. */
export function chipForNode(node: MountNode): PendingChip {
  return {
    id: nextId(),
    ok: true,
    attachment: { kind: 'path', name: node.name, containerPath: node.containerPath },
    detail: node.containerPath
  }
}

/** Flatten the mount tree once, for the `@` typeahead's fuzzy match. */
export function flattenTree(tree: MountNode[], out: MountNode[] = []): MountNode[] {
  for (const n of tree) {
    out.push(n)
    if (n.children) flattenTree(n.children, out)
  }
  return out
}
