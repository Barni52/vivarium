import type { Config, McpServerEntry } from '@shared/types'
import type { ChatService } from './chat'
import { performBrowserLogin } from './mcpLogin'

// MCP servers an agent attaches to a chat by itself (`connect_mcp`), so that a
// fresh chat can be pointed at a server under development and start using it
// with nobody configuring anything.
//
// **Attached over the control channel, as the Agent SDK's `setMcpServers`
// does it.** `mcp_set_servers` replaces the set of servers added that way and
// leaves the ones a process was launched with alone — read off 2.1.311: the
// set it diffs is the dynamic client list, not the startup one — so the
// `vivarium` server from `--mcp-config` is never in it and never at risk. The
// new tools go straight into the live tool list, so the turn that connected
// can use them.
//
// **Then logged in with nobody at the keyboard.** A server behind OAuth comes
// up as `needs-auth`; `mcp_authenticate` hands back the login page's URL,
// main/mcpLogin.ts fills it in a hidden window, and the redirect it catches
// goes back to the CLI as `mcp_oauth_callback_url`. The CLI does every
// protocol step itself and keeps and refreshes the tokens, so this is the same
// login a person would do in a terminal, which is also the point: the server is
// tested the way a real client meets it.
//
// **Remembered on the session**, because the control channel ends with the
// process (see Session.mcpServers), and put back by `restore` every time the
// process starts.

export interface McpOutcome {
  text: string
  isError?: boolean
}

export interface McpDeps {
  chat: ChatService
  readConfig(): Config
  /** persist a chat's attached servers; undefined clears them */
  writeServers(sessionId: string, servers: McpServerEntry[] | undefined): Promise<void>
}

/** One server as `mcp_status` reports it, reduced to what is used here. */
interface ServerStatus {
  name: string
  status: string
  error: string
  tools: number
}

/**
 * How long a freshly attached server may sit at `pending`. Connecting is one
 * HTTP round trip plus a `tools/list`; a server slower than this is reported
 * as still connecting rather than waited on.
 */
const CONNECT_WAIT_MS = 20_000
/** After a login: the token exchange is done, the reconnect is what is left. */
const RECONNECT_WAIT_MS = 30_000
const STATUS_POLL_MS = 750

/** A name the CLI can put in `mcp__<name>__<tool>`, and not the one Vivarium's own server holds. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED_NAME = 'vivarium'

export class McpAttachments {
  constructor(private deps: McpDeps) {}

  /**
   * Put a chat's saved servers back on its new process and log in where the
   * CLI's own tokens no longer do. In the background: an open must not wait on
   * a remote server, and a failure here is visible to anyone who asks
   * `list_mcp`.
   */
  restore(sessionId: string): void {
    const saved = this.findSaved(sessionId)
    if (saved.length === 0) return
    void (async () => {
      const applied = await this.apply(sessionId, saved)
      if (!applied.ok) return
      for (const entry of saved) await this.ensureConnected(sessionId, entry)
    })()
  }

  async connect(sessionId: string, input: McpServerEntry): Promise<McpOutcome> {
    if (!SERVER_NAME_RE.test(input.name)) {
      return failure('name may only use letters, digits, - and _ (at most 64).')
    }
    if (input.name === RESERVED_NAME) return failure(`${RESERVED_NAME} is Vivarium's own server.`)
    if (!isHttpUrl(input.url)) return failure('url must be an http or https URL.')

    const saved = this.findSaved(sessionId)
    const previous = saved.find((e) => e.name === input.name)
    // A reconnect that leaves the login out keeps the one already saved, as
    // long as it is for the same server — that is how calling connect_mcp
    // again redoes a login without the password being repeated. The OAuth
    // client follows the same rule, field by field.
    const same = previous?.url === input.url
    const keepLogin = same && !input.username && !input.password
    if (input.callbackPort !== undefined && !isPort(input.callbackPort)) {
      return failure('callbackPort must be a whole number from 1 to 65535.')
    }
    if (input.timeout !== undefined && !(Number.isInteger(input.timeout) && input.timeout > 0)) {
      return failure('timeout must be a whole number of milliseconds.')
    }
    const entry: McpServerEntry = {
      name: input.name,
      url: input.url,
      username: (keepLogin ? previous?.username : input.username) || undefined,
      password: (keepLogin ? previous?.password : input.password) || undefined,
      clientId: input.clientId || (same ? previous?.clientId : undefined) || undefined,
      callbackPort: input.callbackPort ?? (same ? previous?.callbackPort : undefined),
      headers: input.headers ?? (same ? previous?.headers : undefined),
      timeout: input.timeout ?? (same ? previous?.timeout : undefined)
    }
    const next = [...saved.filter((e) => e.name !== entry.name), entry]

    const applied = await this.apply(sessionId, next)
    if (!applied.ok) return failure(`Could not attach ${entry.name}: ${applied.error}`)
    const refused = applied.errors[entry.name]
    if (refused) return failure(`Could not attach ${entry.name}: ${refused}`)
    await this.deps.writeServers(sessionId, next)
    // The same server again is an unchanged set, which the CLI applies as
    // nothing at all — so one that failed, or whose server was down and is up
    // now, would stay as it was. Asked to reconnect explicitly instead; the
    // answer does not matter, the status read below is what is reported.
    if (previous?.url === entry.url) {
      const reconnect = { subtype: 'mcp_reconnect', serverName: entry.name }
      await this.deps.chat.requestControl(sessionId, reconnect, 30_000)
    }

    const status = await this.ensureConnected(sessionId, entry)
    return describeOutcome(entry, status)
  }

  async disconnect(sessionId: string, name: string): Promise<McpOutcome> {
    const saved = this.findSaved(sessionId)
    if (!saved.some((e) => e.name === name)) {
      return failure(`${name} was not attached with connect_mcp.`)
    }
    const next = saved.filter((e) => e.name !== name)
    const applied = await this.apply(sessionId, next)
    if (!applied.ok) return failure(`Could not detach ${name}: ${applied.error}`)
    await this.deps.writeServers(sessionId, next.length > 0 ? next : undefined)
    return { text: `Detached ${name}.` }
  }

  /** Every server the chat has, attached here or not, with where each one stands. */
  async describe(sessionId: string): Promise<McpOutcome> {
    const statuses = await this.readStatuses(sessionId)
    if (!statuses) return failure('The chat is not running.')
    const saved = this.findSaved(sessionId)
    const rows = statuses.map((s) => {
      const entry = saved.find((e) => e.name === s.name)
      return {
        name: s.name,
        status: s.status,
        tools: s.tools,
        ...(s.error ? { error: s.error } : {}),
        ...(entry ? { url: entry.url, attachedWithConnectMcp: true } : {})
      }
    })
    return { text: JSON.stringify(rows, null, 2) }
  }

  private findSaved(sessionId: string): McpServerEntry[] {
    for (const p of this.deps.readConfig().projects) {
      const s = p.sessions.find((x) => x.id === sessionId)
      if (s) return s.mcpServers ?? []
    }
    return []
  }

  /**
   * Make the chat's dynamic server set exactly `entries`. A minute, because the
   * CLI dials every new server before it answers.
   */
  private async apply(
    sessionId: string,
    entries: McpServerEntry[]
  ): Promise<{ ok: true; errors: Record<string, string> } | { ok: false; error: string }> {
    const servers = Object.fromEntries(entries.map((e) => [e.name, buildServerConfig(e)]))
    const request = { subtype: 'mcp_set_servers', servers }
    const pending = this.deps.chat.requestControl(sessionId, request, 60_000)
    if (!pending) return { ok: false, error: 'the chat is not running' }
    const r = await pending
    if (!r.ok) return { ok: false, error: r.error || 'the CLI refused the server set' }
    const errors: Record<string, string> = {}
    const raw = r.response?.errors
    if (raw && typeof raw === 'object') {
      for (const [name, why] of Object.entries(raw)) errors[name] = String(why)
    }
    return { ok: true, errors }
  }

  /**
   * Wait for the server to leave `pending`, and log in if it lands on
   * `needs-auth` and there is a login to use. Returns the status it ends on,
   * with the login's failure as its error when that is why it stopped.
   */
  private async ensureConnected(
    sessionId: string,
    entry: McpServerEntry
  ): Promise<ServerStatus | null> {
    const settled = (s: string): boolean => s !== 'pending'
    const first = await this.waitForStatus(sessionId, entry.name, settled, CONNECT_WAIT_MS)
    if (first?.status !== 'needs-auth' || !entry.username || !entry.password) return first
    const login = await this.login(sessionId, entry, entry.username, entry.password)
    if (!login.ok) return { ...first, error: login.error }
    // **The CLI does not reconnect after a login the host finished.** Its own
    // flow reconnects once the tokens are in, but `mcp_oauth_callback_url`
    // marks the server as host-driven first, and that branch only records the
    // time and returns (read off 2.1.311) — the server sat at `needs-auth` with
    // good tokens until something asked again, which is why connect_mcp took
    // two calls. So the reconnect is asked for here.
    const reconnect = { subtype: 'mcp_reconnect', serverName: entry.name }
    await this.deps.chat.requestControl(sessionId, reconnect, 30_000)
    return this.waitForStatus(
      sessionId,
      entry.name,
      (s) => s !== 'pending' && s !== 'needs-auth',
      RECONNECT_WAIT_MS
    )
  }

  private async login(
    sessionId: string,
    entry: McpServerEntry,
    username: string,
    password: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { chat } = this.deps
    const request = { subtype: 'mcp_authenticate', serverName: entry.name }
    const started = chat.requestControl(sessionId, request, 30_000)
    if (!started) return { ok: false, error: 'the chat stopped before the login' }
    const auth = await started
    if (!auth.ok) return { ok: false, error: `the CLI could not start the login: ${auth.error}` }
    const response: Record<string, unknown> = auth.response ?? {}
    // Tokens the CLI already holds are still good, or it refreshed them.
    if (response.requiresUserAction === false) return { ok: true }
    const authUrl = typeof response.authUrl === 'string' ? response.authUrl : ''
    const callbackPort = Number(response.callbackPort)
    if (!authUrl || !Number.isInteger(callbackPort) || callbackPort <= 0) {
      return { ok: false, error: 'the CLI did not hand over a login page and callback port' }
    }

    const browser = await performBrowserLogin({ authUrl, callbackPort, username, password })
    if (!browser.ok) return browser

    // Answered once the CLI has exchanged the code for tokens; the reconnect it
    // starts afterwards is what `ensureConnected` waits on.
    const callback = {
      subtype: 'mcp_oauth_callback_url',
      serverName: entry.name,
      callbackUrl: browser.callbackUrl
    }
    const submitted = chat.requestControl(sessionId, callback, 60_000)
    if (!submitted) return { ok: false, error: 'the chat stopped during the login' }
    const done = await submitted
    if (!done.ok) return { ok: false, error: `the token exchange failed: ${done.error}` }
    return { ok: true }
  }

  private async waitForStatus(
    sessionId: string,
    name: string,
    settled: (status: string) => boolean,
    timeoutMs: number
  ): Promise<ServerStatus | null> {
    const deadline = Date.now() + timeoutMs
    let last: ServerStatus | null = null
    for (;;) {
      const all = await this.readStatuses(sessionId)
      if (!all) return last
      last = all.find((s) => s.name === name) ?? null
      if (last && settled(last.status)) return last
      if (Date.now() >= deadline) return last
      await new Promise((r) => setTimeout(r, STATUS_POLL_MS))
    }
  }

  private async readStatuses(sessionId: string): Promise<ServerStatus[] | null> {
    const pending = this.deps.chat.requestControl(sessionId, { subtype: 'mcp_status' })
    if (!pending) return null
    const r = await pending
    if (!r.ok) return null
    const list = r.response?.mcpServers
    if (!Array.isArray(list)) return []
    return list.map((raw) => {
      const s = (raw ?? {}) as Record<string, unknown>
      return {
        name: String(s.name ?? ''),
        status: String(s.status ?? 'unknown'),
        error: typeof s.error === 'string' ? s.error : '',
        tools: Array.isArray(s.tools) ? s.tools.length : 0
      }
    })
  }
}

function describeOutcome(entry: McpServerEntry, status: ServerStatus | null): McpOutcome {
  const tools = `mcp__${entry.name}__*`
  if (!status) {
    return { text: `Attached ${entry.name}; its status is not known yet. list_mcp reports it.` }
  }
  switch (status.status) {
    case 'connected':
      return {
        text: `Connected ${entry.name} (${status.tools} tools, named ${tools}). Usable now.`
      }
    case 'needs-auth':
      return failure(
        status.error
          ? `${entry.name} needs a login, and it failed: ${status.error}`
          : `${entry.name} needs a login. Call connect_mcp again with username and password.`
      )
    case 'pending':
      return {
        text: `Attached ${entry.name}; it is still connecting. list_mcp reports when it is up.`
      }
    default:
      return failure(
        `${entry.name} is ${status.status}${status.error ? `: ${status.error}` : ''}. ` +
          'It stays attached; fix the server and call connect_mcp again.'
      )
  }
}

/**
 * The CLI's config for one server — the shape a `.mcp.json` entry has, so an
 * agent can copy a server's entry field for field, and a fixed client goes in
 * `oauth` exactly as `--client-id` / `--callback-port` would put it there.
 */
function buildServerConfig(entry: McpServerEntry): Record<string, unknown> {
  const oauth = {
    ...(entry.clientId ? { clientId: entry.clientId } : {}),
    ...(entry.callbackPort ? { callbackPort: entry.callbackPort } : {})
  }
  return {
    type: 'http',
    url: entry.url,
    ...(Object.keys(oauth).length > 0 ? { oauth } : {}),
    ...(entry.headers && Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {}),
    ...(entry.timeout ? { timeout: entry.timeout } : {})
  }
}

function isPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535
}

function failure(text: string): McpOutcome {
  return { text, isError: true }
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
