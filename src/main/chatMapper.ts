import type {
  ChatChip,
  ChatEntry,
  ChatQuestion,
  ChatQuestionAnswer,
  ChatQuestionOption,
  ChatRewindRange,
  ChatRole,
  ChatTodo,
  ChatToolBody,
  ChatToolStatus
} from '@shared/types'
import { modelName } from '@shared/models'

// The chat log's one mapper: Claude Code's own JSON → the rows the window draws.
//
// It is deliberately ONE function for two sources. While a turn runs, rows are
// painted from the stream (provisional); at the turn's `result` main re-reads the
// bytes appended to the transcript, maps them through here and *replaces* that
// turn's rows with the transcript-derived ones. That is what makes history the
// app never streamed look identical to history it did — structurally, rather than
// by keeping two mappers in step. Both envelopes carry the same Anthropic
// content-block array under `message`, with the same `message.id` and
// `tool_use.id`, so only the envelope differs and entry ids line up across the
// settle.
//
// **A whitelist, not a blacklist.** `attachment` alone was 2 313 lines in a
// 20-transcript sample, of which 1 877 were `total_tokens_reminder` — injected
// context, not conversation. New line types keep appearing as Claude Code ships:
// a whitelist degrades by missing something, a blacklist by rendering garbage.
//
// **`isSidechain` is never filtered on here, and that corrects the spec.** The
// rule inherited from #7 was "drop isSidechain in the main mapper", read off 20
// transcripts written by the *TUI*, where every line carries `isSidechain: false`.
// A transcript written by `claude -p` — which is every chat session — marks
// **every line true**, main conversation included (verified against 2.1.211:
// 0 false / all true in a -p file, the exact inverse of a TUI file). Filtering on
// it would blank the entire log for exactly the sessions this feature creates.
// It is also unnecessary: subagent work is not written into the parent file at
// all (it lives in the sibling subagents/ directory), so there is nothing here
// for the flag to protect against.

/** Injected context that must never reach a `you` row as though it were typed. */
const STRIP_TAGS = /<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>\s*/g

/**
 * Attached file paths ride in a delimited trailer rather than an interpolated
 * sentence, because the transcript is the history model: this parses back into
 * chips on reopen, where a path you typed by hand and a path you attached would
 * otherwise be indistinguishable. Images and PDFs need no marker — they are real
 * content blocks and replay as themselves.
 */
export const ATTACH_OPEN = '<vivarium-attached>'
export const ATTACH_CLOSE = '</vivarium-attached>'
const ATTACH_RE = /<vivarium-attached>\n([\s\S]*?)\n<\/vivarium-attached>/g

/** The synthetic user message Claude Code writes where a turn was cut. */
const INTERRUPT_MARKER = '[Request interrupted by user]'

/**
 * A typed slash command records as a plain user row wrapped in these — three
 * separate tags, read separately rather than as one anchored pattern. They are
 * *not* adjacent: `/goal fix the bugs` writes
 * `<command-name>` `<command-message>` `<command-args>`, in that order and on
 * their own lines, so a pattern that required args to follow the name silently
 * dropped every argument the user typed.
 */
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/

/**
 * A local command's own output. It arrives as an ordinary **user** line — often
 * in the same line as the command that produced it — which is why it has to be
 * recognised here and not only in the `system/local_command` branch below.
 * Without this the raw tags rendered inside a `you` bubble, as though the user
 * had typed `<local-command-stdout>Set model to …</local-command-stdout>`.
 */
const LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

/**
 * A **background** agent's completion.
 *
 * `Agent` with `run_in_background: true` returns immediately — its tool_result
 * says only `async_launched` and carries no outcome at all (no status, no
 * duration, no token count). The real outcome arrives later, and Claude Code
 * delivers it the same way it delivers a slash command's output: as an ordinary
 * **user** line, this time holding an XML block. Left alone it renders as a
 * tinted `you` bubble containing four hundred characters of markup and the whole
 * agent report, immediately above the paragraph in which Claude paraphrases that
 * same report — which is what "the user typed this" looks like when the user did
 * not type it. Same rule as the interrupt marker and `<local-command-stdout>`.
 *
 * It is not merely suppressed, because it is the *only* place the outcome of a
 * background agent is written down: `<tool-use-id>` names the row that launched
 * it, and the block carries the status and the usage that a synchronous Task's
 * `toolUseResult` would have carried. So it completes that row instead.
 */
const TASK_NOTE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/

/** One `<name>…</name>` out of a task notification, trimmed; '' when absent. */
function noteTag(body: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? ''
}

/**
 * Escape sequences in a local command's output. The CLI writes these coloured
 * when it thinks it has a terminal, and a chat has none anywhere in its path, so
 * they would land in the log as literal noise. Only real ESC-introduced
 * sequences are stripped — a bare `[1m]` is left alone, because that is a model
 * name suffix (the 1M-context variants) and not a colour code.
 */
const CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '')
}

// Truncation budgets. Main keeps the full body and hands the renderer these —
// tool output is the entire weight of a transcript and variant D keeps most of it
// collapsed anyway, so shipping it all would make a 10 MB conversation a 10 MB
// structured clone *and* a 10 MB resident store.
const BASH_TAIL_LINES = 40
const DIFF_MAX_LINES = 200

/** Tool name → gutter role. Everything unrecognised is a `run`. */
function roleForTool(name: string): ChatRole {
  if (/^(Read|NotebookRead)$/.test(name)) return 'read'
  if (/^(Grep|Glob|WebSearch|WebFetch|ToolSearch)$/.test(name)) return 'read'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit'
  if (/^(Bash|BashOutput|KillShell|PowerShell)$/.test(name)) return 'bash'
  if (name === 'Skill') return 'cmd'
  if (/^(Task|Agent)$/.test(name)) return 'task'
  if (/^Task(Create|Update)$/.test(name)) return 'todo'
  if (name === 'AskUserQuestion') return 'ask'
  if (name === 'ExitPlanMode') return 'plan'
  return 'run'
}

type Json = Record<string, unknown>

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Flatten a tool_result's content (string, or a block array) to plain text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((b) => {
      const o = obj(b)
      if (!o) return ''
      if (o.type === 'text') return str(o.text)
      if (o.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function firstLine(s: string): string {
  const t = s.trim().split('\n')[0] ?? ''
  return t.length > 160 ? `${t.slice(0, 157)}…` : t
}

function compact(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Human title for a tool card — the thing you scan for when scrolling back. */
function toolTitle(name: string, input: Json): string {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const off = num(input.offset)
      const lim = num(input.limit)
      return off !== null ? `${path}:${off}${lim !== null ? `-${off + lim}` : ''}` : path
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path
    case 'Bash':
      return compact(str(input.command), 160)
    case 'Grep':
      return `${str(input.pattern)}${input.path ? ` in ${str(input.path)}` : ''}`
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Skill':
      return `/${str(input.skill) || str(input.name)}`
    case 'TaskCreate':
      return str(input.subject)
    case 'TaskUpdate':
      return `${str(input.taskId)} · ${str(input.status)}`
    default: {
      const summary = compact(
        Object.entries(input)
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' '),
        100
      )
      return summary ? `${name} ${summary}` : name
    }
  }
}

/** Body + one-line outcome for a completed tool call. */
function toolBody(
  name: string,
  input: Json,
  result: Json | null,
  text: string
): { body: ChatToolBody; result: string } {
  // An edit shows its diff and a command shows the tail of its output; a read
  // and a search collapse to their gutter line. A read changed nothing; a diff is
  // what you scrolled back for.
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
    const lines: string[] = []
    let plus = 0
    let minus = 0
    for (const hunk of arr(result?.structuredPatch)) {
      const h = obj(hunk)
      if (!h) continue
      for (const raw of arr(h.lines)) {
        const l = str(raw)
        if (l.startsWith('+')) plus++
        else if (l.startsWith('-')) minus++
        lines.push(l)
      }
      lines.push('')
    }
    if (lines.length === 0) {
      // No structured patch (a Write, or an older CLI): show what was written,
      // marked as added so the diff renderer has something honest to colour.
      const content = str(input.content) || str(input.new_string)
      for (const l of content.split('\n')) {
        lines.push(`+${l}`)
        plus++
      }
      for (const l of str(input.old_string).split('\n')) {
        if (!l) continue
        lines.push(`-${l}`)
        minus++
      }
    }
    return {
      body: { kind: 'diff', text: lines.join('\n'), truncated: false },
      result: plus || minus ? `+${plus} −${minus}` : ''
    }
  }
  if (/^(Bash|BashOutput|PowerShell)$/.test(name)) {
    const out = [str(result?.stdout), str(result?.stderr)].filter(Boolean).join('\n') || text
    const code = num(result?.exitCode) ?? num(result?.exit_code)
    return {
      body: { kind: 'text', text: out, truncated: false },
      result: code ? `exit ${code}` : ''
    }
  }
  if (/^(Read|NotebookRead)$/.test(name)) {
    // Dropped entirely, not clipped: a read is the single largest thing in a
    // transcript and the least worth carrying — the card is collapsed anyway.
    const n = text ? text.split('\n').length : 0
    return { body: { kind: 'none', text: '', truncated: false }, result: n ? `${n} lines` : '' }
  }
  return { body: { kind: 'text', text, truncated: false }, result: '' }
}

/** Clip a body for the wire, leaving the full text for `chat:body` to serve. */
export function truncateBody(body: ChatToolBody): ChatToolBody {
  if (body.kind === 'none' || !body.text) return body
  const lines = body.text.split('\n')
  const max = body.kind === 'diff' ? DIFF_MAX_LINES : BASH_TAIL_LINES
  if (lines.length <= max) return body
  // A command's *tail* is the useful end; a diff's head is.
  const kept = body.kind === 'diff' ? lines.slice(0, max) : lines.slice(-max)
  return { kind: body.kind, text: kept.join('\n'), truncated: true }
}

/**
 * What the user chose, out of the tool_result — **structured first**.
 *
 * Claude Code files the whole answer under the transcript line's own
 * `toolUseResult` as `{questions, answers, annotations}`, keyed by question
 * text, so the settled row needs no string-matching at all: `answers` is exact
 * and `annotations[q].notes` is the free text the prose does not reliably carry.
 * The prose rule below is the *fallback* for the live stream, where a
 * `tool_result` block can arrive with no structured sibling.
 *
 * `values` is a list because a multi-select answer is one joined string on the
 * wire (`"A, B"`), and splitting it is only safe when every part is a real
 * option label — a single-select answer may legitimately contain a comma, and a
 * free-text "Other" answer usually does.
 */
function parseAnswers(
  questions: ChatQuestion[],
  structured: Json | null,
  text: string
): ChatQuestionAnswer[] {
  const answers = obj(structured?.answers)
  const annotations = obj(structured?.annotations)
  const raw = new Map<string, string>()
  const notes = new Map<string, string>()

  if (answers) {
    for (const q of questions) {
      const v = answers[q.question]
      // An array survives as an array when the host sent one: the CLI's zod
      // preprocess joins it, but `call()` reads the raw input.
      if (Array.isArray(v)) raw.set(q.question, v.map((x) => str(x)).join(', '))
      else if (typeof v === 'string' && v) raw.set(q.question, v)
    }
  }
  if (annotations) {
    for (const q of questions) {
      const a = obj(annotations[q.question])
      const n = str(a?.notes)
      if (n) notes.set(q.question, n)
    }
  }

  if (raw.size === 0) {
    // Fallback: `Your questions have been answered: "<q>"="<answer>", …`.
    // Anchored on the question texts we already hold rather than on a bare
    // `"…"="…"` sweep, so a preview or a note quoting a `"x"="y"` of its own
    // cannot inject a phantom answer. This is the *only* prose-parsing rule in
    // the design — a cancelled tool is detected structurally (see markCancelled)
    // precisely so it stays one and does not become a pattern — and it degrades
    // to rendering the options un-ticked.
    for (const q of questions) {
      const head = `"${q.question}"="`
      const i = text.indexOf(head)
      if (i < 0) continue
      const end = text.indexOf('"', i + head.length)
      if (end < 0) continue
      const v = text.slice(i + head.length, end)
      if (v) raw.set(q.question, v)
    }
  }

  const out: ChatQuestionAnswer[] = []
  for (const q of questions) {
    const v = raw.get(q.question)
    const note = notes.get(q.question)
    if (!v && !note) continue
    // `(notes only)` is the CLI's sentinel for "notes, no option picked". This
    // window cannot produce one — its Other row *is* an answer — but a
    // conversation started in the TUI and reopened here can hold one, and
    // rendering it as a chip would show the sentinel as though it were typed.
    const picked = v && v !== NO_OPTION ? splitValues(v, q) : []
    out.push({ question: q.question, values: picked, notes: note })
  }
  return out
}

/** The CLI's own "notes, no option picked" sentinel, written into `answers`. */
const NO_OPTION = '(notes only)'

/**
 * `"A, B"` is two ticks; `"Use tabs, not spaces"` is one. Split only when every
 * part is a label the question actually offered — the same test the CLI applies
 * to its own result before deciding the answer was well-formed.
 */
function splitValues(value: string, q: ChatQuestion): string[] {
  if (q.options.some((o) => o.label === value)) return [value]
  if (!q.multiSelect) return [value]
  const parts = value.split(',').map((p) => p.trim())
  if (parts.length > 1 && parts.every((p) => q.options.some((o) => o.label === p))) return parts
  return [value]
}

/** `AskUserQuestion`'s input, shared by the mapper and the live blocking card. */
export function parseQuestions(input: Json): ChatQuestion[] {
  const out: ChatQuestion[] = []
  for (const q of arr(input.questions)) {
    const o = obj(q)
    if (!o) continue
    const options: ChatQuestionOption[] = []
    for (const opt of arr(o.options)) {
      const oo = obj(opt)
      if (oo)
        options.push({
          label: str(oo.label),
          description: str(oo.description) || undefined,
          preview: str(oo.preview) || undefined
        })
    }
    out.push({
      question: str(o.question),
      header: str(o.header) || undefined,
      multiSelect: o.multiSelect === true,
      options
    })
  }
  return out
}

export interface MapResult {
  entries: ChatEntry[]
  /** full tool bodies, by entry id — kept in main, fetched on expand */
  bodies: Map<string, string>
  /** the running todo fold, mutated in place by the caller's mapper */
  todos: Map<string, ChatTodo>
  /** last model seen, so a later pass can keep emitting `model · a → b` dividers */
  model: string | null
  /** sub-log rows keyed by their spawning tool_use id (stream only) */
  subagents: Map<string, ChatEntry[]>
}

/**
 * One conversation's mapper. Stateful across lines because a `tool_use` and its
 * `tool_result` are two of them, and because a model divider is *derived* from
 * consecutive assistant messages disagreeing rather than from a "you clicked the
 * chip" event — which gets the semantics right for free: switching and then not
 * taking a turn leaves no divider, because nothing ran differently.
 */
export class ChatMapper {
  readonly entries: ChatEntry[] = []
  readonly bodies = new Map<string, string>()
  /**
   * The pictures this mapper found, as `data:` URLs, by the handle their chip
   * carries.
   *
   * Kept beside the rows rather than on them, exactly as `bodies` is and for the
   * same reason: an image block is the heaviest thing in a transcript by a wide
   * margin, and a row is copied and shipped over IPC every time its turn moves.
   * `ChatService` drains this into its own bounded store and serves one at a
   * time (see `chat:image`).
   */
  readonly images = new Map<string, string>()
  readonly todos = new Map<string, ChatTodo>()
  readonly subagents = new Map<string, ChatEntry[]>()
  model: string | null = null

  private tools = new Map<string, { entry: ChatEntry; name: string; input: Json }>()
  /**
   * The `task` rows this mapper has produced, by spawning tool_use id.
   *
   * Separate from `tools`, which is the tool_use→tool_result pairing and is
   * *deleted* the moment the result lands. A background agent's outcome arrives
   * long after that (see TASK_NOTE_RE), so the row has to stay reachable once its
   * launch has already been answered.
   */
  private taskRows = new Map<string, Extract<ChatEntry, { kind: 'task' }>>()
  /**
   * One sub-mapper per subagent, kept for the life of this mapper.
   *
   * It used to be a fresh `ChatMapper` per *line*, which silently threw away
   * everything a mapper is stateful for: a `tool_result` looks its `tool_use` up
   * in `tools`, so with the pairing reset between the two lines every result in
   * every live sub-log was dropped on the floor (`toolResult` returns null when
   * it has no pending call) and every tool card sat there spinning forever. The
   * id counters restarted too, so rows collided on `#0`. Reopening the same
   * conversation read the sibling file with one mapper and looked perfect, which
   * is what made this look like a rendering bug rather than a mapping one.
   */
  private subMappers = new Map<string, ChatMapper>()
  private seq = 0
  private turn = 0
  /** index in `entries` where the current turn began, for the cancelled sweep */
  private turnStart = 0
  /** how many blocks of each type one message has already contributed */
  private blockSeq = new Map<string, number>()

  constructor(turn = 0) {
    this.turn = turn
  }

  setTurn(turn: number): void {
    this.turn = turn
    this.turnStart = this.entries.length
  }

  /**
   * Hand this mapper the `task` rows an earlier pass produced.
   *
   * **A background agent outlives the mapper that launched it.** The live mapper
   * is dropped at every `result` and a settle builds a fresh one per turn, but
   * an agent launched in turn 3 reports in turn 5 — so without this the
   * notification lands in a mapper that has never heard of the row it names, and
   * degrades to the orphan case for a row that is right there on screen. The
   * rows are adopted **by reference**, which is the whole trick: completing one
   * updates the object main and the renderer are already holding.
   */
  adoptTasks(entries: ChatEntry[]): void {
    for (const e of entries) if (e.kind === 'task') this.taskRows.set(e.toolUseId, e)
  }

  private id(prefix: string): string {
    return `${prefix}#${this.seq++}`
  }

  /**
   * The id of one content block's row: message id, block type, and the ordinal
   * of that block **among blocks of the same type in the same message**.
   *
   * The type is load-bearing and always was: Claude Code writes one transcript
   * line per content block but gives every line of one API message the same
   * `message.id`, so a message whose text and tool call are two lines yields two
   * blocks both at content-array index 0. Without the type in the key the tool
   * card silently overwrites the paragraph above it.
   *
   * The *ordinal* replaces the content-array index, and that is the fix for the
   * ids drifting apart across the three sources this id has to be computed from.
   * The index means three different things depending on where the block arrives:
   * a transcript line and a per-block `assistant` frame each carry a one-element
   * content array (index always 0), while `stream_event` deltas number blocks
   * across the whole message — so a `[thinking, text]` message painted from
   * deltas produced `msg#1#text` while its settled row was `msg#0#text`, and the
   * paragraph rendered twice until the turn ended. Counting per type is the one
   * derivation all three agree on, since blocks arrive in order everywhere.
   *
   * The first occurrence deliberately has no suffix, so `chat.ts` can compute
   * the same id for a partial-text row without knowing anything but the message
   * id and how many text blocks it has already opened.
   */
  private blockId(msgId: string, type: string): string {
    const key = `${msgId}#${type}`
    const n = this.blockSeq.get(key) ?? 0
    this.blockSeq.set(key, n + 1)
    return n === 0 ? key : `${key}#${n}`
  }

  private push<T extends ChatEntry>(e: T): T {
    this.entries.push(e)
    return e
  }

  /**
   * Feed one line (transcript) or frame (stream). `at` is the host-read
   * timestamp used when the envelope carries none.
   *
   * Returns the entries this line created or *changed* — a `tool_result` mutates
   * the card its `tool_use` already produced, and the renderer upserts by id.
   */
  feed(line: Json, at: number): ChatEntry[] {
    const before = this.entries.length
    const touched: ChatEntry[] = []
    const stamp = this.timeOf(line, at)

    // Subagent inner work is suppressed from the main log and never appended to
    // it: indenting it under the spawning row makes one subagent's bookkeeping
    // outweigh the conversation, and the log's whole argument is a single shared
    // left edge. It is buffered here instead and served as that row's sub-log.
    const parentId = str(line.parent_tool_use_id)
    if (parentId) {
      let sub = this.subMappers.get(parentId)
      if (!sub) {
        sub = new ChatMapper(this.turn)
        this.subMappers.set(parentId, sub)
      }
      // `feed` returns created *and changed* rows, so a tool_result ships the
      // card it just completed rather than nothing. Both sides of the wire
      // upsert these by id for exactly that reason.
      const rows = sub.feed({ ...line, parent_tool_use_id: '' }, at)
      if (rows.length) {
        // Merged by id rather than pushed. The caller drains this bucket after
        // every frame, so in practice a create and its completion land in two
        // separate drains and the merge is `chat.ts`'s to do — but the bucket
        // must not be the one place in the chain that can hold two states of one
        // row, or a drain that happens to be late ships a duplicate key.
        const list = this.subagents.get(parentId) ?? []
        for (const r of rows) {
          const i = list.findIndex((x) => x.id === r.id)
          if (i >= 0) list[i] = r
          else list.push(r)
        }
        this.subagents.set(parentId, list)
      }
      return []
    }

    switch (str(line.type)) {
      case 'user':
        this.user(line, stamp, touched)
        break
      case 'assistant':
        this.assistant(line, stamp)
        break
      case 'system':
        this.system(line, stamp)
        break
      default:
        break // whitelist: everything else is injected context or bookkeeping
    }

    for (let i = before; i < this.entries.length; i++) touched.push(this.entries[i])
    return touched
  }

  private timeOf(line: Json, fallback: number): number {
    const ts = str(line.timestamp)
    if (ts) {
      const t = Date.parse(ts)
      if (Number.isFinite(t)) return t
    }
    return fallback
  }

  // ---- user lines ---------------------------------------------------------
  private user(line: Json, at: number, touched: ChatEntry[]): void {
    // `isMeta` covers a slash command's expanded prompt: the command itself is
    // already recorded as a plain user row, and rendering both would show the
    // machinery twice. (No isSidechain test — see the note at the top.)
    if (line.isMeta === true) return
    const message = obj(line.message)
    if (!message) return
    const uuid = str(line.uuid) || this.id('u')
    const content = message.content

    if (typeof content === 'string') {
      this.userText(content, `${uuid}#0`, at, [], touched)
      return
    }

    const chips: ChatChip[] = []
    const texts: { text: string; id: string }[] = []
    arr(content).forEach((block, i) => {
      const b = obj(block)
      if (!b) return
      const type = str(b.type)
      if (type === 'text') texts.push({ text: str(b.text), id: `${uuid}#${i}` })
      else if (type === 'image') {
        // The block index, not a counter: the id has to name the same picture
        // when this line is mapped again — every settle re-reads its turn, and a
        // reopen re-reads the whole file. A counter would renumber on the second
        // pass and orphan the copy the renderer had already fetched.
        const id = `${uuid}#img#${i}`
        const src = obj(b.source)
        const data = str(src?.data)
        const media = str(src?.media_type) || 'image/png'
        // Only base64 blocks carry the picture. A `url` source would need the
        // renderer to reach the network on a model's say-so, which this window
        // does not do anywhere (see the image note in Markdown.tsx).
        if (data && str(src?.type) === 'base64') this.images.set(id, `data:${media};base64,${data}`)
        // The transcript records no filename — the API block has nowhere to put
        // one — so the picture is its own label, and the chip says so when the
        // bytes are not around to draw.
        chips.push({ kind: 'image', name: 'image', imageId: data ? id : undefined })
      }
      else if (type === 'document') chips.push({ kind: 'document', name: str(b.title) || 'document' })
      else if (type === 'tool_result') {
        const done = this.toolResult(b, obj(line.toolUseResult) ?? obj(line.tool_use_result), at)
        if (done) touched.push(done)
      }
    })
    // Attachment blocks and their prose belong to one send; the chips ride the
    // first text row so a split-send reads as the single message it was.
    if (texts.length === 0 && chips.length > 0) {
      this.push({
        id: `${uuid}#chips`,
        role: 'you',
        at,
        turn: this.turn,
        kind: 'text',
        md: '',
        chips
      })
      return
    }
    texts.forEach((t, i) => this.userText(t.text, t.id, at, i === 0 ? chips : [], touched))
  }

  private userText(
    raw: string,
    id: string,
    at: number,
    chips: ChatChip[],
    touched: ChatEntry[]
  ): void {
    const text = raw.replace(STRIP_TAGS, '').trim()
    if (!text) return

    // An interrupt is a row, not a state: a cut turn is an ordinary turn with one
    // extra row in it. Rendering this as a tinted `you` row — the default for a
    // user message with a plain text block — would be a lie, "as though you had
    // typed the words".
    if (text === INTERRUPT_MARKER) {
      this.push({
        id,
        role: 'stop',
        at,
        turn: this.turn,
        kind: 'stop',
        text: 'interrupted',
        tone: 'muted'
      })
      return
    }

    // A background agent reporting in. Not a `you` row for the same reason the
    // marker above is not one, and folded into the row that launched it rather
    // than shown as a row of its own — see TASK_NOTE_RE.
    const note = TASK_NOTE_RE.exec(text)
    if (note) {
      this.taskNotification(note[1], id, at, touched)
      return
    }

    // A slash command and its local output are *machinery*, and both arrive on
    // ordinary user lines — sometimes on the same one. Rendering either as a
    // `you` row is a lie in the same way the interrupt marker above is: the
    // shipped version printed the raw `<local-command-stdout>…` tags inside the
    // tinted bubble, as though the user had typed the markup.
    const name = COMMAND_NAME_RE.exec(text)
    const stdout = LOCAL_STDOUT_RE.exec(text)
    if (name || stdout) {
      if (name) {
        const args = (COMMAND_ARGS_RE.exec(text)?.[1] ?? '').trim()
        this.push({
          id,
          role: 'you',
          at,
          turn: this.turn,
          kind: 'text',
          md: `${name[1].trim()}${args ? ` ${args}` : ''}`,
          chips: chips.length ? chips : undefined
        })
      }
      if (stdout) {
        const md = stripAnsi(stdout[1]).trim()
        // Its own row when the command echo took `id`, so the two never collide
        // and the log keeps reading command-then-answer.
        const outId = name ? `${id}#out` : id
        if (md) {
          this.bodies.set(outId, md)
          this.push({
            id: outId,
            role: 'cmd',
            at,
            turn: this.turn,
            kind: 'cmd',
            title: '',
            md,
            truncated: false
          })
        }
      }
      return
    }

    // Pull the attached-path trailer back out into chips.
    const paths: ChatChip[] = []
    const body = text
      .replace(ATTACH_RE, (_m, inner: string) => {
        for (const p of inner.split('\n').map((s) => s.trim()).filter(Boolean)) {
          paths.push({ kind: 'path', name: p.split('/').pop() ?? p, detail: p })
        }
        return ''
      })
      .trim()
    const all = [...chips, ...paths]
    this.push({
      id,
      role: 'you',
      at,
      turn: this.turn,
      kind: 'text',
      md: body,
      chips: all.length ? all : undefined
    })
  }

  // ---- assistant lines ----------------------------------------------------
  private assistant(line: Json, at: number): void {
    const message = obj(line.message)
    if (!message) return
    const msgId = str(message.id) || str(line.uuid) || this.id('a')

    // Derived, not clicked: the row marks where the model actually changed.
    const model = str(message.model)
    if (model) {
      if (this.model && this.model !== model) {
        this.push({
          id: this.id('model'),
          role: 'claude',
          at,
          turn: this.turn,
          kind: 'divider',
          // The same spelling the header chip and the composer use — one
          // formatter in @shared, because a divider saying `sonnet → opus`
          // under a chip saying `Opus 5` is two answers to one question.
          text: `model · ${modelName(this.model)} → ${modelName(model)}`
        })
      }
      this.model = model
    }

    // The ordinal is claimed only where a row is actually pushed: an empty text
    // block writes no transcript line and streams no delta, so counting it would
    // shift every later block's id in one source and not the others.
    arr(message.content).forEach((block) => {
      const b = obj(block)
      if (!b) return
      const type = str(b.type)
      if (type === 'text') {
        const md = str(b.text).trim()
        if (md) {
          this.push({
            id: this.blockId(msgId, 'text'),
            role: 'claude',
            at,
            turn: this.turn,
            kind: 'text',
            md
          })
        }
      } else if (type === 'thinking' || type === 'redacted_thinking') {
        const md = str(b.thinking) || str(b.text)
        if (md) {
          this.push({
            id: this.blockId(msgId, 'thinking'),
            role: 'think',
            at,
            turn: this.turn,
            kind: 'thinking',
            md
          })
        }
      } else if (type === 'tool_use') {
        this.toolUse(b, this.blockId(msgId, 'tool_use'), at)
      }
    })
  }

  private toolUse(b: Json, id: string, at: number): void {
    const name = str(b.name)
    const input = obj(b.input) ?? {}
    const toolUseId = str(b.id) || id
    const role = roleForTool(name)

    if (role === 'todo') {
      // A one-line row per call, collapsed the way a read is — it changed nothing
      // on disk — so the log stays a complete record and nothing the agent did is
      // omitted. The *fold* (current state) is rebuilt separately, in main.
      const text =
        name === 'TaskCreate'
          ? `+ ${str(input.subject)}`
          : `${str(input.taskId)} · → ${str(input.status)}`
      const entry = this.push({ id, role: 'todo', at, turn: this.turn, kind: 'todo', text })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    if (role === 'task') {
      // Live, the row is built straight off the tool call; the settled row costs
      // no extra read either, because the parent transcript's own toolUseResult
      // carries agentId/status/duration/tokens. Only *expanding* touches the
      // sibling file, on demand.
      const entry = this.push({
        id,
        role: 'task',
        at,
        turn: this.turn,
        kind: 'task',
        toolUseId,
        agentId: null,
        // `general-purpose` rather than a generic `agent`, because that is what
        // the CLI actually launches when the call names no type — verified
        // against the agent's own `subagents/agent-<id>.meta.json`, which
        // records `agentType: "general-purpose"` for exactly these calls. The
        // background `Agent` tool takes no `subagent_type` at all, so every one
        // of them used to print the placeholder.
        agentType: str(input.subagent_type) || 'general-purpose',
        description: str(input.description) || compact(str(input.prompt), 80),
        status: 'running',
        durationMs: null,
        tools: null,
        tokens: null,
        running: true
      })
      this.tools.set(toolUseId, { entry, name, input })
      // Outlives `tools`, which the result deletes — a background agent reports
      // long after its launch was answered. See taskNotification.
      this.taskRows.set(toolUseId, entry)
      return
    }

    if (name === 'AskUserQuestion') {
      const entry = this.push({
        id,
        role: 'ask',
        at,
        turn: this.turn,
        kind: 'ask',
        questions: parseQuestions(input),
        answers: [],
        pending: true
      })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    if (name === 'ExitPlanMode') {
      const entry = this.push({
        id,
        role: 'plan',
        at,
        turn: this.turn,
        kind: 'plan',
        md: str(input.plan),
        state: 'pending'
      })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    const entry = this.push({
      id,
      role,
      at,
      turn: this.turn,
      kind: 'tool',
      toolUseId,
      title: toolTitle(name, input),
      result: '',
      status: 'running',
      body: { kind: 'none', text: '', truncated: false }
    })
    this.tools.set(toolUseId, { entry, name, input })
  }

  /**
   * A background agent's completion notification completes the `task` row that
   * launched it.
   *
   * Everything the row was missing is in here and nowhere else: `<status>`, and
   * a `<usage>` block whose three numbers are the same three a synchronous
   * Task's `toolUseResult` reports as `totalDurationMs` / `totalToolUseCount` /
   * `totalTokens`. Folding them in is what makes an async agent's row read
   * identically to a synchronous one's, which is the point — the difference
   * between the two is a scheduling detail of the CLI, not something the log
   * should make the reader decode.
   *
   * The `<result>` is deliberately **not** given a row. It is the agent's whole
   * report, it is already the last row of the sub-log this task expands into,
   * and Claude invariably paraphrases it in the very next message — three copies
   * of one paragraph, two of them uninvited.
   *
   * A notification whose `<tool-use-id>` names no row we hold (a `/clear`
   * between launch and report, or a rewind over the launch) still says
   * something happened, so it degrades to a one-line muted row rather than
   * vanishing.
   */
  private taskNotification(body: string, id: string, at: number, touched: ChatEntry[]): void {
    const toolUseId = noteTag(body, 'tool-use-id')
    const entry = this.taskRows.get(toolUseId)
    const status = noteTag(body, 'status') || 'completed'
    const usage = /<usage>([\s\S]*?)<\/usage>/.exec(body)?.[1] ?? ''
    const usageNum = (name: string): number | null => {
      const raw = noteTag(usage, name)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) ? n : null
    }

    if (!entry) {
      const summary = noteTag(body, 'summary') || `agent ${status}`
      this.push({ id, role: 'stop', at, turn: this.turn, kind: 'stop', text: summary, tone: 'muted' })
      return
    }

    entry.agentId = entry.agentId || noteTag(body, 'task-id') || null
    entry.status = status
    entry.durationMs = usageNum('duration_ms') ?? entry.durationMs
    entry.tools = usageNum('tool_uses') ?? entry.tools
    entry.tokens = usageNum('subagent_tokens') ?? entry.tokens
    entry.running = false
    // The row is older than this line, so nothing appended — say so explicitly
    // or the renderer never hears that the agent stopped.
    touched.push(entry)
  }

  /** A tool_result completes the card its tool_use already produced. */
  private toolResult(b: Json, structured: Json | null, at: number): ChatEntry | null {
    const toolUseId = str(b.tool_use_id)
    const pending = this.tools.get(toolUseId)
    if (!pending) return null
    this.tools.delete(toolUseId)
    const { entry, name, input } = pending
    const isError = b.is_error === true
    const text = resultText(b.content)

    if (entry.kind === 'todo') {
      const id = str(structured?.taskId) || str(input.taskId)
      if (name === 'TaskCreate' && id) {
        this.todos.set(id, {
          id,
          subject: str(input.subject),
          activeForm: str(input.activeForm) || undefined,
          status: 'pending'
        })
        entry.text = `+ ${str(input.subject)}`
      } else if (id) {
        const status = str(input.status)
        const existing = this.todos.get(id)
        // `deleted` permanently removes a task — the strip is a mirror of what
        // the agent believes, so it has to lose the entry too.
        if (status === 'deleted') this.todos.delete(id)
        else if (existing) {
          const change = obj(structured?.statusChange)
          existing.status = (status || existing.status) as ChatTodo['status']
          entry.text = `${existing.subject} · ${str(change?.from) || 'pending'} → ${
            str(change?.to) || status
          }`
        }
      }
      return entry
    }

    if (entry.kind === 'task') {
      // `|| entry.agentId`, not `|| null`: a re-read of a turn must not blank an
      // id an earlier pass already recovered.
      entry.agentId = str(structured?.agentId) || entry.agentId
      entry.agentType = str(structured?.agentType) || entry.agentType
      // **A background launch is not a finished agent.** `run_in_background`
      // returns the instant the agent starts, and this result says only that:
      // `status: "async_launched"`, no duration, no tool count, no tokens. Taking
      // it as the outcome froze the row at that word with a blank stats line and
      // no clock — neither running nor finished, which is what a background agent
      // looked like in this app until now. The row stays running until its
      // notification lands (taskNotification), or until the file ends without one
      // (finishHistory).
      if (structured?.isAsync === true || str(structured?.status) === 'async_launched') {
        entry.status = 'running'
        entry.running = true
        return entry
      }
      entry.status = isError ? 'failed' : str(structured?.status) || 'completed'
      entry.durationMs = num(structured?.totalDurationMs)
      entry.tools = num(structured?.totalToolUseCount)
      entry.tokens = num(structured?.totalTokens)
      entry.running = false
      return entry
    }

    if (entry.kind === 'ask') {
      entry.pending = false
      // Keyed against the questions off the tool_use we already mapped — the
      // result echoes its own copy, but the answers map is keyed by question
      // *text* either way, and this one is already parsed.
      entry.answers = parseAnswers(entry.questions, structured, text)
      return entry
    }

    if (entry.kind === 'plan') {
      entry.state = isError ? 'denied' : 'approved'
      return entry
    }

    if (entry.kind !== 'tool') return entry
    const { body, result } = toolBody(name, input, structured, text)
    entry.status = isError ? 'error' : 'ok'
    entry.result = isError ? firstLine(text) || 'error' : result
    entry.body = body
    if (body.text) this.bodies.set(entry.id, body.text)
    if (roleForTool(name) === 'cmd') {
      // A Skill tool_use reads identically whether you typed it or Claude reached
      // for it — same `cmd` row either way.
      const md = body.text || text
      const replacement: ChatEntry = {
        id: entry.id,
        role: 'cmd',
        at: entry.at,
        turn: entry.turn,
        kind: 'cmd',
        title: entry.title,
        md,
        truncated: false
      }
      const i = this.entries.indexOf(entry)
      if (i >= 0) this.entries[i] = replacement
      return replacement
    }
    void at
    return entry
  }

  // ---- system lines -------------------------------------------------------
  private system(line: Json, at: number): void {
    const subtype = str(line.subtype)
    if (subtype === 'local_command') {
      // Promoted out of the drop list: without this row `/context` renders live
      // and then *vanishes* a second later at `result`, when the turn's entries
      // are replaced with transcript-derived ones.
      const raw = str(line.content)
      const m = LOCAL_STDOUT_RE.exec(raw)
      const md = stripAnsi(m ? m[1] : raw).trim()
      if (!md) return
      const id = str(line.uuid) || this.id('cmd')
      this.bodies.set(id, md)
      this.push({ id, role: 'cmd', at, turn: this.turn, kind: 'cmd', title: '', md, truncated: false })
      return
    }
    if (subtype === 'compact_boundary') {
      // Not decoration: without it the log reads as continuous when it is not,
      // and the user is left wondering why the agent re-reads a file it read.
      const meta = obj(line.compactMetadata) ?? obj(line.compact_metadata) ?? line
      const pre = num(meta.preTokens) ?? num(meta.pre_tokens)
      const post = num(meta.postTokens) ?? num(meta.post_tokens)
      const span = pre !== null && post !== null ? ` · ${tok(pre)} → ${tok(post)} tokens` : ''
      this.push({
        id: str(line.uuid) || this.id('compact'),
        role: 'claude',
        at,
        turn: this.turn,
        kind: 'divider',
        text: `compacted${span}`
      })
      return
    }
    if (subtype === 'turn_duration') {
      // Makes reloaded history *richer* than what the stream painted — the one
      // direction in which asymmetry is welcome.
      const ms = num(line.durationMs) ?? num(line.duration_ms) ?? num(line.duration)
      if (ms === null) return
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i]
        if (e.kind === 'turn') {
          e.durationMs = ms
          return
        }
      }
      this.push({
        id: this.id('turn'),
        role: 'run',
        at,
        turn: this.turn,
        kind: 'turn',
        startedAt: at - ms,
        durationMs: ms
      })
    }
  }

  // ---- turn-level sweeps --------------------------------------------------
  /**
   * Classify the tool calls an interrupt killed.
   *
   * **Position, not wording.** Reopened, a cancelled call and a genuinely failed
   * one are both `is_error: true`, so the rule is: the error tool_results with
   * nothing after them in the turn but the interrupt marker are the cancelled
   * ones. A tool that really failed earlier always has assistant blocks after it,
   * because the agent kept going.
   */
  markCancelled(from = this.turnStart): void {
    for (let i = this.entries.length - 1; i >= from; i--) {
      const e = this.entries[i]
      if (!(e.kind === 'stop' && e.text === 'interrupted')) continue
      for (let j = i - 1; j >= from; j--) {
        const prev = this.entries[j]
        if (prev.kind === 'tool') {
          if (prev.status !== 'error') break
          prev.status = 'cancelled'
          // The synthetic result carries only "The user doesn't want to proceed
          // with this tool use…", so an open card would be a card showing nothing.
          prev.result = 'cancelled'
          prev.body = { kind: 'none', text: '', truncated: false }
          continue
        }
        if (prev.kind === 'plan') {
          // A denied plan sitting above the marker was cancelled, not denied —
          // which is what actually happened to it.
          if (prev.state === 'denied') prev.state = 'cancelled'
          continue
        }
        if (prev.kind === 'ask' || prev.kind === 'todo' || prev.kind === 'task') continue
        break
      }
      return
    }
  }

  /**
   * Close a whole-file pass. A transcript whose final entry is a `user` message
   * with no assistant reply is a turn whose process died mid-stream: killing the
   * in-container `claude` is completely silent — no result, no error line, no
   * terminal_reason — so the file holds the prompt and nothing else. Without this
   * a reopened chat shows a user message followed by nothing, which reads as a
   * lost message.
   *
   * The partial text the user watched stream is *not* recoverable here, because
   * none was ever written. That is the one place live-equals-reopened
   * structurally cannot hold, and it is stated rather than papered over.
   */
  finishHistory(at: number): void {
    // A background agent still marked running at the end of a whole-file read
    // has no completion anywhere in this conversation. Almost always that means
    // it never got one: the agent lived inside the CLI process that wrote the
    // file, and the read that matters here is the one at *open*, where that
    // process is already gone. Left alone the row would sit on screen with a
    // clock ticking up from last Tuesday, so it says the one true thing there is
    // to say instead. (The other caller is the re-read after a revert, where an
    // agent really could still be running — and that case repairs itself: its
    // notification completes the row by id when it lands.)
    for (const e of this.entries) {
      if (e.kind === 'task' && e.running) {
        e.running = false
        e.status = 'no report'
      }
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.kind === 'text' && e.role === 'you') {
        this.push({
          id: this.id('stop'),
          role: 'stop',
          at,
          turn: this.turn,
          kind: 'stop',
          text: 'no reply — the CLI stopped before answering',
          tone: 'alert',
          retry: true
        })
      }
      // Anything else as the final entry means the turn produced *something*.
      return
    }
  }
}

function tok(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export { roleForTool, toolTitle }

/**
 * The id `ChatMapper.blockId` will compute for the `n`-th text block of a
 * message — the one thing `chat.ts` needs to paint a partial row that upserts
 * into its own settled row instead of duplicating it. Exported rather than
 * spelled out there, because two copies of this rule drifting apart is exactly
 * the bug it exists to fix.
 */
export function textBlockId(msgId: string, ordinal: number): string {
  return ordinal === 0 ? `${msgId}#text` : `${msgId}#text#${ordinal}`
}

/**
 * Split a transcript read at its last newline, and report the byte length of
 * what came before it.
 *
 * A read of a file Claude Code is still appending to routinely lands mid-line.
 * `parseNdjson` drops that fragment as malformed, which is right — but advancing
 * the stored byte offset past it is not: the rest of that line arrives on the
 * next read with no beginning, is dropped in turn, and the conversation loses a
 * whole message permanently. Consuming only whole lines makes the boundary
 * re-read itself instead, which is free (bytes, not a docker exec) and exact.
 */
export function completeLines(text: string): { complete: string; bytes: number } {
  const cut = text.lastIndexOf('\n')
  if (cut < 0) return { complete: '', bytes: 0 }
  const complete = text.slice(0, cut + 1)
  return { complete, bytes: Buffer.byteLength(complete, 'utf8') }
}

/**
 * Take **one turn's** worth of complete transcript lines out of a read, and
 * report the bytes they occupy.
 *
 * A settle stamps every row it maps with the turn it was asked to settle, so it
 * must not read past the end of that turn — and it can, because a queued
 * follow-up (the composer invites one: "type to queue a follow-up") is written
 * into the file the moment the CLI starts on it, which is the same moment the
 * previous turn's `result` sends us off to read. Without a boundary the settle
 * maps the follow-up's own prompt as part of the turn above it, and the log
 * shows that message twice: once stamped with the old turn by the settle, once
 * stamped with the new one by the optimistic paint.
 *
 * The boundary is Claude Code's own `system/turn_duration` line rather than a
 * guess at what a user message looks like — an interrupt marker, a slash
 * command's echo and its `<local-command-stdout>` reply are all plain user text
 * lines *inside* a turn, so any structural rule would have to enumerate them and
 * would break on the next one the CLI adds. When the marker is absent (an older
 * CLI, a turn that was cut) this consumes the whole read, which is exactly the
 * behaviour it replaces.
 */
export function takeTurn(text: string): { lines: Json[]; bytes: number } {
  const raw = text.split('\n')
  const lines: Json[] = []
  let bytes = 0
  // `text` always ends with a newline (see completeLines), so the final element
  // is the empty string after it and is not a line.
  for (let i = 0; i < raw.length - 1; i++) {
    bytes += Buffer.byteLength(raw[i], 'utf8') + 1
    const t = raw[i].trim()
    if (!t) continue
    let o: Json | null = null
    try {
      o = obj(JSON.parse(t))
    } catch {
      o = null
    }
    if (!o) continue
    lines.push(o)
    if (str(o.type) === 'system' && str(o.subtype) === 'turn_duration') break
  }
  return { lines, bytes }
}

export interface TranscriptWalk {
  /** the lines to map, in file order, with the abandoned stretches left out */
  lines: Json[]
  /** every kept `user` line, in file order, with the byte offset it starts at */
  users: { uuid: string; offset: number }[]
}

/**
 * Walk a whole-file transcript read, reporting where each line *starts*.
 *
 * Two callers need the same walk for opposite halves of it. `readHistory` wants
 * the lines minus the stretches a revert abandoned; `rewind` wants the ordered
 * user-line uuids to aim `rewind_conversation` at, plus the byte offset of the
 * one it is about to abandon. Doing it once, here, is what keeps the two
 * readings of "which messages does this conversation still have" from drifting —
 * a revert must not offer a target it has already thrown away.
 *
 * `skip` is applied by the offset a line *begins* at rather than by matching
 * content, because content repeats: the same prompt sent twice is two lines that
 * are byte-identical, and only one of them was abandoned.
 *
 * Offsets are bytes — `Buffer.byteLength`, never a string index — for the same
 * reason `takeTurn` counts them that way: one multibyte character anywhere above
 * a line slides every offset below it.
 */
export function walkTranscript(text: string, skip: ChatRewindRange[] = []): TranscriptWalk {
  const raw = text.split('\n')
  const lines: Json[] = []
  const users: { uuid: string; offset: number }[] = []
  let offset = 0
  for (let i = 0; i < raw.length; i++) {
    const start = offset
    offset += Buffer.byteLength(raw[i], 'utf8') + 1
    const t = raw[i].trim()
    if (!t) continue
    if (skip.some((r) => start >= r.from && start < r.to)) continue
    let o: Json | null = null
    try {
      o = obj(JSON.parse(t))
    } catch {
      o = null
    }
    if (!o) continue
    lines.push(o)
    if (str(o.type) === 'user') {
      const uuid = str(o.uuid)
      if (uuid) users.push({ uuid, offset: start })
    }
  }
  return { lines, users }
}

/** Parse an NDJSON blob into objects, counting the lines that would not parse. */
export function parseNdjson(text: string): { lines: Json[]; malformed: number } {
  const lines: Json[] = []
  let malformed = 0
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    try {
      const o = obj(JSON.parse(t))
      if (o) lines.push(o)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { lines, malformed }
}

export type { ChatToolStatus }
