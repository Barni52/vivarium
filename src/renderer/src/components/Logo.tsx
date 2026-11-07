import React from 'react'

// The Vivarium app mark, matching build/icon.svg (the Windows icon): three glass
// cells, one per container — green alive, amber waiting, the clear one empty.
// Rendered inline as SVG so it stays crisp at any size. Gradient ids are made
// unique per instance (React.useId) so several logos can coexist on one page
// without url(#id) collisions.
//
// **The one component that does not read the palette, and deliberately.** These
// values are brand, not chrome: they are the same paint as build/icon.svg, which
// is compiled into the installer and shown by Windows in the taskbar, the start
// menu and Explorer — none of which know this app has themes. Theming the mark
// would mean the icon in the title bar and the icon on the taskbar were different
// pictures. It has no backing tile: every cell is a saturated fill or carries a
// mid-teal rim, which reads on carbon and on cream alike.
//
// `small` mirrors the `.small` rules inside icon.svg (the .ico's 16 and 24 frames):
// drop the highlights and the shadow, shrink each cell so the gaps survive, and
// give the glass cell a heavier rim and a denser fill, or it dissolves at 18px.
export function Logo({
  size = 32,
  style
}: {
  size?: number
  style?: React.CSSProperties
}): React.ReactElement {
  const uid = React.useId().replace(/:/g, '')
  const live = `live-${uid}`
  const wait = `wait-${uid}`
  const glass = `glass-${uid}`
  const rim = `rim-${uid}`
  const shadow = `shadow-${uid}`
  const small = size <= 24
  const cell: React.CSSProperties | undefined = small
    ? { transformBox: 'fill-box', transformOrigin: 'center', transform: 'scale(0.92)' }
    : undefined
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" style={style}>
      <defs>
        <linearGradient id={live} x1="0" y1="40" x2="0" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#86E6A0" />
          <stop offset="1" stopColor="#1F9A5C" />
        </linearGradient>
        <linearGradient id={wait} x1="0" y1="124" x2="0" y2="222" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFD27A" />
          <stop offset="1" stopColor="#E08A1F" />
        </linearGradient>
        <linearGradient id={glass} x1="0" y1="124" x2="0" y2="222" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#C7F1EE" stopOpacity="0.45" />
          <stop offset="1" stopColor="#7FD3CC" stopOpacity="0.18" />
        </linearGradient>
        <linearGradient id={rim} x1="0" y1="124" x2="0" y2="222" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7FD6CD" />
          <stop offset="1" stopColor="#2A8F87" />
        </linearGradient>
        <filter id={shadow} x="-25%" y="-25%" width="150%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.28" />
        </filter>
      </defs>

      <g
        filter={small ? undefined : `url(#${shadow})`}
        transform="translate(128 125) scale(1.26) translate(-128 -130)"
      >
        {/* empty cell (glass) */}
        <path
          d="M79.5 125L120.2 148.5L120.2 195.5L79.5 219L38.8 195.5L38.8 148.5Z"
          fill={small ? '#A8E3DC' : `url(#${glass})`}
          fillOpacity={small ? 0.55 : undefined}
          stroke={`url(#${rim})`}
          strokeWidth={small ? 18 : 8}
          strokeLinejoin="round"
          style={cell}
        />
        {!small && <circle cx="79.5" cy="184" r="9" fill="#2A8F87" fillOpacity="0.55" />}

        {/* waiting cell (amber); a same-paint stroke rounds the corners */}
        <path
          d="M176.5 125L217.2 148.5L217.2 195.5L176.5 219L135.8 195.5L135.8 148.5Z"
          fill={`url(#${wait})`}
          stroke={`url(#${wait})`}
          strokeWidth="10"
          strokeLinejoin="round"
          style={cell}
        />

        {/* living cell (green) with its leaf */}
        <path
          d="M128 41L168.7 64.5L168.7 111.5L128 135L87.3 111.5L87.3 64.5Z"
          fill={`url(#${live})`}
          stroke={`url(#${live})`}
          strokeWidth="10"
          strokeLinejoin="round"
          style={cell}
        />
        {!small && (
          <>
            <path
              d="M112 116C112 96 124 80 146 76C146 98 132 112 112 116Z"
              fill="#FFFFFF"
              fillOpacity="0.85"
            />
            <path
              d="M100 64L124 50M152 148L174 136M56 148L76 136"
              stroke="#FFFFFF"
              strokeOpacity="0.45"
              strokeWidth="5"
              strokeLinecap="round"
            />
          </>
        )}
      </g>
    </svg>
  )
}
