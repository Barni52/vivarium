// Reading a unified diff for the output panel's preview. Text in, plain data
// out: the rows are drawn as text nodes like everything else in this app.

import type { DiffStats } from '@shared/types'

export interface DiffFile {
  path: string
  added: number
  removed: number
  /** the hunks' own lines, `@@` headers included; git's preamble is dropped */
  lines: string[]
}

export interface ParsedDiff {
  files: DiffFile[]
  /** the ref it was taken against, when a Vivarium header says */
  base: string | null
  stats: DiffStats
  /** what is left when there is no diff at all: "No differences.", a git error */
  message: string
}

/** Written by `writeBranchDiff`, and how a diff with an ordinary name is recognised. */
const HEADER = '# Vivarium branch diff'

/** A file is drawn as a diff by its name, or by the header the app itself wrote. */
export function isDiffFile(name: string, text: string): boolean {
  return /\.(diff|patch)$/i.test(name) || name === 'changes.txt' || text.startsWith(HEADER)
}

/**
 * The header's counts, not a sum over the rows, whenever it has them: a diff past
 * the read limit is only partly in `text`, and those rows would understate it.
 * A `.patch` an agent wrote has no header, so its rows are all there is.
 */
function headerStats(text: string): DiffStats | null {
  const m = /^# stat:\s+\+(\d+) −(\d+) · (\d+) files?$/m.exec(text)
  return m ? { added: Number(m[1]), removed: Number(m[2]), files: Number(m[3]) } : null
}

export function parseDiff(text: string): ParsedDiff {
  const files: DiffFile[] = []
  const preamble: string[] = []
  let file: DiffFile | null = null
  // Below `@@`, a `---` line is a removed line of text. Above it, a header.
  let inHunk = false
  const source = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')

  const start = (path: string): void => {
    file = { path: path.replace(/^"|"$/g, ''), added: 0, removed: 0, lines: [] }
    files.push(file)
    inHunk = false
  }

  source.forEach((line, i) => {
    const git = /^diff --git "?a\/.+ "?b\/(.+)$/.exec(line)
    if (git) return start(git[1])
    // A plain unified diff has no `diff --git` line, so a file starts at its
    // `---`/`+++` pair. Inside a hunk that pair could be real content, unless
    // an `@@` follows it, and nothing but a new file does that.
    const pair = line.startsWith('--- ') && source[i + 1]?.startsWith('+++ ')
    if (pair && (!inHunk || source[i + 2]?.startsWith('@@'))) {
      if (file?.lines.length || !file) {
        start(source[i + 1].slice(4).replace(/^b\//, '').split('\t')[0])
      }
      return
    }
    const current = file as DiffFile | null
    if (!current) {
      if (!line.startsWith('#')) preamble.push(line)
      return
    }
    if (line.startsWith('@@')) {
      inHunk = true
      current.lines.push(line)
    } else if (inHunk) {
      current.lines.push(line)
      if (line[0] === '+') current.added++
      else if (line[0] === '-') current.removed++
    } else if (line.startsWith('Binary files')) {
      current.lines.push(line)
    }
  })

  return {
    files,
    base: /^# branch:.*\svs\s+(\S+)$/m.exec(text)?.[1] ?? null,
    stats: headerStats(text) ?? {
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      files: files.length
    },
    message: preamble.join('\n').trim()
  }
}
