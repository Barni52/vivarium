import { app, clipboard } from 'electron'
import { promises as fs } from 'fs'
import { join, relative } from 'path'

// Replaces the reference script's TCP clipboard-bridge hack. On Ctrl+V in an
// agent session the renderer asks us for an image; if the Windows clipboard
// holds one, we write it as PNG into the project's clip dir (bind-mounted at
// /clip in the container) and return the container-side path for the renderer
// to type into the pty. Text paste is handled by xterm directly.

let counter = 0

/** `%APPDATA%/vivarium/clip/<projectId>` — the host side of the /clip mount. */
function clipDir(projectId: string): string {
  return join(app.getPath('userData'), 'clip', projectId)
}

export async function pasteImage(projectId: string): Promise<string | null> {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null

  const png = image.toPNG()
  if (!png || png.length === 0) return null

  const dir = clipDir(projectId)
  await fs.mkdir(dir, { recursive: true })

  counter += 1
  const filename = `clip-${Date.now()}-${counter}.png`
  await fs.writeFile(join(dir, filename), png)

  // Container-side path (dir is bind-mounted at /clip).
  return `/clip/${filename}`
}

/**
 * How long a pasted image is kept. A clip's only real consumer is the turn it
 * was pasted into — the renderer types the path straight into the pty and the
 * agent reads the file there and then, after which the picture lives in the
 * conversation rather than on disk. A week is therefore pure margin, for the
 * one habit that would notice a shorter one: pasting a mock-up and referring
 * back to it across restarts.
 */
const CLIP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Drop clips older than `CLIP_TTL_MS`. Called before a container start and
 * **only** while that container is not already running (see DockerService.start),
 * which is the one moment nothing can be mid-turn holding a `/clip` path it is
 * about to read.
 *
 * Age is taken from mtime rather than parsed out of the filename: the timestamp
 * in the name is only a uniqueness device, and a file is exactly as old as the
 * filesystem says it is.
 *
 * Everything here is best-effort and silent. This is housekeeping on the way
 * into a container start — a locked file or a vanished directory must not be
 * the reason the project fails to start.
 */
export async function pruneClips(projectId: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(clipDir(projectId))
  } catch {
    return // nothing has ever been pasted into this project
  }
  const cutoff = Date.now() - CLIP_TTL_MS
  for (const name of names) {
    // Only files this module wrote. Nothing else should be in there, but /clip
    // is mounted read-write into a container running an agent, so "should" is
    // not a thing to delete on.
    if (!name.startsWith('clip-') || !name.endsWith('.png')) continue
    const file = join(clipDir(projectId), name)
    try {
      const stat = await fs.stat(file)
      if (stat.mtimeMs < cutoff) await fs.unlink(file)
    } catch {
      /* raced, locked, or already gone — the next start tries again */
    }
  }
}

/**
 * Delete a project's whole clip directory, for when the project itself goes.
 *
 * The same reasoning as the transcript cascade in `deleteProject`: without it,
 * the larger gesture would be the leakier one. There is no Volumes-dialog
 * equivalent for these — a shadow volume is shared build state that outlives
 * the project on purpose, while a clip belongs to one project and nothing else
 * can ever name it again.
 *
 * The guard is what makes the recursive removal safe: `projectId` arrives over
 * IPC, and this only ever removes a direct child of the clip root, so a value
 * containing a separator or `..` resolves elsewhere and is refused rather than
 * followed.
 */
export async function removeClips(projectId: string): Promise<void> {
  const root = join(app.getPath('userData'), 'clip')
  if (!projectId || relative(root, clipDir(projectId)) !== projectId) return
  await fs.rm(clipDir(projectId), { recursive: true, force: true }).catch(() => {})
}
