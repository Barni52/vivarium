import { app } from 'electron'
import { constants, promises as fs, watch } from 'fs'
import { join, dirname } from 'path'
import type { Config, Project } from '@shared/types'

// Single JSON file under %APPDATA%/vivarium/config.json (ref: plan). Runtime
// state (container running?, live ptys) is NOT stored here — it is queried live.
//
// **This file holds the only durable state the app has**, which is what every
// precaution below is paying for: projects, mounts, sessions, the conversation
// uuids the delete cascade owes, and the rewind ranges without which a reopened
// chat renders turns the model has forgotten. Losing it is not "resets to
// defaults", it is losing the record of what the app was ever told.
//
// **It is shared by every running instance** (see main/instance.ts), and that is
// what `mutate` and `watch` are for: each instance keeps this file's contents in
// memory, so a plain write would publish that copy and silently undo whatever a
// sibling had changed since it was taken.

const EMPTY: Config = { version: 1, projects: [] }

/** See O_EXLOCK in main/instance.ts: a lock Windows drops if the holder dies. */
const O_EXLOCK = 0x10000000

/**
 * How long a write queues behind a sibling's before going ahead regardless. A
 * holder is doing one small read and one small write, so this is only ever reached
 * by something being stuck, and then a change on disk beats a change lost.
 */
const LOCK_WAIT_MS = 3_000

/**
 * What a sibling's write has to change before this instance reacts to it. Each
 * instance saves its own window rectangle here, per drag, and telling the renderer
 * about that would redraw the sidebar of one window for moving the other.
 */
function withoutWindows(config: Config): string {
  return JSON.stringify(config, (key, value) =>
    key === 'window' || key === 'instanceWindows' ? undefined : value
  )
}

/** A parsed config, or null when the text is not one. */
function parseConfig(raw: string): Config | null {
  try {
    const parsed = JSON.parse(raw) as Config
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects)) return null
    return parsed
  } catch {
    return null
  }
}

export class ConfigStore {
  private path: string
  /** The previous good version, kept one deep — see `write`. */
  private backupPath: string
  private cache: Config = EMPTY
  /** The text `cache` was parsed from or written as: what a sibling changing it looks like. */
  private text: string | null = null
  /**
   * The cache holds something of a sibling's that `watch` has not reported yet.
   *
   * A flag, because the comparison cannot be made where the report is. A mutate
   * adopts the file before it writes, so when the sibling's change was absorbed by
   * one of the fire-and-forget saves here, the file and the cache already agree by
   * the time the watcher looks, and that change never reached the renderer.
   */
  private unreported = false
  /**
   * Every write, in order.
   *
   * Writes used to run concurrently and share one temp path, which is a way to
   * destroy the file: two `fs.writeFile` calls on `config.json.tmp` open it with
   * independent descriptors, both truncate, and both write from offset zero — so
   * the shorter one finishing second leaves its own head followed by the longer
   * one's tail, and the rename publishes that hybrid as config.json. It was
   * reachable in normal use: five of this app's mutate call sites are
   * fire-and-forget `void store.mutate(...)` from ChatService (the rewind record,
   * the command cache, the mode write, the generated title, the `/clear` id
   * swap), and one turn settling can fire two of them.
   *
   * Serializing also makes the mutator function itself see the latest config
   * rather than a snapshot taken before the write in front of it landed, so two
   * overlapping mutates can no longer lose one another's change.
   */
  private queue: Promise<unknown> = Promise.resolve()
  /** Distinguishes this process's temp files, and each write's from the last. */
  private tmpSeq = 0

  constructor() {
    // app.getPath('userData') resolves to %APPDATA%/vivarium on Windows (the
    // product name), which is exactly where we want config.json.
    this.path = join(app.getPath('userData'), 'config.json')
    this.backupPath = join(app.getPath('userData'), 'config.bak.json')
  }

  get filePath(): string {
    return this.path
  }

  /**
   * Read the config, preferring the backup over starting empty.
   *
   * The three outcomes are deliberately distinct, because they used to be one:
   * any failure at all set the cache to EMPTY, and the *next* mutate then wrote
   * that empty config straight over whatever was on disk. A file that failed to
   * parse — a torn write, a hand-edit with a trailing comma — therefore cost
   * every project the app had, silently, and the app came up looking like a
   * fresh install rather than like something broken.
   *
   * Now nothing is ever written over: an unparseable file is moved aside under a
   * name that says what it is, and the backup written before the last good save
   * is tried before giving up. Recovery in the worst case is a rename by hand,
   * and in the common case is automatic.
   */
  async load(): Promise<Config> {
    let raw: string | null = null
    try {
      raw = await fs.readFile(this.path, 'utf-8')
    } catch {
      // No file: a first run, or a userData dir that was cleared. There is
      // nothing to preserve, so this is not the corrupt path — fall through to
      // the backup, which covers "config.json was deleted but we had one".
    }

    if (raw !== null) {
      const parsed = parseConfig(raw)
      if (parsed) {
        this.cache = parsed
        this.text = raw
        return this.cache
      }
      // Present and unreadable. Moved rather than overwritten: it is the only
      // copy of everything except whatever the backup happens to hold.
      await fs.rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => {})
    }

    const backup = await fs.readFile(this.backupPath, 'utf-8').catch(() => null)
    const recovered = backup === null ? null : parseConfig(backup)
    this.cache = recovered ?? EMPTY
    return this.cache
  }

  get(): Config {
    return this.cache
  }

  getProject(id: string): Project | undefined {
    return this.cache.projects.find((p) => p.id === id)
  }

  async mutate(fn: (config: Config) => Config): Promise<Config> {
    // The mutator runs *inside* the queue, so it clones a cache that already
    // includes every write ahead of it. Running it at call time (as this used
    // to) means two overlapping mutates both branch off the same base and the
    // second one's write drops the first one's change.
    //
    // The lock and the re-read are that same argument one level out. The queue
    // orders this process's writes, and a sibling instance has a queue of its own,
    // so the base has to be the file rather than the cache, read while nobody else
    // can be writing it. A mutator is a function for exactly this reason: it can be
    // applied to a config nobody had when it was written.
    return this.enqueue(() =>
      this.locked(async () => {
        await this.adoptDisk()
        const next = fn(structuredClone(this.cache))
        await this.write(next)
        return next
      })
    )
  }

  /**
   * Tell `onChange` when a sibling instance changes the file.
   *
   * The directory rather than the file, because every write here is a rename
   * *over* config.json and a watch on the file itself would stay on the replaced
   * one. This instance's own writes come through as well, which is how a change
   * absorbed by one of them gets reported (see `unreported`), and otherwise find
   * the text they just wrote. In the queue so that it can never land between a
   * mutate's re-read and its write.
   */
  watch(onChange: (config: Config) => void): void {
    const name = 'config.json'
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      watch(dirname(this.path), (_event, file) => {
        if (file && file !== name) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          void this.enqueue(async () => {
            await this.adoptDisk()
            if (!this.unreported) return
            this.unreported = false
            onChange(this.cache)
          })
        }, 80)
      })
    } catch {
      /* the windows simply stop agreeing until the next launch */
    }
  }

  /**
   * Replace the cache with the file, if the file differs. A file that does not
   * parse is ignored: `load` deals with that, and it is no reason to discard a
   * working copy halfway through a write.
   */
  private async adoptDisk(): Promise<void> {
    const raw = await fs.readFile(this.path, 'utf-8').catch(() => null)
    if (raw === null || raw === this.text) return
    const parsed = parseConfig(raw)
    if (!parsed) return
    if (withoutWindows(parsed) !== withoutWindows(this.cache)) this.unreported = true
    this.cache = parsed
    this.text = raw
  }

  /** Run `op` holding the lock every instance writes under. */
  private async locked<T>(op: () => Promise<T>): Promise<T> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    const flags = constants.O_RDWR | constants.O_CREAT | O_EXLOCK
    const giveUp = Date.now() + LOCK_WAIT_MS
    let lock: fs.FileHandle | null = null
    while (!lock) {
      try {
        lock = await fs.open(`${this.path}.lock`, flags)
      } catch {
        if (Date.now() > giveUp) break
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    try {
      return await op()
    } finally {
      await lock?.close().catch(() => {})
    }
  }

  /** Run `op` after every write already queued, whether those succeeded or not. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    // The chain itself must never carry a rejection forward, or one failed write
    // poisons every write after it. The caller still sees its own failure —
    // that is `run`, which is what is returned.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async write(config: Config): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    // One version back, refreshed before each save. Best-effort: a failed copy
    // costs the *next* recovery, never this write, and on the very first save
    // there is nothing to copy.
    await fs.copyFile(this.path, this.backupPath).catch(() => {})
    // Unique per write. The queue above already makes two concurrent writes
    // impossible within one process; the suffix is what stops a second app
    // instance — which has its own queue and knows nothing about ours — from
    // resurrecting the interleaving through a shared path.
    const tmp = `${this.path}.${process.pid}.${this.tmpSeq++}.tmp`
    const text = JSON.stringify(config, null, 2)
    try {
      // Atomic publish: write the whole document to a temp file, then rename it
      // over the real one, so a crash mid-write leaves config.json untouched.
      await fs.writeFile(tmp, text, 'utf-8')
      await fs.rename(tmp, this.path)
      // **After** the rename, never before it. The cache is what every later
      // `get`, `getProject` and `mutate` clone reads, so adopting a config the
      // disk refused — a locked file (OneDrive or antivirus holding config.json
      // open is routine on Windows), a permission error, a full disk — leaves
      // the process reporting state that exists nowhere else. Five of the
      // mutate call sites are fire-and-forget `void store.mutate(...)`, so
      // nothing would notice at the time, and the next launch would read back a
      // config missing changes the UI had already treated as saved. Failing
      // means the change is lost now, loudly and to the caller, rather than
      // quietly at the next start.
      this.cache = config
      this.text = text
    } catch (err) {
      // A temp file left behind would never be cleaned up by anything else, and
      // it sits next to the config in the user's own AppData folder.
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
}
