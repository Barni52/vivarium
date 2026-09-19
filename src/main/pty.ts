import * as pty from 'node-pty'
import { execFile } from 'child_process'
import type { IPty } from 'node-pty'
import type { Project, Session } from '@shared/types'
import { isHostProject } from '@shared/projects'
import type { DockerService } from './docker'
import { ensureHostBridgeFiles } from './bridge'
import { cmdLine, hostConversationExists, resolveClaude, withoutParentSession } from './host'

type Emit = (channel: string, payload: unknown) => void

interface Tracked {
  proc: IPty
  session: Session
  /** Set by kill(id, silent) — this pty's exit must not be reported (see kill). */
  silent?: boolean
}

let pwshCache: string | undefined

function resolvePwsh(): Promise<string> {
  if (pwshCache !== undefined) return Promise.resolve(pwshCache)
  return new Promise((resolve) => {
    execFile('pwsh', ['-NoProfile', '-Command', 'exit'], { windowsHide: true }, (err) => {
      pwshCache = err ? 'powershell.exe' : 'pwsh.exe'
      resolve(pwshCache)
    })
  })
}

export class PtyManager {
  private terms = new Map<string, Tracked>()

  constructor(
    private docker: DockerService,
    private emit: Emit
  ) {}

  has(sessionId: string): boolean {
    return this.terms.has(sessionId)
  }

  liveIds(): string[] {
    return [...this.terms.keys()]
  }

  /**
   * Spawn a pty for a session. `cols`/`rows` come from the renderer's initial
   * xterm fit. Container sessions require the container to be running (checked
   * by the caller). Returns false if the local binary could not be spawned.
   */
  async spawn(
    session: Session,
    project: Project,
    cols: number,
    rows: number
  ): Promise<boolean> {
    // Re-use an existing pty if one is already alive (selection re-attach).
    if (this.terms.has(session.id)) return true

    let file: string
    // A string only for the cmd.exe shim path — see host.ts `cmdLine`.
    let args: string[] | string
    let cwd: string

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    } as Record<string, string>

    // Everything below that runs on the host (not through `docker exec`, which
    // passes no environment across) gets it without an outer Claude Code's
    // session markers — see withoutParentSession.
    if (session.type === 'host-shell') {
      file = await resolvePwsh()
      args = ['-NoLogo']
      cwd = project.basePath
      withoutParentSession(env)
    } else if (isHostProject(project)) {
      // A host project's agent: the Windows `claude`, straight in the project
      // folder. Deliberately *without* --dangerously-skip-permissions — the
      // container is what made bypass a reasonable default, and here there is
      // none, so this is exactly the `claude` you would get by typing it into
      // your own terminal in that folder, prompts and all. (Shift+Tab still
      // walks it through the TUI's own modes.)
      const claude = await resolveClaude()
      if (!claude) return false
      const settings = await ensureHostBridgeFiles(project.id)
      // Everything else mirrors the container agent (DockerService.execArgs):
      // the hooks come in through --settings rather than the user's own
      // settings.json, which a `claude` started anywhere else would pick up, and
      // the conversation is pinned by id so it survives the app restarting.
      const argv = ['--settings', settings]
      if (session.claudeSessionId) {
        const resume = await hostConversationExists(session.claudeSessionId)
        argv.push(resume ? '--resume' : '--session-id', session.claudeSessionId)
      }
      withoutParentSession(env)
      env.VIVARIUM_SESSION_ID = session.id
      file = claude.kind === 'exe' ? claude.path : process.env['ComSpec'] || 'cmd.exe'
      args = claude.kind === 'exe' ? argv : cmdLine(claude.path, argv)
      cwd = project.basePath
    } else {
      const bin = await this.docker.binaryName()
      if (!bin) return false
      file = bin
      args = await this.docker.execArgs(
        project,
        session.type === 'agent' ? 'agent' : 'shell',
        session.id
      )
      // cwd is irrelevant for the docker client; use a safe existing dir.
      cwd = project.basePath
    }

    let proc: IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env,
        useConpty: true
      })
    } catch {
      return false
    }

    // The tracked entry — not the session id — is what the exit handler closes
    // over, so a silenced kill can never mute the *replacement* pty's exit if the
    // two generations overlap.
    const tracked: Tracked = { proc, session }
    this.terms.set(session.id, tracked)

    proc.onData((data) => this.emit('pty:data', { sessionId: session.id, data }))
    proc.onExit(({ exitCode }) => {
      // Only drop it if this generation is still the current one (kill() already
      // removed it, and a replacement may have taken the slot since).
      if (this.terms.get(session.id) === tracked) this.terms.delete(session.id)
      if (tracked.silent) return
      this.emit('pty:exit', { sessionId: session.id, exitCode })
    })

    return true
  }

  write(sessionId: string, data: string): void {
    this.terms.get(sessionId)?.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const t = this.terms.get(sessionId)
    if (t && cols > 0 && rows > 0) {
      try {
        t.proc.resize(cols, rows)
      } catch {
        /* pty may have just exited */
      }
    }
  }

  /**
   * Kill a single session's pty (used by "Kill session").
   *
   * `silent` suppresses the 'pty:exit' event for callers that are about to
   * replace this pty rather than end the session — the cross-project move. The
   * ordering is the reason: moveSession kills here and *then* rewrites config,
   * so by the time the OS reports the exit the renderer has already swapped in a
   * fresh terminal for the same session id, and that terminal would print
   * "[session ended]" and clear `live` on top of the pty it just opened.
   * Removing a session leaves the default on — nothing survives to be confused.
   */
  kill(sessionId: string, silent = false): void {
    const t = this.terms.get(sessionId)
    if (!t) return
    if (silent) t.silent = true
    try {
      t.proc.kill()
    } catch {
      /* already gone */
    }
    this.terms.delete(sessionId)
  }

  /**
   * On app quit: kill every tracked pty's LOCAL process. This never stops the
   * container — for agents it only severs the docker-exec client (the agent
   * process ends because it has no multiplexer, which is the accepted model).
   */
  killAll(): void {
    for (const { proc } of this.terms.values()) {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }
    this.terms.clear()
  }
}
