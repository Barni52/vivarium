// SVG icons ported from the design mockup (scratchpad/page.html).
import React from 'react'

type P = { size?: number; color?: string; style?: React.CSSProperties }

const svg = (size: number, children: React.ReactNode, style?: React.CSSProperties): React.ReactElement => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={style}>
    {children}
  </svg>
)

// Agent. A four-point star with *concave* sides plus a small second spark —
// Claude's mark, and a spiky silhouette that can't be confused with the
// host window or the container cube at 15px. The old version was a convex
// diamond-ish star that just read as a blob next to the terminal glyph.
export const Sparkle = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M7.1 1.1C7.5 4.5 9.4 6.4 12.9 6.9 9.4 7.4 7.5 9.3 7.1 12.7 6.7 9.3 4.8 7.4 1.3 6.9 4.8 6.4 6.7 4.5 7.1 1.1Z"
        fill={color}
      />
      <path d="M12.5 9.6l.7 1.85 1.85.7-1.85.7-.7 1.85-.7-1.85-1.85-.7 1.85-.7z" fill={color} />
    </>,
    style
  )

// Chat. A rounded speech outline with the agent's own spark inside it — the
// fourth clearly distinct silhouette after the star, the window frame and the
// cube. It says *the agent, spoken to* rather than inventing an unrelated mark,
// which is what the type is: the same Claude Code, driven through a chat surface
// instead of a terminal.
export const ChatBubble = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M2 4.2A1.6 1.6 0 013.6 2.6h8.8A1.6 1.6 0 0114 4.2v5.4a1.6 1.6 0 01-1.6 1.6H6.6L3.2 14V11.2h-.2A1.1 1.1 0 012 10.1z"
        stroke={color}
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path
        d="M8 4.4c.25 1.9 1.15 2.8 3.05 3.05-1.9.25-2.8 1.15-3.05 3.05-.25-1.9-1.15-2.8-3.05-3.05C6.85 7.2 7.75 6.3 8 4.4Z"
        fill={color}
      />
    </>,
    style
  )

export const Folder = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path
      d="M1.6 4.4A1 1 0 012.6 3.4h3l1.2 1.4h6.6a1 1 0 011 1v6.2a1 1 0 01-1 1H2.6a1 1 0 01-1-1z"
      stroke={color}
      strokeWidth="1.1"
    />,
    style
  )

// A host project: a desktop monitor on its stand — "this runs on the PC", where
// a container project is a folder that gets mounted into the box. Chosen to
// share nothing with its two neighbours: the Folder it replaces in the sidebar,
// and the HostWindow session glyph that will usually sit right under it (a
// frame with a title bar and a prompt, and no stand).
export const Monitor = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="1.6" y="2.4" width="12.8" height="8.6" rx="1.2" stroke={color} strokeWidth="1.1" />
      <path d="M8 11v2.4M5.2 13.6h5.6" stroke={color} strokeWidth="1.1" strokeLinecap="round" />
    </>,
    style
  )

// Box with an arrow leaving its top-right corner — the OS "open in external app"
// convention. Used to open the shared folder in Explorer.
export const OpenExternal = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path
      d="M9 3.4H4a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1v-5M8 8l4.5-4.5M9.2 3.4h3.4v3.4"
      stroke={color}
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
    style
  )

export const Chevron = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path d="M6 4l4 4-4 4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
    style
  )

// Host shell (PowerShell on Windows). A window frame with a title bar and a
// prompt inside: "a terminal window on the desktop". The frame is what tells
// it apart from the container cube — one bare `>_` glyph used to serve both
// shell types, leaving color as the only difference between them.
export const HostWindow = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="1.5" y="2.6" width="13" height="10.8" rx="1.5" stroke={color} strokeWidth="1.15" />
      <path d="M1.5 5.6h13" stroke={color} strokeWidth="1.15" />
      <path
        d="M4.7 8.1l1.6 1.6-1.6 1.6"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.4 11.3h2.9" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </>,
    style
  )

// Container shell (bash inside the container). An isometric cube — the app's
// whole mental model is "this runs in the box", and a hexagonal outline is the
// third clearly distinct silhouette after the star and the window.
export const ContainerCube = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M8 1.9l5.7 2.85v6.5L8 14.1l-5.7-2.85v-6.5z"
        stroke={color}
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path
        d="M2.3 4.75L8 7.6l5.7-2.85M8 7.6v6.5"
        stroke={color}
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
    </>,
    style
  )

export const Plus = ({ size = 16, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M8 3v10M3 8h10" stroke={color} strokeWidth="1.5" strokeLinecap="round" />, style)

// A proper toothed cog: 8 flat-topped trapezoidal teeth (radial sides + flat
// tips) around a hollow hub. Built procedurally so the teeth are evenly spaced
// and geometrically exact — reads as a gear at small sizes, unlike thin spokes.
const GEAR_PATH = ((): string => {
  const cx = 8
  const cy = 8
  const teeth = 8
  const rTip = 6.7 // tooth tip radius
  const rRoot = 4.9 // valley radius between teeth
  const step = (Math.PI * 2) / teeth
  const half = step * 0.28 // angular half-width of each tooth
  const pt = (ang: number, r: number): string =>
    `${(cx + Math.cos(ang) * r).toFixed(2)} ${(cy + Math.sin(ang) * r).toFixed(2)}`
  let d = ''
  for (let i = 0; i < teeth; i++) {
    const c = i * step
    d += `${i === 0 ? 'M' : 'L'}${pt(c - half, rRoot)}L${pt(c - half, rTip)}L${pt(
      c + half,
      rTip
    )}L${pt(c + half, rRoot)}`
  }
  return `${d}Z`
})()

export const Gear = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d={GEAR_PATH} stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.3" stroke={color} strokeWidth="1.1" />
    </>,
    style
  )

export const Stop = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <rect x="4" y="4" width="8" height="8" rx="1" fill={color} />, style)

// The IEC power symbol — a ring broken at the top with a stem through the gap.
// Pairs with Stop (filled square) for the container's start/stop menu item: an
// outline for "off, press to turn on", a solid block for "on, press to stop".
// The arc is the *major* one (large-arc 1) in the screen-counterclockwise
// direction (sweep 0), which is the half that passes under the circle.
export const Power = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M5.36 4.63A4.6 4.6 0 1 0 10.64 4.63"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M8 2.3v5.3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </>,
    style
  )

// ---- terminal context-menu glyphs ----------------------------------------
// Deliberately the conventional shapes (two sheets / clipboard / marquee
// corners / magnifier ± / eraser) rather than anything invented: these are the
// items where a wrong guess is cheap but a moment of "which one was it" isn't.

// Two offset sheets. The back one is drawn as an open L so the sheets read as
// stacked without needing a fill to hide the overlap.
export const Copy = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.4" stroke={color} strokeWidth="1.15" />
      <path
        d="M10.6 5.6V3.5a1 1 0 00-1-1H3.5a1 1 0 00-1 1v6.1a1 1 0 001 1h2.1"
        stroke={color}
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </>,
    style
  )

export const Paste = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="3.4" y="4.2" width="9.2" height="9.6" rx="1.3" stroke={color} strokeWidth="1.15" />
      {/* the clip, overlapping the board's top edge the way a real one does */}
      <rect x="5.9" y="2" width="4.2" height="2.8" rx="1" stroke={color} strokeWidth="1.15" />
    </>,
    style
  )

// Marquee corners — a selection outline with nothing inside, so it can't be
// mistaken for the host-shell window frame.
export const SelectAll = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path
      d="M2.6 5.8V3.6a1 1 0 011-1h2.2M10.2 2.6h2.2a1 1 0 011 1v2.2M13.4 10.2v2.2a1 1 0 01-1 1h-2.2M5.8 13.4H3.6a1 1 0 01-1-1v-2.2"
      stroke={color}
      strokeWidth="1.25"
      strokeLinecap="round"
    />,
    style
  )

// One glass, three marks: nothing (find), plus, minus. Sharing the lens keeps
// Find and the two zoom items reading as the same family in one menu.
const magnifier = (color: string, mark: 'none' | 'plus' | 'minus'): React.ReactNode => (
  <>
    <circle cx="7" cy="7" r="4.4" stroke={color} strokeWidth="1.15" />
    <path d="M10.3 10.3l3 3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    {mark !== 'none' && (
      <path
        d={mark === 'plus' ? 'M7 5.1v3.8M5.1 7h3.8' : 'M5.1 7h3.8'}
        stroke={color}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    )}
  </>
)

export const Search = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, magnifier(color, 'none'), style)

export const ZoomIn = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, magnifier(color, 'plus'), style)

export const ZoomOut = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, magnifier(color, 'minus'), style)

// Stacked disks — the conventional read for storage, and deliberately nothing
// like Folder (host paths) or the rounded square (containers): a docker volume
// is neither of those.
export const Disks = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <ellipse cx="8" cy="4.3" rx="5" ry="2.1" stroke={color} strokeWidth="1.15" />
      <path
        d="M3 4.3v7.4c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V4.3"
        stroke={color}
        strokeWidth="1.15"
        strokeLinecap="round"
      />
      <path
        d="M3 8c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1"
        stroke={color}
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </>,
    style
  )

export const Restart = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M13 5A5.2 5.2 0 103.4 8.4" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13.2 2.2v3h-3" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </>,
    style
  )

export const Pencil = ({ size = 13, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M10.8 2.6l2.6 2.6-7.5 7.5H3.3v-2.6z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />, style)

// A tick. Drawn heavy and with a short tail so it still reads inside the 16px
// checkbox in the chat's question dialog, which is the only place it is used —
// at that size a hairline check turns into a grey smudge.
export const Check = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path
      d="M3.4 8.4l3.1 3.2 6.2-6.6"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
    style
  )

export const Close = ({ size = 13, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M4 4l8 8M12 4l-8 8" stroke={color} strokeWidth="1.4" strokeLinecap="round" />, style)

export const Trash = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M2.5 4.5h11M6 4.5V3.2a1 1 0 011-1h2a1 1 0 011 1v1.3" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
      <path d="M3.8 4.5l.6 8a1 1 0 001 .95h5.2a1 1 0 001-.95l.6-8" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 7v4M9.5 7v4" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    </>,
    style
  )

export const Lock = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke={color} strokeWidth="1.1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke={color} strokeWidth="1.1" />
    </>,
    style
  )

export const GitBranch = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <circle cx="4.5" cy="3.5" r="1.6" stroke={color} strokeWidth="1.15" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke={color} strokeWidth="1.15" />
      <circle cx="11.5" cy="4.5" r="1.6" stroke={color} strokeWidth="1.15" />
      <path d="M4.5 5.1v5.8M6.1 4.5h2.4a1.5 1.5 0 011.5 1.5v.4M11.5 6.1c0 2.2-1.6 3.2-3.5 3.6" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    </>,
    style
  )

export const File = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M4 2.2h5l3 3v8.6H4z"
        stroke={color}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M9 2.2v3h3" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
    </>,
    style
  )

// ---- file-type icons (shared output tree) ---------------------------------
// Popular formats only — anything unknown falls back to the generic File.
// Colors reuse the app palette so the tree stays cohesive.

const ImageFile = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="2.5" y="3.5" width="11" height="9" stroke={color} strokeWidth="1.1" />
      <circle cx="5.8" cy="6.4" r="1" fill={color} />
      <path d="M4 11l3-3 2 2 2.2-2.2 1.8 1.8" stroke={color} strokeWidth="1.1" strokeLinejoin="round" fill="none" />
    </>,
    style
  )

const Globe = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.1" fill="none" />
      <path d="M2.5 8h11M8 2.5c-2.1 1.7-2.1 9.3 0 11 2.1-1.7 2.1-9.3 0-11z" stroke={color} strokeWidth="1.1" fill="none" />
    </>,
    style
  )

const DocLines = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M4 2.2h5l3 3v8.6H4z" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2.2v3h3" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.8 8.2h4.4M5.8 10.6h4.4" stroke={color} strokeWidth="1.1" strokeLinecap="round" />
    </>,
    style
  )

const CodeFile = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path
      d="M6.2 4.8L3.2 8l3 3.2M9.8 4.8l3 3.2-3 3.2"
      stroke={color}
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />,
    style
  )

const TableFile = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="2.5" y="3.5" width="11" height="9" stroke={color} strokeWidth="1.1" />
      <path d="M2.5 6.5h11M7 6.5v6" stroke={color} strokeWidth="1.1" />
    </>,
    style
  )

const Archive = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="3.5" y="2.5" width="9" height="11" stroke={color} strokeWidth="1.1" />
      <path d="M8 4v1.2M8 6.8V8M8 9.6v1.2" stroke={color} strokeWidth="1.1" strokeLinecap="round" />
    </>,
    style
  )

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])
const CODE_EXTS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'py', 'java', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'xml'
])
const TABLE_EXTS = new Set(['csv', 'tsv', 'xls', 'xlsx'])
const ARCHIVE_EXTS = new Set(['zip', '7z', 'rar', 'tar', 'gz'])

/**
 * A file's glyph and its tint, in the output tree.
 *
 * Eight kinds sharing the palette's chromatic tokens rather than eight hues of
 * their own — the shape is doing the work here, exactly as it does for the
 * session types, and the colour only groups them: warm (`--str`) for things you
 * read, `--code-fn` blue for source, `--ok` for data, `--danger` for the one
 * that opens outside the app. Everything else stays grey, which is most of a
 * tree most of the time.
 */
export function FileIcon({ name, size = 14, style }: { name: string; size?: number; style?: React.CSSProperties }): React.ReactElement {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (IMAGE_EXTS.has(ext)) return <ImageFile size={size} color="var(--code-keyword)" style={style} />
  if (ext === 'html' || ext === 'htm') return <Globe size={size} color="var(--accent2)" style={style} />
  if (ext === 'md' || ext === 'markdown') return <DocLines size={size} color="var(--role-you)" style={style} />
  if (ext === 'pdf') return <DocLines size={size} color="var(--danger)" style={style} />
  if (ext === 'txt' || ext === 'log') return <DocLines size={size} color="var(--dim)" style={style} />
  if (CODE_EXTS.has(ext)) return <CodeFile size={size} color="var(--code-fn)" style={style} />
  if (TABLE_EXTS.has(ext)) return <TableFile size={size} color="var(--ok)" style={style} />
  if (ARCHIVE_EXTS.has(ext)) return <Archive size={size} color="var(--muted)" style={style} />
  return <File size={size} color="var(--dim)" style={style} />
}

// A 270° arc opening at the top right, closed by a solid arrowhead pointing
// clockwise — the reload convention.
//
// The arc is written endpoint-style, so the flags decide which of the two possible
// circles is drawn: (large-arc 1, sweep 1) resolves these endpoints to centre (8,8)
// r=4.9, concentric with the viewBox. The previous (1, 0) resolved to (7.30, 4.81)
// — 3.2 too high, the top of the circle at y=-0.39 — and an <svg> root clips to its
// viewport, so that glyph lost ~1 unit off the top, crammed its ink above y=8.6, sat
// high in its button and looked flat where the clip cut it. Keep the centre at (8,8)
// and the ink spans 2.0..13.7 in both axes, the margin the other icons here keep.
//
// The head is a filled triangle on the arc's end, pointing along its travel: the old
// two stroked lines meeting at a right angle read as a stray tick at 13px.
export const Refresh = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M12.6 6.32A4.9 4.9 0 116.32 3.4" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5.24 2.04 8.72 2.53 6.36 5.14Z" fill={color} />
    </>,
    style
  )

// Revert-to-a-message. Deliberately *not* the Refresh arc with its head moved:
// that one is a closed loop and reads as "do it again", which is the opposite of
// what this does. This is an open arc travelling leftwards, back the way the
// conversation came, on the same 2.0..13.7 ink box the icons here share.
export const Undo = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M3.1 7.4a5 5 0 118.4 3.7"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M2.05 4.3 6.2 7.15 2.2 9.1Z" fill={color} />
    </>,
    style
  )

export const PanelToggle = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2" stroke={color} strokeWidth="1.2" />
      <path d="M6.2 2.8v10.4" stroke={color} strokeWidth="1.2" />
    </>,
    style
  )

// One glyph per session type — three different silhouettes, so the sidebar,
// the terminal header and the new-session picker all read without color.
export function TypeIcon({ type, size = 15, color }: { type: string; size?: number; color?: string }): React.ReactElement {
  if (type === 'agent') return <Sparkle size={size} color={color} />
  if (type === 'chat') return <ChatBubble size={size} color={color} />
  if (type === 'host-shell') return <HostWindow size={size} color={color} />
  return <ContainerCube size={size} color={color} />
}

// Three staggered bouncing dots — the "agent is thinking" indicator (chat
// typing-ellipsis). Not an SVG, but it lives here so SessionRow and the
// collapsed-project aggregate in ProjectRow share one look. Rendered in the
// agent accent (violet) precisely so it can never be confused with the green
// container-running square.
export function ThinkingDots({
  color,
  title,
  style
}: {
  color: string
  title?: string
  style?: React.CSSProperties
}): React.ReactElement {
  return (
    <span title={title} style={{ display: 'flex', alignItems: 'center', gap: 2.5, flex: 'none', ...style }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 3.5,
            height: 3.5,
            borderRadius: '50%',
            background: color,
            animation: `vthink 1.1s ease-in-out ${i * 0.15}s infinite`
          }}
        />
      ))}
    </span>
  )
}
