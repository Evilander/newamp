// Shared UI icons as inline SVG (currentColor, block display) — same pattern
// as TransportIcons.tsx so they inherit theme color and stay crisp at the
// 12–16px sizes the chrome runs at. Geometry favors the recognizable material
// vocabulary over novelty; strokes are reserved for glyphs that need an
// outline voice (StarOutline, Antenna).

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

export function Star({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M12 2.8l2.7 5.9 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2-4.7-4.3 6.3-.7z" />
    </svg>
  );
}

export function StarOutline({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className} fill="none">
      <path
        d="M12 3.6l2.4 5.2 5.6.6-4.2 3.8 1.2 5.5-5-2.8-5 2.8 1.2-5.5-4.2-3.8 5.6-.6z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Note({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M12 3v10.55A3.96 3.96 0 0010 13c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

export function Close({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
  );
}

export function Gear({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  );
}

export function Dice({ size = 14, className }: IconProps): JSX.Element {
  // Five-pip face; pips are even-odd holes so the die reads at 12px.
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        fillRule="evenodd"
        d="M5 3.5h14A1.5 1.5 0 0120.5 5v14a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 19V5A1.5 1.5 0 015 3.5zm1.6 4.7a1.6 1.6 0 103.2 0 1.6 1.6 0 00-3.2 0zm7.6 0a1.6 1.6 0 103.2 0 1.6 1.6 0 00-3.2 0zM10.4 12a1.6 1.6 0 103.2 0 1.6 1.6 0 00-3.2 0zm-3.8 3.8a1.6 1.6 0 103.2 0 1.6 1.6 0 00-3.2 0zm7.6 0a1.6 1.6 0 103.2 0 1.6 1.6 0 00-3.2 0z"
      />
    </svg>
  );
}

export function Antenna({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="12" cy="10" r="2" />
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M12 12.4V21" />
        <path d="M8.5 13.5A4.9 4.9 0 018.5 6.5" />
        <path d="M15.5 6.5a4.9 4.9 0 010 7" />
        <path d="M6 16A7.7 7.7 0 016 4" />
        <path d="M18 4a7.7 7.7 0 010 12" />
      </g>
    </svg>
  );
}

export function Detach({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
    </svg>
  );
}

export function Camera({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        fillRule="evenodd"
        d="M9.4 3L7.8 4.8H4.5a2 2 0 00-2 2V18a2 2 0 002 2h15a2 2 0 002-2V6.8a2 2 0 00-2-2h-3.3L14.6 3H9.4zm-2 9.4a4.6 4.6 0 109.2 0 4.6 4.6 0 00-9.2 0z"
      />
      <path d="M12 9.4a3 3 0 110 6 3 3 0 010-6z" />
    </svg>
  );
}

export function Refresh({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

export function Queue({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z" />
    </svg>
  );
}

export function ChevronRight({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M9.7 6L8.3 7.4l4.6 4.6-4.6 4.6 1.4 1.4 6-6z" />
    </svg>
  );
}

export function Sparkle({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M12 2.6Q13.4 9.2 19.4 12 13.4 14.8 12 21.4 10.6 14.8 4.6 12 10.6 9.2 12 2.6Z" />
    </svg>
  );
}
