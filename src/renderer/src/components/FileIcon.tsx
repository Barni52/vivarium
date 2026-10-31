import React from 'react'
// One import per icon, not the package root. The root re-exports all ~1500 icons
// in every weight, and Vite pre-bundles what it is given in dev.
import { Archive } from '@phosphor-icons/react/dist/csr/Archive'
import { BracketsCurly } from '@phosphor-icons/react/dist/csr/BracketsCurly'
import { File } from '@phosphor-icons/react/dist/csr/File'
import { FileText } from '@phosphor-icons/react/dist/csr/FileText'
import { Folder } from '@phosphor-icons/react/dist/csr/Folder'
import { FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen'
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch'
import { GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff'
import { Globe } from '@phosphor-icons/react/dist/csr/Globe'
import { Image } from '@phosphor-icons/react/dist/csr/Image'
import { Note } from '@phosphor-icons/react/dist/csr/Note'
import { Table } from '@phosphor-icons/react/dist/csr/Table'
import { TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow'
import type { Icon } from '@phosphor-icons/react'

// The output tree's icons: Phosphor, in its Fill weight.
//
// **The icon carries the colour so the name does not have to.** File names used
// to be tinted, which made every row read as a link, and the 1px line icons
// beside them turned to grey specks at 13px. A solid shape holds its hue at that
// size, and the name stays plain `--fg`.
//
// The shape says what kind of thing a file is, never which extension it has. So
// no `file-pdf` or `file-zip`: those print the letters inside the glyph, which
// only restates the name beside it.

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])
const CODE = new Set([
  'js', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'py', 'java', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'xml'
])
const DATA = new Set(['csv', 'tsv', 'xls', 'xlsx'])
const ARCHIVE = new Set(['zip', '7z', 'rar', 'tar', 'gz'])

function fileIcon(name: string): { icon: Icon; color: string } {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  // By name first: `changes.txt` is a diff, whatever its extension says.
  if (name === 'changes.txt' || ext === 'diff' || ext === 'patch') {
    return { icon: GitDiff, color: 'var(--ok)' }
  }
  if (ext === 'md' || ext === 'markdown' || ext === 'docx') {
    return { icon: FileText, color: 'var(--role-you)' }
  }
  if (ext === 'txt') return { icon: Note, color: 'var(--role-you)' }
  if (ext === 'pdf') return { icon: FileText, color: 'var(--danger)' }
  if (DATA.has(ext)) return { icon: Table, color: 'var(--ok)' }
  if (ext === 'html' || ext === 'htm') return { icon: Globe, color: 'var(--accent2)' }
  if (IMAGE.has(ext)) return { icon: Image, color: 'var(--role-agent)' }
  if (CODE.has(ext)) return { icon: BracketsCurly, color: 'var(--str)' }
  if (ext === 'log') return { icon: TerminalWindow, color: 'var(--muted)' }
  if (ARCHIVE.has(ext)) return { icon: Archive, color: 'var(--muted)' }
  return { icon: File, color: 'var(--muted)' }
}

export function FileIcon({ name, size = 15 }: { name: string; size?: number }): React.ReactElement {
  const { icon: Glyph, color } = fileIcon(name)
  return <Glyph size={size} weight="fill" color={color} style={{ flex: 'none' }} />
}

/** A folder, or the branch mark for a top-level folder holding a branch's diff. */
export function FolderIcon({
  open,
  branch = false,
  size = 15
}: {
  open: boolean
  branch?: boolean
  size?: number
}): React.ReactElement {
  if (branch) return <GitBranch size={size} weight="fill" color="var(--accent2)" style={{ flex: 'none' }} />
  const Glyph = open ? FolderOpen : Folder
  return <Glyph size={size} weight="fill" color="var(--code-type)" style={{ flex: 'none' }} />
}
