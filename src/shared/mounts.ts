// Where a mounted host folder lands inside the container.
//
// This is the second piece of *logic* in `@shared`, and it earns the place the
// same way `models.ts` does: **both processes have to name the same path**.
// `docker.ts` builds the `--mount` targets the container actually receives, and
// the mount dialog is the one place this app tells you where a folder ended up.
// A second copy of the rule let the two disagree — the dialog printed the raw
// folder leaf, so a folder named `My Project` was advertised at
// `/workspace/My Project` while docker was handed `/workspace/My_Project`, and
// two mounts sharing a leaf (`frontend/shared`, `backend/shared`) were both
// shown at `/workspace/shared` though the second really lands under a suffix.
// Sending someone to a container path that does not exist is worse than saying
// nothing, so there is now one rule and both callers read it.

/** One bind mount, as docker is told about it. */
export interface MountTarget {
  hostPath: string
  target: string
  /** The shared output folder — one folder for every project, so no shadow volumes. */
  shared?: true
}

/**
 * SHA-1, first 8 hex digits — the disambiguating suffix and, in `docker.ts`,
 * container and shadow-volume names.
 *
 * Hand-rolled because `@shared` is imported by the renderer, which has no
 * `node:crypto` and whose `crypto.subtle` is async — and an async hash cannot
 * be read during a render. It is byte-for-byte node's
 * `createHash('sha1').update(s, 'utf8')`, which it has to be: these digits are
 * baked into the names of containers and volumes that already exist on disk,
 * and a different digest would strand every one of them.
 */
export function shortHash(input: string): string {
  const bytes = new TextEncoder().encode(input)
  // Message + 0x80 + zero padding to 56 mod 64 + a 64-bit big-endian bit count.
  const marked = bytes.length + 1
  const total = marked + (((56 - (marked % 64)) + 64) % 64) + 8
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const view = new DataView(buf.buffer)
  const bits = bytes.length * 8
  view.setUint32(total - 8, Math.floor(bits / 0x1_0000_0000))
  view.setUint32(total - 4, bits >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let at = 0; at < total; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  // Only the first word is ever read, but the rest are cheap and keep this a
  // sha1 rather than a lookalike anyone would have to re-derive to trust.
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('').slice(0, 8)
}

/** Everything docker's own name grammar rejects becomes `_`. */
export function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * The last segment of a host path. Its own implementation because `@shared`
 * cannot import `node:path` — and `path.basename` would be the *posix* one in
 * the renderer's bundle anyway, which does not know `\` is a separator.
 */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Every bind mount for a project, in the order docker is given them.
 *
 * Two rules beyond "take the folder's name": the leaf is sanitized, and a leaf
 * already in use gets a `-<hash of its host path>` suffix so the second folder
 * lands somewhere of its own rather than shadowing the first. The shared output
 * folder reserves `output` before any of them, so a project folder actually
 * named `output` is the one that moves.
 */
export function mountTargets(mounts: string[], sharedOutput?: string): MountTarget[] {
  const out: MountTarget[] = []
  const usedNames = new Set<string>()
  if (sharedOutput) {
    usedNames.add('output')
    out.push({ hostPath: sharedOutput, target: '/workspace/output', shared: true })
  }
  for (const abs of mounts) {
    const leafRaw = sanitize(basename(abs))
    let leaf = leafRaw
    if (usedNames.has(leaf)) leaf = `${leafRaw}-${shortHash(abs)}`
    usedNames.add(leaf)
    out.push({ hostPath: abs, target: `/workspace/${leaf}` })
  }
  return out
}
