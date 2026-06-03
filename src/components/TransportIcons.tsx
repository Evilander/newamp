// Transport control icons as inline SVG (currentColor fill) so they inherit
// theme color, take crisp optical weight at any size, and can animate — unlike
// the font-dependent Unicode glyphs (⏮ ▶ ⏸ ◼ ⏭) they replace, which render
// differently per platform and can't morph or react.
//
// Geometry uses the standard IEC 60417 media vocabulary (triangle / double-bar /
// square) — recognizability beats novelty for transport controls.

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number) {
  return {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'currentColor',
    'aria-hidden': true as const,
    focusable: false as const,
  };
}

export function PrevIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M6 6h2.2v12H6z" />
      <path d="M19 6v12l-9-6z" />
    </svg>
  );
}

export function NextIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M5 6v12l9-6z" />
      <path d="M15.8 6H18v12h-2.2z" />
    </svg>
  );
}

export function StopIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect x="6" y="6" width="12" height="12" rx="1.6" />
    </svg>
  );
}

/**
 * Play↔pause with a tasteful transition. Both glyphs live in the SVG; the
 * inactive one fades + scales out. Cleaner and more robust than animating the
 * path `d` between incompatible shapes, and it degrades gracefully under
 * prefers-reduced-motion (the CSS transition is disabled there).
 */
export function PlayPauseIcon({ playing, size = 18, className }: IconProps & { playing: boolean }): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className} data-playing={playing ? 'true' : 'false'}>
      <path className="pp-glyph pp-play" d="M8 5.5v13l11-6.5z" />
      <g className="pp-glyph pp-pause">
        <rect x="6.5" y="5.5" width="3.6" height="13" rx="1" />
        <rect x="13.9" y="5.5" width="3.6" height="13" rx="1" />
      </g>
    </svg>
  );
}

export function ShuffleIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2 1.4-1.4zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4h-5.5zm.3 9.4-1.4 1.4 3.1 3.1L12.5 20H18v-5.5l-2 2-1.2-1.1z" />
    </svg>
  );
}

export function RepeatIcon({ one = false, size = 16, className }: IconProps & { one?: boolean }): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
      {one && <path d="M12.9 15V9h-1l-2 1v1.1h1.5V15z" />}
    </svg>
  );
}
