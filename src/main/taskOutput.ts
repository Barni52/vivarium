import type { ChatShellOutput } from '@shared/types'

// The two halves of reading a background command's output that do not depend
// on where the file is — the container side (DockerService.readOutputTail) and
// the host side (host.ts readHostOutputTail) each do their own I/O.

/**
 * The one shape of path the CLI writes a background task's output to:
 * `…/tasks/<id>.output`, either slash. The path arrives parsed out of a tool
 * result, so anything else is refused before it is read — on the host that is
 * a file on the user's own disk.
 */
export function isTaskOutputPath(path: string): boolean {
  // Only the end is pinned: the start is a temp directory, which on Windows
  // holds the user's own name and may hold anything a name can.
  return /[\\/]tasks[\\/][A-Za-z0-9_-]+\.output$/.test(path) && !path.includes('..')
}

/**
 * The last `lines` lines of `text`, and whether there were more. A trailing
 * newline ends the last line rather than starting an empty one, so a file
 * that ends cleanly does not count one line too many.
 */
export function takeLastLines(text: string, lines: number): ChatShellOutput {
  const all = text.replace(/\r\n/g, '\n').split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  const truncated = all.length > lines
  return { ok: true, text: all.slice(-lines).join('\n'), truncated }
}
