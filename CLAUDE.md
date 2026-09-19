# CLAUDE.md

Vivarium is a **Windows-only Electron desktop app**: a session manager that runs Claude Code
agents in per-project Docker containers with selective folder mounts, plus container-bash and
host-PowerShell terminals. Agents come in two kinds — a terminal `agent` (xterm + the TUI) and a
`chat`, a custom chat surface driving the same CLI over stream-json. Personal corporate tool — no
external users.

**This file is an index, not the archive.** The code is deliberately densely commented (see Code
style) and that is where the reasoning lives. What follows is the shortest statement of each rule
that is enough to stop you breaking it, and the file to read for the argument behind it.

## Architecture

electron-vite, three build targets, aliases `@shared` / `@renderer`.

`src/main/`

- `ipc.ts` — `registerIpc()`: every handler, the output-folder watcher, the taskbar badge.
- `docker.ts` — `DockerService`: container lifecycle, `docker run` args, image builds streamed
  into the session terminal, the volume inventory, transcript and subagent-log reads.
- `dockerfiles.ts` — inline slim/full Dockerfiles, `IMAGE_VERSION`, shared volume names.
- `pty.ts` — `PtyManager`: node-pty processes keyed by session id.
- `chat.ts` — `ChatService`: one live `claude -p` process per `chat` session, the transcript
  reader and its byte offset, the body cache, the todo fold, the subagent buffer.
- `chatMapper.ts` — the one mapper turning Claude Code JSON (stream frames *and* transcript
  lines) into log rows.
- `bridge.ts` — the agent hook bridge: a per-project host dir bind-mounted at `/vivarium` holding
  hook settings + `hook.sh`; `BridgeWatcher` tails its `events.log`.
- `config.ts` — atomic persistence of the single `%APPDATA%/vivarium/config.json`.
- `git.ts` — branch detection (reads `.git/HEAD` directly) + "Write branch diff".
- `clipboard.ts` — Ctrl+V image paste → PNG in the project clip dir (mounted at `/clip`).
- `claude.ts` — `ClaudeService`: npm `latest` lookup (10-min cache) + per-container version probe.
- `host.ts` — a host project's agent: which Windows `claude` to run, and whether its conversation
  already exists in `~/.claude`.

`src/preload/index.ts` — the typed `window.vivarium`. The renderer never touches `ipcRenderer`.

`src/shared/` — `ipc.ts` (`CH`, channel names), `types.ts` (all cross-process types), `models.ts`,
`mounts.ts`, `projects.ts`, `theme.ts`. `models.ts`, `mounts.ts` and `projects.ts` are the only
*logic* in `@shared` and earn it the same way: both processes name models, both name the container
path a mounted folder lands on, and both enforce which session types a project can hold and where
a session may move — so a second copy of any of them would let two surfaces disagree about what is
answering you, send you to a `/workspace/…` path docker never created, or offer a move main then
refuses after killing the pty. `models.ts` returns
anything it does not recognise **unchanged** — inventing a name is how a chip ends up lying.
`mounts.ts` carries its own SHA-1 because the renderer has no `node:crypto` and an async digest
cannot be read during a render; it is byte-exact with node's, which it must be — those eight hex
digits are in the names of containers and volumes that already exist. `theme.ts` is the two-value
sliver of the palette that main also needs: `ThemeName` and `THEME_BG`, because
`BrowserWindow.backgroundColor` paints under the document and main has neither CSS nor the
renderer's `localStorage`.

`src/renderer/src/` — React + zustand + xterm; `state/store.ts` is the single store for UI state.

- `theme.ts` — **the whole palette, three themes wide**, plus `SESSION_TYPES` (the one place type
  wording, hue and popover geometry live, with `TypeIcon` so types never depend on colour alone).
  `MIDNIGHT` is both the default and the schema — `Tokens` derives from its keys, so a theme that
  forgets a token does not compile, and there is no fallback because a missing custom property
  renders as nothing. `CHAT` / `CODE` are now **names for `var(--x)`, not a second palette**; they
  survive so the log can say "the page", "an inset card", "the fourth grey" instead of spelling a
  token 200 times, and nothing in them may hold a literal again. `CHAT_TEXT` is one type scale
  (12.5 base, 11.5 for anything that is a label). Hover, press and the control radius are
  `.vchat`-scoped rules in `GLOBAL_CSS`; anything clickable that is not a `<button>` opts in with
  `data-click`.
- `components/chat/` — `ChatView` (chrome, log column, pinned bands, composer), `ChatLog`,
  `Markdown`, `highlight.ts`, `attach`.
- `Markdown` is hand-rolled and built around one rule: **everything renders as text nodes and
  nothing is ever set as HTML**, so a tool result containing markup is shown rather than run and
  there is no sanitiser to get wrong. That constrains the *output*, not dependencies —
  `highlight.ts` uses Prism's `tokenize` (a token tree), never `highlight` (an HTML string).
  Anything reached for later clears the same bar. Links go out through `openExternal`, never an
  `<a>`: this window has no new-window handler, so a navigation would open the page inside the app.
- `Elapsed.tsx` is the only thing in the UI that ticks.

**Adding an IPC feature** touches four places in order: channel name in `src/shared/ipc.ts` →
handler in `src/main/ipc.ts` → typed method in `src/preload/index.ts` → renderer call via
`window.vivarium.*`. No exceptions, chat included.

**`chat:event` is the one deliberate departure** from one-channel-per-payload: it carries a
discriminated `ChatEvent` union, because a turn's appends, the turn-end replacement of those same
rows, blocking cards, task/todo, `rewound` and exit are strictly ordered — and Electron guarantees
ordering **within** a channel, not across channels.

**`session:renamed` is the one config channel that pushes.** Every other config change starts in
the renderer and adopts the `Config` its invoke returns; a chat that has named itself starts in
main, so there is no return value to adopt. It carries the whole `Config` anyway, into
`adoptConfig`, so the store keeps having exactly one way to take a config update.

## Invariants — do not break

### Colour and theming

- **No literal colour anywhere outside `theme.ts`.** Two exceptions, both deliberate and both
  documented in place: the close button's hover red (`#c2352a` in `TitleBar` — Windows' red, not
  Vivarium's, and the same on every theme) and `Logo.tsx` (brand artwork, the same paint as
  `build/icon.svg`, which Windows draws in the taskbar knowing nothing about themes). A grep for
  `#[0-9a-f]{3,8}` outside those two files should come back empty.
- **Three themes — midnight (default), graphite, paper — and every token is defined by all three.**
  Values live in `renderer/theme.ts`; `Tokens` is derived from `MIDNIGHT`'s keys so an incomplete
  theme is a type error.
- **`data-theme` on `<html>` is the authority.** The pre-paint script in `renderer/index.html`
  resolves it from `localStorage['vivarium.theme']` **before any module loads** — that is what
  stops a dark→light snap, and it is why the key and the three names are spelled as literals there.
  `store.theme` is a mirror for React to re-render off; only `setTheme` writes both, in that order.
- **A `var()` re-resolves itself; four consumers do not, and must be told.** xterm's `theme` and
  its find-bar `ISearchOptions` (canvas, and the latter refuses alpha), the taskbar badge (canvas),
  and `BrowserWindow.backgroundColor` (another process). They read `tokensFor(name)`; the terminals
  repaint via an effect on `theme` and main is pushed the page colour on `window:set-background`.
- **Ink is never a constant.** `--accent2` is a light orange on midnight, a light amber on graphite
  and a dark rust on paper, so anything filled names its own ink token — `--on-accent2`,
  `--danger-fg`, `--send-fg`, `--accent-fg`. This is the rule paper breaks first if ignored.
- **The theme swap transitions; progress fills opt out** with `data-meter`. A meter animates its
  own `width` and escalates through three hues, and cross-fading colour on top of that smears it.
- The ANSI palette is per theme: Campbell on the dark two, a darkened set on paper where `white`
  and `brightWhite` are **deliberately inverted** so `\e[97m` stays readable on cream.

### Docker and persistence

- The docker logic was ported from `claude-box.ps1` (removed; see git history). The
  `(ref 123-456)` comments in `docker.ts` point at lines in that script.
- Bind mounts use `--mount`, never `-v` — a Windows source path's drive-letter colon breaks the
  `-v` parser. A *named volume* has no colon, so `-v` is legitimate there.
- Bump `IMAGE_VERSION` in `dockerfiles.ts` whenever either Dockerfile string changes: it is
  written as an image label and checked before every start, and without the bump stale images are
  silently reused.
- Volumes `claude-box-creds` / `claude-box-home` are shared with the user's claude-box setup on
  purpose (auth and agent memory carry over) — never rename, and never removable. That guard is in
  `DockerService.removeVolume` as well as the UI, because the name arrives over IPC.
- **Volumes are only ever removed from the Volumes dialog.** Deleting a project drops its
  container, not the shadow build caches its mounts created.
- `publishedPort` applies to `full`-image projects only.
- Mounts may only change while the container is stopped (`ipc.ts` enforces it); saving settings on
  a running container recreates it.
- Quitting the app **never stops containers** — only a project's explicit stop control does. Quit
  kills local ptys only (`PtyManager.killAll`).
- **No multiplexer by design** (tmux was deliberately removed) and no detached process: a live
  turn dies with the app, for both agent kinds. The *conversation* survives regardless — both
  kinds write the same container-side transcript — so only the in-flight turn is lost.
- Runtime state (container running, live ptys) is **queried live, never persisted**. `config.json`
  holds projects/mounts/sessions/settings and is written through `ConfigStore.mutate` (atomic
  temp-file + rename). Seven deliberate exceptions, all user preferences or facts that *cannot* be
  queried: `Session.mode`, `Session.model`, `Session.effort`, `Config.chatZoom`,
  `Session.previousClaudeSessionIds` + `Config.pendingTranscriptDeletes`, `Session.rewound`, and
  `Session.autoName` (*who* last named a chat — nothing can be asked once both answers are just a
  string in `name`). `Session.effort` is the strongest case of the lot: the CLI reports the effort
  level **nowhere** — not in `init`, and there is no control request that asks — so the pick is the
  only record that a pick was made.
  Not persisted, for contrast: the `list_models` result, the composer draft, `terminalFontSize`.
  `Project.slashCommands` is cached as a **hint, never authority** — the CLI always decides, so a
  stale entry can only mis-suggest, never mis-execute.
- **Claude Code is never updated under a running container, and always fresh in a new one.** One
  rule, and the line between the halves is `docker run`. Updating an existing container is
  user-initiated only (the Claude Code dialog). `DockerService.freshenClaude` runs on the
  **fresh-create path only**, where by construction no session exists to change it under; every
  failure there is non-fatal.
- **Delete means delete, for chat conversations.** Deleting a chat deletes its whole transcript
  chain and deleting a project cascades. The mechanism is a debt list
  (`Config.pendingTranscriptDeletes`) written in the *same atomic mutate* that removes the
  session, drained at launch and after each container start. **There is no sweep and never will
  be** — the `-workspace` slug holds claude-box's transcripts too. The removal is `rm -rf` with an
  interpolated variable: the safety rests entirely on that uuid coming from `randomUUID()`.

### Host projects

- **A project is a container project unless `Project.kind === 'host'`.** Absent means container, so
  old config needs no migration; the kind is picked in Add project and **never changes** — a
  conversation cannot follow a project across the boundary. A host project holds only `agent` and
  `host-shell` (`@shared/projects`, enforced by the picker, the drop targets *and* main's
  `addSession`/`moveSession`). Its `mounts` are empty and its `image` is an inert `slim`.
- **A host agent is plain `claude.exe` in `basePath` — never `--dangerously-skip-permissions`.** The
  container is what made bypass a sane default; without one, the agent is the same `claude` you
  would get in your own terminal, prompts and all. Spawned directly (no shell), found by
  `resolveClaude` on PATH then `~/.local/bin`, resumed by pinned id exactly like a container agent.
- **Host ptys drop an outer Claude Code's session markers** (`withoutParentSession`). Launch the app
  from inside a Claude session and Electron inherits `CLAUDE_CODE_CHILD_SESSION` & co.; a host
  `claude` then thinks it is a child, **saves no transcript**, and every later `--resume` breaks.
  The list is explicit — `CLAUDE_CODE_*` is also where the user's own configuration lives.
- **Hooks reach it through a host-flavoured `hooks.json` in the same bridge dir.** Claude Code on
  Windows runs hook commands in Git Bash, so `hook.sh` is the same script addressed by
  `C:/…` path. It adds `PermissionRequest` → waiting, because a host agent is asked constantly;
  nothing reports the *answer*, so `TerminalView` resumes on Enter **or a digit**. The files are
  written only-if-changed: every host agent spawns at once at launch, and truncating a
  `hooks.json` a sibling `claude.exe` is parsing makes it run hookless.
- **An agent never moves into, out of, or between host projects** (`canMoveSession`). Claude files
  a transcript under the directory it started in and refuses `--resume` from any other, which is
  also why changing a host project's folder gives its agents **new** conversation ids. Container
  agents never meet this: every one runs in `/workspace`.
- **Every docker-facing handler refuses or skips host projects in main** — the lifecycle four,
  `claudeUpdate`, and the `containerStates` / `claudeStatus` sweeps. Their sessions render at launch
  like host shells and never get the "Container stopped" placeholder.

### Terminals

- **All resizing goes through `fitNow()`** in `TerminalView` — never `fit.fit()` or
  `resizeSession`. FitAddon clamps a collapsed container to 2×1 instead of refusing, and a
  2-column fit reflows the whole 50k-line scrollback irrecoverably. Chat sessions have no terminal
  and no fit: `ChatView` sits *beside* the terminal views, never in place of them.
- **A stale scroll area is "short of the buffer", not "zero range"** (`repairIfStuck`), and row
  height is measured off `.xterm-screen`, never taken from xterm's cached dimensions object.
- In the **normal** buffer the mouse wheel belongs to the user even when the app has enabled mouse
  tracking (Claude Code does); only the **alternate** buffer gets it.
- **`TerminalHost` keeps one long-lived view per opened session.** Terminals *must* — unmounting
  disposes the xterm and its scrollback — while chat *may*; the `live[]` clause is kept for chat
  for cheapness rather than survival, so do not "fix" it by adding a type branch.
- **A terminal's lifetime follows its pty, not the container probe.** `states[].running` is a 3s
  `docker inspect` poll reporting false on any non-zero exit, so `toRender`'s `live[session.id]`
  clause must never be dropped. It must equally not open a session on a *genuinely* stopped
  container — that stays an explicit user action.
- **A session is live whenever it can be, not when it was last clicked.** Two consequences the
  code depends on: the terminal body renders with nothing selected (`EmptyState` is an overlay
  inside it, and the views in there are what open the ptys), and `openSession` retries on
  `container-stopped`/`spawn-failed` while the store still says running. `OPEN_LIMIT` caps that
  burst, handing slots straight to waiters so the cap cannot drift up.
- **Moving a session between projects transfers the conversation and only that** — the transcript
  path is identical from any container, so `execArgs` picks `--resume` itself and nothing is
  copied. The pty, the scrollback and the mounts do not follow. `moveSession` kills the pty
  silently, because it kills before rewriting config.
- **No "Clear" in the terminal context menu** — `clear()` drops the whole 50k-line scrollback with
  no confirmation. The shell's own `clear`/`cls` covers the intent.
- **The focus ring is a `box-shadow`, not an `outline`** (`GLOBAL_CSS`): every field in this app
  sets `outline:none` *inline*, and inline wins.

### Agent activity

- Idle/working/waiting has **two producers that unify at the event, not at the channel** — both
  emit `AgentActivityEvent` on `agent:activity` and the store cannot tell them apart. Do not
  reintroduce hook *kinds* over IPC.
  - pty `agent`: Claude Code **hooks** (`UserPromptSubmit`/`Stop`, plus `PreToolUse`/`PostToolUse`
    on the two tools whose execution *is* a wait), never by parsing terminal output. Scoped with
    `--settings /vivarium/hooks.json` — never the shared `settings.json`, which would leak them
    into claude-box sessions. `bridge.ts` owns the hook→state mapping, so that vocabulary stops at
    the process boundary.
  - `chat`: derived from the ordinary stream (`assistant` → working, any pending `can_use_tool` →
    waiting, `result` → idle), which costs no extra parsing. Never pointed at the hooks and never
    given a `VIVARIUM_SESSION_ID`. `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is deliberately never
    set — an undocumented env-gated signal is the silent breakage hooks were introduced to end.
  - Hook gotchas are **pty-only** TUI artifacts: `Stop` does not fire on an Esc-interrupt, and
    `PostToolUse` does not fire on a rejection, which "No, keep planning" is. Neither exists over
    stream-json, so `TerminalView`'s Esc/Enter heuristics must not be reproduced in the chat.
  - Bridge files are rewritten and the log truncated on every container start, so a container that
    was already up serves the old `hooks.json` until it is restarted.
- **A turn duration is a stopwatch on the host clock, and blocking on the user pauses it.** Events
  are stamped as the host *reads* them (a WSL2 clock drifts from Windows across sleep, and these
  are subtracted from the renderer's clock), `agentSince` only on real transitions, and `waiting`
  freezes the reading — so the number always means work done, not wall time.
- **An attention flag is cleared by viewing its session, and focusing the window is viewing** —
  main sends `windowFocused` from the same `win.on('focus')` that stops the flash, and
  `acknowledgeSelected` drops the selected session's flag only.

### Chat sessions

- **A chat drives Claude Code; it is not a bespoke agent loop.** One
  `docker exec -i … claude -p --input-format stream-json --output-format stream-json` per session
  — **`-i`, never `-it`**, no TTY anywhere in the path. Three flags are load-bearing:
  `--permission-prompt-tool stdio` (an undocumented *sentinel*, not an MCP server; without it a
  raw `-p` run auto-denies every prompt **and** drops `AskUserQuestion`/`ExitPlanMode` from the
  tool list), `--forward-subagent-text`, and `--include-partial-messages`. **Nothing is emitted
  until the first user message** — `init` is the answer to turn one, not a greeting, so a client
  that waits for it deadlocks. The control channel is live from spawn, which is what makes the
  open-time context read possible.
- **Always *launched* in `bypassPermissions`; a `plan` session is transitioned into plan mode over
  the control channel at spawn.** Never `--permission-mode plan`: bypass availability is decided
  once at startup, and ExitPlanMode's approval restores `prePlanMode ?? 'default'`, which is only
  recorded by a transition *into* plan mode. A refused `set_permission_mode` is never swallowed.
- **The transcript is the chat's model, not a log of it.** History is the container-side `.jsonl`
  read over `docker exec`; there is **no host-side mirror**, which would drift from the file
  `--resume` actually feeds the model. A turn paints from the stream, and at `result` main
  re-reads from its stored byte offset and *replaces* that turn's rows. Accepted cost: no history
  while the container is stopped. Four rules make the replacement safe, all because it deletes
  what it replaces — whole lines only (`completeLines`), one turn per settle (`takeTurn`), a settle
  reading from the turn's own start offset (which makes it idempotent), and, under all of them, the
  floor: a settle holding **less prose than the stream already painted is never applied**. It
  re-reads `SETTLE_ATTEMPTS` times and then keeps the streamed rows *for good* — running out of
  attempts is not permission to delete a turn. An aborted turn is not settled, but its bytes are
  still stepped over (`skipTurn`).
- **The first `turn_duration` in a settle's read is not necessarily that turn's end.** `takeTurn`
  walks the read in segments and skips leading ones that produced no model work (no `assistant`
  line and no `compact_boundary`), because the file grows *between* turns too: a `set_model` echo,
  and above all a background agent's `<task-notification>` followed by the `turn_duration` the CLI
  **defers** for as long as any background task is running. Stopping at the first marker made a
  handful of stale lines *be* the turn, so the turn's own message and answer were deleted and then
  re-materialised under the next turn's number — with `load earlier` offering them back and having
  nothing to give, because main had thrown them away too. The skipped lines are **kept**, not
  dropped: the notification is the only record of a background agent's outcome and has to reach the
  mapper to complete the row that launched it.
- **A revert is the CLI's own `rewind_conversation` control request, and the transcript does not
  shrink for it.** It pops exactly one message (so reverting N is N sequential calls, newest
  first), cannot pop the first, must be aimed from the *file* rather than `l.entries`, and
  *appends* a `last-prompt` branch pointer rather than truncating. So the abandoned byte range is
  recorded on `Session.rewound` and subtracted by every later whole-file read. **Do not "fix" this
  by following the branch pointer instead** — that was tried and fails on compaction, with the
  failure mode of blanking history on conversations nobody reverted. Its `prefillText` is the line
  **as stored**, so it goes through `typedText` before it reaches the composer: a slash command or
  skill is stored as `<command-name>` markup and used to come back into the box as that, where the
  log row for the same line has always read `/foo-bar`. One rule spells both (`commandLine`).
  File restore is deliberately absent.
- **`isSidechain` is never filtered on.** A transcript written by `claude -p` marks *every* line
  true, main conversation included — the exact inverse of a TUI transcript. Filtering blanks the
  entire log for exactly the sessions this feature creates.
- **Chat entry ids are `<message id>#<block type>#<ordinal among blocks of that type>`** — never
  the content-array index, which means three different things across the three sources a row can
  arrive from. Ids must stay stable across the stream→transcript settle, and
  `chatMapper.textBlockId` is the single spelling of the rule. **A settled turn's rows are dropped
  by id as well as by turn**, because one line can be mapped under two turns; both ends filter
  both ways.
- **A subagent has three sources and one `task` row.** A synchronous `Task` completes from its
  `toolUseResult`. A **background `Agent`** returns `async_launched` with no outcome at all, so
  its row stays running until a `<task-notification>` user line completes it — folded into the
  row, never rendered as itself, and adopted across turns by reference (`adoptTasks`), since the
  agent outlives the mapper that launched it. The **sub-log** is the sibling file once the agent
  stops and the forwarded stream while it runs, chosen by the row's `running`; one sub-mapper per
  subagent, and rows merged by id at all three hops.
- **Neither a slash command's output nor a task notification is something the user typed.** Both
  arrive on ordinary **user** lines, and both render as raw markup inside the tinted `you` bubble
  if the mapper does not recognise them there.
- **The composer's `/` typeahead opens with its first row highlighted; its `@` one opens with
  none.** A `/` is only a menu when it is the first character, so the list is unambiguously what
  you are doing; an `@` occurs in prose (`foo@bar.com`), where a default highlight would put a
  completion under Enter mid-sentence. What the old no-highlight default protected — Enter meaning
  "send `/clear`", not "complete it" — is kept by `enterSends`: Enter completes the highlighted
  row **unless the row is already typed out to the letter**, and one computation feeds both the key
  handler and the footer hint so they cannot promise different things. Tab is one press for `/`
  and still two for `@`. The list is deduped — `init` reports `slash_commands` and `skills`
  separately and they overlap — and a leading `/command` is tinted only when the CLI has it.
- **A leading `/command` is coloured, not highlighted, and the colour comes from a twin behind the
  textarea.** One textarea paints one flat colour, so while a known command leads the draft the two
  swap jobs: the textarea keeps caret, selection and editing but goes `color: transparent` (with
  `caretColor` restated, or the caret goes with it), and the twin paints every glyph — the command
  in `CHAT.you`, the rest in exactly `CHAT.text`. The twin may differ from the textarea in **colour
  only**: any weight, size, family or spacing of its own moves the glyphs out from under the real
  caret. Selected text stays readable because the app's `::selection` is 32% alpha.
- **What `/` can expand is learned from `init` *and* from the disk.** `init` is emitted at the
  first turn of a process and re-emitted only when `set_model`/`set_permission_mode` arms it, and
  there is no `list_commands` control request — so a skill written since is missing from the menu.
  `ChatService.refreshCommands` scans the container's four canonical directories and **merges**:
  init's names first, the scan may only add, which keeps the built-ins and plugin skills it cannot
  see. An `init` **replaces** and re-arms the throttle.
- **A follow-up typed while a turn is running is queued in main, never written into the pipe.**
  There is no CLI-side queue over stream-json: a message that lands mid-tool-call is *steered into
  the running turn* (both prompts answered in one message, **one** `result`), one that lands in the
  sliver before the turn ends starts a turn of its own, and one written while a `can_use_tool` is
  outstanding does nothing at all — the CLI reads no further stdin until it is answered. Since
  everything downstream of `result` counts one result per message, the steered case left a second
  clock counting `working` against an already-answered turn until the silence timeout cut it ten
  minutes later. `ChatService.queue` holds it and `startNext` opens it at `result`, which is the
  only moment the CLI is provably free — so exactly one clock exists at a time, and a queued
  message is a turn of its own, as it is in the TUI. Its row is painted where it was typed and
  tagged `queued`; the tag comes off when the turn opens, and becomes `not sent` if the process
  dies or the conversation is cleared under it. An **aborted** turn still flushes the queue: the
  usual reason to have a message waiting is that it says what to do instead.
- **The chat has no terminal states, and nothing retries itself.** Every failure recovers by the
  same single act — respawn and re-read the transcript. Detection is a **60s silence timeout on
  *any* frame**: killing the in-container `claude` is completely silent, and a broken credential
  emits a normal-looking `init` and then nothing. The clock **stops while any `can_use_tool` is
  outstanding**, because a CLI blocked on a human is provably not the broken CLI this detects.
  Recovery is never automatic.
- **`terminal_reason` is the only test that distinguishes cancelled from failed** — `is_error`
  cannot, since a clean deny-then-interrupt reports true. On reopen a cancelled tool is detected
  **structurally**, never by matching the refusal wording. The `interrupted` row has two producers
  on one stream and neither can be dropped, so whichever lands second is suppressed, per turn.
- **A chat names itself, and a human rename ends the arrangement for good.** Two beats: the first
  message of a chat still called `chat-N` replaces that name with a cleaned slice of what you
  typed (instant, free), and the settle replaces the slice with a few words from a **throwaway
  Haiku process** (`docker.askClaude` — `-w /tmp` so no project CLAUDE.md loads, a pinned
  `--session-id` so the transcript it necessarily writes can be deleted). Never the chat's own
  process: the transcript *is* the model's context, so a "name this" turn would both show in the
  log and be re-fed to the agent forever. Regenerated only when what the chat is about can have
  changed — **a compaction** (the CLI's own evidence that the opening prompt no longer describes
  the conversation), a `/clear`, or the "Retitle" menu item — never per turn. `mayRename` is the
  whole safety story: `autoName` *or* a name still matching `chat-\d+`, which is what makes every
  chat already in config.json eligible with no migration. The rename handler tells `ChatService`
  as well as config (`manualRename`), because `l.session` is a snapshot from open time and a title
  generated against a stale copy would land on top of the name just typed. Every failure — no
  model, a timeout, a paragraph instead of a name — keeps the name it has and says nothing.
- **Effort is set two ways because the CLI offers no third.** There is no `set_effort` control
  request (2.1.261 answers "Unsupported control request subtype"), `set_model` takes an `effort`
  key only by ignoring it, and no frame ever reports the level — so `Session.effort` is applied as
  `--effort` at spawn and, on a chat that is already live, by sending Claude Code's own
  `/effort <level>`: a **local** command that spends no tokens (`result.usage` comes back zeroed)
  and answers "Set effort level to high (this session only)". It goes through `send` as an
  ordinary turn, which is what makes it queue behind a running one instead of being steered into
  a turn already costed at the old level. Writing it straight into the pipe is the thing not to
  do: the CLI answers with a full init/assistant/result, and a `result` with nothing in flight is
  read as the *previous* turn's. The picker offers exactly `list_models`' own
  `supportedEffortLevels` for the picked model, narrowed to the five in `EFFORT_LEVELS` — `/effort`
  also takes `auto` and `ultracode`, but `--effort auto` is **warned about and ignored**, which
  would leave the header naming a level the next launch is not on.
  **`--effort` is passed on every chat spawn, picked or not** (`DEFAULT_EFFORT`, `high`). That is
  what makes the header's reading a report rather than a guess: with nothing passed the session
  would run at a default the CLI states nowhere and is free to move, so there is deliberately no
  "CLI default" option in the picker — it is the one setting the app could not report. An
  unrecognised level in config falls back to `DEFAULT_EFFORT` rather than being forwarded, because
  the CLI does not refuse one, it warns on stderr (unread here) and quietly uses its own. Terminal `agent` sessions get
  no effort for the same reason they get no `--model`: the TUI has its own `/effort`.
- **The context meter is only as fresh as the last thing that asked for it**, so `set_model` asks
  too — the ceiling is a property of the model. `setModel` adopts the *resolved* id for display
  while `Session.model` keeps the **alias**, which is what `--model` needs at the next spawn.
- **`Session.model` is what the chat is on; what the process reports is only which model answered
  a turn.** A slash command, skill or agent definition may pin a model, and a turn that expands one
  *runs on it* — the CLI reports it in that turn's `init` and returns to the session's model by
  itself at the next turn. Adopting that report as the chat's model is what left a chat on Opus for
  good after one such turn, so `reading()` prefers the pick and takes a report only as a **fuller
  spelling** of it (`fable` → `claude-fable-5-…`), never as a different model; the visited model
  stays visible as the turn's own `model · a → b` divider, which is why the settle's mapper is
  seeded like the live one. `holdModel` re-asserts the pick when the two disagree, written on the
  line *above* the turn's message — the CLI applies a control request as it reads it, so that gets
  this turn rather than the next. Same-model comparisons are `sameModel` in `@shared/models`, never
  `!==`: the pick is an alias and every report is resolved. And a refused `set_model` is **never
  swallowed** — `setModel` re-emits the reading actually in force and the ipc handler does not
  persist, or the picker would record a preference the CLI rejected and then assert it every turn.
- **The turn clock's token reading steps per API message and is never estimated between them.**
  Only `output` is on screen (the whole context is re-sent every message, so a summed input reads
  as a cost the turn did not incur), and subagent tokens are excluded because `result.usage`
  excludes them.

### The chat window

- **The `AskUserQuestion` card is the whole tool, and it is the last row of the log.** Not a
  pinned band (it is a form, not a sentence with two buttons after it), not a modal (a scrim over
  the conversation the question is about), and no longer a floating card (it covered the last few
  messages, which are what a question is usually about). It has no height cap and no inner
  scroller — the log is the scroller — and focus is taken with `preventScroll`. There is no
  dismiss: "Chat about this" is the way out, and it is a `deny`, not an empty `allow`. Three more
  CLI facts it rests on: "Other" is an answer filed under the question rather than a separate
  field, multi-select answers travel joined with `", "` as a string, and `updatedInput` is
  re-validated against the tool's schema (unknown keys tolerated). The settled row reads
  `toolUseResult`, never prose.
- **A `you` row is a raised `--card` bubble *and* a `--role-you` left rail *and* a gap above it.**
  The surface alone was one step over the page and read as one more tool card; the rail and the
  gap are what make a turn findable when scrolling back through mostly machinery.
- **The log has exactly one scrollbar and it is `ScrollRail`.** The native one is turned off
  (`vchat-log` in `GLOBAL_CSS`), because two bars down one column are two answers to "where am I".
  So the rail takes the whole job: the thumb drags, the track takes a click, and the wheel over it
  is forwarded to the log. The thumb is the **full width** of the rail — an inset thumb in a strip
  this narrow reads as a tick in a channel rather than as the bar. It is an **overlay over the
  log's right gutter, never a flex item beside it**: the log and the composer share `CHAT_EDGE` so
  a message and the box you answer in line up, and a rail that took layout width would move one of
  those edges and not the other. It is a sibling of the scroller rather than a child, because an
  absolutely positioned child of a scroll container scrolls with the content. **Nothing in it
  re-renders**: the thumb is sized and positioned straight onto the DOM from a rAF-coalesced
  ResizeObserver and scroll listener, because a streaming turn grows the log ~25 times a second and
  a `setState` per observation would repaint it on every one. `RAIL_W` is 8 and clears the widest
  row by **2px at 0.7× zoom**, so it does not grow without re-checking that. It is chrome and is
  not zoomed.
- **It carried a mark per message and per compaction, and that is deliberately gone.** Eight pixels
  of notches down the edge of a reading column is noise on every row, and what they were for —
  finding what you asked and getting back to it — is what the `Outline` rail already does, with
  room for the words themselves. A scrollbar only has to say where you are. Do not re-add them.
- **A compaction is its own entry kind, it owns a body, and its summary is never a `you` row.**
  Claude Code writes one as *two* transcript lines: a `system`/`compact_boundary` carrying
  `compactMetadata` (trigger, pre/post tokens, duration), then an ordinary **`user` line flagged
  `isCompactSummary`** holding the summary the next turn is fed. Mapped as the user line it looks
  like, that second one renders in the tinted bubble as though you had typed "This session is
  being continued from a previous conversation…" — the same lie the interrupt marker, a slash
  command's stdout and a task notification each get caught for, and this is the fourth. Worse than
  a leak: a summary that *quotes* a slash command hits `COMMAND_NAME_RE`, which is unanchored, and
  the whole thing became a phantom `you` row reading `/foo-bar` — a message the user never sent.
  Both lines fold into one `kind: 'compact'` row, **collapsed by default** (the summary is written
  for the model and is the largest thing in the log where it is least worth reading) with the full
  text behind `chat:body` exactly as a tool body. A `model · a → b` `divider` stays a quiet label
  on one rule; these are not the same kind of event and must not wear the same style.
- **Compacting and compacted are one object in two states, drawn by one component.** `CompactBand`
  renders both, so the thing you watched happen is the thing you scroll back to. The running form
  is the turn clock replaced, off `turn.phase === 'compacting'`, which main sets from the **same
  `SLOW_COMMANDS` test** that already starts a `/compact` turn on the wide silence budget — the one
  turn whose silence is known in advance rather than guessed at. **The band does not pulse, and
  nothing in it may**: the chip already carries dots and a ticking clock, and a third animation
  applied to the whole chip fades the *label* along with the border, so the words dim and brighten
  under the reader — which is exactly what reads as a flash. A border that is simply lit says
  "this one is live" without moving. An **auto**-compaction strikes mid-turn and is
  indistinguishable from thinking until its boundary lands, so it is deliberately never guessed
  at; the row it produces is the report. `phase` is
  cleared when the boundary arrives, so the tail of the turn reads as the ordinary work it is.
- **A Skill's body is collapsed, and it is the one thing in the log that is closed by default.**
  A `Skill` tool_result is the whole SKILL.md — instructions addressed to the model, which used to
  render as markdown in place and bury the turn around it. The row states what was loaded and how
  large it was; the text is one click away and still *in* the log, because dropping it would make
  the transcript lie about what entered the model's context. A local command's stdout is the other
  `cmd` row, told apart by having **no title**, and stays open: it is short, it is addressed to
  you, and `/context` draws a meter that reflowing destroys.
- **The log follows the tail on a ResizeObserver, not on the entry count** — a streaming turn
  grows the last row rather than adding one. `pinned` (within 40px of the bottom) keeps it from
  yanking a reader who scrolled up. **Corollary, binding the pinned bands and everything in the
  log: a hover may not change a height.** The question card's preview pane reserves the tallest
  option's space with `visibility`; do not compute it against font metrics.
- **Streamed prose is revealed at a steady rate, and that is not decoration** — the CLI's own
  cadence is ~68 characters every ~460 ms, so `ChatLog` drains at a *rate* (`REVEAL_CATCHUP`),
  only for the row the running turn is writing into, and snaps to full the instant the turn ends.
  `LogRow` is memoised and `ChatView`'s `handlers` with it, or every paint re-renders every row in
  the log, markdown parse included.
- **The turn clock draws at the bottom of the log while running** and stays in its place in time
  once frozen — which takes agreement in three places (`settleTurn`, `freezeTurnClock`, the
  store's `applyEntries`).
- **Chat zoom is CSS `zoom` on the two columns, never on the view root** — a zoomed
  `position:absolute; inset:0` box scales its own edges. There is no `max-width` on either column:
  the window is the measure. Both share `CHAT_EDGE` and must keep sharing it, or the log and the
  box you answer in stop lining up. `chatZoom` is persisted and shared by every chat; the chords
  are Ctrl +/-/0 and Ctrl+wheel, written down in the log's context menu.
- **Copying out of the log answers with markdown, and the unit is a block, never a character.**
  Each rendered block carries the source lines it came from (`data-md-from`/`-to`; `Md`'s container
  holds the lines in a `WeakMap`, not in a `data-` attribute, which would stamp every message's
  full text into the DOM a second time). A block the selection covers *completely* is replaced by
  exactly those lines — a table pastes back as `| a | b |`, a fenced block keeps its fences. A
  block covered only in part has no honest markdown answer, so it contributes the text that was
  actually highlighted, and the stretches between blocks go through `Range.toString()` rather than
  a hand-rolled text walk: the browser already knows where a rendered selection breaks lines, and
  re-deriving that from `display` values is a second renderer nobody asked for.
  `selectionMarkdown` returns **null** when it has nothing better than the default, which is what
  lets `onCopy` leave the event alone instead of reimplementing the browser's copy — the other
  clipboard flavours survive. **Only the top-level `blocks()` call tags**: a nested one indexes
  into a *derived* array — a dedented list item, a quote with its `>` stripped — so its indices
  name lines the message does not contain, and tagging them would hand back confidently wrong
  bytes. `CodeBlock`'s own copy button is unaffected and still yields the bare code, which is the
  other thing a reader means by "copy" and the reason both exist.

## Commands

```
npm install          # postinstall rebuilds node-pty against Electron
npm run dev          # electron-vite dev server + Electron
npm run dev:cdp      # the same, plus CDP on 9366 and a visible window
npm run typecheck    # tsc for both tsconfig.node.json and tsconfig.web.json
npm run build:win    # NSIS installer in dist/
```

## Verifying changes

There is **no test suite, by design — don't add one.**

1. `npm run typecheck` — always.
2. **Probe the running app** when you need a fact the code cannot give you. The `playwright` MCP
   server (pinned in `.mcp.json`) attaches over CDP to the real Electron app, so `npm run dev:cdp`
   has to be up first — Playwright can only attach, never launch. `browser_evaluate` reaches the
   two debug handles where this app's truth actually lives: `window.__vivStore.getState()`
   (zustand — dialogs, container states, chat entries) and `window.__vivTerms[sessionId]` (xterm,
   for scrollback that is on a canvas and in no DOM). Verify against those, not against pixels.
   **Do not write or run an end-to-end test flow unless the user asks for one.** Probing,
   snapshotting and reading state on your own initiative are fine and expected; scripted
   click-through scenarios are only ever done on request.
   Three things worth knowing before disbelieving what it shows you:
   - **Occlusion is the whole ballgame.** Windows tells Chromium when the window is fully covered
     and Chromium stops compositing it: screenshots time out, `requestAnimationFrame` never fires,
     and every dialog's entry animation freezes at opacity 0 — so the app looks empty and the
     click looks lost. `CalculateNativeWinOcclusion` is disabled under CDP for that reason.
   - Not every chip is a button: the four session types under the empty state are a *legend*.
   - **Never `browser_close`** — it closes the app, not a tab. And it drives the *real* app, so it
     will start containers and spend tokens if you click the things that do that.
3. For mapper/parser work, prefer an offline harness over the UI: bundle with
   `esbuild src/main/chatMapper.ts --bundle --format=esm --platform=node --alias:@shared=./src/shared`
   and feed it real transcript lines pulled out with `docker exec`. It is faster, it is exact, and
   it can replay the same input through the pre-fix version to prove a fix is not vacuous.
4. A headless smoke run inside the Linux dev container is possible: install Electron's system libs
   (`libgtk-3-0 libnss3 libasound2 libgbm1 libxss1`), `nohup Xvfb :93 -screen 0 1600x1000x24 &`
   (nohup specifically), then `ELECTRON_DISABLE_SANDBOX=1 VIVARIUM_CDP_PORT=9366 DISPLAY=:93 nohup
   npm run dev &` and connect over CDP. Vite HMR does not fire on that bind mount — kill Electron
   and relaunch to pick up renderer edits.
5. Anything docker-, pwsh-, or WSL-dependent cannot run in that container — the user verifies those
   paths on the Windows host. Say so explicitly instead of claiming verification.

## Git

- **Commit straight onto `main`.** No feature branch and no PR unless asked — this is a personal
  single-user tool, so a branch is only a merge step nobody is going to review. Do not "branch
  first" out of caution; that default does not apply here.
- **Every commit is followed by a push.** `git push` in the same turn as the commit (`-u origin
  main` if the upstream is somehow unset) — do not leave commits sitting locally waiting to be
  asked about. If the push fails, say so; do not silently treat the commit as done.
- Committing itself is still on request, as always — these two rules say *where* a commit goes and
  what happens *after* it, not that work should be committed unprompted.

## Code style

- Prettier-ish: 2-space indent, single quotes, no semicolons, explicit return types on functions.
- **Comment policy (overrides the global no-comments rule):** this repo is deliberately densely
  commented, and that is where the reasoning this file only indexes actually lives. New code keeps
  that style — explain Windows quirks, docker gotchas and non-obvious decisions inline, focusing
  on *why* and on constraints the code cannot express.
- Cross-process types live in `src/shared/types.ts`; renderer-only types stay in the renderer.
