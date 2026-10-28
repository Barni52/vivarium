import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { EFFORT_LEVELS, isEffort } from '@shared/models'
import { isHostProject } from '@shared/projects'
import type { ChatEffort, ChatOpenResult, Config, Project, Session } from '@shared/types'
import { bridgeDir } from './bridge'
import { DEFAULT_DIFF_BASE, gitBranch, isDiffBase, writeBranchDiff } from './git'
import type { ChatService } from './chat'
import { BACKEND_PORTS } from './dockerfiles'
import type { McpAttachments } from './mcpServers'

// Chat-to-chat orchestration: an MCP server inside main that every chat is
// handed at spawn, so one chat can list, create, message, read, stop and
// delete the others — a coding agent driving a testing agent in another
// project is the case it exists for — and attach further MCP servers to itself
// or to another chat (main/mcpServers.ts).
//
// **Full access, by the user's decision.** Any chat reaches any chat in any
// project, host projects included, at any depth, with no opt-in and no hop
// limit. That deliberately steps around the selective mounts: a chat in a
// project without the backend can ask one that has it. The one thing refused
// is acting on yourself where it cannot mean anything (messaging or deleting
// your own chat), and a stopped container is never started on an agent's
// say-so — starting one stays the user's act.
//
// **Replies are pushed, never polled.** `send_to_chat` returns at once; when
// the turn it started ends, ChatService writes the answer into the sender as a
// message of its own (see TurnOrigin in main/chat.ts and main/relay.ts). A
// blocking wait would hold the sender's turn open across the other chat's
// whole turn, and that silence trips the sender's own ten-minute timeout.
//
// Plain `node:http` and a hand-rolled JSON-RPC answer rather than the MCP SDK.
// The Streamable HTTP transport allows a server to answer every POST with one
// `application/json` body and to refuse the optional GET stream with a 405,
// and a server with nothing to push over MCP needs no more than that: no
// sessions, no SSE, nothing a dependency would be carrying.
//
// **The token is the caller's identity.** One per spawn, minted here and
// written into that chat's `--mcp-config`; the session a request comes from is
// whatever the token maps to, never anything a tool argument says. A sibling
// process in the same container can read the token off `ps`, which is accepted:
// every chat may reach every other chat anyway, so impersonation gains nothing
// access does not already give.

/**
 * Fixed rather than ephemeral so a container shell can `curl` the server with
 * a number it already knows. Every chat is respawned with the app, so nothing
 * outlives a change to it.
 */
export const ORCHESTRATION_PORT = 47821

/** A request body bigger than this is refused rather than buffered. */
const MAX_BODY_BYTES = 1_000_000

/** `read_chat` answers with at most this much, keeping the newest turns. */
const READ_MAX_CHARS = 40_000

/**
 * What the server needs from the rest of main, handed in by ipc.ts so the
 * config writes, the open gate and the delete cascade stay the same code the
 * UI's own handlers run.
 */
export interface OrchestrationDeps {
  readConfig(): Config
  chat: ChatService
  isContainerRunning(project: Project): Promise<boolean>
  /** through the same gate a renderer open queues at */
  openChat(project: Project, session: Session): Promise<ChatOpenResult>
  /** add a chat session and push the new config to the renderer */
  createChat(
    projectId: string,
    name: string,
    model?: string,
    effort?: ChatEffort
  ): Promise<Session | null>
  /** the UI's delete, cascade and all, and push the new config to the renderer */
  removeChat(projectId: string, sessionId: string): Promise<void>
  /** MCP servers agents attach to chats (main/mcpServers.ts) */
  mcp: McpAttachments
}

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

type RpcReply =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

interface ToolResult {
  text: string
  isError?: boolean
}

type ToolArgs = Record<string, unknown>

const CHAT_ID = { type: 'string', description: 'The chat id, as list_chats reports it.' }

const TARGET_CHAT = {
  type: 'string',
  description: 'The chat id, as list_chats reports it. Defaults to your own chat.'
}

const TOOLS = [
  {
    name: 'list_chats',
    description:
      'List every project and the chats in it. Each chat has an id (the other chat tools take it), ' +
      'a name, its model and a status: idle, working, waiting (blocked on a question to the user), or ' +
      'offline (no process running; sending to it starts one if its project is available). ' +
      'Your own chat is marked self.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_chat',
    description:
      "Create a chat in a project and send it its first message. The chat is a full Claude Code agent " +
      "working in that project's files. Returns its id. Its answer arrives later in this conversation " +
      'as a <chat-notification> message, so do not poll for it. Fails when the project container is stopped.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project id, as list_chats reports it.' },
        name: { type: 'string', description: 'A short name saying what the chat is for.' },
        prompt: { type: 'string', description: 'The first message.' },
        model: { type: 'string', description: 'Optional model alias or id, for example opus or sonnet.' },
        effort: { type: 'string', enum: [...EFFORT_LEVELS], description: 'Optional thinking effort.' }
      },
      required: ['project', 'name', 'prompt']
    }
  },
  {
    name: 'send_to_chat',
    description:
      'Send a message to another chat. Returns at once; a busy chat runs it after its current turn. ' +
      'When the turn your message started ends, its final answer arrives in this conversation as a ' +
      '<chat-notification> message with status done, failed or stopped, so do not poll for it. ' +
      'A message you receive wrapped in <chat-message> came from another chat, and your final answer to ' +
      'it is delivered back to that chat automatically: answer it directly instead of sending one back.',
    inputSchema: {
      type: 'object',
      properties: { chat: CHAT_ID, message: { type: 'string' } },
      required: ['chat', 'message']
    }
  },
  {
    name: 'read_chat',
    description:
      'Read the most recent turns of a chat: the messages it received and its answers, without tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: CHAT_ID,
        turns: { type: 'number', description: 'How many turns, newest last. Defaults to 1.' }
      },
      required: ['chat']
    }
  },
  {
    name: 'stop_chat',
    description:
      'Stop the turn a chat is running. Whoever sent the message it was answering is notified with status ' +
      'stopped. Messages queued behind the turn still run.',
    inputSchema: { type: 'object', properties: { chat: CHAT_ID }, required: ['chat'] }
  },
  {
    name: 'connect_mcp',
    description:
      'Attach an HTTP MCP server to a chat, your own unless chat is given. When the server has a .mcp.json ' +
      'entry, copy its url, oauth.clientId, oauth.callbackPort, headers and timeout into the matching ' +
      'arguments. Its tools become available in ' +
      'that chat right away as mcp__<name>__<tool>. A server behind a browser login is logged in ' +
      'automatically with username and password. The server stays attached when the chat restarts, and ' +
      'calling this again for an attached server redoes the login when one is needed. The url is ' +
      "resolved from the chat's own machine: in a container project, localhost ports " +
      `${BACKEND_PORTS.join(', ')} reach the host.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Letters, digits, - and _; becomes the tool name prefix.' },
        url: { type: 'string', description: 'The MCP endpoint, for example http://localhost:9980/mcp.' },
        username: { type: 'string', description: 'For a server behind a login.' },
        password: { type: 'string', description: 'For a server behind a login.' },
        clientId: {
          type: 'string',
          description:
            'A fixed OAuth client to log in with, when the identity provider refuses to register a new ' +
            "one. It is oauth.clientId in the server's .mcp.json entry."
        },
        callbackPort: {
          type: 'number',
          description: "The redirect port that client allows: oauth.callbackPort in .mcp.json, if set."
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: "Headers sent with every request: headers in the server's .mcp.json entry."
        },
        timeout: {
          type: 'number',
          description: "Tool call timeout in milliseconds: timeout in the server's .mcp.json entry."
        },
        chat: TARGET_CHAT
      },
      required: ['name', 'url']
    }
  },
  {
    name: 'disconnect_mcp',
    description: 'Detach an MCP server that connect_mcp attached, from your own chat unless chat is given.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, chat: TARGET_CHAT },
      required: ['name']
    }
  },
  {
    name: 'list_mcp',
    description:
      "List a chat's MCP servers (your own unless chat is given) with each one's status: connected, " +
      'pending, needs-auth, failed or disabled, and how many tools it has.',
    inputSchema: { type: 'object', properties: { chat: TARGET_CHAT } }
  },
  {
    name: 'write_branch_diff',
    description:
      "Write the diff of a project's current git branch against a base into the shared output folder, " +
      'as changes.txt in a folder named after the branch (slashes become -). Committed changes only ' +
      '(<base>...HEAD), limited to the folders the project mounts, after fetching origin. Returns where ' +
      'the file is from your chat. The review-changes-html and mr-description skills read it from there.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: "The project id, as list_chats reports it. Defaults to your own chat's project."
        },
        base: {
          type: 'string',
          description: `The branch or ref to diff against. Defaults to ${DEFAULT_DIFF_BASE}.`
        }
      }
    }
  },
  {
    name: 'delete_chat',
    description:
      'Delete a chat and its whole conversation history. This cannot be undone. Your own chat cannot be deleted.',
    inputSchema: { type: 'object', properties: { chat: CHAT_ID }, required: ['chat'] }
  }
]

/**
 * What `initialize` answers a client that names no revision. One that names a
 * revision gets it echoed back: nothing this server says differs between them.
 */
const PROTOCOL_VERSION = '2025-06-18'

export class OrchestrationServer {
  /** token → the session it was minted for */
  private callers = new Map<string, string>()
  /** session → its current token, so a respawn retires the previous one */
  private tokens = new Map<string, string>()
  /**
   * The address containers reach Windows on. A promise because finding it runs
   * `wsl.exe`, and a chat spawning at launch must wait for the answer rather
   * than be handed a URL that names the wrong host.
   */
  private hostIp: Promise<string | null> = Promise.resolve(null)

  constructor(private deps: OrchestrationDeps) {}

  /**
   * Listen on loopback for host chats and on the WSL gateway address for
   * container ones — and **not** on 0.0.0.0, which would put the server on
   * every network the machine is on.
   */
  start(hostIp: Promise<string | null>): void {
    this.hostIp = hostIp
    this.listen('127.0.0.1')
    void hostIp.then((ip) => {
      if (ip) this.listen(ip)
    })
  }

  /**
   * Mint this spawn's token and write the `--mcp-config` file for it, returning
   * the path *as the CLI will see it* — `/vivarium/mcp/…` inside a container
   * (the bridge dir is already mounted there), the Windows path on the host.
   * A file rather than inline JSON: a host chat is spawned without a shell, and
   * how a JSON argument's quotes survive Windows command-line quoting depends on
   * which runtime parses it back out. Null when the file could not be written —
   * orchestration is never a reason a chat fails to open.
   */
  async prepareConfig(project: Project, session: Session): Promise<string | null> {
    const host = isHostProject(project)
    // Without a detected gateway, docker was given `host-gateway` for
    // host.docker.internal (see buildRunArgs), so that is the name to try.
    const address = host ? '127.0.0.1' : ((await this.hostIp) ?? 'host.docker.internal')
    const previous = this.tokens.get(session.id)
    if (previous) this.callers.delete(previous)
    const token = randomUUID()
    this.callers.set(token, session.id)
    this.tokens.set(session.id, token)
    const config = {
      mcpServers: {
        vivarium: {
          type: 'http',
          url: `http://${address}:${ORCHESTRATION_PORT}/mcp`,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    }
    const dir = join(bridgeDir(project.id), 'mcp')
    const file = `${session.id}.json`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), JSON.stringify(config, null, 2), 'utf8')
    } catch {
      return null
    }
    return host ? join(dir, file) : `/vivarium/mcp/${file}`
  }

  private listen(host: string): void {
    const server = createServer((req, res) => void this.handle(req, res))
    // Not fatal, and not retried: a port someone else holds or an address that
    // has gone away leaves chats running without the tools, which is what they
    // were before. Said on main's stdout, which is where anyone debugging this
    // is already looking.
    server.on('error', (e) => {
      console.error(`[vivarium] orchestration listener ${host}:${ORCHESTRATION_PORT}: ${e.message}`)
    })
    server.listen(ORCHESTRATION_PORT, host)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return this.reply(res, 404)
    const caller = this.callers.get(readBearer(req))
    if (!caller) return this.reply(res, 401)
    // The client may open a GET stream for server-initiated messages; there are
    // none to send, and 405 is the spec's way of saying so.
    if (req.method !== 'POST') return this.reply(res, 405)
    const body = await readBody(req)
    if (body === null) return this.reply(res, 413)
    let request: RpcRequest
    try {
      request = JSON.parse(body) as RpcRequest
    } catch {
      return this.send(res, rpcError(null, -32700, 'Parse error'))
    }
    // A notification (`notifications/initialized`, a cancel) has no id and
    // wants no answer beyond the acceptance.
    if (request.id === undefined || request.id === null) return this.reply(res, 202)
    let reply: RpcReply
    try {
      reply = await this.answer(request, request.id, caller)
    } catch (e) {
      reply = rpcError(request.id, -32603, e instanceof Error ? e.message : String(e))
    }
    this.send(res, reply)
  }

  private async answer(
    request: RpcRequest,
    id: string | number,
    caller: string
  ): Promise<RpcReply> {
    switch (request.method) {
      case 'initialize': {
        const asked = request.params?.protocolVersion
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'vivarium', version: app.getVersion() }
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      case 'tools/call': {
        const name = request.params?.name
        const args = (request.params?.arguments ?? {}) as ToolArgs
        const result = await this.callTool(String(name), args, caller)
        if (!result) return rpcError(id, -32602, `Unknown tool: ${String(name)}`)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: result.text }],
            isError: result.isError === true
          }
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${String(request.method)}`)
    }
  }

  /** null for a tool this server does not have */
  private async callTool(name: string, args: ToolArgs, caller: string): Promise<ToolResult | null> {
    switch (name) {
      case 'list_chats':
        return { text: JSON.stringify(this.listChats(caller), null, 2) }
      case 'create_chat':
        return this.createChat(args, caller)
      case 'send_to_chat':
        return this.sendToChat(args, caller)
      case 'read_chat':
        return this.readChat(args)
      case 'stop_chat':
        return this.stopChat(args)
      case 'delete_chat':
        return this.deleteChat(args, caller)
      case 'write_branch_diff':
        return this.writeDiff(args, caller)
      case 'connect_mcp':
        return this.withTargetChat(args, caller, (id) =>
          this.deps.mcp.connect(id, {
            name: readString(args.name).trim(),
            url: readString(args.url).trim(),
            username: readString(args.username) || undefined,
            password: readString(args.password) || undefined,
            clientId: readString(args.clientId).trim() || undefined,
            callbackPort: typeof args.callbackPort === 'number' ? args.callbackPort : undefined,
            headers: readHeaders(args.headers),
            timeout: typeof args.timeout === 'number' ? args.timeout : undefined
          })
        )
      case 'disconnect_mcp':
        return this.withTargetChat(args, caller, (id) =>
          this.deps.mcp.disconnect(id, readString(args.name).trim())
        )
      case 'list_mcp':
        return this.withTargetChat(args, caller, (id) => this.deps.mcp.describe(id))
      default:
        return null
    }
  }

  /**
   * Every project, chats or not — a project with none yet is still somewhere a
   * chat can be created. Read from config at each call, so a chat added or
   * renamed since the caller spawned is already in the answer.
   */
  private listChats(caller: string): unknown {
    const { chat } = this.deps
    return this.deps.readConfig().projects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: isHostProject(p) ? 'host' : 'container',
      chats: p.sessions
        .filter((s) => s.type === 'chat')
        .map((s) => ({
          id: s.id,
          name: s.name,
          model: s.model,
          status: chat.findActivity(s.id) ?? 'offline',
          ...(s.id === caller ? { self: true } : {})
        }))
    }))
  }

  private async createChat(args: ToolArgs, caller: string): Promise<ToolResult> {
    const projectId = readString(args.project)
    const name = readString(args.name).trim()
    const prompt = readString(args.prompt)
    const model = readString(args.model).trim() || undefined
    const effort = readString(args.effort)
    if (!name || !prompt.trim()) return failure('name and prompt are required.')
    if (effort && !isEffort(effort)) {
      return failure(`effort must be one of ${EFFORT_LEVELS.join(', ')}.`)
    }
    const project = this.deps.readConfig().projects.find((p) => p.id === projectId)
    if (!project) return failure(`No project with id ${projectId}. list_chats lists them.`)
    // Before the chat exists, not after: a chat created into a stopped
    // container would sit in the sidebar unopened, and its first message with it.
    const stopped = await this.checkStopped(project)
    if (stopped) return stopped
    const picked = isEffort(effort) ? effort : undefined
    const session = await this.deps.createChat(project.id, name, model, picked)
    if (!session) return failure(`Could not create a chat in project ${project.name}.`)
    const sent = await this.deliver(project, session, prompt, caller)
    if (sent.isError) {
      return { text: `Created chat ${session.id}, but: ${sent.text}`, isError: true }
    }
    return {
      text:
        `Created chat "${session.name}" (${session.id}) in project ${project.name} and sent it the prompt. ` +
        'Its answer will arrive as a <chat-notification> message.'
    }
  }

  private async sendToChat(args: ToolArgs, caller: string): Promise<ToolResult> {
    const found = this.findChat(readString(args.chat))
    if ('text' in found) return found
    if (found.session.id === caller) return failure('That is your own chat.')
    const message = readString(args.message)
    if (!message.trim()) return failure('message is empty.')
    return this.deliver(found.project, found.session, message, caller)
  }

  private async readChat(args: ToolArgs): Promise<ToolResult> {
    const found = this.findChat(readString(args.chat))
    if ('text' in found) return found
    const opened = await this.ensureOpen(found.project, found.session)
    if (opened) return opened
    const turns = typeof args.turns === 'number' && args.turns >= 1 ? Math.floor(args.turns) : 1
    const text = this.deps.chat.formatRecentTurns(found.session.id, turns)
    if (text === null) return failure('The chat closed while it was being read.')
    // The newest turns are the ones asked about, so a clip drops from the top.
    if (text.length <= READ_MAX_CHARS) return { text }
    return { text: `[older text clipped]\n\n${text.slice(text.length - READ_MAX_CHARS)}` }
  }

  private async stopChat(args: ToolArgs): Promise<ToolResult> {
    const found = this.findChat(readString(args.chat))
    if ('text' in found) return found
    const activity = this.deps.chat.findActivity(found.session.id)
    if (activity !== 'working' && activity !== 'waiting') {
      return { text: `"${found.session.name}" is not running a turn.` }
    }
    await this.deps.chat.interrupt(found.session.id)
    return { text: `Stopped the running turn of "${found.session.name}".` }
  }

  private async deleteChat(args: ToolArgs, caller: string): Promise<ToolResult> {
    const found = this.findChat(readString(args.chat))
    if ('text' in found) return found
    if (found.session.id === caller) return failure('Your own chat cannot be deleted.')
    await this.deps.removeChat(found.project.id, found.session.id)
    return { text: `Deleted chat "${found.session.name}" (${found.session.id}).` }
  }

  /**
   * The UI's "Write branch diff", for an agent: the same writer, the same output
   * folder, and the base the user set in the output panel unless the agent
   * names one. The path handed back is the one the *caller* can open — its
   * container's `/workspace/output/…`, or the Windows path for a host chat —
   * whichever project the diff was taken of.
   */
  private async writeDiff(args: ToolArgs, caller: string): Promise<ToolResult> {
    const config = this.deps.readConfig()
    const output = config.sharedOutputFolder
    if (!output) {
      return failure('No shared output folder is set, so there is nowhere to write the diff.')
    }
    const callerProject = config.projects.find((p) => p.sessions.some((s) => s.id === caller))
    const projectId = readString(args.project) || callerProject?.id || ''
    const project = config.projects.find((p) => p.id === projectId)
    if (!project) return failure(`No project with id ${projectId}. list_chats lists them.`)
    const base = readString(args.base).trim() || config.diffBase || DEFAULT_DIFF_BASE
    if (!isDiffBase(base)) return failure(`${base} is not a branch or ref name.`)
    if (!gitBranch(project.basePath)) {
      return failure(`Project ${project.name} is not on a git branch (no repository at its folder).`)
    }
    const r = await writeBranchDiff(project, output, base)
    if (!r.ok || !r.folder) return failure(`Could not write the diff: ${r.message}`)
    const where =
      callerProject && !isHostProject(callerProject)
        ? `/workspace/output/${r.folder}/changes.txt`
        : r.message
    return {
      text:
        `Wrote the diff of ${gitBranch(project.basePath)} against ${base} (project ${project.name}) ` +
        `to ${where}.`
    }
  }

  /**
   * Run an MCP tool against the chat it names, or against the caller's own —
   * opened first if it is another chat that is not running yet.
   */
  private async withTargetChat(
    args: ToolArgs,
    caller: string,
    run: (sessionId: string) => Promise<ToolResult>
  ): Promise<ToolResult> {
    const target = readString(args.chat) || caller
    const found = this.findChat(target)
    if ('text' in found) return found
    const opened = await this.ensureOpen(found.project, found.session)
    if (opened) return opened
    return run(found.session.id)
  }

  /** Open the target if it needs it, then send as the caller. */
  private async deliver(
    project: Project,
    session: Session,
    text: string,
    caller: string
  ): Promise<ToolResult> {
    const opened = await this.ensureOpen(project, session)
    if (opened) return opened
    const { chat } = this.deps
    const from = this.findSessionName(caller)
    const busy = chat.findActivity(session.id) !== 'idle'
    const origin = { sender: caller, relay: chat.findTurnOrigin(caller) }
    if (!chat.sendFromAgent(session.id, text, { id: caller, name: from }, origin)) {
      return failure(`"${session.name}" closed before the message could be sent.`)
    }
    return {
      text: busy
        ? `Queued for "${session.name}" behind the turn it is running.`
        : `Sent to "${session.name}".`
    }
  }

  /** null once the chat has a live process; otherwise why it cannot have one */
  private async ensureOpen(project: Project, session: Session): Promise<ToolResult | null> {
    if (this.deps.chat.has(session.id)) return null
    const stopped = await this.checkStopped(project)
    if (stopped) return stopped
    const r = await this.deps.openChat(project, session)
    if (r.ok) return null
    const why = r.message ?? r.reason ?? 'unknown reason'
    return failure(`Could not open "${session.name}": ${why}.`)
  }

  private async checkStopped(project: Project): Promise<ToolResult | null> {
    if (isHostProject(project)) return null
    if (await this.deps.isContainerRunning(project)) return null
    return failure(`The container of project ${project.name} is stopped; the user has to start it.`)
  }

  private findChat(chatId: string): { project: Project; session: Session } | ToolResult {
    for (const project of this.deps.readConfig().projects) {
      const session = project.sessions.find((s) => s.id === chatId)
      if (session?.type === 'chat') return { project, session }
    }
    return failure(`No chat with id ${chatId}. list_chats lists them.`)
  }

  private findSessionName(sessionId: string): string {
    for (const project of this.deps.readConfig().projects) {
      const session = project.sessions.find((s) => s.id === sessionId)
      if (session) return session.name
    }
    return 'another chat'
  }

  private send(res: ServerResponse, reply: RpcReply): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply))
  }

  private reply(res: ServerResponse, status: number): void {
    res.writeHead(status)
    res.end()
  }
}

function failure(text: string): ToolResult {
  return { text, isError: true }
}

/** A headers object with every value a string, or undefined for anything else. */
function readHeaders(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, value] of Object.entries(v)) {
    if (typeof value === 'string') out[k] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function rpcError(id: string | number | null, code: number, message: string): RpcReply {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function readBearer(req: IncomingMessage): string {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1] : ''
}

/** The whole body as text, or null once it passes MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}
