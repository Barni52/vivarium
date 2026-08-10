// Global CSS: palette custom-props, keyframes, scrollbars. Injected once at
// startup from `main.tsx`.
import type { SessionType } from '@shared/types'
import { DEFAULT_THEME, THEME_BG, THEME_KEY, isThemeName, type ThemeName } from '@shared/theme'

// Re-exported so the renderer has one import for "the theme", and so the four
// non-CSS consumers do not each have to know which half a given fact lives in.
export { DEFAULT_THEME, THEME_KEY, isThemeName }
export type { ThemeName }

/**
 * **The palette, one column per theme. Every colour in this app is one of these
 * values, and this file is the only place any of them is written down.**
 *
 * `MIDNIGHT` below is both the default theme *and* the schema: `Tokens` is
 * derived from its keys, so a theme that forgets a token does not compile. That
 * is the whole safety story for adding a fourth — there is no "falls back to
 * midnight" path, because a missing custom property does not fall back, it
 * renders as nothing at all.
 *
 * These are TS objects rather than only CSS blocks because four consumers in
 * this app cannot resolve a custom property — they are not CSS at all:
 *   - xterm's `theme` and its find-bar `ISearchOptions` (a WebGL canvas it
 *     paints itself; the search options additionally refuse alpha),
 *   - the taskbar badge (a 2D canvas `fillStyle`; see `store.ts`),
 *   - Electron's `BrowserWindow.backgroundColor` (main process, no document).
 * Those read `tokensFor(theme).x` by name and **must be re-read when the theme
 * changes** — a `var()` swaps itself, a canvas does not. Everything else uses
 * `var(--x)` and needs no notification at all.
 *
 * Keys are the custom-property names without the leading dashes, which is what
 * makes the CSS generation a one-liner and what stops a var existing that has no
 * entry here.
 */
const MIDNIGHT = {
  /** main content background: the terminal, the chat page, the empty state.
   *  From `@shared/theme` — this is the one token the *main* process needs too
   *  (it paints the window under the document), so it is written down there. */
  bg: THEME_BG.midnight,
  /** chrome: title bar and sidebar, one step up from the page */
  panel: '#171a24',
  /** a user message bubble — the one raised surface in the log */
  card: '#1b1e29',
  /** the composer and every inset box: a card that is being written into */
  card2: '#1a1d27',
  /** hairline dividers */
  border: '#262b3a',
  /** button and composer outlines — an edge you are meant to see */
  'border-strong': '#333a4d',
  /** text inputs. Below the page, because you type *into* it. */
  input: '#10121a',
  /** primary text */
  fg: '#d7dae3',
  /** secondary labels */
  muted: '#7c8497',
  /** timestamps, paths, hints */
  dim: '#5b6376',
  /**
   * A find-in-chat match.
   *
   * Its own token rather than a reuse of `--accent2-soft`, on the rule this file
   * already states for `--warn`: a token is a meaning, not a hex. "The find bar
   * matched here" and "this chip is in bypass" are two meanings, and one of them
   * changing colour later must not drag the other with it.
   *
   * An alpha wash of the theme's `--str`, which is the hue this palette already
   * spends on *the part of the text somebody picked out* — a quoted string, a
   * bold run. A search hit is the reader picking one out, so it is the same
   * idea. Translucent, so the glyphs keep their own colour and a match inside a
   * code span or a bold run still reads as code or bold.
   */
  find: 'rgba(217,160,106,.30)',
  /** the empty half of a progress bar */
  track: '#2a3042',
  /** the one filled accent: "Add project", the active-item left bar */
  accent: '#2f5fd0',
  /** ink on `--accent` */
  'accent-fg': '#f2f5ff',
  /** the counterweight: bypass outline, `claude` label, agent icon, ctx fill */
  accent2: '#e0663d',
  'accent2-soft': 'rgba(224,102,61,.12)',
  /** hover and selected row background — one value, both jobs */
  sel: '#232838',
  /** running dots, quota bar fills */
  ok: '#2fbf5f',
  /** quoted strings, and bold inline in assistant prose */
  str: '#d9a06a',
  /** slash commands */
  cmd: '#d1594a',
  /** the send button */
  send: '#d1594a',
  /** ink on the send button */
  'send-fg': '#fff',
  /** the `you` role word */
  'role-you': '#6cb6d9',
  /** the `stop` role word */
  'role-stop': '#8d94a6',

  // ── Derived. ─────────────────────────────────────────────────────────────
  // The named palette does not cover a few states this app has and a transcript
  // mock-up does not: something going wrong, something in flight, a scrim, a
  // focus ring, an ink colour for each filled surface. They are tokens rather
  // than literals at the ~40 call sites that need them, and — the reason they
  // are per-theme rather than shared — most of them *invert* on `paper`: ink on
  // a fill goes light where the fill went dark, and the scrim goes from "darken
  // the page" to "grey it".

  /** destructive: kill, delete, a crashed turn. Held apart from `--cmd`/`--send`,
   *  which are loud without meaning *this ends something*. */
  danger: '#c2352a',
  'danger-soft': 'rgba(194,53,42,.14)',
  /** ink on a filled `--danger` */
  'danger-fg': '#fff',
  /** in flight: a container starting, a Claude Code version behind npm.
   *  Deliberately the same value as `--str` under a second name — a token is a
   *  meaning, not a hex, and "a string literal" and "something is pending" are
   *  two meanings that happen to agree on a hue. */
  warn: '#d9a06a',
  'ok-soft': 'rgba(47,191,95,.12)',
  /** ink on a filled `--accent2`, and on the `--str` box of a ticked option.
   *  **This is the token that makes `paper` work**: `--accent2` is a light
   *  orange on the dark themes and a dark rust on the light one, so its ink
   *  cannot be a constant anywhere. */
  'on-accent2': '#12141c',
  /** the dialog scrim */
  overlay: 'rgba(8,9,13,.66)',
  /** keyboard focus, lifted off `--accent` so the ring reads on top of it */
  focus: '#5b83e0',
  'focus-soft': 'rgba(47,95,208,.28)',
  /** selected text. **Translucent, and that is load-bearing** — the chat
   *  composer paints a `/command` by going `color: transparent` and letting a
   *  twin behind it draw the glyphs, and this band is what keeps a selection
   *  readable over glyphs that are no longer there (see `ChatView`). An opaque
   *  value here blanks the command you are typing. */
  selection: 'rgba(47,95,208,.32)',
  /** the one drop shadow, for popovers and dialogs */
  shadow: 'rgba(0,0,0,.62)',

  // ── Syntax. ──────────────────────────────────────────────────────────────
  // Fenced code and the diff a tool card holds. Eight roles, and the named
  // palette has three chromatic tokens to spend — collapsing eight onto three
  // would leave a code block with no structure at all, which is the one place
  // colour is doing load-bearing work rather than decoration. So six of the
  // eight *are* palette tokens under a second name (the `--warn` argument), and
  // exactly two hues per theme are the code block's own.
  /** comments — the dimmest thing in the window, which is `--dim`'s job */
  'code-comment': '#5b6376',
  /** braces, semicolons, operators: structure, not content. `--muted`. */
  'code-punct': '#7c8497',
  /** `if`, `class`, `import` — the block's own hue #1, held off `--accent` */
  'code-keyword': '#a98fe0',
  /** strings, chars, regex, attribute values. `--str`. */
  'code-string': '#d9a06a',
  /** numbers and the constants that read like them — hue #2, warm, off `--cmd` */
  'code-number': '#d1846a',
  /** a name in call position. `--role-you`. */
  'code-fn': '#6cb6d9',
  /** class names, tags, JSON keys — `--str` lifted, so types and strings differ */
  'code-type': '#d9c07a',
  /** a ```diff fence's own signs. The tool card's diff tints the row instead. */
  'code-ins': '#2fbf5f',
  'code-del': '#d1594a',
  /** the two diff row tints — `--ok` / `--cmd` at 10%, over `--card2` */
  'ins-soft': 'rgba(47,191,95,.10)',
  'del-soft': 'rgba(209,89,74,.10)'
} as const

/** Every token a theme must supply. Derived from `MIDNIGHT`, so it cannot drift. */
export type Tokens = Record<keyof typeof MIDNIGHT, string>

/** Neutral carbon with an amber action colour. Nothing in it is blue. */
const GRAPHITE: Tokens = {
  bg: THEME_BG.graphite,
  panel: '#1a1a1a',
  card: '#202020',
  card2: '#1d1d1d',
  border: '#2d2d2d',
  'border-strong': '#3d3d3b',
  input: '#111',
  fg: '#e5e3dd',
  muted: '#8c8a83',
  dim: '#6a6862',
  find: 'rgba(201,160,106,.30)',
  track: '#2f2f2d',
  accent: '#b8792b',
  'accent-fg': '#1a1305',
  accent2: '#d9a13b',
  'accent2-soft': 'rgba(217,161,59,.12)',
  sel: '#272725',
  ok: '#89b04f',
  str: '#c9a06a',
  cmd: '#cf7a3c',
  send: '#b8792b',
  'send-fg': '#1a1305',
  'role-you': '#9bb6a0',
  'role-stop': '#8c8a83',

  // Still the one red in the app that means "this ends something" — a warm
  // theme is not a reason for a delete button to stop looking like one.
  danger: '#c2352a',
  'danger-soft': 'rgba(194,53,42,.16)',
  'danger-fg': '#fff',
  // `--accent2` rather than `--str` here: on this theme the amber *is* the
  // action colour, and "in flight" reads as a paler version of it.
  warn: '#d9a13b',
  'ok-soft': 'rgba(137,176,79,.12)',
  // `--accent2` is a light amber on this theme, so its ink is the same near
  // black `--accent-fg` uses.
  'on-accent2': '#1a1305',
  overlay: 'rgba(0,0,0,.66)',
  focus: '#d9a13b',
  'focus-soft': 'rgba(217,161,59,.26)',
  selection: 'rgba(184,121,43,.32)',
  shadow: 'rgba(0,0,0,.7)',

  'code-comment': '#6a6862',
  'code-punct': '#8c8a83',
  'code-keyword': '#b294c9',
  'code-string': '#c9a06a',
  'code-number': '#cf7a3c',
  'code-fn': '#9bb6a0',
  'code-type': '#d9c07a',
  'code-ins': '#89b04f',
  'code-del': '#cf7a3c',
  'ins-soft': 'rgba(137,176,79,.10)',
  'del-soft': 'rgba(207,122,60,.10)'
}

/**
 * Warm light, ink text, slate action — and the theme every derived token exists
 * for. On a light ground the fills go dark, so their ink goes light; the scrim
 * greys the page instead of darkening it; the shadow is a fraction of what it
 * was, because a heavy drop shadow on cream reads as dirt; and every syntax hue
 * has to be dark enough to sit on `--card`, which here is pure white.
 */
const PAPER: Tokens = {
  bg: THEME_BG.paper,
  panel: '#eeeae0',
  card: '#fff',
  card2: '#fbf9f4',
  border: '#ddd7c9',
  'border-strong': '#c9c2b1',
  input: '#fff',
  fg: '#2c2b26',
  muted: '#78736a',
  dim: '#9a9488',
  find: 'rgba(154,91,28,.26)',
  track: '#e2ddd0',
  accent: '#1f5f8b',
  'accent-fg': '#f4fbff',
  accent2: '#b5451b',
  'accent2-soft': 'rgba(181,69,27,.10)',
  sel: '#e5dfd0',
  ok: '#3f8f4f',
  str: '#9a5b1c',
  cmd: '#b5451b',
  send: '#b5451b',
  'send-fg': '#fffaf7',
  'role-you': '#1f5f8b',
  'role-stop': '#78736a',

  // A step darker than the close button's red, which stays what it is on every
  // theme: this one has to carry small text on cream.
  danger: '#b3261e',
  'danger-soft': 'rgba(179,38,30,.10)',
  'danger-fg': '#fffaf7',
  warn: '#9a5b1c',
  'ok-soft': 'rgba(63,143,79,.12)',
  // Inverted, and this is the whole reason the token exists: `--accent2` is a
  // dark rust here, so a tick drawn on it is near white.
  'on-accent2': '#fffaf7',
  // Grey the page rather than darken it — 66% black over cream is a different
  // colour, not a dimmer one.
  overlay: 'rgba(44,43,38,.42)',
  focus: '#1f5f8b',
  'focus-soft': 'rgba(31,95,139,.22)',
  // Lower alpha than the dark themes: the band is a *dark* wash over dark text
  // here rather than a light one over light text, so it reaches "unreadable"
  // sooner. Still translucent, which is the part that matters (see above).
  selection: 'rgba(31,95,139,.24)',
  shadow: 'rgba(44,43,38,.18)',

  'code-comment': '#9a9488',
  'code-punct': '#78736a',
  'code-keyword': '#6d3c9e',
  'code-string': '#9a5b1c',
  'code-number': '#b5451b',
  'code-fn': '#1f5f8b',
  'code-type': '#7a5a12',
  'code-ins': '#2f7a3d',
  'code-del': '#b5451b',
  'ins-soft': 'rgba(63,143,79,.12)',
  'del-soft': 'rgba(181,69,27,.10)'
}

/**
 * The Windows console "Campbell" ANSI palette — what makes coloured program
 * output (PSReadLine, git, ls, npm) render the way it does in a real Windows
 * terminal instead of in xterm's washed-out defaults. Shared by both dark
 * themes; `paper` needs its own, below.
 */
const CAMPBELL = {
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#3b78ff',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#6aa9ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2'
}

/**
 * ANSI for a light terminal. Every hue is darkened until it reads on cream —
 * Campbell's `brightYellow` (#f9f1a5) is invisible on `paper` and its `blue`
 * (#3b78ff) glares.
 *
 * **`white` and `brightWhite` are deliberately inverted.** On a dark theme they
 * are the two lightest greys, which is how a program spends them: `brightWhite`
 * means *emphasis*. Kept literal here they would be paper-on-paper. So the
 * ordering flips — `white` is a mid grey and `brightWhite` is nearly the ink
 * colour — which preserves the *intent* (bright = stands out) at the cost of the
 * name. Every light terminal theme makes some version of this trade; this is the
 * version that keeps `\e[97m` readable rather than the one that keeps it white.
 */
const ANSI_LIGHT = {
  black: '#2c2b26',
  red: '#a32b20',
  green: '#2f7a3d',
  yellow: '#8a6a12',
  blue: '#1f5f8b',
  magenta: '#7a3b8f',
  cyan: '#1d6f76',
  white: '#8c8a83',
  brightBlack: '#6a6862',
  brightRed: '#c2352a',
  brightGreen: '#3f8f4f',
  brightYellow: '#a8801a',
  brightBlue: '#2a76a8',
  brightMagenta: '#94499f',
  brightCyan: '#248790',
  brightWhite: '#4a4842'
}

export interface Theme {
  name: ThemeName
  /** what the switcher calls it */
  label: string
  /**
   * The switcher's 9px swatch. It is the theme's own `accent` on the two dark
   * themes and its *paper* on the light one — you pick a theme by the surface
   * you will be reading on, and `paper`'s accent is a blue that would make it
   * look like a third variant of midnight in a row of three squares.
   */
  swatch: string
  /**
   * Drives `color-scheme`, so the native scrollbars, the form controls we do not
   * draw ourselves and the text caret follow the theme instead of staying dark
   * over a cream page.
   */
  scheme: 'dark' | 'light'
  /** the 16 ANSI slots xterm paints program output with */
  ansi: typeof CAMPBELL
  tokens: Tokens
}

/** In switcher order, which is also cycle order for the keyboard shortcut. */
export const THEMES: Theme[] = [
  { name: 'midnight', label: 'Midnight', swatch: '#2f5fd0', scheme: 'dark', ansi: CAMPBELL, tokens: MIDNIGHT },
  { name: 'graphite', label: 'Graphite', swatch: '#b8792b', scheme: 'dark', ansi: CAMPBELL, tokens: GRAPHITE },
  { name: 'paper', label: 'Paper', swatch: '#f2eee3', scheme: 'light', ansi: ANSI_LIGHT, tokens: PAPER }
]

export function themeFor(name: ThemeName): Theme {
  return THEMES.find((t) => t.name === name) ?? THEMES[0]
}

/** The four non-CSS consumers' way in. See the note on `MIDNIGHT`. */
export function tokensFor(name: ThemeName): Tokens {
  return themeFor(name).tokens
}

/**
 * What `data-theme` says right now.
 *
 * The attribute, not `localStorage`, because the pre-paint script in
 * `index.html` has already resolved the stored value (including the "unset or
 * junk → midnight" case) and written it there. Reading it back is how the rest
 * of the app inherits that decision instead of making it a second time and
 * possibly differently.
 */
export function currentTheme(): ThemeName {
  const v = document.documentElement.dataset.theme
  return isThemeName(v) ? v : DEFAULT_THEME
}

/**
 * Swap the theme: the attribute the CSS blocks key off, and the store of record.
 *
 * A `try` around `localStorage` because a quota-exhausted or disabled store
 * throws on *write*, and a theme that will not persist is still a theme that
 * should apply for this session.
 */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name
  try {
    localStorage.setItem(THEME_KEY, name)
  } catch {
    /* persistence is a nicety; the swap already happened */
  }
}

/** `--bg:#12141c;--panel:#171a24;…` for one theme. */
const vars = (t: Tokens): string =>
  Object.entries(t)
    .map(([k, v]) => `--${k}:${v}`)
    .join(';')

/**
 * Every theme as a CSS block: the default on bare `:root`, the rest behind
 * `[data-theme]`.
 *
 * Midnight is emitted **twice** — once unqualified and once under its own
 * attribute — and the duplicate is not redundant. `:root` alone would be beaten
 * by nothing, but a future theme block placed after it wins on document order
 * for any token it also sets; giving midnight a selector of the same specificity
 * as its siblings means the three are decided by which attribute is on the
 * element and never by which was written last.
 */
const THEME_CSS = THEMES.map(
  (t) =>
    `${t.name === DEFAULT_THEME ? ':root,' : ''}:root[data-theme="${t.name}"]{color-scheme:${t.scheme};${vars(t.tokens)}}`
).join('\n  ')

/**
 * Shape, which is not a theme's business. A radius is the same radius on cream
 * as it is on carbon, so these sit outside the per-theme blocks — one place to
 * change, and no way for two themes to disagree about how round a button is.
 */
const SHAPE_VARS = '--radius:6px;--radius-sm:4px'

// The app's own chrome. `GLOBAL_CSS` — what actually gets injected — is this
// plus the handful of chat rules at the bottom of the file, which are down there
// so they can interpolate `CHAT` rather than restate its values in a string
// that would then drift from it silently.
//
/**
 * The one type face in the app — chrome, terminals, paths, versions, transcripts.
 * It used to be spelled out inline in ~20 components, which is why swapping the
 * face meant touching all of them; import this instead.
 *
 * JetBrains Mono rather than IBM Plex Mono: a taller x-height and a wider glyph
 * body make it hold up better at the 13px the terminal runs at, and its 0/O and
 * 1/l/I are drawn to be told apart, which matters for reading container ids and
 * hashes. Plex Mono stays as the first fallback — it is still bundled, so an
 * unresolved JetBrains lands on a known face rather than on whatever Windows
 * calls `monospace`.
 *
 * Note for the terminal: JetBrains Mono ships programming ligatures and xterm
 * does not run them (that needs the ligatures addon we don't load). They simply
 * don't fire — `!=` stays two glyphs — which is the behaviour we want anyway,
 * since a ligature is one glyph in two cells and the WebGL atlas is per-cell.
 */
export const MONO = "'JetBrains Mono', 'IBM Plex Mono', monospace"

const APP_CSS = `
  *{box-sizing:border-box}
  :root{${SHAPE_VARS}}
  ${THEME_CSS}
  html,body,#root{margin:0;padding:0;height:100%;background:var(--bg)}
  /* Mono everywhere, and the 12.5px base every other size in the app is set
     relative to. This is a tool for reading paths, container ids, model names,
     branch names and transcripts — there is no prose surface in it long enough
     to want a text face, and the sans one that used to be here meant the
     sidebar and the terminal beside it disagreed about how wide a character is. */
  body{font-family:${MONO};font-size:12.5px;color:var(--fg)}
  ::selection{background:var(--selection)}
  /* **The theme swap, and the only reason this rule is global.**

     Almost every surface in this app is styled *inline*, so there is no class to
     hang a transition on and no stylesheet rule that could win against the
     inline background anyway — but \`transition\` is not in competition with
     anything here, it only says *how* a value that changed should arrive. One
     universal rule therefore covers every element the swap touches, including
     the ones nobody has written yet, which is exactly the argument the radius
     and hover rules already make for the chat window.

     Three properties and no more: \`background-color\`, \`color\`, \`border-color\`.
     Not \`all\`, and not \`box-shadow\` — the focus ring is drawn with a shadow
     and it has to appear the instant a key lands, not fade in over 150ms.

     **Progress fills opt out.** A meter animates its own \`width\` as a reading
     changes, and a colour transition on top of that turns the escalation from
     accent → amber → red into a smear through the intermediate hues while the
     bar is also moving. \`[data-meter]\` marks the fill, not the track: the
     track is an ordinary themed surface and should cross-fade like the rest. */
  *,*::before,*::after{transition:background-color .15s,color .15s,border-color .15s}
  [data-meter]{transition:none}
  /* Keyboard focus. Every field in this app sets outline:none inline and inline
     styles win, so the ring is drawn with box-shadow instead: a hairline in the
     accent hue plus a soft bloom, square like the controls it wraps. :focus-visible
     rather than :focus, so clicking never lights anything up — this is only for
     people driving the app from the keyboard, who until now had nothing at all. */
  :focus{outline:none}
  :focus-visible{outline:none;box-shadow:0 0 0 1px var(--focus),0 0 0 4px var(--focus-soft)}
  /* xterm parks a hidden textarea at the cursor and keeps it focused the whole
     time a terminal is active — a ring there would just follow the caret. */
  .xterm textarea:focus-visible{box-shadow:none}
  /* The custom thumb. \`color-scheme\` (set per theme above) is what makes the
     scrollbars we do *not* restyle — and the text caret, and any native control
     left undrawn — follow the theme rather than staying dark over cream; this
     covers the ones we do. */
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:var(--border);border:2px solid transparent;background-clip:padding-box}
  ::-webkit-scrollbar-thumb:hover{background:var(--dim)}
  input,button,textarea{font-family:inherit}
  @keyframes vthink{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
  @keyframes vpending{0%,100%{opacity:.35}50%{opacity:1}}
  @keyframes vover{from{opacity:0}to{opacity:1}}
  @keyframes vdlg{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @keyframes vpop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
`

/**
 * Per-session-type hues, and all four are palette tokens rather than hues of
 * their own — there is one palette now, and a session type is not a reason to
 * add to it.
 *
 * `agent` takes `--accent2` because that is what the spec names the agent icon.
 * The other three then have to be told apart *within* what is left, which is why
 * shape (`TypeIcon`) stays the primary distinction and colour only reinforces
 * it: `chat` is the cool `--role-you` (a chat is an agent, spoken to rather than
 * typed at, so it sits beside the agent without being it), `host-shell` is
 * `--muted` (the one that is not in the container at all, and the quietest),
 * and `container-shell` takes `--str`.
 *
 * `--ok` is deliberately *not* used here: it means "this container is running"
 * a few pixels away on the project header, and a colour may mean one thing.
 *
 * These are `var()` strings and they reach `<svg fill=…>` presentation
 * attributes through `TypeIcon`. That resolves — Blink maps a presentation
 * attribute into the cascade, so custom-property substitution applies — and the
 * file-type icons in the output tree have relied on it since before this
 * palette. What does *not* resolve is a canvas or xterm; those read `PALETTE`.
 */
export const ACCENT: Record<string, string> = {
  agent: 'var(--accent2)',
  chat: 'var(--role-you)',
  'container-shell': 'var(--str)',
  'host-shell': 'var(--muted)'
}

/**
 * The chat window's vocabulary.
 *
 * **It is no longer a second palette.** It used to hold plain hex strings on
 * purpose — the argument was containment: the sidebar, the title bar and the
 * terminals held `--bg`/`--panel`/`--text` as custom properties, the chat held
 * literals, so neither could drag the other. That bought isolation at the price
 * of a copy, and the copy is what is being paid off here: there is now **one**
 * palette for the whole app, so the chat's greys and the agent tab's greys are
 * not "kept in sync", they are the same three tokens.
 *
 * What survives is the *naming*. Every entry below is a `var()` pointing into
 * `PALETTE`, and it exists so the log can go on saying "the page", "a machinery
 * card", "the fourth grey down" instead of spelling a token at 200 call sites —
 * which is also what keeps a re-skin to this file. Nothing here may hold a
 * literal colour again; if a reading needs a value the palette does not have,
 * the value goes in `PALETTE` and the name goes here.
 *
 * The role hues are the answer to "user turn, tool call and AI response are hard
 * to tell apart": `--role-you` for what you said, `--accent2` for what Claude
 * said, and neither for the machinery, which lives in bordered mono cards.
 */
export const CHAT = {
  /** the page — the same `--bg` a terminal session runs on */
  bg: 'var(--bg)',
  /** the chrome: header and composer sit one step back, on `--panel` */
  header: 'var(--panel)',
  /** the composer — the same `--card2` as every other box you look *into* */
  composer: 'var(--card2)',
  /**
   * An inset box: a tool card, a diff, an expanded body, the plan panel.
   *
   * The one distinction the log's surfaces turn on. `card` is the *raised* one
   * and belongs to exactly one thing — the `you` bubble — while everything the
   * machinery draws is recessed. They were the same fill before this palette,
   * which is precisely why "user turn, tool call and AI response are hard to
   * tell apart" was the complaint that started the redesign.
   */
  inset: 'var(--card2)',
  /** the `you` bubble's raised surface, and nothing else */
  card: 'var(--card)',
  /** a recess *inside* a panel: a chip's fill, a meter's track */
  well: 'var(--input)',
  /** the empty half of a meter */
  track: 'var(--track)',
  /** ink on the send button's fill. A ticked option is *not* this — it is filled
   *  with `hold`, a light warm hue on the dark themes, and takes `--on-accent2`. */
  onAccent: 'var(--send-fg)',
  /** hairline dividers */
  border: 'var(--border)',
  borderSoft: 'var(--border)',
  borderCard: 'var(--border)',
  /** an edge you are meant to see: the composer, an outlined control */
  borderComposer: 'var(--border-strong)',
  /** the `you` bubble. A real card now, not a white lift over the page. */
  band: 'var(--card)',
  /** a row under the pointer, or a toggle that is on */
  hover: 'var(--sel)',
  /**
   * Corners, as CSS lengths rather than numbers — they are `var()` now, and a
   * var cannot be suffixed with `px` at the call site. `radius` is for controls
   * (chips, the mode toggle, send) and `radiusCard` for the panels they sit in.
   */
  radius: 'var(--radius-sm)',
  radiusCard: 'var(--radius)',
  /**
   * Type, brightest to dimmest. The palette has three greys where this had five,
   * which is the point — `prose` and `text` were a step apart that no longer
   * exists now that a chat paragraph and an agent's output are the same `--fg`,
   * and the bottom three all landed on "quieter than a label".
   */
  text: 'var(--fg)',
  prose: 'var(--fg)',
  dim: 'var(--muted)',
  dim2: 'var(--muted)',
  dim3: 'var(--dim)',
  dim4: 'var(--dim)',
  /** you: the cool role hue. Also the list bullet. */
  you: 'var(--role-you)',
  /** claude: `--accent2`, and the colour of a link */
  claude: 'var(--accent2)',
  /** a leading `/command` in the composer, and a command row in the log */
  cmd: 'var(--cmd)',
  /** the send button's fill */
  send: 'var(--send)',
  /** the `plan` chip — the quiet mode, outlined in `--border-strong` */
  mode: 'var(--muted)',
  /** the `bypass` chip — the loud one */
  bypass: 'var(--accent2)',
  /** the model chip's label */
  model: 'var(--fg)',
  /** the process is up */
  live: 'var(--ok)',
  /** the `stop` role word */
  stop: 'var(--role-stop)',
  /** plan / question — the "hold on" register */
  hold: 'var(--str)',
  /** a find-in-chat match; the current row additionally takes a `you` rail */
  find: 'var(--find)',
  danger: 'var(--danger)',
  /** context fill, escalating — `--accent2` while there is room, then amber, then red */
  ctx: ['var(--accent2)', 'var(--str)', 'var(--danger)']
}

/**
 * Syntax highlighting, for fenced code blocks and the diff a tool card holds.
 *
 * Names for the `--code-*` half of the palette, on the same terms as `CHAT`: the
 * values live in `PALETTE`, this says what each one is *for*. Six of the eight
 * roles are palette tokens under a second name and only two hues are the code
 * block's own — the argument for that split, and why it is not one hue fewer, is
 * written where the values are.
 *
 * Plain code is not in this object at all: it inherits `CHAT.prose` from the
 * `<pre>`, so a block in a language we do not have renders exactly as it did
 * before highlighting existed.
 */
export const CODE = {
  /** comments, and anything else the language treats as ignorable */
  comment: 'var(--code-comment)',
  /** braces, semicolons, operators — structure, not content */
  punct: 'var(--code-punct)',
  /** `if`, `class`, `public`, `import` */
  keyword: 'var(--code-keyword)',
  /** strings, chars, template literals, regex, attribute values */
  string: 'var(--code-string)',
  /** numbers, and the constants that read like them: booleans, `null`, enums */
  number: 'var(--code-number)',
  /** a name in call or definition position */
  fn: 'var(--code-fn)',
  /** class names, tags, attribute names, Java annotations, JSON keys */
  type: 'var(--code-type)',
  /** a ```diff fence's own signs. The tool card's diff tints the row instead. */
  ins: 'var(--code-ins)',
  del: 'var(--code-del)'
}

/**
 * Everything injected at startup: the app's chrome, then the chat's.
 *
 * The chat rules live here rather than in `APP_CSS` for one reason — they are
 * written in terms of `CHAT`, which is defined above them. Every one of them is
 * **scoped to `.vchat`**, the class on the chat's root, so none of it can reach
 * the sidebar, the title bar or the terminals. That scoping is now the *whole*
 * of the containment story: the palette is shared, so a `.vchat` rule is the
 * only thing left that says "this belongs to the chat and nowhere else".
 *
 * The radius rule is the reason this is worth doing at all: it rounds every
 * control in the window, including the ones nobody has written yet, where a
 * `borderRadius` threaded through ~25 inline styles rounds only today's.
 */
export const GLOBAL_CSS = `${APP_CSS}
  .vchat button,.vchat input,.vchat textarea{border-radius:${CHAT.radius}}
  /* Hover and press, once, for every control in the window — the same argument
     the radius rule makes, and the reason both live here: they reach the
     controls nobody has written yet.

     It has to be a **filter** rather than a background. Every control in this
     window is styled *inline*, and an inline background beats any rule this
     sheet could write — the hover would silently do nothing on exactly the
     controls that need it, which is the same trap the focus ring documents.
     (An inline background of var(--x) is still an inline background: pointing
     the palette at custom properties changed where the value comes from, not
     which declaration wins.) Brightness lifts a filled button's fill, a card's
     panel and a transparent chip's border and label alike, so one declaration
     covers all three shapes.

     The data-click attribute is for what is clickable without being a button:
     a tool card and the thinking row, which are divs because they wrap block
     content a button may not contain. */
  .vchat button:not(:disabled),.vchat [data-click]{transition:filter .12s,background-color .12s,border-color .12s,color .12s}
  .vchat button:not(:disabled):hover,.vchat [data-click]:hover{filter:brightness(1.32)}
  .vchat button:not(:disabled):active,.vchat [data-click]:active{filter:brightness(.9)}
  /* …with one exception. 1.32 is tuned for a transparent chip, where it has to
     lift a border and a label off the page; on the send button's saturated fill
     the same number reads as the button changing colour. */
  .vchat button[data-send]:not(:disabled):hover{filter:brightness(1.1)}
  /* A fenced code block's copy button. It is revealed by a hover on the
     *block* rather than on itself, which is the one thing an inline style
     cannot say — the same argument the two rules above make, and the reason
     this lives here instead of in Markdown.tsx.

     Hidden means pointer-events:none as well as transparent: an invisible
     button still takes clicks, and this one sits over the top-right corner of
     code the reader is trying to select. Focus and the just-copied state hold
     it open, so a keyboard can reach it and the tick it swaps to is never
     shown to a corner nobody is pointing at. Opacity only — a hover in this
     window may not change a height, and the log re-pins its tail on any
     height change at all. */
  .vchat [data-code] [data-copy]{opacity:0;pointer-events:none;transition:opacity .12s,filter .12s,color .12s}
  .vchat [data-code]:hover [data-copy],.vchat [data-code] [data-copy]:focus-visible,.vchat [data-code] [data-copy][data-copied]{opacity:1;pointer-events:auto}
  /* A wider gutter than the app-wide thumb: the log is a reading column and the
     bar sits at the very edge of it, so it is inset rather than flush. */
  .vchat-scroll::-webkit-scrollbar-thumb{background:${CHAT.border};border:3px solid ${CHAT.bg};background-clip:padding-box}
  .vchat-scroll::-webkit-scrollbar-thumb:hover{background:${CHAT.dim3}}
`

/**
 * The chat's type scale.
 *
 * One object because "make the chat a bit smaller" is one request, and it used
 * to be thirty inline numbers across three files. It is **not** the zoom: zoom
 * is what a reader reaches for at their own desk and it multiplies everything
 * here. This is the size the window is drawn at before they touch it.
 *
 * Two sizes and no more, which is the whole scale: **12.5 is the app's base**
 * and everything that is a label rather than a message is **11.5**. The five
 * steps this used to have (13.5/11/10.5/11.5) were four different ways of saying
 * "smaller than the prose" in a window that is one face throughout, and at mono
 * metrics the half-point between them was invisible anyway.
 */
export const CHAT_TEXT = {
  /** a message body, and the `Md` size every heading and table derives from */
  prose: 12.5,
  /** leading inside a paragraph and between the items of a list */
  proseLine: 1.55,
  /** machinery: tool cards, clocks, command output, the composer's status line */
  mono: 11.5,
  /** the gutter's `hh:mm role`, chips, and the `show 40 lines` hints */
  gutter: 11.5,
  /** fenced code and an `AskUserQuestion` preview — a grid, which holds its own */
  code: 11.5
}

/**
 * The chat's left and right margin — the *only* thing between the log and the
 * window edge.
 *
 * There used to be an 880px reading measure here and the column was centred in
 * it. The argument for it (a paragraph that runs to a 2560px edge is scanned,
 * not read) is a real one, and it lost to what it actually looked like: on a
 * maximised window the conversation was a narrow ribbon with a wide band of dead
 * background down each side, and the band on the left read as wider still
 * because the gutter was inside the column and the prose started another 100px
 * in. The window is the measure now — the user picks it by sizing the window,
 * which is the control they already have and the one they were reaching for. The
 * gutter column went the same way and for the same reason (see `ChatLog`): its
 * `CHAT_GUTTER` of 84 was the last horizontal number in the log that the content
 * did not get to use, so `CHAT_EDGE` is now the whole of the left margin, on
 * every line of every message rather than only on the ones a role word did not
 * happen to sit beside.
 */
export const CHAT_EDGE = 14

/** Which context tint a percentage earns. Colour appears when it means something. */
export function ctxColor(pct: number): string {
  // Percentages, never token counts: maxTokens came back as 1 000 000 on one
  // model, so a threshold expressed in tokens would never fire there.
  return pct >= 85 ? CHAT.ctx[2] : pct >= 60 ? CHAT.ctx[1] : CHAT.ctx[0]
}

export interface SessionTypeMeta {
  type: SessionType
  /**
   * One word, and never a word another type also uses. The old labels were
   * "Terminal · container" / "Terminal · host": identical for the first nine
   * characters, which is exactly how far you read when picking from a list.
   */
  title: string
  /** '' for the agent; the two shells share a group heading in the picker */
  group: string
  /** what actually runs — the most concrete distinction there is */
  shell: string
  /** where it runs */
  where: string
  accent: string
}

/**
 * The four session kinds, in picker order: the two agent kinds first (they are
 * the point of the app), then the shells with **host above container** — host is
 * the one that gets picked nearly every time.
 *
 * `chat` is a fourth type *alongside* `agent`, not a replacement — though it is
 * designed so it could swallow it later, so nothing here may assume the terminal
 * agent is gone.
 */
export const SESSION_TYPES: SessionTypeMeta[] = [
  {
    type: 'agent',
    title: 'Agent',
    group: '',
    shell: 'claude',
    where: 'in the container',
    accent: ACCENT.agent
  },
  {
    type: 'chat',
    title: 'Chat',
    group: '',
    shell: 'claude -p',
    where: 'in the container',
    accent: ACCENT.chat
  },
  {
    type: 'host-shell',
    title: 'Host',
    group: 'Terminal',
    shell: 'PowerShell',
    where: 'on Windows',
    accent: ACCENT['host-shell']
  },
  {
    type: 'container-shell',
    title: 'Container',
    group: 'Terminal',
    shell: 'bash',
    where: 'in the container',
    accent: ACCENT['container-shell']
  }
]

/**
 * Geometry of the new-session popover. Lives here rather than in the component
 * because openAddSession (store.ts) needs it to keep the panel on screen, and
 * the component importing the store already makes the other direction a cycle.
 */
export const ADD_SESSION_POPOVER = { width: 336, height: 434 }

export function typeMeta(type: string): SessionTypeMeta {
  return SESSION_TYPES.find((t) => t.type === type) ?? SESSION_TYPES[0]
}

/** Full name for prose and tooltips: 'Agent' / 'Host terminal' / 'Container terminal'. */
export function typeLabel(type: string): string {
  const m = typeMeta(type)
  return m.group ? `${m.title} ${m.group.toLowerCase()}` : m.title
}
