import { app, ipcMain, dialog, BrowserWindow, clipboard, shell, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, mkdir, stat } from 'node:fs/promises'
import { join, resolve, sep, extname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '@shared/ipc'
import type {
  AppInfo,
  BadgePayload,
  ChatAnswer,
  ChatAttachment,
  ChatEntry,
  ChatEvent,
  ChatMode,
  ChatModelOption,
  ChatOpenResult,
  ChatRewindResult,
  ClaudeStatus,
  ClaudeUpdateResult,
  Config,
  ContainerState,
  DiffResult,
  DockerStatus,
  MountNode,
  NewProjectInput,
  OutputNode,
  Project,
  SessionType,
  SpawnResult,
  TranscriptHit,
  TranscriptSearchResult,
  UpdateProjectInput,
  VolumeRemoveResult,
  VolumeReport
} from '@shared/types'
import { ConfigStore } from './config'
import { DockerService } from './docker'
import { BridgeWatcher, bridgeDir } from './bridge'
import { ChatService } from './chat'
import { gitBranch, writeBranchDiff } from './git'
import { PtyManager } from './pty'
import { pasteImage, removeClips } from './clipboard'
import { UsageService } from './usage'
import { ClaudeService } from './claude'

/**
 * What a new chat is spawned on, until someone picks something else.
 *
 * Hardcoded, and deliberately not a project setting: this is a single-user tool
 * whose answer to "which model" is the same in every project, and a per-project
 * default would be a persisted `Config` field, a control in Project settings and
 * a second place a session's model can come from — all to express one line.
 *
 * The **pinned id, not the `opus` alias**: an alias moves with each release, and
 * a default that silently becomes the next generation is not a default anybody
 * chose. `Session.model` holds what `--model` is given at the next spawn (see
 * DockerService.execArgs), so this is that spelling and not a display name.
 * Changing a session's model in the picker overwrites it and nothing here
 * reaches back in — this seeds, it does not enforce.
 */
const DEFAULT_CHAT_MODEL = 'claude-opus-5'

/**
 * `store` is passed in rather than made here: main/index.ts reads the saved
 * window size out of it before `new BrowserWindow`, so by the time this runs the
 * one store already exists and is loaded. Two instances would be two caches over
 * one file, each overwriting the other's writes.
 */
export function registerIpc(win: BrowserWindow, store: ConfigStore): void {
  const docker = new DockerService()
  const emit = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const pty = new PtyManager(docker, emit)
  const usage = new UsageService(docker)
  const claude = new ClaudeService(docker)
  // A freshly created container is born with whatever Claude Code the cached
  // image was built around, which is as old as the image. This is the one thing
  // docker needs from the registry to fix that, handed down rather than
  // imported so the dependency between the two services keeps pointing one way
  // (see DockerService.freshenClaude).
  docker.setClaudeLatest(() => claude.latestVersion())

  // ---- chat sessions ------------------------------------------------------
  // One CLI process per chat session (see main/chat.ts). Its four callbacks are
  // the things only this module can do: persist, and reach the title bar.
  const chat = new ChatService(
    docker,
    (e: ChatEvent) => emit(CH.chatEvent, e),
    (e) => emit(CH.agentActivity, e),
    (sessionId, next, previous) => {
      // `/clear` is forwarded verbatim like any other command and *handled*, not
      // intercepted: the outgoing id is retired onto the session rather than
      // deleted, so an accidental /clear stays recoverable through Claude's own
      // --resume picker, and the delete cascade later takes the whole chain.
      void store.mutate((cfg) => {
        for (const p of cfg.projects) {
          const s = p.sessions.find((x) => x.id === sessionId)
          if (!s) continue
          s.previousClaudeSessionIds = [...(s.previousClaudeSessionIds ?? []), previous]
          s.claudeSessionId = next
        }
        return cfg
      })
    },
    (sessionId, ranges) => {
      // The transcript stretches a revert abandoned. Claude Code leaves them in
      // the file (a rewind moves a branch pointer, it does not truncate), so
      // without this record the next whole-file read renders turns the model has
      // forgotten. Written whole rather than appended: ChatService merges, so
      // config never has to know how two overlapping reverts combine.
      void store.mutate((cfg) => {
        for (const p of cfg.projects) {
          const s = p.sessions.find((x) => x.id === sessionId)
          if (s) s.rewound = ranges.length > 0 ? ranges : undefined
        }
        return cfg
      })
    },
    (projectId, commands) => {
      void store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (p) p.slashCommands = commands
        return cfg
      })
    },
    (sessionId, mode) => {
      // The same persistence chatSetMode performs, for a mode change that did not
      // come from the toggle: approving a plan leaves plan mode, and this record is
      // what every later spawn restores the session to, so a reopen has to agree
      // with the header rather than plan all over again.
      void store.mutate((cfg) => {
        for (const p of cfg.projects) {
          const s = p.sessions.find((x) => x.id === sessionId)
          if (s) s.mode = mode
        }
        return cfg
      })
    },
    (sessionId, name) => {
      // A name the chat generated for itself. `autoName` rides with it in the
      // same mutate — the two are one fact ("this was written by the app"), and
      // a name persisted without its flag would be indistinguishable from one
      // the user typed the moment the app restarts.
      void store
        .mutate((cfg) => {
          for (const p of cfg.projects) {
            const s = p.sessions.find((x) => x.id === sessionId)
            if (!s) continue
            s.name = name
            s.autoName = true
          }
          return cfg
        })
        // The only config change that pushes: the renderer did not ask for this
        // one, so it cannot adopt a return value.
        .then((cfg) => emit(CH.sessionRenamed, cfg))
    },
    (five, seven) => usage.applyStreamLimits(five, seven)
  )
  ;(win as unknown as { __chat?: ChatService }).__chat = chat

  // ---- claude plan usage --------------------------------------------------
  // Polled by the renderer (TitleBar chips); all token/HTTP logic lives in
  // UsageService.
  ipcMain.handle(CH.fetchUsage, () => usage.fetch())

  // ---- claude code version / manual update -------------------------------
  // Updates are user-initiated only (no auto-updater): status feeds the
  // title-bar version chip, update runs npm inside one project's container.
  ipcMain.handle(CH.claudeStatus, (_e, force: boolean): Promise<ClaudeStatus> =>
    claude.status(store.get().projects, force)
  )

  ipcMain.handle(CH.claudeUpdate, async (_e, projectId: string): Promise<ClaudeUpdateResult> => {
    const p = store.getProject(projectId)
    if (!p) return { ok: false, version: null, message: 'project not found' }
    const r = await claude.update(p)
    // The model list is whatever *that* CLI reported, and it has just been
    // replaced — so the cache for this project is dropped rather than left to
    // offer the old version's models until the app restarts.
    if (r.ok) chat.forgetModels(projectId)
    return r
  })

  // Expose the pty manager for app-quit cleanup.
  ;(win as unknown as { __pty?: PtyManager }).__pty = pty

  // ---- agent hook bridge --------------------------------------------------
  // One watcher per project tails its bridge events.log (see bridge.ts) and
  // forwards the *state* it derives from Claude Code's hooks. Chat sessions
  // reach the same channel from the other producer (ChatService above), which is
  // why hook vocabulary no longer crosses IPC at all.
  const bridges = new Map<string, BridgeWatcher>()

  function syncBridgeWatchers(): void {
    const ids = new Set(store.get().projects.map((p) => p.id))
    for (const [id, w] of bridges) {
      if (!ids.has(id)) {
        w.close()
        bridges.delete(id)
      }
    }
    for (const id of ids) {
      if (!bridges.has(id)) {
        const w = new BridgeWatcher(bridgeDir(id), (e) => emit(CH.agentActivity, e))
        bridges.set(id, w)
        void w.start()
      }
    }
  }

  // ---- the transcript delete debt ----------------------------------------
  // Delete means delete: a chat session's conversation goes with it, and so does
  // every id its /clear calls retired. The list is the *mechanism*, not an error
  // handler — every delete records its uuids in the same atomic mutate that
  // removes the session, then kicks a drain. There is no success path and no
  // failure path, just "the debt is recorded" followed by "the debt is paid",
  // where the fast case is a drain that runs immediately and succeeds.
  //
  // Chosen over try-then-enqueue-on-failure because in that shape "the session is
  // gone" and "we owe its transcript" are two separate durable facts with a
  // window between them: the config write lands, the app dies before the docker
  // run returns, and the transcript is stranded with no record that anyone ever
  // meant to delete it — precisely the state this list exists to make impossible.
  function conversationIds(project: Project | undefined, sessionId?: string): string[] {
    const out: string[] = []
    for (const s of project?.sessions ?? []) {
      if (sessionId && s.id !== sessionId) continue
      // Terminal `agent` sessions are out of scope and keep stranding transcripts
      // exactly as they do today; shell sessions never own a conversation at all.
      if (s.type !== 'chat') continue
      if (s.claudeSessionId) out.push(s.claudeSessionId)
      out.push(...(s.previousClaudeSessionIds ?? []))
    }
    return out
  }

  let draining = false
  /**
   * Pay the debt. Runs at app launch and after each successful container start —
   * the two moments the daemon is proven up, with no new timer. Piggybacking the
   * 3s container poll was rejected: `isRunning` is documented as reporting false
   * for any non-zero exit, and hanging file deletion off a signal the codebase
   * calls unreliable is asking for it.
   *
   * One container for the whole drain, and the uuids are dropped **only on exit
   * 0**, so a failed drain leaves the debt intact. `rm -rf` exits 0 on a missing
   * path, so a debt whose files are already gone self-clears.
   */
  async function drainTranscriptDeletes(): Promise<void> {
    if (draining) return
    const owed = store.get().pendingTranscriptDeletes ?? []
    if (owed.length === 0) return
    draining = true
    try {
      if (!(await docker.deleteTranscripts(owed))) return
      await store.mutate((cfg) => {
        cfg.pendingTranscriptDeletes = (cfg.pendingTranscriptDeletes ?? []).filter(
          (id) => !owed.includes(id)
        )
        if (cfg.pendingTranscriptDeletes.length === 0) delete cfg.pendingTranscriptDeletes
        return cfg
      })
    } finally {
      draining = false
    }
  }

  // ---- config / projects / sessions -------------------------------------
  ipcMain.handle(CH.loadConfig, async (): Promise<Config> => {
    const cfg = await store.load()
    // Backfill: give any pre-existing agent session (created before the
    // resume feature) a pinned Claude conversation id so it too gets
    // resume-on-reopen from now on. Persist only if something changed.
    let changed = false
    for (const p of cfg.projects) {
      for (const s of p.sessions) {
        if (s.type === 'agent' && !s.claudeSessionId) {
          s.claudeSessionId = randomUUID()
          changed = true
        }
      }
    }
    if (changed) await store.save(cfg)
    // Apply the persisted shared output folder to docker + start watching it.
    docker.setSharedOutput(cfg.sharedOutputFolder)
    startOutputWatcher()
    syncBridgeWatchers()
    // App launch is one of the two moments Docker is proven up (see the debt list).
    void drainTranscriptDeletes()
    return cfg
  })

  ipcMain.handle(CH.createProject, async (_e, input: NewProjectInput): Promise<Config> => {
    const id = randomUUID()
    const cfg = await store.mutate((cfg) => {
      cfg.projects.push({
        id,
        name: input.name.trim() || 'untitled-project',
        basePath: input.basePath,
        mounts: input.mounts,
        image: input.image,
        publishedPort: input.publishedPort,
        sessions: []
      })
      return cfg
    })
    syncBridgeWatchers()
    return cfg
  })

  ipcMain.handle(CH.updateProject, async (_e, input: UpdateProjectInput): Promise<Config> => {
    const project = store.getProject(input.id)
    const running = project ? await docker.isRunning(project) : false
    return store.mutate((cfg) => {
      const p = cfg.projects.find((x) => x.id === input.id)
      if (!p) return cfg
      p.name = input.name.trim() || p.name
      p.basePath = input.basePath
      p.image = input.image
      p.publishedPort = input.publishedPort
      // Mounts may only change while the container is stopped.
      if (!running) p.mounts = input.mounts
      return cfg
    })
  })

  ipcMain.handle(CH.deleteProject, async (_e, id: string): Promise<Config> => {
    const project = store.getProject(id)
    // Deleting a project cascades to every chat session it holds. Without this the
    // larger, more destructive gesture would be the leakier one — the way to
    // *keep* a conversation would be to delete the whole project.
    const owed = conversationIds(project)
    if (project) {
      for (const s of project.sessions) {
        pty.kill(s.id)
        chat.close(s.id)
      }
      await docker.remove(project)
      // The container is gone, so nothing can read /clip any more — and nothing
      // will ever name this directory again, since it is keyed by a project id
      // that is about to leave config.json. The same cascade the conversations
      // get, for the same reason.
      await removeClips(id)
    }
    const cfg = await store.mutate((cfg) => {
      cfg.projects = cfg.projects.filter((p) => p.id !== id)
      // Enqueued inside the mutate that removes the project, so this cannot race
      // the `docker rm -f` above: a config write and a container removal are
      // different things entirely.
      if (owed.length) {
        cfg.pendingTranscriptDeletes = [...(cfg.pendingTranscriptDeletes ?? []), ...owed]
      }
      return cfg
    })
    syncBridgeWatchers()
    void drainTranscriptDeletes()
    return cfg
  })

  ipcMain.handle(
    CH.addSession,
    async (_e, projectId: string, type: SessionType, name: string): Promise<Config> => {
      const id = randomUUID()
      // Both agent kinds get a second UUID pinned as Claude Code's conversation id
      // so the conversation can be resumed across container/app restarts (see
      // Session.claudeSessionId + docker.execArgs). Shell sessions have no
      // conversation to resume, so they don't get one.
      const owns = type === 'agent' || type === 'chat'
      const claudeSessionId = owns ? randomUUID() : undefined
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (p) {
          p.sessions.push({
            id,
            name,
            type,
            claudeSessionId,
            // A new chat starts in bypass, matching today's terminal agent:
            // nothing in daily use gets slower and no habit needs retraining.
            mode: type === 'chat' ? 'bypassPermissions' : undefined,
            // …and on a model of this app's choosing rather than the CLI's. Chat
            // only, for the same reason `mode` is: nothing reads `Session.model`
            // for a terminal agent — that one is `--model`-less on purpose and
            // takes its model from the CLI's own config and its own `/model` —
            // so writing one there would be a stored preference with no effect.
            model: type === 'chat' ? DEFAULT_CHAT_MODEL : undefined
          })
        }
        return cfg
      })
    }
  )

  ipcMain.handle(
    CH.renameSession,
    async (_e, projectId: string, sessionId: string, name: string): Promise<Config> => {
      const next = name.trim()
      // A human named it, so the chat auto-titler is done with this session for
      // good (see Session.autoName). Told to the live ChatService as well as
      // written to config, because its `l.session` is a snapshot from open time
      // and a title generated against a stale copy would land on top of the name
      // just typed.
      if (next) chat.manualRename(sessionId, next)
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        const s = p?.sessions.find((x) => x.id === sessionId)
        if (s && next) {
          s.name = next
          delete s.autoName
        }
        return cfg
      })
    }
  )

  ipcMain.handle(
    CH.removeSession,
    async (_e, projectId: string, sessionId: string): Promise<Config> => {
      pty.kill(sessionId)
      chat.close(sessionId)
      const owed = conversationIds(store.getProject(projectId), sessionId)
      const cfg = await store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (p) p.sessions = p.sessions.filter((s) => s.id !== sessionId)
        if (owed.length) {
          cfg.pendingTranscriptDeletes = [...(cfg.pendingTranscriptDeletes ?? []), ...owed]
        }
        return cfg
      })
      void drainTranscriptDeletes()
      return cfg
    }
  )

  // Clamped here as well as in the store, because config.json is a text file a
  // user can edit and a bad number would be read back at every launch. Returns
  // nothing: the renderer already holds the value it just set, and handing back
  // a whole Config for a zoom step would have the renderer replace its projects
  // list on every notch of the mouse wheel.
  ipcMain.handle(CH.setChatZoom, async (_e, value: number): Promise<void> => {
    const z = Math.max(0.7, Math.min(2.2, Number(value) || 1))
    await store.mutate((cfg) => {
      cfg.chatZoom = z
      return cfg
    })
  })

  ipcMain.handle(CH.reorderProjects, async (_e, orderedIds: string[]): Promise<Config> => {
    return store.mutate((cfg) => {
      const byId = new Map(cfg.projects.map((p) => [p.id, p]))
      const reordered = orderedIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
      // keep any projects not present in the ordered list (safety) appended in original order
      for (const p of cfg.projects) if (!orderedIds.includes(p.id)) reordered.push(p)
      cfg.projects = reordered
      return cfg
    })
  })

  ipcMain.handle(
    CH.reorderSessions,
    async (_e, projectId: string, orderedSessionIds: string[]): Promise<Config> => {
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (!p) return cfg
        const byId = new Map(p.sessions.map((s) => [s.id, s]))
        const reordered = orderedSessionIds
          .map((id) => byId.get(id))
          .filter((s): s is NonNullable<typeof s> => !!s)
        for (const s of p.sessions) if (!orderedSessionIds.includes(s.id)) reordered.push(s)
        p.sessions = reordered
        return cfg
      })
    }
  )

  /**
   * Move a session to another project (sidebar drag). `index` is the insertion
   * point in the target's session list; -1 or out of range appends.
   *
   * The pty cannot follow the session — for a container session it is a `docker
   * exec` client bound to the old container, for a host shell a pwsh rooted at the
   * old basePath — so it is killed here and the renderer reopens against the new
   * project (see TerminalHost's project-scoped key). Silently, because the kill
   * happens *before* the config rewrite below and the exit would otherwise land on
   * the replacement terminal (see PtyManager.kill).
   *
   * An agent's conversation survives untouched, with no transfer step:
   * claudeSessionId travels on the Session object, /home/node/.claude is the same
   * claude-box-creds volume in every container, and every agent execs with
   * -w /workspace, so the transcript path is identical from the new container and
   * execArgs picks --resume there. What does change — the point of the feature — is
   * which mounts sit under /workspace, so file paths from earlier in the
   * conversation may not exist anymore; the confirm dialog says so.
   */
  ipcMain.handle(
    CH.moveSession,
    async (
      _e,
      fromProjectId: string,
      toProjectId: string,
      sessionId: string,
      index: number
    ): Promise<Config> => {
      // Validate before killing anything — a call that can't move the session
      // must not end its pty either.
      const src = store.getProject(fromProjectId)
      if (
        fromProjectId === toProjectId ||
        !src?.sessions.some((s) => s.id === sessionId) ||
        !store.getProject(toProjectId)
      ) {
        return store.get()
      }
      pty.kill(sessionId, true)
      // A chat's process is a `docker exec -i` client bound to the old container,
      // so it dies exactly as a pty does and for the same reason. Everything else
      // transfers for free and *better* than the terminal case: the transcript
      // slug is identical in every container and the transcript is the model, so
      // the remounted chat re-reads it and shows an identical log, where a
      // terminal agent's move drops its scrollback. What does not survive is the
      // composer — the draft text and every pending chip — and the confirm dialog
      // says so.
      chat.close(sessionId)
      return store.mutate((cfg) => {
        const from = cfg.projects.find((x) => x.id === fromProjectId)
        const to = cfg.projects.find((x) => x.id === toProjectId)
        if (!from || !to || from === to) return cfg
        const i = from.sessions.findIndex((s) => s.id === sessionId)
        if (i < 0) return cfg
        const [session] = from.sessions.splice(i, 1)
        const at = index < 0 || index > to.sessions.length ? to.sessions.length : index
        to.sessions.splice(at, 0, session)
        return cfg
      })
    }
  )

  // ---- git ---------------------------------------------------------------
  ipcMain.handle(CH.projectBranches, async (): Promise<Record<string, string | null>> => {
    const out: Record<string, string | null> = {}
    for (const p of store.get().projects) out[p.id] = gitBranch(p.basePath)
    return out
  })

  ipcMain.handle(CH.projectDiff, async (_e, projectId: string): Promise<DiffResult> => {
    const cfg = store.get()
    const p = cfg.projects.find((x) => x.id === projectId)
    if (!p) return { ok: false, message: 'not-found' }
    if (!cfg.sharedOutputFolder) return { ok: false, message: 'no-output' }
    return writeBranchDiff(p, cfg.sharedOutputFolder, cfg.diffBase || 'origin/master')
  })

  ipcMain.handle(CH.setDiffBase, async (_e, value: string): Promise<Config> => {
    return store.mutate((cfg) => {
      cfg.diffBase = value.trim() || undefined
      return cfg
    })
  })

  // ---- docker / containers ----------------------------------------------
  ipcMain.handle(CH.dockerStatus, async (): Promise<DockerStatus> => {
    const bin = await docker.binaryName()
    return {
      available: !!bin,
      binary: bin,
      message: bin ? undefined : 'docker not found on PATH — start Docker/Rancher Desktop'
    }
  })

  // ---- volume housekeeping ------------------------------------------------
  // Nothing else in the app ever removes a volume, so this is the only place
  // the shadow build caches (and any leftovers from older naming) can be seen
  // or reclaimed. Ownership is derived from the current projects' mounts —
  // whatever doesn't match is orphaned.
  ipcMain.handle(CH.volumes, (): Promise<VolumeReport> => docker.listVolumes(store.get().projects))

  ipcMain.handle(
    CH.removeVolume,
    (_e, name: string): Promise<VolumeRemoveResult> => docker.removeVolume(name)
  )

  // One `docker ps -a` for every project, rather than two `docker inspect` each.
  // The renderer polls this every 3 seconds, and the per-project pair was 2N
  // process launches per tick — the same burst OPEN_LIMIT exists to meter, since
  // a loaded daemon answers `docker inspect` non-zero and isRunning() reads that
  // as "stopped". See DockerService.containerStates.
  ipcMain.handle(
    CH.containerStates,
    (): Promise<ContainerState[]> => docker.containerStates(store.get().projects)
  )

  const sinkFor = (projectId: string) => (data: string): void =>
    emit(CH.containerOutput, { projectId, data })

  ipcMain.handle(CH.startContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    const ok = await docker.start(p, sinkFor(projectId))
    emit(CH.containerStateChanged, { projectId, running: ok })
    // The second of the two moments Docker is proven up (see the debt list).
    if (ok) void drainTranscriptDeletes()
    return ok
  })

  ipcMain.handle(CH.stopContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    await docker.stop(p)
    emit(CH.containerStateChanged, { projectId, running: false })
    return true
  })

  ipcMain.handle(CH.restartContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    const ok = await docker.restart(p, sinkFor(projectId))
    emit(CH.containerStateChanged, { projectId, running: ok })
    return ok
  })

  ipcMain.handle(CH.recreateContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    const ok = await docker.recreate(p, sinkFor(projectId))
    emit(CH.containerStateChanged, { projectId, running: ok })
    return ok
  })

  // ---- shared output folder ---------------------------------------------
  let outputWatcher: FSWatcher | null = null
  let watchDebounce: ReturnType<typeof setTimeout> | null = null

  function startOutputWatcher(): void {
    if (outputWatcher) {
      try {
        outputWatcher.close()
      } catch {
        /* already closed */
      }
      outputWatcher = null
    }
    const folder = store.get().sharedOutputFolder
    if (!folder) return
    try {
      // recursive watch is supported on Windows; debounce to coalesce bursts.
      outputWatcher = watch(folder, { recursive: true }, () => {
        if (watchDebounce) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => emit(CH.outputChanged, {}), 200)
      })
    } catch {
      outputWatcher = null // folder missing / not watchable
    }
  }

  // Bounds for the shared-output walk, matching what `scanMounts` below already
  // argues for: this feeds a panel, not a file browser.
  //
  // It had only a depth guard, and the folder it walks is mounted read-write
  // into *every* container at /workspace/output — it is where agents have been
  // told to drop artifacts. The first build, unpack or stray `npm install` that
  // lands in there made every fs.watch event walk the whole thing, on a 200 ms
  // debounce, so a process writing continuously re-walked continuously.
  //
  // The skip list is deliberately smaller than MOUNT_SKIP: `dist` and `out` are
  // plausible names for something an agent *meant* to leave here, and hiding a
  // real artifact is worse than walking it.
  const OUTPUT_SKIP = new Set(['node_modules', '.git'])
  const OUTPUT_MAX_DEPTH = 8
  /** Per directory. Nobody scrolls to the 400th sibling in a side panel. */
  const OUTPUT_MAX_ENTRIES = 400
  /** Whole tree, so a wide shallow explosion is bounded as well as a deep one. */
  const OUTPUT_MAX_NODES = 4000

  async function scanTree(dir: string, depth: number, budget: { left: number }): Promise<OutputNode[]> {
    if (depth > OUTPUT_MAX_DEPTH || budget.left <= 0) return []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
    const keep = entries.filter((e) => !OUTPUT_SKIP.has(e.name))
    const dirs = keep.filter((e) => e.isDirectory()).sort(byName)
    const files = keep.filter((e) => e.isFile()).sort(byName)
    const out: OutputNode[] = []
    // Sliced together rather than per kind, so one directory cannot spend the
    // cap on folders and leave no room for the files beside them.
    for (const d of dirs.slice(0, OUTPUT_MAX_ENTRIES)) {
      if (budget.left-- <= 0) return out
      const p = join(dir, d.name)
      out.push({ name: d.name, path: p, type: 'dir', children: await scanTree(p, depth + 1, budget) })
    }
    for (const f of files.slice(0, Math.max(0, OUTPUT_MAX_ENTRIES - out.length))) {
      if (budget.left-- <= 0) return out
      out.push({ name: f.name, path: join(dir, f.name), type: 'file' })
    }
    return out
  }

  ipcMain.handle(CH.setSharedOutput, async (_e, folder: string | null): Promise<Config> => {
    const next = await store.mutate((cfg) => {
      cfg.sharedOutputFolder = folder || undefined
      return cfg
    })
    docker.setSharedOutput(next.sharedOutputFolder)
    if (next.sharedOutputFolder) {
      await mkdir(next.sharedOutputFolder, { recursive: true }).catch(() => {})
    }
    startOutputWatcher()
    // Auto-recreate running containers so the new mount applies immediately.
    for (const p of next.projects) {
      if (await docker.isRunning(p)) {
        const ok = await docker.recreate(p, sinkFor(p.id))
        emit(CH.containerStateChanged, { projectId: p.id, running: ok })
      }
    }
    return next
  })

  ipcMain.handle(CH.outputTree, async (): Promise<OutputNode[]> => {
    const folder = store.get().sharedOutputFolder
    return folder ? scanTree(folder, 0, { left: OUTPUT_MAX_NODES }) : []
  })

  ipcMain.handle(CH.openOutputFile, async (_e, abs: string): Promise<string> => {
    const folder = store.get().sharedOutputFolder
    if (!folder) return 'no-folder'
    const root = resolve(folder)
    const target = resolve(abs)
    // Only allow opening files inside the shared folder (reject traversal).
    if (target !== root && !target.startsWith(root + sep)) return 'outside'
    const ext = extname(target).toLowerCase()
    if (ext === '.html' || ext === '.htm') {
      await shell.openExternal(pathToFileURL(target).href) // force default browser
      return ''
    }
    return shell.openPath(target) // OS default app; '' on success
  })

  // A link in a chat message. The scheme allowlist is the whole point: the href
  // comes from model output, and `shell.openExternal` will happily hand a
  // `file:`/`ms-settings:`/custom-protocol URL to Windows to execute.
  ipcMain.handle(CH.openExternal, async (_e, url: string): Promise<string> => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'bad-url'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
      return 'bad-scheme'
    }
    await shell.openExternal(parsed.href)
    return ''
  })

  // Reveal the shared-output root itself in Explorer (the header "open" button).
  ipcMain.handle(CH.openOutputFolder, async (): Promise<string> => {
    const folder = store.get().sharedOutputFolder
    if (!folder) return 'no-folder'
    return shell.openPath(resolve(folder)) // Explorer window; '' on success
  })

  ipcMain.handle(CH.deleteOutputFile, async (_e, abs: string): Promise<string> => {
    const folder = store.get().sharedOutputFolder
    if (!folder) return 'no-folder'
    const root = resolve(folder)
    const target = resolve(abs)
    // Must be strictly inside the shared folder — never delete the root itself,
    // never allow traversal outside it.
    if (target === root) return 'is-root'
    if (!target.startsWith(root + sep)) return 'outside'
    // Recycle Bin, not permanent unlink: reversible, and handles non-empty dirs.
    // The recursive fs.watch fires outputChanged → the tree refreshes itself.
    try {
      await shell.trashItem(target)
      return ''
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })

  // ---- pty / sessions ----------------------------------------------------
  // Opening one container session costs up to three docker.exe launches: the
  // isRunning probe below, the transcript probe inside execArgs, and the exec
  // client itself. Sessions no longer open one click at a time — every session of
  // a project opens the moment its container comes up (TerminalHost) — and that
  // burst is exactly what makes `docker inspect` answer non-zero, which
  // isRunning() reads as "container stopped". So let only a few through at once.
  // FIFO, so an interactive open waits at worst for a couple of probes; host
  // shells don't touch docker and skip the gate entirely.
  const OPEN_LIMIT = 3
  let openActive = 0
  const openWaiting: (() => void)[] = []
  async function openGate<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing open hands its slot *directly* to the next waiter instead of
    // releasing the count and resolving it: resolving a promise only queues a
    // microtask, so a caller arriving in between would see the freed slot too and
    // the two of them would both run — the cap would drift up by one per handover.
    if (openActive >= OPEN_LIMIT) await new Promise<void>((r) => openWaiting.push(r))
    else openActive++
    try {
      return await fn()
    } finally {
      const next = openWaiting.shift()
      if (next) next()
      else openActive--
    }
  }

  ipcMain.handle(
    CH.openSession,
    async (
      _e,
      projectId: string,
      sessionId: string,
      cols: number,
      rows: number
    ): Promise<SpawnResult> => {
      const p = store.getProject(projectId)
      const s = p?.sessions.find((x) => x.id === sessionId)
      if (!p || !s) return { ok: false, reason: 'not-found' }

      // Already live → just re-attach (renderer keeps the xterm).
      if (pty.has(sessionId)) return { ok: true }

      if (s.type === 'host-shell') {
        const ok = await pty.spawn(s, p, cols, rows)
        return ok ? { ok: true } : { ok: false, reason: 'spawn-failed' }
      }

      return openGate(async () => {
        if (!(await docker.binaryName())) {
          return { ok: false, reason: 'docker-missing', message: 'docker not found on PATH' }
        }
        // Opening a session must NOT start a stopped container — starting is an
        // explicit action via the project power control. If the container isn't
        // running, tell the renderer to show the "start the container"
        // placeholder instead of spawning (which would auto-start it).
        if (!(await docker.isRunning(p))) {
          return { ok: false, reason: 'container-stopped' }
        }
        // Re-check: this open may have waited behind others at the gate, and a
        // sibling could have opened the same session in the meantime.
        if (pty.has(sessionId)) return { ok: true }
        const ok = await pty.spawn(s, p, cols, rows)
        return ok ? { ok: true } : { ok: false, reason: 'spawn-failed' }
      })
    }
  )

  ipcMain.on(CH.writeSession, (_e, sessionId: string, data: string) => pty.write(sessionId, data))
  ipcMain.on(CH.resizeSession, (_e, sessionId: string, cols: number, rows: number) =>
    pty.resize(sessionId, cols, rows)
  )
  ipcMain.on(CH.killSession, (_e, sessionId: string) => pty.kill(sessionId))

  // ---- chat sessions ------------------------------------------------------
  // Its own handler rather than a fourth branch of openSession — cols/rows are
  // meaningless for a chat — but it shares the same openGate, because a chat open
  // still costs three docker.exe launches and the burst is exactly what makes
  // `docker inspect` answer non-zero.
  ipcMain.handle(
    CH.chatOpen,
    async (_e, projectId: string, sessionId: string, retry = false): Promise<ChatOpenResult> => {
      const p = store.getProject(projectId)
      const s = p?.sessions.find((x) => x.id === sessionId)
      if (!p || !s) return { ok: false, reason: 'not-found' }
      if (!retry && chat.has(sessionId)) return chat.open(p, s)
      return openGate(() => chat.open(p, s, retry))
    }
  )

  ipcMain.handle(
    CH.chatSend,
    (_e, sessionId: string, text: string, attachments: ChatAttachment[]): Promise<boolean> =>
      chat.send(sessionId, text, attachments ?? [])
  )

  ipcMain.handle(CH.chatInterrupt, (_e, sessionId: string): Promise<void> =>
    chat.interrupt(sessionId)
  )

  ipcMain.handle(
    CH.chatRewind,
    (_e, sessionId: string, entryId: string): Promise<ChatRewindResult> =>
      chat.rewind(sessionId, entryId)
  )

  ipcMain.handle(
    CH.chatAnswer,
    (_e, sessionId: string, requestId: string, answer: ChatAnswer): Promise<void> =>
      chat.answer(sessionId, requestId, answer)
  )

  ipcMain.handle(CH.chatSetMode, async (_e, sessionId: string, mode: ChatMode): Promise<Config> => {
    await chat.setMode(sessionId, mode)
    // Persisted, deliberately: a per-session user preference about how the agent
    // runs is not runtime state observed from Docker, which is exactly what
    // config.json is for. Restored at reopen as the launch --permission-mode.
    return store.mutate((cfg) => {
      for (const p of cfg.projects) {
        const s = p.sessions.find((x) => x.id === sessionId)
        if (s) s.mode = mode
      }
      return cfg
    })
  })

  ipcMain.handle(CH.chatSetModel, async (_e, sessionId: string, model: string): Promise<Config> => {
    await chat.setModel(sessionId, model)
    return store.mutate((cfg) => {
      for (const p of cfg.projects) {
        const s = p.sessions.find((x) => x.id === sessionId)
        if (s) s.model = model || undefined
      }
      return cfg
    })
  })

  // The owning project is resolved here rather than in ChatService, which has no
  // view of config: the model list is a property of the *container's* Claude
  // Code, so it is cached and answered per project (see ChatService.listModels).
  ipcMain.handle(CH.chatModels, (_e, sessionId: string): Promise<ChatModelOption[]> => {
    const project = store.get().projects.find((p) => p.sessions.some((s) => s.id === sessionId))
    return chat.listModels(sessionId, project?.id ?? null)
  })

  ipcMain.on(CH.chatClose, (_e, sessionId: string) => chat.close(sessionId))

  // Fire-and-forget: a stale menu is a cosmetic fault and a scan that fails, is
  // throttled away or finds nothing is a no-op the composer must not wait on.
  ipcMain.on(CH.chatRefreshCommands, (_e, sessionId: string) => {
    void chat.refreshCommands(sessionId)
  })

  // Fire-and-forget for the same reason, one beat slower: the answer is a model
  // call away and arrives as a `session:renamed` push, so the menu that asked
  // for it has long since closed.
  ipcMain.on(CH.chatRetitle, (_e, sessionId: string) => chat.retitle(sessionId))

  ipcMain.handle(CH.chatBody, (_e, sessionId: string, entryId: string): string | null =>
    chat.body(sessionId, entryId)
  )

  // The picture behind an image chip. Fetched per chip rather than shipped with
  // the row, for the reason ChatChip.imageId documents: a screenshot is the
  // heaviest thing in a conversation and a row is copied on every turn update.
  ipcMain.handle(CH.chatImage, (_e, sessionId: string, imageId: string): string | null =>
    chat.image(sessionId, imageId)
  )

  ipcMain.handle(
    CH.chatEarlier,
    (
      _e,
      sessionId: string,
      mounted: number,
      firstId?: string
    ): { entries: ChatEntry[]; total: number } => chat.earlier(sessionId, mounted, firstId)
  )

  ipcMain.handle(
    CH.chatSubagent,
    (_e, sessionId: string, toolUseId: string, agentId: string | null): Promise<ChatEntry[]> =>
      chat.subagent(sessionId, toolUseId, agentId)
  )

  // The `@` typeahead's source, and the composer's routing table: a dropped file
  // under one of these becomes a container path, anything else becomes inline
  // content. Walked from the host side — nothing here touches docker.
  ipcMain.handle(CH.chatMountTree, async (_e, projectId: string): Promise<MountNode[]> => {
    const p = store.getProject(projectId)
    if (!p) return []
    const roots = docker.mountTargets(p)
    const out: MountNode[] = []
    for (const { hostPath, target } of roots) {
      out.push({
        name: target.split('/').pop() ?? target,
        hostPath,
        containerPath: target,
        type: 'dir',
        children: await scanMounts(hostPath, target, 0)
      })
    }
    return out
  })

  // Bounded on both axes: this feeds a typeahead, not a file browser, and a deep
  // node_modules would otherwise cost seconds of stat() for entries nobody scrolls
  // to. The shadow volumes make those directories the container's copy anyway.
  const MOUNT_SKIP = new Set(['node_modules', '.git', '.angular', 'target', 'dist', 'out'])
  async function scanMounts(dir: string, target: string, depth: number): Promise<MountNode[]> {
    if (depth > 5) return []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: MountNode[] = []
    for (const e of entries.slice(0, 400)) {
      if (e.name.startsWith('.') || MOUNT_SKIP.has(e.name)) continue
      const hostPath = join(dir, e.name)
      const containerPath = `${target}/${e.name}`
      if (e.isDirectory()) {
        out.push({
          name: e.name,
          hostPath,
          containerPath,
          type: 'dir',
          children: await scanMounts(hostPath, containerPath, depth + 1)
        })
      } else if (e.isFile()) {
        out.push({ name: e.name, hostPath, containerPath, type: 'file' })
      }
    }
    return out
  }

  // ---- transcript search --------------------------------------------------
  /**
   * "Which conversation was that in." Greps every transcript on the shared creds
   * volume (see DockerService.searchTranscripts) and maps the uuids it finds back
   * onto sessions.
   *
   * The mapping is where this stops being a grep and becomes useful, and it has
   * three cases rather than one. A uuid can be a session's *current*
   * conversation; it can be one a `/clear` retired onto
   * `previousClaudeSessionIds`, which is a real place the answer might be and the
   * only feature in the app that surfaces those at all; or it can belong to
   * nothing here — claude-box's own transcripts share this volume by design, and
   * a deleted session's conversation may still be awaiting a drain. The third
   * kind is reported rather than filtered, because "12 matches somewhere outside
   * Vivarium" is a true and useful answer, and silently dropping it would make
   * the totals lie.
   */
  ipcMain.handle(
    CH.searchTranscripts,
    async (_e, query: string): Promise<TranscriptSearchResult> => {
      const term = typeof query === 'string' ? query.trim() : ''
      if (!term) return { ok: true, hits: [] }
      const r = await docker.searchTranscripts(term)
      if (!r.ok) return { ok: false, hits: [], error: r.error }

      // uuid → where it lives, built once rather than searched per hit.
      const owner = new Map<
        string,
        {
          projectId: string
          projectName: string
          sessionId: string
          sessionName: string
          archived: boolean
        }
      >()
      for (const p of store.get().projects) {
        for (const s of p.sessions) {
          const base = {
            projectId: p.id,
            projectName: p.name,
            sessionId: s.id,
            sessionName: s.name
          }
          if (s.claudeSessionId) owner.set(s.claudeSessionId, { ...base, archived: false })
          for (const old of s.previousClaudeSessionIds ?? []) {
            owner.set(old, { ...base, archived: true })
          }
        }
      }

      const hits: TranscriptHit[] = []
      for (const [uuid, matches] of r.counts) {
        const own = owner.get(uuid)
        hits.push({
          uuid,
          matches,
          projectId: own?.projectId ?? null,
          projectName: own?.projectName ?? null,
          sessionId: own?.sessionId ?? null,
          sessionName: own?.sessionName ?? null,
          archived: own?.archived ?? false,
          foreign: !own,
          snippet: r.snippets.get(uuid)
        })
      }
      // Most matches first: the conversation that mentions a thing thirty times
      // is nearly always the one being looked for, and a uuid has no other order
      // worth sorting by — the file's mtime would need a second docker call.
      hits.sort((a, b) => b.matches - a.matches)
      return { ok: true, hits }
    }
  )

  // ---- clipboard ---------------------------------------------------------
  ipcMain.handle(CH.pasteImage, async (_e, projectId: string): Promise<string | null> =>
    pasteImage(projectId)
  )
  ipcMain.handle(CH.clipboardReadText, (): string => clipboard.readText())
  ipcMain.on(CH.clipboardWriteText, (_e, text: string) => clipboard.writeText(text))

  // ---- dialogs / window --------------------------------------------------
  // Version chip in the title bar. The runtime versions ride along because the
  // one time you want them is when writing up a bug, and they're free here.
  ipcMain.handle(
    CH.appInfo,
    (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    })
  )

  ipcMain.handle(CH.browseFolder, async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // Several mounts from one trip through the picker. Ctrl/Shift-click in the
  // folder list selects more than one; a cancel is an empty array rather than
  // null, so the caller's "add these" path is the only path.
  ipcMain.handle(CH.browseFolders, async (): Promise<string[]> => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  // One level of directories under a base folder, for the mount picker's
  // quick-add chips — the fast way to mount four of a monorepo's six packages.
  //
  // Absolute-only by design: a relative string here would resolve against the
  // app's cwd, which is nowhere near the user's project. Dot-directories and
  // node_modules are dropped because they are never what someone is picking
  // between (and the shadow volumes make node_modules the container's copy
  // anyway) — anything unusual is still reachable by typing it or by Browse….
  // Junctions and symlinks are common in dev trees and docker binds them fine,
  // so they are stat()ed rather than skipped along with the files.
  const SUBFOLDER_SKIP = new Set(['node_modules'])
  ipcMain.handle(CH.subfolders, async (_e, basePath: string): Promise<string[]> => {
    if (typeof basePath !== 'string' || !basePath.trim() || !isAbsolute(basePath.trim())) return []
    const base = basePath.trim()
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return [] // a half-typed path, a disconnected drive, a folder we can't read
    }
    const named = entries
      .filter((e) => !e.name.startsWith('.') && !SUBFOLDER_SKIP.has(e.name))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .slice(0, 200)
    const dirs = await Promise.all(
      named.map(async (e) => {
        const full = join(base, e.name)
        if (e.isDirectory()) return full
        try {
          return (await stat(full)).isDirectory() ? full : null
        } catch {
          return null // a broken link
        }
      })
    )
    return dirs.filter((d): d is string => d !== null).sort((a, b) => a.localeCompare(b))
  })

  ipcMain.on(CH.windowMinimize, () => win.minimize())
  ipcMain.on(CH.windowMaximize, () => (win.isMaximized() ? win.unmaximize() : win.maximize()))
  ipcMain.on(CH.windowClose, () => win.close())

  // The renderer's theme, as a colour Chromium can paint under the document.
  // Validated rather than trusted: this arrives over IPC and goes straight into
  // a native call, and Electron throws on a string it cannot parse — which would
  // take the handler down for a value that is only ever cosmetic. #rgb, #rrggbb
  // and #rrggbbaa are the shapes `tokensFor(name).bg` can produce.
  ipcMain.on(CH.setWindowBackground, (_e, color: string) => {
    if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) win.setBackgroundColor(color)
  })

  // Confirm-on-quit: intercept every window-close path — the title-bar ✕ (which
  // routes through windowClose → win.close()), Alt+F4, and the taskbar/Aero
  // close — and ask the renderer to confirm before actually closing. The
  // renderer sends confirmQuit back once the user accepts, which flips the flag
  // and re-issues the close for real. The smoke-test harness (VIVARIUM_CDP_PORT)
  // bypasses the prompt so automated teardown isn't blocked by the modal.
  let closeConfirmed = Boolean(process.env['VIVARIUM_CDP_PORT'])
  win.on('close', (e) => {
    if (closeConfirmed) return
    e.preventDefault()
    win.webContents.send(CH.quitRequested)
  })
  ipcMain.on(CH.confirmQuit, () => {
    closeConfirmed = true
    win.close()
  })

  // ---- taskbar attention badge (agents finished / asking, with count) ----
  // The renderer draws the count disc on a canvas (main has no canvas) and
  // ships it as a data URL. The overlay mirrors the outstanding-notification
  // count — it clears when every flagged session has been viewed (count 0), and
  // focusing the window only counts as viewing the *selected* session, so the
  // number stays glanceable while working.
  // flashFrame(true) flashes until focus with no built-in duration, so a timer
  // stops it after a few seconds (Discord-style burst) — only the flashing is
  // time-limited.
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  const stopFlash = (): void => {
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
    }
    if (!win.isDestroyed()) win.flashFrame(false)
  }
  ipcMain.on(CH.setBadge, (_e, b: BadgePayload) => {
    if (win.isDestroyed()) return
    win.setOverlayIcon(
      b.dataUrl ? nativeImage.createFromDataURL(b.dataUrl) : null,
      b.count > 0 ? `${b.count} agent session${b.count === 1 ? '' : 's'} need attention` : ''
    )
    if (b.flash) {
      // Discord-style attention flash — Windows FlashWindowEx (built-in).
      win.flashFrame(true)
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(stopFlash, 4000)
    } else if (b.count === 0) {
      stopFlash()
    }
  })
  win.on('focus', () => {
    stopFlash() // stop flashing once the user looks at the app; the count stays
    // …the count stays for every session except the one actually on screen,
    // which has now been looked at: the renderer drops that one's flag, and with
    // it the overlay if it was the last. Sent from here rather than read off a
    // renderer 'focus' event because activation is what Windows tells main about
    // directly, and a minimized window brought back by its taskbar/start-menu
    // entry is exactly the case that has to work.
    emit(CH.windowFocused, {})
  })
}
