import { app } from 'electron'
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { basename, join } from 'node:path'

// Several Vivariums at once, which is what developing Vivarium in Vivarium comes
// to: the one you work in, and the build you just made, side by side.
//
// **`userData` is shared and `sessionData` is not.** Those are two different
// directories to Electron, which only look like one because the second defaults
// to the first. What this app owns (config.json, bridge/, clip/) is the same for
// every instance, so every window shows the same projects and chats. What
// Chromium owns (caches, localStorage, network state) cannot be shared at all:
// measured on 31.7.7, a second process on one profile takes 6.1s to its first
// frame instead of 0.2s, logs `Unable to move the cache: Access is denied` and
// `Gpu Cache Creation failed: -2`, and gets a localStorage that reads back empty
// — which here means losing the theme. With its own sessionData the same launch
// is 0.2s with nothing in the log.
//
// **Slot 0 is the root directory, unchanged.** A lone instance is exactly what it
// always was, on the profile it has always had. Extra instances take the lowest
// free slot, and a slot's folder is kept, so its caches are warm the next time.

/**
 * libuv's `UV_FS_O_EXLOCK`: open with a share mode of zero. Node has no constant
 * for it on Windows, and it is the only file lock Node can reach synchronously.
 *
 * It is what makes every lock in this file need no cleanup. Windows drops it with
 * the handle, so a crash or a Task Manager kill leaves nothing behind to go stale
 * (no pid to check, no reuse to fear), and children do not inherit it: an agent
 * spawned from this process cannot keep the slot alive after the app has gone.
 */
const O_EXLOCK = 0x10000000

/** Far more windows than anyone wants, and a bound on the port range. */
const MAX_SLOTS = 32

const LOCK_FILE = 'instance.lock'

let slot = 0

/** Which instance this is: 0 for the first, and also for a lone one. */
export function instanceSlot(): number {
  return slot
}

function instancesRoot(): string {
  return join(app.getPath('userData'), 'instances')
}

function slotDir(n: number): string {
  return n === 0 ? app.getPath('userData') : join(instancesRoot(), String(n))
}

function isBusy(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'EBUSY'
}

/**
 * Is something holding this file open, in any mode at all? Answered by asking
 * for it exclusively and letting go: EBUSY is the only "yes", and a file that
 * does not exist is a "no".
 */
function held(file: string): boolean {
  try {
    closeSync(openSync(file, constants.O_RDONLY | O_EXLOCK))
    return false
  } catch (e) {
    return isBusy(e)
  }
}

/**
 * A running Chromium on this profile, whichever build it is.
 *
 * What makes a build that predates slots visible: it takes no lock of ours, but
 * LevelDB keeps this file open for as long as the profile is. Without the check,
 * the first launch of a new build beside an installed old one would claim slot 0
 * and recreate the very collision this module exists to end. Only ever asked of
 * another process's profile, since from inside the app the answer is always yes.
 */
function profileInUse(dir: string): boolean {
  return held(join(dir, 'Local Storage', 'leveldb', 'LOCK'))
}

/**
 * Carry the theme into a slot the first time it is used.
 *
 * The theme lives in the renderer's localStorage and is resolved before any module
 * loads (see renderer/index.html), so a new profile would open on the default
 * until someone noticed. Copying the folder rather than teaching main the
 * theme: `LOCK` is the only file a running Chromium denies, and a torn last
 * record is something LevelDB recovers from by dropping it. Only once, so a window
 * can then keep a theme of its own, which is a useful way to tell two apart.
 * Best-effort: the failure is a default theme.
 */
function seedLocalStorage(dir: string): void {
  const from = join(app.getPath('userData'), 'Local Storage')
  const to = join(dir, 'Local Storage')
  if (existsSync(to) || !existsSync(from)) return
  try {
    cpSync(from, to, { recursive: true, filter: (src) => basename(src) !== 'LOCK' })
  } catch {
    /* see above */
  }
}

/**
 * Take the lowest free slot and point Chromium at its folder.
 *
 * **Has to run before `ready`**, the last moment sessionData can move, and it is
 * synchronous for that reason: `net.Server` on a named pipe would be the other way
 * to get an OS-released lock, and it would finish after the profile had opened.
 *
 * Not `app.requestSingleInstanceLock()`, which looks like the tool for this. It is
 * keyed on the app's *name* as well as the directory, and a dev run is `vivarium`
 * where a packaged one is `Vivarium`, so the two builds this exists for would not
 * see each other.
 *
 * Any failure here leaves slot 0, which is how the app behaved before there were
 * slots: a lock that cannot be taken must never be why a window does not open.
 */
export function claimInstance(): number {
  try {
    for (let n = 0; n < MAX_SLOTS; n++) {
      const dir = slotDir(n)
      mkdirSync(dir, { recursive: true })
      let fd: number
      try {
        fd = openSync(join(dir, LOCK_FILE), constants.O_RDWR | constants.O_CREAT | O_EXLOCK)
      } catch (e) {
        if (isBusy(e)) continue
        throw e
      }
      if (n === 0 && profileInUse(dir)) {
        closeSync(fd)
        continue
      }
      // `fd` is deliberately never closed: that open descriptor *is* the claim,
      // and a numeric one is not garbage collected. It ends with the process.
      slot = n
      if (n > 0) {
        seedLocalStorage(dir)
        app.setPath('sessionData', dir)
      }
      return n
    }
  } catch {
    /* see above */
  }
  return slot
}

/**
 * Is any other instance running right now?
 *
 * For the few launch-time steps whose reasoning was "nothing can be alive at this
 * moment", which is only true of the whole machine if this is the only instance.
 */
export function otherInstancesRunning(): boolean {
  if (slot !== 0) {
    const root = slotDir(0)
    if (held(join(root, LOCK_FILE)) || profileInUse(root)) return true
  }
  let names: string[]
  try {
    names = readdirSync(instancesRoot())
  } catch {
    return false
  }
  return names.some(
    (name) => /^\d+$/.test(name) && Number(name) !== slot && held(join(slotDir(Number(name)), LOCK_FILE))
  )
}

/** A pid still running. Asked with signal 0, which delivers nothing. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM is a process that exists and is not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Which instance is running which conversation.
 *
 * **One conversation, one process.** Sessions open themselves as soon as they can
 * (see CLAUDE.md), so without this a second window would `--resume` every chat and
 * agent the first one already has: double the processes, and two CLIs each holding
 * their own copy of a conversation in memory, so that answering in one window
 * forks the transcript under the other. Every window still *shows* every chat. A
 * chat held elsewhere is read from its transcript with no process behind it, and
 * "Move here" hands it over. Shells have no conversation and are never leased.
 *
 * A lease is a file named for the session, holding the holder's pid, and all
 * coordination is the shared directory: taking one over is rewriting the file, and
 * the holder lets go when its watcher sees that. So there is no channel between
 * instances to authenticate or to keep alive, and no peer to wait on when it is
 * gone. A pid can be stale, unlike the slot lock, because these are created and
 * dropped per session, far too often to hold a handle for each. The worst a reused
 * pid does is show a free chat as held, with "Move here" one click away.
 *
 * The session id is a filename, so every caller has found it in config first.
 */
export class SessionLeases {
  private dir = join(instancesRoot(), 'held')
  private mine = new Set<string>()
  private others = new Set<string>()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    /** another instance took this one: its process has to go */
    private onLost: (sessionId: string) => void,
    /** whether a session is held by another instance changed */
    private onHeld: (sessionId: string, held: boolean) => void
  ) {}

  start(): void {
    mkdirSync(this.dir, { recursive: true })
    this.scan()
    try {
      this.watcher = watch(this.dir, () => {
        // Coalesced because one launch claims every session at once.
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => this.scan(), 60)
      })
    } catch {
      this.watcher = null
    }
  }

  private file(sessionId: string): string {
    return join(this.dir, sessionId)
  }

  /** The pid in a lease; 0 when it is unreadable, empty or gone. */
  private holder(sessionId: string): number {
    try {
      return Number(readFileSync(this.file(sessionId), 'utf8')) || 0
    } catch {
      return 0
    }
  }

  /**
   * Hold this session, unless a running instance does. An empty file reads as
   * free: that is a claim in the microseconds before its write, and if two
   * instances do both get here, whichever write lands second wins and the
   * other's next `scan` finds it lost.
   */
  claim(sessionId: string): boolean {
    try {
      writeFileSync(this.file(sessionId), String(process.pid), { flag: 'wx' })
      this.mine.add(sessionId)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return true // never a reason not to open
    }
    const pid = this.holder(sessionId)
    if (pid === process.pid) {
      this.mine.add(sessionId)
      return true
    }
    if (pid && alive(pid)) {
      this.others.add(sessionId)
      return false
    }
    this.take(sessionId)
    return true
  }

  /** Hold this session whoever does now. The holder's watcher does the rest. */
  take(sessionId: string): void {
    try {
      writeFileSync(this.file(sessionId), String(process.pid))
    } catch {
      /* a lease that cannot be written is a lease nobody else can see either */
    }
    this.others.delete(sessionId)
    this.mine.add(sessionId)
  }

  release(sessionId: string): void {
    if (!this.mine.delete(sessionId)) return
    if (this.holder(sessionId) !== process.pid) return
    rmSync(this.file(sessionId), { force: true })
  }

  /** On quit. Removed rather than left to go stale, so a sibling hears about it. */
  releaseAll(): void {
    for (const id of [...this.mine]) this.release(id)
    this.watcher?.close()
    this.watcher = null
  }

  /**
   * Bring what this instance believes up to date with the directory.
   *
   * Reads every lease, which are a few bytes each and a few dozen at most, and
   * only ever after one of them changed. A lease whose pid has died is removed here
   * as well as being free to claim, so a crash does not leave its chats reading as
   * held. Nothing in the directory outlives this as anything but a filename.
   */
  private scan(): void {
    const next = new Set<string>()
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const id of names) {
      const pid = this.holder(id)
      if (!pid || pid === process.pid) continue
      if (alive(pid)) next.add(id)
      else rmSync(this.file(id), { force: true })
    }
    for (const id of [...this.mine]) {
      if (!next.has(id)) continue
      this.mine.delete(id)
      this.onLost(id)
    }
    for (const id of next) if (!this.others.has(id)) this.onHeld(id, true)
    for (const id of this.others) if (!next.has(id)) this.onHeld(id, false)
    this.others = next
  }
}
