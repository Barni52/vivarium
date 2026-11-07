// Rasterize build/icon.svg into a multi-size Windows build/icon.ico (+ a 256 PNG).
// Uses Electron's offscreen Chromium (the only rasterizer available here) to render
// the SVG at each size, then packs the PNGs into an ICO (PNG-compressed entries,
// which Windows Vista+ supports).
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

// Keep the app alive between renders: destroying a window drops the count to
// zero, which would otherwise auto-quit before the next size renders.
app.on('window-all-closed', () => {})

const ROOT = path.join(__dirname, '..')
const SVG = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8')
const SIZES = [256, 128, 64, 48, 32, 24, 16]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:transparent}' +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    // icon.svg carries its own hand-tuned rules for taskbar size and below,
    // scoped under a `small` root class; this only switches them on.
    (size <= 24 ? SVG.replace('<svg ', '<svg class="small" ') : SVG)
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve)
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })
  // Offscreen's first frame(s) are blank — poll capturePage until it paints a
  // non-empty image at the requested size.
  let png = null
  for (let attempt = 0; attempt < 40; attempt++) {
    win.webContents.invalidate()
    await sleep(80)
    const img = await win.webContents.capturePage()
    if (!img.isEmpty()) {
      const sz = img.getSize()
      if (sz.width >= size - 1 && sz.height >= size - 1) {
        png = img.resize({ width: size, height: size }).toPNG()
        if (png && png.length > 0) break
      }
    }
  }
  win.destroy()
  if (!png || png.length === 0) throw new Error(`no non-empty frame for size ${size}`)
  return png
}

function buildIco(pngs) {
  // pngs: [{size, buf}]
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach((p, i) => {
    const b = i * 16
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, b + 0) // width (0 = 256)
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1) // height
    dir.writeUInt8(0, b + 2) // palette
    dir.writeUInt8(0, b + 3) // reserved
    dir.writeUInt16LE(1, b + 4) // color planes
    dir.writeUInt16LE(32, b + 6) // bits per pixel
    dir.writeUInt32LE(p.buf.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += p.buf.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)])
}

app.whenReady().then(async () => {
  try {
    const pngs = []
    for (const size of SIZES) {
      const buf = await render(size)
      pngs.push({ size, buf })
      // corner-alpha sanity check on the largest render
      if (size === 256) {
        // PNG top-left pixel alpha lives after IHDR/IDAT; instead just report bytes
        fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), buf)
        console.log(`  256 png: ${buf.length} bytes`)
      }
      console.log(`  rendered ${size}px (${buf.length} bytes)`)
    }
    const ico = buildIco(pngs)
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico)
    console.log(`icon.ico written: ${ico.length} bytes, ${pngs.length} sizes`)
    app.exit(0)
  } catch (e) {
    console.error('FAILED:', e)
    app.exit(1)
  }
})
