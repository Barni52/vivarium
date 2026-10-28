import { readFileSync, statSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'path'
import { execFile } from 'child_process'
import type { Project, DiffResult } from '@shared/types'

// Resolve the current git branch for a working directory by reading .git/HEAD
// directly — no git binary required. Handles the common cases: a normal repo,
// a worktree/submodule (.git is a file pointing at the real gitdir), and a
// detached HEAD (returns a short commit hash).
export function gitBranch(basePath: string): string | null {
  if (!basePath) return null
  try {
    let gitDir = join(basePath, '.git')
    const st = statSync(gitDir)
    if (st.isFile()) {
      const m = readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)
      if (!m) return null
      gitDir = resolve(basePath, m[1].trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (ref) return ref[1]
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7) // detached HEAD
    return null
  } catch {
    return null
  }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a git command in `cwd`. Never throws; captures stdout/stderr/exit code. */
function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, // diffs can be large
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** The base a diff is taken against when nothing else was picked. */
export const DEFAULT_DIFF_BASE = 'origin/master'

/**
 * Whether `base` may go to `git diff` as `<base>...HEAD`. It is an argument of
 * its own (no shell), but git reads one that starts with `-` as an *option* —
 * `--output=<file>` among them — and an agent can now pass it, so only the
 * characters a ref name is written with get through.
 */
export function isDiffBase(base: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/.test(base) && !base.includes('..')
}

/**
 * The folder a branch's diff and its review go in: the branch name, with the
 * characters a Windows folder name cannot hold made `-` — so `feature/ABC-1`
 * is `feature-ABC-1`, one flat folder rather than a tree the skills would have
 * to walk.
 */
export function branchFolderName(branch: string): string {
  const name = branch
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return name || 'unknown-branch'
}

/**
 * Fetch origin, then write a diff of the current branch vs `base` (committed
 * only, `<base>...HEAD`) into `<outputFolder>/<branch>/changes.txt`, scoped to
 * the project's mounted subfolders (folders outside the repo are ignored).
 * Always writes a file so the user gets feedback even on error.
 *
 * **One folder per branch** (`branchFolderName`), so the diff and the review
 * written from it sit together and two branches never overwrite each other's.
 */
export async function writeBranchDiff(
  project: Project,
  outputFolder: string,
  base: string
): Promise<DiffResult> {
  const cwd = project.basePath
  const branch = gitBranch(cwd) ?? '(unknown)'
  if (!isDiffBase(base)) return { ok: false, message: `not a branch or ref name: ${base}` }

  // 1. Fetch remote — non-fatal (offline / no origin still lets a stale diff run).
  const fetched = await run('git', ['fetch', 'origin', '--prune'], cwd)
  const fetchNote = fetched.code === 0 ? '' : `git fetch failed: ${fetched.stderr.trim() || 'unknown error'}`

  // 2. Mounted subfolders → pathspecs relative to the repo root (skip those
  //    outside the repo). Distinguish "no mounts" from "mounts, none in repo".
  const specs: string[] = []
  for (const m of project.mounts) {
    const rel = relative(cwd, m)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    specs.push(rel.split(sep).join('/'))
  }
  const hadMounts = project.mounts.length > 0

  // 3. Build + run the diff (or note that nothing is in scope).
  let body: string
  if (hadMounts && specs.length === 0) {
    body = 'No mounted folders are inside this repository; nothing to diff.'
  } else {
    const args = ['diff', `${base}...HEAD`]
    if (specs.length) args.push('--', ...specs)
    const diff = await run('git', args, cwd)
    if (diff.code !== 0) {
      body = `git diff failed:\n${diff.stderr.trim() || 'unknown error'}`
    } else {
      body = diff.stdout.trim() ? diff.stdout : 'No differences.'
    }
  }

  // 4. Header + write changes.txt.
  const scope = specs.length ? specs.join(', ') : hadMounts ? '(none in repo)' : '(no mounts → whole repo)'
  const header = [
    `# Vivarium branch diff`,
    `# repo:    ${cwd}`,
    `# branch:  ${branch}  vs  ${base}`,
    `# scope:   ${scope}`,
    `# generated: ${new Date().toISOString()}`,
    fetchNote ? `# note:    ${fetchNote}` : null,
    ''
  ]
    .filter((l) => l !== null)
    .join('\n')

  const folder = branchFolderName(gitBranch(cwd) ?? '')
  const dir = join(outputFolder, folder)
  const file = join(dir, 'changes.txt')
  await mkdir(dir, { recursive: true })
  await writeFile(file, `${header}\n${body}\n`, 'utf8')
  return { ok: true, message: file, folder }
}
