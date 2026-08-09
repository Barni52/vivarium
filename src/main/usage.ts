import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageLimit, UsageSnapshot } from '@shared/types'
import type { DockerService } from './docker'

// Claude plan usage via the undocumented OAuth endpoint the Claude Code CLI's
// /usage command uses. Auth reuses the existing Claude Code OAuth token —
// Vivarium NEVER refreshes tokens itself (that's claude's job; every agent run
// rewrites the shared-volume copy), it only reads the freshest copy it can
// find: host ~/.claude first (present if claude was ever run on Windows), then
// the claude-box-creds volume through docker. On 401 the cache is dropped and
// the sources are re-read once — an agent may have rotated the token since.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

interface OauthCreds {
  accessToken: string
  /** epoch ms; 0 when the file omitted it (then only a 401 invalidates) */
  expiresAt: number
}

// Response shape as observed 2026-07 — undocumented, so every field is
// optional and parsing is defensive.
interface RawWindow {
  utilization?: number
  resets_at?: string
}
interface RawLimit {
  kind?: string
  percent?: number
  severity?: string
  resets_at?: string
  is_active?: boolean
  scope?: { model?: { display_name?: string } } | null
}
interface RawUsage {
  limits?: RawLimit[]
  five_hour?: RawWindow | null
  seven_day?: RawWindow | null
}

function parseSnapshot(body: RawUsage): UsageSnapshot {
  const limits: UsageLimit[] = []
  for (const l of Array.isArray(body.limits) ? body.limits : []) {
    if (typeof l?.percent !== 'number') continue
    limits.push({
      kind: String(l.kind ?? ''),
      percent: l.percent,
      severity: String(l.severity ?? 'normal'),
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
      modelName:
        typeof l.scope?.model?.display_name === 'string' ? l.scope.model.display_name : null,
      isActive: !!l.is_active
    })
  }
  // Variants without a `limits` array: synthesize from the two fixed windows.
  if (limits.length === 0) {
    for (const [kind, w] of [
      ['session', body.five_hour],
      ['weekly_all', body.seven_day]
    ] as const) {
      if (typeof w?.utilization !== 'number') continue
      limits.push({
        kind,
        percent: w.utilization,
        severity: 'normal',
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
        modelName: null,
        isActive: false
      })
    }
  }
  return { ok: true, limits, fetchedAt: Date.now() }
}

export class UsageService {
  private creds: OauthCreds | null = null
  /** last snapshot that actually carried limits — the base a stream top-up merges into */
  private last: UsageSnapshot | null = null
  /** epoch ms until which the endpoint told us to back off (429 Retry-After).
   * Measured limit is ~5 requests / 5 min; a trip locks the rest of the
   * window, so requests during the backoff are guaranteed 429s — skip them. */
  private blockedUntil = 0

  constructor(private docker: DockerService) {}

  /** Still good to send? 60s slack so a token about to expire mid-request isn't
   *  used. A file that omitted expiresAt (0) counts as usable — nothing local
   *  can disprove it, so only a 401 does. */
  private static usable(c: OauthCreds): boolean {
    return c.expiresAt === 0 || c.expiresAt - 60_000 > Date.now()
  }

  private async acquireToken(): Promise<OauthCreds | null> {
    const sources: Array<() => Promise<string | null>> = [
      () => readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8').catch(() => null),
      () => this.docker.readSharedCredentials()
    ]
    // Access tokens live ~1h and we never refresh them, so "first source that
    // has one" is the wrong pick: the host copy is only rewritten when claude
    // runs on Windows, while the shared volume is rewritten by every
    // containerized agent run — i.e. constantly, since that's what this app is
    // for. Taking the host copy unconditionally lets an hours-old token shadow
    // a fresh one and 401 every poll, and the retry below re-reads the same
    // sources in the same order, so it 401s again and the chips sit at "usage
    // n/a" until someone happens to run claude on Windows.
    //
    // So: the first *usable* token wins (a fresh host copy still short-circuits,
    // keeping the common case docker-free), and if every source is expired the
    // least-stale one is returned — that way the request reports auth-expired
    // rather than the misleading no-credentials.
    let bestExpired: OauthCreds | null = null
    for (const read of sources) {
      const raw = await read()
      if (!raw) continue
      try {
        const o = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } })
          .claudeAiOauth
        if (typeof o?.accessToken === 'string' && o.accessToken) {
          const creds = { accessToken: o.accessToken, expiresAt: Number(o.expiresAt) || 0 }
          if (UsageService.usable(creds)) return creds
          if (!bestExpired || creds.expiresAt > bestExpired.expiresAt) bestExpired = creds
        }
      } catch {
        // malformed file — try the next source
      }
    }
    return bestExpired
  }

  private async token(force: boolean): Promise<OauthCreds | null> {
    if (!force && this.creds && UsageService.usable(this.creds)) return this.creds
    this.creds = await this.acquireToken()
    return this.creds
  }

  private async request(
    token: string
  ): Promise<{ status: number; body: RawUsage | null; retryAfter: number | null }> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10_000)
    try {
      const r = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: ctl.signal
      })
      const ra = Number(r.headers.get('retry-after'))
      const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null
      if (!r.ok) return { status: r.status, body: null, retryAfter }
      return {
        status: r.status,
        body: (await r.json().catch(() => null)) as RawUsage | null,
        retryAfter
      }
    } catch {
      return { status: 0, body: null, retryAfter: null } // network failure / timeout
    } finally {
      clearTimeout(t)
    }
  }

  async fetch(): Promise<UsageSnapshot> {
    const fail = (error: string): UsageSnapshot => ({
      ok: false,
      error,
      limits: [],
      fetchedAt: Date.now()
    })
    /**
     * A *transient* failure is answered with the last good snapshot rather than
     * an error, when there is one.
     *
     * Two reasons, and the second is the one that was actually broken. The
     * renderer already keeps its last good snapshot across a failed poll
     * (refreshUsage), so `fail()` here only ever meant "the store keeps the copy
     * it already had" — while *this* copy is the one `applyStreamLimits` merges
     * a stream top-up into. Returning `fail()` was therefore what made that merge
     * unobservable: `this.last` was written by this method and read by nothing
     * that could reach the renderer, so a topped-up snapshot had no way out of
     * this service and the next poll overwrote it.
     *
     * It carries its own `fetchedAt`, which is deliberately *not* re-stamped —
     * the TitleBar dims a stale reading off that timestamp, and the whole point
     * is that this answer is honestly old.
     *
     * Credential failures are excluded: they are not transient, and hiding
     * auth-expired behind a stale-but-plausible reading is how someone spends an
     * afternoon wondering why the numbers stopped moving.
     */
    const stale = (error: string): UsageSnapshot => this.last ?? fail(error)

    if (Date.now() < this.blockedUntil) return stale('rate-limited')
    let creds = await this.token(false)
    if (!creds) return fail('no-credentials')
    let res = await this.request(creds.accessToken)
    if (res.status === 401 || res.status === 403) {
      creds = await this.token(true)
      if (!creds) return fail('no-credentials')
      res = await this.request(creds.accessToken)
      if (res.status === 401 || res.status === 403) return fail('auth-expired')
    }
    if (res.status === 429) {
      this.blockedUntil = Date.now() + (res.retryAfter ?? 300) * 1000
      return stale('rate-limited')
    }
    if (res.status === 0) return stale('network')
    if (!res.body) return stale(`http-${res.status}`)
    const snap = parseSnapshot(res.body)
    if (snap.limits.length) this.last = snap
    return snap
  }

  /**
   * A chat stream's `rate_limit_event` carries the same five_hour / seven_day
   * utilisation the title-bar chips poll for, so it tops the last good snapshot
   * up and re-stamps `fetchedAt` — keeping the staleness dimming truthful.
   *
   * The poll is unchanged and the stream cannot replace it: a stream event is
   * only as fresh as your last turn, so an hour without talking to an agent tells
   * you nothing while the poll has told you twenty times. Accepted cost: a
   * stream-sourced top-up carries no `severity` and no per-model limits, which is
   * invisible in practice — the chips render only the two windows and filter
   * per-model limits out.
   *
   * **Observed reality on Claude Code 2.1.211: the event carries no utilisation
   * number**, only a status and a reset time, so this no-ops today. It is wired
   * anyway because the shape is version-dependent and a no-op merge costs
   * nothing, while discovering the field later would mean re-deriving all of the
   * above. A missing percentage never overwrites a real one.
   */
  applyStreamLimits(five: Record<string, unknown> | null, seven: Record<string, unknown> | null): void {
    const base = this.last
    if (!base) return
    const merge = (kind: string, w: Record<string, unknown> | null): void => {
      const pct = typeof w?.utilization === 'number' ? w.utilization : null
      if (pct === null) return
      // epoch seconds (the stream's form) or an ISO string (the endpoint's)
      const resetsAt =
        typeof w?.resets_at === 'string'
          ? w.resets_at
          : typeof w?.resets_at === 'number'
            ? new Date(w.resets_at * 1000).toISOString()
            : null
      const i = base.limits.findIndex((l) => l.kind === kind)
      const next = { ...(base.limits[i] ?? { kind, severity: 'normal', modelName: null, isActive: false }), percent: pct, resetsAt }
      if (i >= 0) base.limits[i] = next
      else base.limits.push(next)
    }
    merge('session', five)
    merge('weekly_all', seven)
    base.fetchedAt = Date.now()
  }
}
