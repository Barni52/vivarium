import { app } from 'electron'
import { promises as fs } from 'fs'
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

const EMPTY: Config = { version: 1, projects: [] }

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

  async save(config: Config): Promise<void> {
    await this.enqueue(async () => {
      await this.write(config)
    })
  }

  async mutate(fn: (config: Config) => Config): Promise<Config> {
    // The mutator runs *inside* the queue, so it clones a cache that already
    // includes every write ahead of it. Running it at call time (as this used
    // to) means two overlapping mutates both branch off the same base and the
    // second one's write drops the first one's change.
    return this.enqueue(async () => {
      const next = fn(structuredClone(this.cache))
      await this.write(next)
      return next
    })
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
    this.cache = config
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
    try {
      // Atomic publish: write the whole document to a temp file, then rename it
      // over the real one, so a crash mid-write leaves config.json untouched.
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8')
      await fs.rename(tmp, this.path)
    } catch (err) {
      // A temp file left behind would never be cleaned up by anything else, and
      // it sits next to the config in the user's own AppData folder.
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
}
