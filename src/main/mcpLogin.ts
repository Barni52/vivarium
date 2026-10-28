import { BrowserWindow, session as electronSession } from 'electron'
import { randomUUID } from 'node:crypto'

// The browser half of an MCP server's OAuth login, done with nobody at the
// keyboard.
//
// The CLI does the protocol: discovery, client registration, PKCE, the token
// exchange, storing and refreshing the tokens. What it cannot do in a chat is
// the part a person does — open the login page, type a username and password,
// press the button. `mcp_authenticate` hands that part to the host as an
// `authUrl`, and this module is the host doing it: a hidden Electron window
// (real Chromium, so every redirect and script of a real login page runs),
// the login form filled and submitted, and the final redirect **caught before
// it is sent**. That last step is what makes it work across the container
// boundary: the redirect points at the CLI's own callback listener, on the
// *container's* localhost, which a page loaded on Windows could never reach —
// so the URL is taken off the request and handed to the CLI with
// `mcp_oauth_callback_url` instead (see main/mcpServers.ts).
//
// Form filling is generic on purpose: the first visible password field, the
// username field beside it, the form's own submit. Keycloak's login page is
// the case it is written against, consent screen included, but nothing in here
// names Keycloak, so another identity provider with a plain form works too.

export type LoginResult = { ok: true; callbackUrl: string } | { ok: false; error: string }

export interface LoginRequest {
  authUrl: string
  /** the port of the CLI's callback listener; the redirect to it is the finish line */
  callbackPort: number
  username: string
  password: string
}

/** Long enough for a slow identity provider, short enough to fail a tool call honestly. */
const LOGIN_TIMEOUT_MS = 60_000

/**
 * What runs in the login page after each load. Returns what it did, so a page
 * that comes back with the form still on it can be recognised as a refusal.
 * Values are set through the prototype's setter and followed by `input`
 * events, because a page built on a framework reads its own state rather than
 * the DOM attribute.
 */
function buildFillScript(username: string, password: string): string {
  return `(() => {
  const username = ${JSON.stringify(username)};
  const password = ${JSON.stringify(password)};
  const visible = (el) => !!el && el.offsetParent !== null;
  const setValue = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const submit = (form, scope) => {
    const button = scope.querySelector('[type="submit"]');
    if (form && form.requestSubmit) {
      if (button && button.form === form) form.requestSubmit(button);
      else form.requestSubmit();
    }
    else if (button) button.click();
    else if (form) form.submit();
  };
  const userSelector = 'input[name="username"], input[autocomplete="username"], input[type="email"], input[type="text"]';
  const shown = document.querySelector('.alert-error, #input-error, .kc-feedback-text, #kc-error-message, [role="alert"]');
  const error = shown ? shown.textContent.trim() : '';
  const pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (pw) {
    const scope = pw.form || document;
    const user = [...scope.querySelectorAll(userSelector)].find(visible);
    if (user) setValue(user, username);
    setValue(pw, password);
    submit(pw.form, scope);
    return { action: 'login', error };
  }
  const userOnly = [...document.querySelectorAll('input[name="username"], input[autocomplete="username"]')].find(visible);
  if (userOnly) {
    setValue(userOnly, username);
    submit(userOnly.form, userOnly.form || document);
    return { action: 'username' };
  }
  const accept = document.querySelector('[name="accept"]');
  if (accept) { accept.click(); return { action: 'consent' }; }
  return { action: 'none', title: document.title, error };
})()`
}

interface FillOutcome {
  action: 'login' | 'username' | 'consent' | 'none'
  title?: string
  error?: string
}

/**
 * Drive one login to the CLI's callback and return the callback URL, or say
 * why it did not get there. Never throws, never shows a window.
 */
export function performBrowserLogin(req: LoginRequest): Promise<LoginResult> {
  // A fresh in-memory session per attempt: no cookie from an earlier login
  // (another user, a revoked grant) can steer this one, and two logins running
  // at once cannot see each other's requests.
  const ses = electronSession.fromPartition(`mcp-login-${randomUUID()}`)
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  return new Promise((resolve) => {
    let done = false
    // How many times each page kind has been answered. A login form that comes
    // back after being submitted is the identity provider refusing the
    // credentials; submitting again would only lock the account sooner.
    let logins = 0
    let consents = 0
    let lastPage = ''

    const finish = (result: LoginResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      ses.webRequest.onBeforeRequest(null)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => {
      const where = lastPage ? ` (last page: ${lastPage})` : ''
      const seconds = LOGIN_TIMEOUT_MS / 1000
      finish({ ok: false, error: `the login did not finish within ${seconds}s${where}` })
    }, LOGIN_TIMEOUT_MS)

    // Every request, not a URL pattern: a match pattern's port handling is not
    // something to bet the finish line on, and the identity provider itself is
    // usually on localhost too, on another port.
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      if (!isCallback(details.url, req.callbackPort)) {
        callback({})
        return
      }
      callback({ cancel: true })
      finish({ ok: true, callbackUrl: details.url })
    })

    win.webContents.on('did-finish-load', () => {
      if (done) return
      lastPage = win.webContents.getURL()
      void win.webContents
        .executeJavaScript(buildFillScript(req.username, req.password))
        .then((outcome: FillOutcome) => {
          if (done) return
          if (outcome.action === 'login' && ++logins > 1) {
            const why = outcome.error || 'the login form came back after submitting'
            finish({ ok: false, error: `the login was refused: ${why}` })
          } else if (outcome.action === 'consent' && ++consents > 2) {
            finish({ ok: false, error: 'the consent page kept coming back' })
          } else if (outcome.action === 'none' && outcome.error) {
            finish({ ok: false, error: `the login page reported: ${outcome.error}` })
          }
        })
        .catch(() => {
          /* the page navigated away mid-script; the next load runs it again */
        })
    })

    // The cancelled callback request fails the load that carried it, which is
    // the expected end of a successful login rather than an error.
    win.loadURL(req.authUrl).catch(() => {})
  })
}

function isCallback(url: string, port: number): boolean {
  try {
    const u = new URL(url)
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === String(port)
  } catch {
    return false
  }
}
