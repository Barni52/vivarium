// One face, three weights. IBM Plex Sans was here until the app went mono
// throughout — nothing references it now, and a webfont family nobody sets is
// three files of bundle that get downloaded and never drawn.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
// Plex Mono is the fallback in MONO (theme.ts), so it has to be loaded too —
// the whole point of naming a bundled fallback is that it is actually present.
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@xterm/xterm/css/xterm.css'

import { createRoot } from 'react-dom/client'
import { App } from './App'
import { GLOBAL_CSS, currentTheme, tokensFor } from './theme'

const style = document.createElement('style')
style.textContent = GLOBAL_CSS
document.head.appendChild(style)

// Tell main what colour to paint the window, synchronously at module eval —
// before the font wait below, before React, and so before `ready-to-show` lets
// the window be seen at all. The theme itself was already resolved by the
// pre-paint script in index.html; this only forwards the page colour to the one
// consumer that lives in another process. Skipped when `boot()` is running
// outside Electron (there is no preload bridge in a plain browser).
window.vivarium?.setWindowBackground(tokensFor(currentTheme()).bg)

// Chrome 156 (Electron 45) rejects a canvas `font` that starts with whitespace,
// and a rejected assignment is silent: the context keeps `10px sans-serif`.
// xterm's WebGL glyph atlas builds `${italic} ${weight} ${size}px ${family}`
// with an empty italic part for upright text, so every terminal rasterised in a
// 10px sans-serif and laid the result out in JetBrains Mono's cells: thin,
// unevenly spaced, box drawing in the wrong cells. @xterm/addon-webgl 0.19 builds
// the same string, so an upgrade does not fix it. Trimming at the setter
// does, for every string xterm builds and any version of it, and cannot change a
// valid value, since whitespace at either end of a CSS font means nothing.
// Remove once `ctx.font = ' 400 13px monospace'` reads back as 13px again.
for (const proto of [
  CanvasRenderingContext2D.prototype,
  globalThis.OffscreenCanvasRenderingContext2D?.prototype
]) {
  const font = proto && Object.getOwnPropertyDescriptor(proto, 'font')
  if (!proto || !font?.set || !font.get) continue
  const set = font.set
  Object.defineProperty(proto, 'font', {
    ...font,
    set(this: CanvasRenderingContext2D, value: string) {
      set.call(this, typeof value === 'string' ? value.trim() : value)
    }
  })
}

// Preload the terminal font (regular + bold) BEFORE the first xterm builds its
// WebGL glyph atlas. Otherwise the atlas caches a fallback / synthesizes bold by
// double-drawing, which renders as smeared/doubled text.
async function boot(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load("13px 'JetBrains Mono'"),
      document.fonts.load("500 13px 'JetBrains Mono'"),
      document.fonts.load("700 13px 'JetBrains Mono'")
    ])
    await document.fonts.ready
  } catch {
    /* fonts API unavailable — render anyway */
  }
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
