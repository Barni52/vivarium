import { spawn, execFile } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { join, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  ClaudeVersionInfo,
  ContainerState,
  Project,
  VolumeInfo,
  VolumeRemoveResult,
  VolumeReport
} from '@shared/types'
import {
  IMAGE_VERSION,
  SLIM_IMAGE,
  FULL_IMAGE,
  CREDS_VOLUME,
  HOME_VOLUME,
  BACKEND_PORTS,
  slimDockerfile,
  fullDockerfile
} from './dockerfiles'
import { bridgeDir, ensureBridgeFiles } from './bridge'
import { clipDir, pruneClips } from './clipboard'

export type LineSink = (chunk: string) => void

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Is `a` an older release than `b`?
 *
 * Numeric compare of the dotted parts and nothing else. A prerelease suffix
 * (`2.1.0-rc.1`) is deliberately read as its release — the question here is only
 * ever "is the container behind the registry's `latest`", and `latest` never
 * points at a prerelease, so the worst this can do is decline to reinstall a
 * version somebody hand-installed. Unparseable either side → false, i.e. leave
 * it alone: a version string this does not understand is not evidence of
 * anything.
 */
function isOlderVersion(a: string, b: string): boolean {
  // The suffix comes off before the split, not after: `2.1.226-rc.1` splits into
  // four fields and would otherwise compare as *newer* than the 2.1.226 it is a
  // candidate for.
  const parts = (v: string): number[] =>
    v.split('-')[0].split('.').map((p) => parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : NaN))
  const x = parts(a)
  const y = parts(b)
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return false
}

/** short 4-byte SHA1 hex of a string (ref: 8-char hash suffix in claude-box.ps1). */
function shortHash(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 8)
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Shadow-volume suffix → what it overlays. Read by shadowMounts (which builds
 * the names) *and* by listVolumes (which explains them back to the user), so
 * the two can't drift apart — a suffix that isn't in here won't compile.
 */
const SHADOW_KINDS = {
  nm: 'node_modules',
  ngcache: '.angular cache',
  extnm: 'extensions/node_modules',
  target: 'Maven target'
} as const

/**
 * Volume-name prefix for one mounted host folder's shadow volumes. The hash is
 * of the absolute path, which is what lets listVolumes tell a live cache from
 * an orphan: no current mount hashes to it → nothing will ever use it again.
 */
function shadowPrefix(abs: string): string {
  return `vivarium-${shortHash(abs)}`
}

/** docker reports sizes as "0B" / "461.4kB" / "1.21GB" — back to bytes. */
function parseSize(size: string): number | null {
  const m = size.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/)
  if (!m) return null
  const units: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    // docker uses decimal units, but accept binary ones so a CLI that switches
    // reports a wrong-by-2.4% total instead of no total at all
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  }
  const mult = units[m[2].toLowerCase()]
  const n = Number(m[1])
  return mult && Number.isFinite(n) ? Math.round(n * mult) : null
}

export class DockerService {
  /** Resolved container-runtime binary, or null if none found. */
  private binary: string | null | undefined
  /** Cached Windows host IP the container forwards backend ports to. */
  private hostIp: string | null | undefined
  /** Shared output folder (absolute host path) mounted into every container. */
  private sharedOutput: string | undefined

  /** Set/clear the shared output folder mounted into all containers. */
  setSharedOutput(p: string | undefined): void {
    this.sharedOutput = p || undefined
  }

  // ---- runtime detection (ref 72-81, nerdctl dropped) --------------------
  async detect(): Promise<string | null> {
    if (this.binary !== undefined) return this.binary
    this.binary = (await this.which('docker')) ? 'docker' : null
    return this.binary
  }

  private which(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      // `docker --version` is a cheap existence probe that works cross-platform.
      execFile(cmd, ['--version'], { windowsHide: true }, (err) => resolve(!err))
    })
  }

  private async docker(): Promise<string> {
    const bin = await this.detect()
    if (!bin) throw new Error('docker-missing')
    return bin
  }

  // ---- generic command runners -------------------------------------------
  // `timeoutMs` guards the commands that talk to a possibly-wedged container
  // (version probe, npm install): docker exec has no timeout of its own and a
  // hung child would leave the caller's spinner up forever.
  private async exec(args: string[], timeoutMs?: number): Promise<ExecResult> {
    const r = await this.execBuf(args, timeoutMs)
    return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
  }

  /**
   * The same runner, keeping stdout as bytes. Decoding per chunk (as the string
   * form used to) mangles any multi-byte character that straddles a chunk
   * boundary, which a 10 MB transcript read will hit sooner or later — and the
   * caller counts *bytes* to resume the read from, so a re-encoded length would
   * drift from the file's own offsets.
   */
  private async execBuf(
    args: string[],
    timeoutMs?: number
  ): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const bin = await this.docker()
    return new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true })
      const chunks: Buffer[] = []
      let stderr = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (code: number, err?: string): void => {
        if (timer) clearTimeout(timer)
        resolve({ code, stdout: Buffer.concat(chunks), stderr: err ?? stderr })
      }
      if (timeoutMs) {
        // 124 mirrors coreutils `timeout` so callers can tell it apart.
        timer = setTimeout(() => {
          child.kill()
          done(124, stderr || 'timed out')
        }, timeoutMs)
      }
      child.stdout.on('data', (d: Buffer) => chunks.push(d))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('close', (code) => done(code ?? 0))
      child.on('error', () => done(1, stderr || 'spawn failed'))
    })
  }

  /**
   * The same runner again, with something written to the child's stdin.
   *
   * Exists for exactly one caller (askClaude below) and for one reason: the text
   * it sends is a slice of the user's own conversation, and stdin is the only
   * way into the container that never becomes part of a command line. An argv
   * would have to survive `sh -c` quoting, which is a shell-injection bug
   * waiting for the first prompt containing a backtick.
   */
  private async execStdin(
    args: string[],
    stdin: string,
    timeoutMs?: number
  ): Promise<ExecResult> {
    const bin = await this.docker()
    return new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (code: number, err?: string): void => {
        if (timer) clearTimeout(timer)
        resolve({ code, stdout, stderr: err ?? stderr })
      }
      if (timeoutMs) {
        timer = setTimeout(() => {
          child.kill()
          done(124, stderr || 'timed out')
        }, timeoutMs)
      }
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('close', (code) => done(code ?? 0))
      child.on('error', () => done(1, stderr || 'spawn failed'))
      // A `-p` run reads its whole prompt from stdin and waits for EOF, so the
      // end matters as much as the write.
      child.stdin.on('error', () => {
        /* the child died before it read us; the exit code is the report */
      })
      child.stdin.write(stdin)
      child.stdin.end()
    })
  }

  /**
   * Ask Claude Code a one-shot question inside a project's container, in a
   * conversation that is thrown away before this resolves.
   *
   * The chat auto-titler is the only caller, and every choice here is about
   * keeping it invisible — a name in the sidebar is not worth a slow, expensive
   * or side-effecting call:
   *
   * - **Never the chat's own live process.** The transcript *is* the model's
   *   context, so a "name this conversation" turn sent down that stdin would
   *   both appear in the user's log and be re-fed to the agent for the rest of
   *   the session. A separate process is the only way to ask about a
   *   conversation without joining it.
   * - **`-w /tmp`, not `/workspace`.** cwd decides which CLAUDE.md files load,
   *   and the project's is the largest thing this call could accidentally pay
   *   for. `/tmp` has none. (The user-level `~/.claude/CLAUDE.md` on the shared
   *   home volume still loads; that one is not addressable from here.)
   * - **A pinned `--session-id`,** so the throwaway transcript it necessarily
   *   writes has a name we know and can delete. Without it the CLI mints a uuid
   *   we never learn, and the `-tmp` project dir grows a file per titling for
   *   the life of the volume.
   *
   * Returns trimmed stdout, or null on any failure at all — a caller that
   * cannot get a title keeps the one it has, which is always a reasonable
   * outcome and never worth a dialog.
   */
  async askClaude(
    project: Project,
    prompt: string,
    model: string,
    timeoutMs = 90_000
  ): Promise<string | null> {
    if (!(await this.detect())) return null
    const container = this.containerName(project)
    const uuid = randomUUID()
    // `-i` for the stdin pipe, and no `-t` — there is no TTY in this path any
    // more than in the chat's own (a TTY would make the CLI paint a spinner
    // into the answer). Default `--output-format text`: the answer is the whole
    // of stdout, which is the cheapest thing to parse and the hardest to
    // misread. Tools are not disabled by a flag because a plain `-p` run
    // auto-denies every permission prompt (the same CLI fact the chat's
    // `--permission-prompt-tool stdio` exists to *undo*), and `/tmp` holds
    // nothing to read anyway.
    const r = await this.execStdin(
      ['exec', '-i', '-w', '/tmp', container, 'claude', '-p', '--model', model, '--session-id', uuid],
      prompt,
      timeoutMs
    )
    // Best-effort, and deliberately not awaited into the answer: the title is
    // worth having even if the cleanup fails, and the file is a few KB.
    //
    // **`rm -rf` with an interpolated variable**, so the safety argument sits
    // here exactly as it does on deleteTranscripts: `uuid` is `randomUUID()`
    // output — hex and hyphens, never user input, never a name the CLI chose —
    // and the glob names that one conversation, so the `-workspace` slug next
    // to it (which holds this project's chats *and* claude-box's) cannot be
    // reached even if the escaping of the cwd changes under us.
    void this.exec([
      'exec',
      container,
      'sh',
      '-c',
      `rm -rf /home/node/.claude/projects/*/${uuid}.jsonl /home/node/.claude/projects/*/${uuid}/`
    ])
    if (r.code !== 0) return null
    const text = r.stdout.trim()
    return text || null
  }

  /** Run a docker command, streaming combined output to a sink line-by-line. */
  private async execStream(args: string[], sink: LineSink, stdin?: string): Promise<number> {
    // Resolved *before* the promise, not inside it. This used to be an `async`
    // executor, where `this.docker()` throwing `docker-missing` rejected a
    // promise nobody held and left the returned one unsettled for good — a
    // container start whose progress streams into a terminal, spinning forever
    // with no timeout behind it. Every caller today happens to check `detect()`
    // first, which is why it was never seen; nothing enforced that.
    let bin: string
    try {
      bin = await this.docker()
    } catch {
      sink('\r\n[vivarium] docker not found on PATH. Start Docker/Rancher Desktop.\r\n')
      return 1
    }
    return new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true })
      const forward = (d: Buffer): void => sink(d.toString().replace(/\n/g, '\r\n'))
      child.stdout.on('data', forward)
      child.stderr.on('data', forward)
      child.on('close', (code) => resolve(code ?? 0))
      child.on('error', (e) => {
        sink(`\r\n[vivarium] failed to run docker: ${e.message}\r\n`)
        resolve(1)
      })
      if (stdin !== undefined) {
        child.stdin.write(stdin)
        child.stdin.end()
      }
    })
  }

  // ---- Windows host IP (ref 229-250) -------------------------------------
  private async detectHostIp(): Promise<string | null> {
    if (this.hostIp !== undefined) return this.hostIp
    let ip: string | null = null

    // Primary: the WSL2 VM default gateway is the address that reaches Windows.
    ip = await new Promise<string | null>((resolve) => {
      execFile(
        'wsl.exe',
        ['-e', 'sh', '-lc', 'ip route show default'],
        { windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null)
          const clean = stdout.replace(/\0/g, '') // wsl output is sometimes UTF-16
          const m = clean.match(/via\s+(\d{1,3}(?:\.\d{1,3}){3})/)
          resolve(m ? m[1] : null)
        }
      )
    })

    // Fallback: the host-side "vEthernet (WSL)" adapter address.
    if (!ip) {
      ip = await new Promise<string | null>((resolve) => {
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like 'vEthernet (WSL*' } | Select-Object -First 1 -ExpandProperty IPAddress)"
          ],
          { windowsHide: true },
          (err, stdout) => resolve(err ? null : stdout.trim() || null)
        )
      })
    }

    this.hostIp = ip
    return ip
  }

  // ---- images (ref 351-526) ----------------------------------------------
  private async imageCurrent(name: string): Promise<boolean> {
    const inspect = await this.exec([
      'image',
      'inspect',
      name,
      '--format',
      '{{ index .Config.Labels "vivarium.version" }}'
    ])
    if (inspect.code !== 0) return false
    return inspect.stdout.trim() === IMAGE_VERSION
  }

  /**
   * Ensure the image for `variant` exists and is current, building if needed.
   * Streams build output to `sink`. Slim is always built first (full is FROM slim).
   */
  async ensureImage(variant: 'slim' | 'full', sink: LineSink, rebuild = false): Promise<boolean> {
    if (rebuild || !(await this.imageCurrent(SLIM_IMAGE))) {
      sink(`\r\n==> Building ${SLIM_IMAGE} (fast, ~1-2 minutes)\r\n`)
      const args = ['build', '-t', SLIM_IMAGE, '-f', '-']
      if (rebuild) args.push('--no-cache', '--pull')
      args.push('.')
      const code = await this.execStream(args, sink, slimDockerfile())
      if (code !== 0) {
        sink('\r\n[vivarium] slim image build failed\r\n')
        return false
      }
    }

    if (variant === 'full' && (rebuild || !(await this.imageCurrent(FULL_IMAGE)))) {
      sink(`\r\n==> Building ${FULL_IMAGE} on top of slim (one-time, ~5-10 minutes)\r\n`)
      const args = ['build', '-t', FULL_IMAGE, '-f', '-']
      if (rebuild) args.push('--no-cache') // no --pull: base is the local slim image
      args.push('.')
      const code = await this.execStream(args, sink, fullDockerfile())
      if (code !== 0) {
        sink('\r\n[vivarium] full image build failed\r\n')
        return false
      }
    }
    return true
  }

  // ---- volumes (ref 528-535) ---------------------------------------------
  private async ensureVolumes(): Promise<void> {
    for (const vol of [CREDS_VOLUME, HOME_VOLUME]) {
      const inspect = await this.exec(['volume', 'inspect', vol])
      if (inspect.code !== 0) await this.exec(['volume', 'create', vol])
    }
  }

  // ---- shared Claude credentials (for the usage endpoint) -----------------
  /**
   * Read `.credentials.json` out of the shared creds volume. Prefer `docker
   * exec` into any running vivarium container (instant, no image needed); fall
   * back to a throwaway busybox run mounting the volume read-only — busybox
   * (~1 MB) is pulled once on first use. Returns null when docker is missing,
   * nothing is running and busybox can't be pulled, or the file doesn't exist.
   */
  async readSharedCredentials(): Promise<string | null> {
    // Every step is capped: this runs behind an IPC handler the renderer awaits,
    // and a daemon that is starting up or wedged makes plain `docker ps` hang
    // indefinitely rather than fail. Without a cap that hang propagates all the
    // way to the title bar, which shows nothing at all until the call settles.
    // The busybox run gets more room — it may have to pull the image once.
    try {
      const ps = await this.exec(
        ['ps', '--filter', 'name=vivarium-', '--format', '{{.Names}}'],
        5_000
      )
      const name = ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)[0]
      if (ps.code === 0 && name) {
        const r = await this.exec(
          ['exec', name, 'cat', '/home/node/.claude/.credentials.json'],
          5_000
        )
        if (r.code === 0 && r.stdout.trim()) return r.stdout
      }
      const r = await this.exec(
        [
          'run',
          '--rm',
          '-v',
          `${CREDS_VOLUME}:/creds:ro`,
          'busybox',
          'cat',
          '/creds/.credentials.json'
        ],
        20_000
      )
      return r.code === 0 && r.stdout.trim() ? r.stdout : null
    } catch {
      return null // docker-missing
    }
  }

  // ---- naming ------------------------------------------------------------
  containerName(project: Project): string {
    // One container per project; the id hash avoids collisions between projects
    // that share a folder leaf name.
    return `vivarium-${sanitize(project.name)}-${shortHash(project.id)}`
  }

  imageName(project: Project): string {
    return project.image === 'full' ? FULL_IMAGE : SLIM_IMAGE
  }

  // ---- shadow mounts (ref 553-566) ---------------------------------------
  // Overlay container-local named volumes on top of build-output dirs so
  // in-container installs/builds are fast and never touch the Windows checkout.
  private shadowMounts(hostDir: string, target: string, volPrefix: string): string[] {
    const vols: string[] = []
    // Suffixes are keyed off SHADOW_KINDS so the Volumes dialog can always name
    // what it found.
    const shadow = (suffix: keyof typeof SHADOW_KINDS, at: string): void => {
      vols.push('-v', `${volPrefix}-${suffix}:${at}`)
    }
    if (existsSync(join(hostDir, 'package.json'))) {
      shadow('nm', `${target}/node_modules`)
      shadow('ngcache', `${target}/.angular`)
      if (existsSync(join(hostDir, 'extensions', 'package.json'))) {
        shadow('extnm', `${target}/extensions/node_modules`)
      }
    }
    if (existsSync(join(hostDir, 'pom.xml'))) {
      shadow('target', `${target}/target`)
    }
    return vols
  }

  /**
   * Where each of a project's mounted folders lands inside the container.
   *
   * Read by the run-arg builder *and* by the chat composer's attachment routing —
   * a file under one of these becomes a container path, anything else becomes
   * inline content — so the leaf naming lives in exactly one place. A chat chip
   * shows the container path it produced, which is also what disarms the shadow
   * volume trap: `<mount>/node_modules` and friends are overlaid by volumes, so a
   * file dragged from `D:\proj\node_modules\…` resolves to the copy the
   * *container* installed rather than the one you dragged, and showing the
   * translated path means you can see what you actually got.
   */
  mountTargets(project: Project): Array<{ hostPath: string; target: string; shared?: true }> {
    const out: Array<{ hostPath: string; target: string; shared?: true }> = []
    const usedNames = new Set<string>()
    // Shared output folder: always mounted (read-write) at /workspace/output so
    // agents in every project drop artifacts to the same place. Reserve the
    // "output" leaf first so a project folder literally named "output" gets a
    // hash-suffixed target instead of colliding with this one.
    if (this.sharedOutput) {
      usedNames.add('output')
      out.push({ hostPath: this.sharedOutput, target: '/workspace/output', shared: true })
    }
    for (const abs of project.mounts) {
      const leafRaw = sanitize(basename(abs))
      let leaf = leafRaw
      if (usedNames.has(leaf)) leaf = `${leafRaw}-${shortHash(abs)}`
      usedNames.add(leaf)
      out.push({ hostPath: abs, target: `/workspace/${leaf}` })
    }
    return out
  }

  /**
   * A fingerprint of everything about a container that **cannot be changed after
   * it is created**, written on it as a label and re-checked before every start.
   *
   * This is the fix for a bug with a nasty shape: mounts may only be edited while
   * the container is stopped (the settings dialog locks them otherwise), and
   * `start()` reuses a stopped container as-is — so the one path the UI allowed
   * was the one path that never applied the change. You added a folder, the
   * config recorded it, and `/workspace` never gained it. "Restart" did not help
   * either, being stop-then-start on the same container; only *recreate* rebuilds
   * the mount set, and nothing on that path called it.
   *
   * A label rather than diffing `docker inspect`'s mount list: this is an exact
   * equality test on one string, where a diff has to normalise Windows paths,
   * decide what counts as equal, and be re-audited every time a run argument is
   * added. It also covers the image variant and the published port, which had
   * the identical bug through the identical route.
   *
   * Shadow volumes are deliberately *not* in here even though they are mounts:
   * they are derived from whether a `package.json`/`pom.xml` exists on disk, so
   * including them would silently recreate a container the first time you ran
   * `npm init` inside a mounted folder.
   *
   * A container created before this existed has no label, does not match, and is
   * recreated once — the same one-time upgrade the hook-bridge check used to do,
   * and safe for the same reason: everything durable is in the named volumes.
   */
  private containerSpec(project: Project): string {
    return shortHash(
      JSON.stringify({
        v: 1,
        image: this.imageName(project),
        // Slim never publishes, so a port left in config must not count as a
        // difference — it changes nothing about the container.
        port: project.image === 'full' ? (project.publishedPort ?? null) : null,
        mounts: this.mountTargets(project).map((m) => [m.hostPath, m.target])
      })
    )
  }

  // ---- run-args construction (ref 537-795, ported to /workspace) ----------
  private async buildRunArgs(project: Project): Promise<string[]> {
    const name = this.containerName(project)
    const hostIp = await this.detectHostIp()
    const forwardTarget = hostIp ?? 'host.docker.internal'

    const args: string[] = [
      'run',
      '-dt',
      // tini as PID 1. Without it PID 1 is `sleep infinity`, and the kernel
      // ignores default-action signals for PID 1 — so `docker stop`'s SIGTERM
      // does nothing and docker hangs the full 10s grace before SIGKILL. tini
      // forwards SIGTERM to the child, so the container stops in ~0.3s cleanly.
      '--init',
      '--name',
      name,
      '--label',
      'vivarium=1',
      '--label',
      `vivarium.project=${project.id}`,
      '--label',
      `vivarium.workspace=${project.basePath}`,
      // What this container was built to be. Compared before every start; a
      // mismatch means the project has been edited since and the container has
      // to be rebuilt rather than restarted (see containerSpec).
      '--label',
      `vivarium.spec=${this.containerSpec(project)}`,
      '-e',
      'COLORTERM=truecolor',
      '-e',
      'TERM=xterm-256color'
    ]

    // Host access + backend forwarding.
    if (hostIp) {
      args.push('--add-host', `host.docker.internal:${hostIp}`)
    } else {
      args.push('--add-host', 'host.docker.internal:host-gateway')
    }
    args.push('-e', `HOST_FORWARD_PORTS=${BACKEND_PORTS.join(',')}`)
    args.push('-e', `HOST_FORWARD_TARGET=${forwardTarget}`)

    // Published port: FULL projects only. Slim never publishes (even if set).
    if (project.image === 'full' && project.publishedPort && project.publishedPort > 0) {
      const p = project.publishedPort
      args.push('-p', `${p}:${p}`)
    }

    // Home + creds volumes (shared across all containers).
    args.push('-v', `${HOME_VOLUME}:/home/node`)
    args.push('-v', `${CREDS_VOLUME}:/home/node/.claude`)

    // Selected mounts → /workspace/<leaf>, deduped by leaf name, plus shadows.
    // Bind mounts use --mount (not -v): a Windows source like `C:\foo` contains
    // a drive-letter colon, and docker's -v parser mis-splits it into a bogus
    // third "mode" segment ("invalid mode: /workspace/..."). --mount is
    // comma/key=value delimited, so the colon is unambiguous.
    for (const { hostPath, target, shared } of this.mountTargets(project)) {
      args.push('--mount', `type=bind,source=${hostPath},target=${target}`)
      // The shared output folder is one folder for every project; it gets no
      // per-project shadow volumes.
      if (!shared) args.push(...this.shadowMounts(hostPath, target, shadowPrefix(hostPath)))
    }

    // Clip dir for image-paste (host-managed bind mount).
    args.push('--mount', `type=bind,source=${clipDir(project.id)},target=/clip`)

    // Hook bridge: Claude Code hook settings + event log (see bridge.ts).
    args.push('--mount', `type=bind,source=${bridgeDir(project.id)},target=/vivarium`)

    args.push('-w', '/workspace')
    args.push(this.imageName(project))
    // Keep-alive PID1 that first starts the socat relays, then sleeps forever.
    args.push('host-forward', 'sleep', 'infinity')
    return args
  }

  // ---- lifecycle ---------------------------------------------------------
  async containerExists(project: Project): Promise<boolean> {
    const r = await this.exec(['container', 'inspect', this.containerName(project)])
    return r.code === 0
  }

  async isRunning(project: Project): Promise<boolean> {
    const r = await this.exec([
      'inspect',
      '-f',
      '{{.State.Running}}',
      this.containerName(project)
    ])
    if (r.code !== 0) return false
    return r.stdout.trim() === 'true'
  }

  /**
   * Every project's container state, in **one** docker launch.
   *
   * The per-project pair (`isRunning` + `containerExists`) is two `docker.exe`
   * launches each, and the renderer polls this every 3 seconds — so six projects
   * were twelve process spawns per tick, awaited one after another, on the
   * platform where spawning is the expensive part. That is also the *same* burst
   * `OPEN_LIMIT` exists to meter: a loaded daemon answers `docker inspect`
   * non-zero, which `isRunning` reads as "container stopped", so the poll was
   * quietly competing with every session open.
   *
   * `docker ps -a` answers for all of them at once, and it answers *consistently*
   * — one snapshot rather than 2N reads taken at different moments, which is what
   * let a container be reported as existing-but-stopped when it had just started.
   *
   * **Matched by name, not by the `vivarium.project` label**, even though the
   * label exists and reads like the better key. Two reasons. `docker ps` renders
   * `.Labels` as one flat comma-joined string rather than a map, so pulling one
   * out means `{{.Label "…"}}` and a template that fails *closed* — a typo would
   * exit non-zero and report every container stopped, which is a worse failure
   * than the one being fixed. And name matching is what `isRunning` and
   * `containerExists` already do, so this stays exactly equivalent to them:
   * renaming a project changes `containerName`, and its old container should go
   * on reading as absent here precisely because nothing else can reach it either.
   *
   * The `name=vivarium-` filter follows `readSharedCredentials`, which scopes the
   * same way. A project with no container is simply absent from the output, which
   * is exactly `{exists: false}`.
   */
  async containerStates(projects: Project[]): Promise<ContainerState[]> {
    const out: ContainerState[] = projects.map((p) => ({
      projectId: p.id,
      running: false,
      exists: false
    }))
    if (!(await this.detect())) return out
    // Capped like every other command that talks to a daemon which may be
    // starting up: this sits behind a handler the renderer awaits every 3s, and
    // an uncapped hang would stall the poll rather than report "not running".
    const r = await this.exec(
      ['ps', '-a', '--filter', 'name=vivarium-', '--format', '{{.Names}}\t{{.State}}'],
      10_000
    )
    if (r.code !== 0) return out

    const byName = new Map<string, string>()
    for (const line of r.stdout.split('\n')) {
      const [name, state] = line.split('\t')
      if (name && state) byName.set(name.trim(), state.trim())
    }

    projects.forEach((p, i) => {
      const state = byName.get(this.containerName(p))
      if (state === undefined) return
      out[i].exists = true
      // 'running' is the only state that counts; 'created', 'exited', 'paused',
      // 'restarting', 'dead' and 'removing' are all not-running, which matches
      // isRunning()'s `{{.State.Running}} == true` exactly.
      out[i].running = state === 'running'
    })
    return out
  }

  /**
   * Start (or create) the project container. Builds the image first if needed;
   * all progress streams to `sink`. Returns true on success.
   */
  async start(project: Project, sink: LineSink): Promise<boolean> {
    if (!(await this.detect())) {
      sink('\r\n[vivarium] docker not found on PATH. Start Docker/Rancher Desktop.\r\n')
      return false
    }

    const name = this.containerName(project)

    // Does it exist, and was it built for the project as it is *now*? One
    // inspect answers both — a missing container exits non-zero, and a container
    // whose mounts, image or port no longer match carries a different spec hash
    // (or none at all, if it predates the label).
    const want = this.containerSpec(project)
    const probe = await this.exec([
      'container',
      'inspect',
      '-f',
      '{{ index .Config.Labels "vivarium.spec" }}',
      name
    ])
    let exists = probe.code === 0

    if (exists && probe.stdout.trim() !== want) {
      // **The mount fix.** A bind mount cannot be added to an existing
      // container, so a project whose folders changed has to be rebuilt rather
      // than started — which is exactly what did not happen before, because
      // mounts are only editable while stopped and the stopped path reused the
      // container verbatim. Safe: everything durable lives in the named
      // home/creds/shadow volumes, so this costs the container and nothing else.
      sink(
        `\r\n==> Recreating ${name} — its mounts, image or port no longer match the project\r\n`
      )
      await this.exec(['rm', '-f', name])
      exists = false
    }

    // Already running? Nothing to do.
    if (exists && (await this.isRunning(project))) return true

    // Refresh hook script/settings + drop stale events before every start.
    await ensureBridgeFiles(project.id)
    // Same window, same reason: this is past the already-running check, so no
    // agent in this container can be mid-turn holding a /clip path it is about
    // to read. Pasted images are otherwise written once and never removed.
    await pruneClips(project.id)

    // Exists but stopped → just start it.
    if (exists) {
      sink(`\r\n==> Starting existing container ${name}\r\n`)
      return (await this.execStream(['start', name], sink)) === 0
    }

    // Fresh create: ensure image + volumes, then run.
    const built = await this.ensureImage(project.image, sink)
    if (!built) return false
    await this.ensureVolumes()

    // Ensure the host-side clip dir (and shared output folder, if set) exist
    // before binding them — a missing bind source fails `docker run`.
    await fsp.mkdir(clipDir(project.id), { recursive: true })
    if (this.sharedOutput) {
      await fsp.mkdir(this.sharedOutput, { recursive: true }).catch(() => {})
    }

    sink(`\r\n==> Creating container ${name} (${this.imageName(project)})\r\n`)
    const args = await this.buildRunArgs(project)
    const code = await this.execStream(args, sink)
    if (code !== 0) {
      // docker run can leave a half-created container behind — clean it up.
      await this.exec(['rm', '-f', name])
      sink('\r\n[vivarium] docker run failed\r\n')
      return false
    }
    await this.freshenClaude(project, sink)
    return true
  }

  /**
   * Bring a **brand-new** container's Claude Code up to the published version.
   *
   * The CLI is an image layer (`npm install -g` in slimDockerfile) and the image
   * is only rebuilt when IMAGE_VERSION changes, which is roughly never — so the
   * version a container is born with is the version that was current the day the
   * image was built, months ago, and every new project and every `recreate`
   * started life behind. That is what this fixes.
   *
   * **This is not the auto-update that was removed, and the difference is the
   * whole reason it is allowed to exist.** That one was a fire-and-forget
   * `npm i -g` on *every container start*, which swapped the CLI out from under
   * sessions that were already running in it. This runs on exactly one path —
   * the `docker run` that just created the container — where by construction
   * there is no session, no agent and no live turn to change anything under. It
   * is also awaited and streamed into the terminal that is already showing the
   * image build, so it is a step you watch rather than something that happened
   * to you. Starting an existing container still never touches the CLI.
   *
   * Every failure is non-fatal and quiet-ish: no network, no npm, a registry
   * outage, docker being slow — the container is up and perfectly usable with
   * the image's version, and the version chip goes on saying so.
   */
  private async freshenClaude(project: Project, sink: LineSink): Promise<void> {
    const latest = await this.claudeLatest?.()
    if (!latest) return
    const have = (await this.claudeVersion(project)).installed
    if (!have || !isOlderVersion(have, latest)) return
    sink(`\r\n==> Updating Claude Code ${have} → ${latest} in the new container\r\n`)
    const r = await this.updateClaude(project)
    if (r.code !== 0) {
      sink(`[vivarium] could not update Claude Code — staying on ${have}\r\n`)
      return
    }
    sink(`[vivarium] Claude Code ${(await this.claudeVersion(project)).installed ?? latest}\r\n`)
  }

  /**
   * What "the newest published version" is, injected rather than imported.
   *
   * `ClaudeService` owns the npm-registry lookup and its cache, and it is built
   * *on top of* this service — so it hands its getter down instead, and the
   * dependency keeps pointing one way. Absent (nobody wired it) means no
   * freshening, which is the old behaviour.
   */
  private claudeLatest: (() => Promise<string | null>) | undefined

  setClaudeLatest(fn: () => Promise<string | null>): void {
    this.claudeLatest = fn
  }

  async stop(project: Project): Promise<void> {
    // Cap the grace period at 2s. New containers run with --init and stop almost
    // instantly; this bound only matters for containers created before --init
    // (their PID 1 ignores SIGTERM) so they no longer hang the full 10s default.
    await this.exec(['stop', '-t', '2', this.containerName(project)])
  }

  async restart(project: Project, sink: LineSink): Promise<boolean> {
    await this.stop(project)
    return this.start(project, sink)
  }

  /** Remove + recreate (used after a mount / image / port change). */
  async recreate(project: Project, sink: LineSink): Promise<boolean> {
    await this.exec(['rm', '-f', this.containerName(project)])
    return this.start(project, sink)
  }

  // ---- Claude Code version (manual updates, see main/claude.ts) -----------
  /**
   * Read the Claude Code version installed inside a project's container.
   * The CLI lives in the container's own filesystem, so this only works while
   * it runs — a stopped or not-yet-created container has no version to report,
   * and the reason is surfaced in the UI rather than guessed at.
   */
  async claudeVersion(project: Project): Promise<ClaudeVersionInfo> {
    const base = { projectId: project.id }
    if (!(await this.detect())) return { ...base, installed: null, reason: 'docker-missing' }
    if (!(await this.containerExists(project))) return { ...base, installed: null, reason: 'no-container' }
    if (!(await this.isRunning(project))) return { ...base, installed: null, reason: 'stopped' }
    const r = await this.exec(['exec', this.containerName(project), 'claude', '--version'], 20_000)
    // `claude --version` prints e.g. "2.2.0 (Claude Code)" — take the semver.
    const m = r.stdout.match(/\d+\.\d+\.\d+[^\s]*/)
    if (r.code !== 0 || !m) return { ...base, installed: null, reason: 'error' }
    return { ...base, installed: m[0] }
  }

  /**
   * Install the newest Claude Code inside the container, replacing the copy baked
   * into the image. The image installs it as root under /usr/local/lib/node_modules
   * but the container runs as `node`, so Claude's own auto-updater can't write there
   * — we install out of band with the node user's passwordless sudo (see the sudoers
   * line in dockerfiles.ts); npm and node both sit in /usr/local/bin, which is on
   * sudo's default secure_path.
   *
   * Awaited, unlike everything else here that shells out in the background: the
   * caller drives a progress row and reports the outcome. Two consequences the UI
   * spells out — a `claude` already running keeps its in-memory version until
   * relaunched, and since the install lands in the writable layer a later `recreate`
   * reverts it to the image's version, which the version chip re-flags instead of
   * silently self-healing.
   */
  async updateClaude(project: Project): Promise<ExecResult> {
    // 6 min: a cold npm cache on a slow link genuinely takes minutes, and a
    // half-finished install is worse than a slow one.
    return this.exec(
      [
        'exec',
        this.containerName(project),
        'sudo',
        'npm',
        'install',
        '-g',
        '--no-fund',
        '--no-audit',
        '@anthropic-ai/claude-code@latest'
      ],
      360_000
    )
  }

  async remove(project: Project): Promise<void> {
    await this.exec(['rm', '-f', this.containerName(project)])
  }

  // ---- volume housekeeping -----------------------------------------------
  /**
   * List the volumes Vivarium is responsible for, with sizes and ownership.
   *
   * Every mounted folder can spawn up to four shadow volumes (see shadowMounts) and
   * nothing else ever removes one — deleting a project drops its container, never
   * its node_modules or Maven caches — so they are a slow, invisible disk leak, and
   * a renamed or unmounted folder strands its caches under a hash nobody can read.
   *
   * Sizes only come from `docker system df -v`; `volume inspect` doesn't report
   * them. It walks every volume directory, so it can take seconds on a large
   * node_modules and the caller shows a loading state. `--format {{json .Volumes}}`
   * keeps us off the human table layout, but the fields are still read defensively
   * (Links arrives as a *string*, Size as "1.21GB"), and a failed sweep falls back
   * to `volume ls` — listing and removal still work, just without sizes.
   */
  async listVolumes(projects: Project[]): Promise<VolumeReport> {
    if (!(await this.detect())) return { volumes: [], sized: false, error: 'docker not found' }

    // prefix → project names, so a shadow volume can say whose mount made it
    const owners = new Map<string, Set<string>>()
    for (const p of projects) {
      for (const abs of p.mounts) {
        const key = shadowPrefix(abs)
        const set = owners.get(key) ?? new Set<string>()
        set.add(p.name)
        owners.set(key, set)
      }
    }

    let sized = true
    let error: string | undefined
    let rows: Array<{ name: string; size: string | null; links: number }> = []

    // 90s: a directory walk over every volume on the machine, not a metadata read.
    const df = await this.exec(['system', 'df', '-v', '--format', '{{json .Volumes}}'], 90_000)
    if (df.code === 0) {
      try {
        const parsed: unknown = JSON.parse(df.stdout.trim() || '[]')
        for (const entry of Array.isArray(parsed) ? parsed : []) {
          // Every field is optional as far as we're concerned: this is an
          // undocumented format from a CLI that has changed it before.
          const v = entry as { Name?: unknown; Size?: unknown; Links?: unknown }
          if (typeof v.Name !== 'string' || !v.Name) continue
          rows.push({
            name: v.Name,
            size: typeof v.Size === 'string' ? v.Size : null,
            links: Number(v.Links) || 0
          })
        }
      } catch {
        sized = false
        error = 'could not parse docker system df output'
      }
    } else {
      sized = false
      error = (df.stderr || df.stdout).trim().split('\n')[0] || `docker system df exited ${df.code}`
    }

    if (!sized) {
      const ls = await this.exec(['volume', 'ls', '--format', '{{.Name}}'])
      rows = ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name, size: null, links: 0 }))
    }

    const volumes: VolumeInfo[] = []
    for (const row of rows) {
      const shared = row.name === CREDS_VOLUME || row.name === HOME_VOLUME
      if (!shared && !row.name.startsWith('vivarium-')) continue // not ours

      // `vivarium-<8 hex>-<suffix>` is a shadow volume; anything else under the
      // prefix is a leftover from older naming or a dev run, which is worth
      // showing precisely *because* nothing accounts for it.
      const m = row.name.match(/^(vivarium-[0-9a-f]{8})-(.+)$/)
      const contents = m ? SHADOW_KINDS[m[2] as keyof typeof SHADOW_KINDS] : undefined
      const isShadow = !!m && !!contents

      volumes.push({
        name: row.name,
        kind: shared ? 'shared' : isShadow ? 'shadow' : 'other',
        size: row.size,
        bytes: row.size ? parseSize(row.size) : null,
        links: row.links,
        contents: isShadow ? contents : null,
        projects: isShadow ? [...(owners.get(m[1]) ?? [])] : [],
        locked: shared
      })
    }
    return { volumes, sized, error }
  }

  /**
   * Remove one volume. Docker refuses while a container still references it,
   * which is the behaviour we want — the message goes straight to the UI.
   */
  async removeVolume(name: string): Promise<VolumeRemoveResult> {
    // Belt to the renderer's braces: the shared pair holds the Claude sign-in
    // and every agent's memory, and nothing outside `vivarium-*` is ours to
    // delete — this runs on a name that arrived over IPC.
    if (name === CREDS_VOLUME || name === HOME_VOLUME) {
      return { ok: false, message: 'shared Claude volume — never removed from here' }
    }
    if (!name.startsWith('vivarium-')) return { ok: false, message: 'not a Vivarium volume' }
    const r = await this.exec(['volume', 'rm', name], 30_000)
    if (r.code === 0) return { ok: true }
    const raw = (r.stderr || r.stdout).trim().split('\n')[0] ?? ''
    return {
      ok: false,
      message: raw.replace(/^Error response from daemon:\s*/i, '') || `docker exited ${r.code}`
    }
  }

  /** Build the argv (minus the leading binary) for a session's exec/attach. */
  async execArgs(
    project: Project,
    kind: 'agent' | 'chat' | 'shell',
    sessionId: string,
    /**
     * Whether the conversation transcript already exists, when the caller has
     * just read it and knows. A chat open costs three docker.exe launches under
     * one gate slot (probe, transcript read, exec client); letting it re-probe
     * here would quietly make it four.
     */
    conversationExists?: boolean
  ): Promise<string[]> {
    const name = this.containerName(project)
    if (kind === 'chat') {
      const session = project.sessions.find((s) => s.id === sessionId)
      // `-i`, never `-it`: there is no TTY anywhere in this path, which is the
      // whole point of the chat type. Everything below rides one NDJSON stream in
      // each direction (see main/chat.ts).
      const args = ['exec', '-i', '-w', '/workspace', name, 'claude', '-p']
      args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose')
      // Load-bearing and undocumented — it is not in `claude --help`. A sentinel,
      // not a real MCP server: without it a raw `-p` run **auto-denies every
      // prompt**, *and* AskUserQuestion / EnterPlanMode / ExitPlanMode are not in
      // the session's tool list at all (verified by diffing init.tools with and
      // without it). Every turn needs it, including a slash-command turn.
      args.push('--permission-prompt-tool', 'stdio')
      // Token deltas, so prose paints as it is generated rather than landing in
      // one block at the end. Chunky over docker exec (~16 events in 5s), but real.
      args.push('--include-partial-messages')
      // Required for the live sub-log to match the settled sibling file block for
      // block. Without it the stream withholds a subagent's prose and thinking, so
      // the sub-log would *grow paragraphs* at completion — a systematic twitch,
      // which is not what the turn-end settle is meant to expose.
      args.push('--forward-subagent-text')
      // **Always bypassPermissions, even for a session saved in `plan`** — plan is
      // then entered over the control channel at spawn (see ChatService.start).
      // Launching directly in plan mode is a one-way door, for two reasons read off
      // the CLI (2.1.220) rather than guessed:
      //   1. `isBypassPermissionsModeAvailable` is decided **once**, at startup,
      //      from `--permission-mode bypassPermissions || --dangerously-skip-permissions`,
      //      and every later `set_permission_mode bypassPermissions` is refused
      //      against it for the life of the process ("the session was not launched
      //      with --dangerously-skip-permissions"). The header toggle and the plan
      //      card were both asking for a mode the process could never enter.
      //   2. ExitPlanMode's approval path ends by setting the mode to
      //      `prePlanMode ?? 'default'`, and `prePlanMode` is only recorded by a
      //      *transition* into plan mode. Launched in plan there was no transition,
      //      so approving a plan landed the session in `default` — asking about
      //      every edit, which is not one of this app's two modes.
      // Entering plan mode from bypass answers both: bypass stays available, and the
      // CLI's own plan exit restores exactly the mode it came from.
      args.push('--permission-mode', 'bypassPermissions')
      // Vivarium owns the model: a chip reading "opus" at reopen while the process
      // actually spawned on the CLI's configured default is a reading that lies
      // about a live fact, in a header made entirely of readings.
      if (session?.model) args.push('--model', session.model)
      // Deliberately absent: --settings /vivarium/hooks.json and
      // VIVARIUM_SESSION_ID. The hook bridge stays for pty agents only; a chat
      // derives its own activity from this stream, and double-emitting would give
      // the store two producers for one session.
      const claudeId = session?.claudeSessionId
      if (claudeId) {
        const resume =
          conversationExists ?? (await this.claudeConversationExists(name, claudeId))
        args.push(resume ? '--resume' : '--session-id', claudeId)
      }
      return args
    }
    if (kind === 'agent') {
      // VIVARIUM_SESSION_ID tags this exec's hook events with the owning
      // session; --settings loads the bridge hooks without touching the shared
      // /home/node/.claude settings (claude-box sessions stay hook-free).
      const args = [
        'exec',
        '-it',
        '-e',
        `VIVARIUM_SESSION_ID=${sessionId}`,
        '-w',
        '/workspace',
        name,
        'claude',
        '--dangerously-skip-permissions',
        '--settings',
        '/vivarium/hooks.json'
      ]
      // Resume-across-restart: pin Claude's own conversation id. `--session-id`
      // starts a fresh conversation with that id and errors if it exists;
      // `--resume` re-attaches an existing one and errors if it doesn't. So branch
      // on whether the transcript is already on the persistent .claude volume —
      // Claude's own "id already in use" test, which also self-heals a session that
      // was opened but never messaged (no transcript yet → fresh). Legacy sessions
      // are backfilled with a claudeSessionId on config load; only a truly missing
      // id falls through to a bare, non-resumable claude.
      const claudeId = project.sessions.find((s) => s.id === sessionId)?.claudeSessionId
      if (claudeId) {
        const resume = await this.claudeConversationExists(name, claudeId)
        args.push(resume ? '--resume' : '--session-id', claudeId)
      }
      return args
    }
    return ['exec', '-it', '-w', '/workspace', name, 'bash']
  }

  /**
   * Does a Claude Code conversation transcript for `uuid` already exist inside the
   * container? Claude writes them to
   * $CLAUDE_CONFIG_DIR/projects/<escaped-cwd>/<uuid>.jsonl on the persistent
   * claude-box-creds volume. Globbing across the projects dir rather than hardcoding
   * the escaped cwd (`/workspace` → `-workspace`) keeps a change to Claude's
   * path-escaping from silently breaking the check. A failed exec returns false →
   * start a fresh conversation. The uuid is Vivarium-generated (hex + hyphens), so
   * it is safe to interpolate into the shell command.
   */
  private async claudeConversationExists(container: string, uuid: string): Promise<boolean> {
    const res = await this.exec([
      'exec',
      container,
      'sh',
      '-c',
      `ls /home/node/.claude/projects/*/${uuid}.jsonl 2>/dev/null`
    ])
    return res.code === 0 && res.stdout.trim() !== ''
  }

  // ---- chat transcripts ---------------------------------------------------
  /**
   * Read a conversation transcript out of the container, optionally resuming
   * from a byte offset.
   *
   * The container-side .jsonl is the *model* of a chat conversation, not a log of
   * it — reading Claude's own file is what makes cross-type resume free (a
   * conversation started in an xterm agent opens in chat with its full history,
   * and vice versa) and what stops the UI from ever showing something other than
   * what `--resume` actually feeds the model. The accepted cost is that history
   * is unreadable while the container is stopped, which lands on the same
   * "Container stopped" placeholder that already explains it.
   *
   * Globbed across the projects dir for the same reason claudeConversationExists
   * globs: hardcoding the escaped cwd (`/workspace` → `-workspace`) would break
   * silently if Claude changed its path escaping. `tail -c +N` is 1-based.
   */
  async readTranscript(
    project: Project,
    uuid: string,
    fromByte = 0
  ): Promise<{ ok: boolean; text: string; bytes: number; message?: string }> {
    const path = `/home/node/.claude/projects/*/${uuid}.jsonl`
    const cmd =
      fromByte > 0 ? `tail -c +${fromByte + 1} ${path} 2>/dev/null` : `cat ${path} 2>/dev/null`
    // 60s: a 10 MB read over `docker exec` on a busy daemon, not a metadata probe.
    const r = await this.execBuf(['exec', this.containerName(project), 'sh', '-c', cmd], 60_000)
    // A conversation that has never been messaged has no file yet: `cat` exits
    // non-zero with nothing on stdout, which is an empty history, not a failure.
    if (r.code !== 0 && r.stdout.length === 0) {
      const msg = r.stderr.trim().split('\n')[0]
      if (r.code === 124) return { ok: false, text: '', bytes: 0, message: 'timed out' }
      // exit 1 from the glob simply means "no such file".
      if (r.code === 1 && !msg) return { ok: true, text: '', bytes: 0 }
      if (msg) return { ok: false, text: '', bytes: 0, message: msg }
    }
    return { ok: true, text: r.stdout.toString('utf8'), bytes: r.stdout.length }
  }

  /**
   * Read one subagent's sibling log. Subagent inner work is *not* written into
   * the parent transcript — the parent file already is the collapsed view and
   * this file already is the expansion — so this is only ever read on demand,
   * keyed by the agentId the parent's own tool result reports.
   *
   * **`agentId` is the one interpolation here that is not a `randomUUID()`.** It
   * is parsed out of tool-result content (`chatMapper`'s `task-id` note tag, or
   * `toolUseResult.agentId`), so it is model-influenced data going into `sh -c`.
   * The blast radius is small and worth stating rather than implying: the shell
   * is inside a container where the agent already runs with
   * `--dangerously-skip-permissions`, so nothing reachable through it was out of
   * reach anyway. It is validated regardless, because the neighbouring
   * interpolations (`deleteTranscripts`, `askClaude`) each stop and argue for
   * their own safety and this one had the same shape with no argument behind it.
   */
  async readSubagentLog(project: Project, uuid: string, agentId: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return null
    const cmd = `cat /home/node/.claude/projects/*/${uuid}/subagents/agent-${agentId}.jsonl 2>/dev/null`
    const r = await this.execBuf(['exec', this.containerName(project), 'sh', '-c', cmd], 30_000)
    return r.stdout.length > 0 ? r.stdout.toString('utf8') : null
  }

  /**
   * The slash-command and skill definitions sitting on disk in the container.
   *
   * This exists because `system/init` — Claude Code's own list, and the only
   * authoritative one — is not emitted until the first user message of a
   * process (see ChatService.init). So a chat you have just opened, or one open
   * since before you wrote a skill this morning, offers whatever list the last
   * turn happened to report. The CLI itself is *not* stale (verified against
   * 2.1.226: a SKILL.md created while the process ran turned up in the next
   * init it emitted), only this app's picture of it is.
   *
   * The four canonical directories, and deliberately no more:
   * `<cwd>/.claude` for the project and `$CLAUDE_CONFIG_DIR` — which the image
   * pins to `/home/node/.claude`, on the shared creds volume — for the user.
   * Plugin skills (`plugin:name`) live under a repos tree whose layout this
   * would have to guess at, and they arrive with `init` like everything else;
   * the merge is a union, so missing them costs nothing.
   *
   * Paths out, names *not* derived here: turning a path into `/dir:name` is
   * Claude Code's rule, not docker's, and it belongs next to the code that
   * already merges the CLI's own list (see commandNamesFrom in chat.ts).
   */
  async listCommandFiles(project: Project): Promise<string[]> {
    // Both `find`s are allowed to fail — a project with no `.claude` is the
    // common case, and `find` exits non-zero for a missing root — so stderr
    // goes nowhere and the trailing `true` keeps the exec's own code at 0.
    // `head` bounds a pathological tree; nobody has 500 commands, and if they
    // do the menu was never going to help.
    const cmd =
      "{ find /workspace/.claude/commands /home/node/.claude/commands -type f -name '*.md' 2>/dev/null;" +
      " find /workspace/.claude/skills /home/node/.claude/skills -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null; } | head -500; true"
    const r = await this.exec(['exec', this.containerName(project), 'sh', '-c', cmd], 15_000)
    if (r.code !== 0) return []
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  }

  /**
   * Grep every conversation on the shared creds volume.
   *
   * Conversations accumulate there forever — deliberately, since deletion is
   * explicit and there is no sweep — so the archive only grows, and until now
   * there was no way to ask it anything. "Which chat was it where I worked out
   * the WSL gateway" was unanswerable without opening sessions one at a time.
   *
   * **Not a `sh -c` anywhere in here, and that is the whole safety story.** The
   * query is the one piece of genuine free-text user input this app puts near a
   * shell, and every other interpolated command in this file has had to argue
   * that its variable is a `randomUUID()`. This one cannot make that argument, so
   * it does not interpolate at all: the term travels as its own argv element,
   * where a quote, a backtick or a `;` is just a character grep looks for.
   * `-F` keeps it a literal rather than a regex (nobody types `a.b(` meaning a
   * pattern), and `-e` is what stops a term beginning with `-` being read as an
   * option.
   *
   * Counts rather than `-l`, which would stop at the first match per file: the
   * count is what ranks the results, and "the conversation that mentions this
   * thirty times" is almost always the one being looked for. It costs a full read
   * of every transcript, which is why this is a button and not a keystroke.
   *
   * Prefers a running container over a throwaway one, following
   * `readSharedCredentials` — the volume is the same from either, and an exec
   * into something already up needs no image and no container create.
   */
  async searchTranscripts(
    query: string,
    timeoutMs = 60_000
  ): Promise<{ ok: boolean; counts: Map<string, number>; error?: string }> {
    const empty = new Map<string, number>()
    if (!query.trim()) return { ok: true, counts: empty }
    if (!(await this.detect())) return { ok: false, counts: empty, error: 'docker-missing' }
    // Or `docker run -v` would *create* claude-box-creds on a machine that has
    // never run a container — the same trap deleteTranscripts documents.
    if (!(await this.volumeExists(CREDS_VOLUME))) {
      return { ok: false, counts: empty, error: 'no-volume' }
    }

    const root = '/home/node/.claude/projects'
    const grep = ['grep', '-rFc', '--include=*.jsonl', '-e', query, root]

    // A running container first (instant), else a throwaway mounting the volume.
    const ps = await this.exec(
      ['ps', '--filter', 'name=vivarium-', '--format', '{{.Names}}'],
      5_000
    )
    const up =
      ps.code === 0
        ? ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0]
        : undefined
    const r = up
      ? await this.exec(['exec', up, ...grep], timeoutMs)
      : await this.exec(
          ['run', '--rm', '-v', `${CREDS_VOLUME}:/home/node/.claude`, SLIM_IMAGE, ...grep],
          timeoutMs
        )

    if (r.code === 124) return { ok: false, counts: empty, error: 'timed-out' }
    // grep exits 1 for "no lines matched anywhere", which is a successful search
    // that found nothing — not a failure. Anything above that is one.
    if (r.code > 1) {
      const msg = (r.stderr || r.stdout).trim().split('\n')[0]
      return { ok: false, counts: empty, error: msg || `grep exited ${r.code}` }
    }

    // `grep -rc` prints a line for every file it read, matched or not, so the
    // zeros are filtered here rather than through a shell pipe.
    const counts = new Map<string, number>()
    for (const line of r.stdout.split('\n')) {
      const at = line.lastIndexOf(':')
      if (at < 0) continue
      const n = parseInt(line.slice(at + 1), 10)
      if (!Number.isFinite(n) || n <= 0) continue
      const file = line.slice(0, at)
      const uuid = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
      if (!uuid) continue
      // A subagent's sibling log lives at `<uuid>/subagents/agent-*.jsonl`, so
      // its hits are folded into the conversation that spawned it rather than
      // reported as a conversation of their own — which is what the parent's
      // collapsed task row means anyway.
      const parent = /\/([0-9a-fA-F-]{36})\/subagents\//.exec(file)?.[1]
      const key = parent ?? uuid
      counts.set(key, (counts.get(key) ?? 0) + n)
    }
    return { ok: true, counts }
  }

  async volumeExists(name: string): Promise<boolean> {
    const r = await this.exec(['volume', 'inspect', name])
    return r.code === 0
  }

  /**
   * Delete conversations by uuid, through a throwaway container.
   *
   * `docker exec` was rejected and this is the load-bearing choice: exec needs
   * the project's container alive, but deleteProject force-removes it in the same
   * handler, and a project sitting stopped — the normal state for one you are
   * deleting because you are done with it — has nothing to exec into. The
   * transcript was never really *in* the container; it is on a named volume any
   * container can mount, so running, stopped and already-destroyed collapse into
   * one path with no branch and no ordering constraint.
   *
   * `-v` rather than `--mount` is legitimate here: that invariant is about a
   * Windows source path's drive-letter colon breaking docker's -v parser, and a
   * named volume has no drive letter. SLIM_IMAGE is guaranteed present wherever a
   * transcript can exist, because FULL_IMAGE is built on top of it.
   *
   * **This is `rm -rf` with interpolated variables, and the safety argument has
   * to sit right here rather than be inferred:** every uuid comes from
   * `randomUUID()` — hex and hyphens, never user input — and the glob names one
   * conversation, so other projects' and claude-box's transcripts are
   * untouchable by construction. A transcript is a *directory*, not a file: the
   * `<uuid>/` half holds `subagents/*.jsonl`, which is where most of the bytes
   * and most of the conversation actually are. The blast radius of getting the
   * interpolation wrong is no longer one file.
   */
  async deleteTranscripts(uuids: string[]): Promise<boolean> {
    // The actual uuid shape, not "36 characters of hex and hyphens" — which also
    // accepted 36 hyphens. Nothing unsafe got through either way (no glob
    // character, no slash, no separator), but this is the one place in the file
    // where a comment is doing the safety work, and the test should say the same
    // thing the comment above does.
    const safe = uuids.filter((u) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u)
    )
    if (safe.length === 0) return true
    if (!(await this.detect())) return false
    // Or `docker run -v` would *create* claude-box-creds on a machine that has
    // never run a container — housekeeping manufacturing the very thing the
    // housekeeping dialog reports.
    if (!(await this.volumeExists(CREDS_VOLUME))) return false
    const paths = safe
      .flatMap((u) => [
        `/home/node/.claude/projects/*/${u}.jsonl`,
        `/home/node/.claude/projects/*/${u}/`
      ])
      .join(' ')
    const r = await this.exec(
      [
        'run',
        '--rm',
        '-v',
        `${CREDS_VOLUME}:/home/node/.claude`,
        SLIM_IMAGE,
        'sh',
        '-c',
        `rm -rf ${paths}`
      ],
      60_000
    )
    // rm -rf exits 0 on a missing path, so a debt whose files are already gone
    // self-clears; anything else leaves the debt intact for the next drain.
    return r.code === 0
  }

  async binaryName(): Promise<string | null> {
    return this.detect()
  }
}
