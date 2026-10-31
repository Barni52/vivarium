import { readFileSync, statSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'path'
import { execFile } from 'child_process'
import { DEFAULT_DIFF_BASE, isDiffBase } from '@shared/projects'
import type { Config, DiffRefs, DiffResult, DiffStats, Project } from '@shared/types'

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

/**
 * The base for a project with nothing picked: what the repo itself calls its
 * default, then the old global setting, then `origin/master`.
 *
 * `origin/HEAD` is a local ref that `git clone` sets and `git init` plus
 * `git remote add` does not, so it can be absent from a perfectly good repo.
 */
async function fallbackBase(project: Project, config: Config): Promise<string> {
  const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], project.basePath)
  const ref = head.code === 0 ? head.stdout.trim() : ''
  return ref && isDiffBase(ref) ? ref : config.diffBase || DEFAULT_DIFF_BASE
}

/** The base this project's diff is taken against, for the UI and for agents alike. */
export async function resolveDiffBase(project: Project, config: Config): Promise<string> {
  return project.diffBase || fallbackBase(project, config)
}

/** The compare popover's reading of the repo. Run when it opens, never polled. */
export async function diffRefs(project: Project, config: Config): Promise<DiffRefs> {
  const listed = await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], project.basePath)
  // `refs/remotes/origin/HEAD` shortens to plain `origin` on current git and to
  // `origin/HEAD` on older ones. Neither is a branch anybody would pick.
  const remotes = listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('/') && !l.endsWith('/HEAD') && isDiffBase(l))
  return { fallback: await fallbackBase(project, config), remotes }
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
 * A project's mounted subfolders as pathspecs relative to the repo root, the
 * ones outside the repo skipped — what the diff and the commit are both limited
 * to, since the mounts are all an agent could have changed. `hadMounts` tells
 * "no mounts, so the whole repo" apart from "mounts, none of them in the repo".
 */
function mountPathspecs(project: Project): { specs: string[]; hadMounts: boolean } {
  const specs: string[] = []
  for (const m of project.mounts) {
    const rel = relative(project.basePath, m)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    specs.push(rel.split(sep).join('/'))
  }
  return { specs, hadMounts: project.mounts.length > 0 }
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

  // 2. Mounted subfolders → pathspecs relative to the repo root.
  const { specs, hadMounts } = mountPathspecs(project)

  // 3. Build + run the diff (or note that nothing is in scope).
  let body: string
  let stats: DiffStats | undefined
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
      stats = await numstat(cwd, ['diff', '--numstat', ...args.slice(1)])
    }
  }

  // 4. Header + write changes.txt.
  const scope = specs.length ? specs.join(', ') : hadMounts ? '(none in repo)' : '(no mounts → whole repo)'
  const header = [
    `# Vivarium branch diff`,
    `# repo:    ${cwd}`,
    `# branch:  ${branch}  vs  ${base}`,
    `# scope:   ${scope}`,
    stats ? `# stat:    ${formatStats(stats)}` : null,
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
  return { ok: true, message: file, folder, stats }
}

/**
 * Sum `git diff --numstat`. A second git run rather than counting `+` lines in
 * the body, because this is exact where a count has to guess at a line that
 * merely starts with `+++`, and a binary file (`-  -  path`) still counts as a
 * file. It goes in the header so the preview can read the true size of a diff
 * too large to load whole.
 */
async function numstat(cwd: string, args: string[]): Promise<DiffStats | undefined> {
  const r = await run('git', args, cwd)
  if (r.code !== 0) return undefined
  const stats: DiffStats = { added: 0, removed: 0, files: 0 }
  for (const line of r.stdout.split('\n')) {
    const [added, removed] = line.split('\t')
    if (added === undefined || removed === undefined) continue
    stats.files++
    stats.added += Number(added) || 0
    stats.removed += Number(removed) || 0
  }
  return stats
}

/** The size of a diff in the one spelling the header and the tool answer share. */
export function formatStats(s: DiffStats): string {
  return `+${s.added} −${s.removed} · ${s.files} ${s.files === 1 ? 'file' : 'files'}`
}

export interface CommitOutcome {
  ok: boolean
  message: string
}

/**
 * Stage and commit every change in a project's checkout, on the branch it is
 * on — `git add -A` then `git commit`, both limited to the project's mounts
 * like the diff is (the whole repo when it mounts none).
 *
 * **`branch` is a check, not a switch.** The commit lands only if the
 * checkout is already on that branch: an agent cannot see the host's `.git`,
 * so naming the branch it believes it is on is what stops a commit landing on
 * `master` because somebody switched branches in their IDE. Nothing is ever
 * checked out here.
 *
 * The pathspec goes to `git commit` as well as to `git add`, which is git's
 * `--only` mode: whatever the user had staged elsewhere by hand stays staged
 * and out of this commit. It runs as the user, in their repo, so their
 * identity and their hooks apply, and a hook that refuses is reported as the
 * failure it is. Nothing is pushed.
 */
export async function commitBranchChanges(
  project: Project,
  branch: string,
  message: string
): Promise<CommitOutcome> {
  const cwd = project.basePath
  const current = gitBranch(cwd)
  if (!current) return { ok: false, message: 'there is no git repository at the project folder' }
  if (current !== branch) {
    return { ok: false, message: `the checkout is on ${current}, not ${branch}; nothing was committed` }
  }
  const { specs, hadMounts } = mountPathspecs(project)
  if (hadMounts && specs.length === 0) {
    return { ok: false, message: 'none of the mounted folders is inside this repository' }
  }
  const scope = specs.length ? ['--', ...specs] : []

  const added = await run('git', ['add', '-A', ...scope], cwd)
  if (added.code !== 0) return { ok: false, message: `git add failed: ${gitError(added)}` }
  // Exit 1 means "there are staged differences", 0 "there are none".
  const staged = await run('git', ['diff', '--cached', '--quiet', ...scope], cwd)
  if (staged.code === 0) return { ok: true, message: `nothing to commit on ${branch}` }
  if (staged.code !== 1) return { ok: false, message: `git diff failed: ${gitError(staged)}` }

  const committed = await run('git', ['commit', '-m', message, ...scope], cwd)
  if (committed.code !== 0) return { ok: false, message: `git commit failed: ${gitError(committed)}` }
  const head = await run('git', ['log', '-1', '--format=%h %s'], cwd)
  const stat = await run('git', ['show', '--shortstat', '--format=', 'HEAD'], cwd)
  return {
    ok: true,
    message: `committed ${head.stdout.trim()} on ${branch} (${stat.stdout.trim() || 'no file changes'})`
  }
}

/** What a failed git command said — a hook prints to either stream. */
function gitError(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split('\n').slice(0, 20).join('\n')
}
