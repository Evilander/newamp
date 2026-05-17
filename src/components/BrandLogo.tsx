import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import logoUrl from '../../build/logo.png';

interface BrandLogoProps {
  size?: number;
  title?: string;
  withGlow?: boolean;
  className?: string;
  themed?: boolean;
}

export function BrandLogo({
  size = 22,
  title = 'NewAmp',
  withGlow = true,
  className,
  themed = true,
}: BrandLogoProps): JSX.Element {
  const style = useMemo<CSSProperties>(
    () => ({
      width: size,
      height: size,
      filter: !themed && withGlow ? 'drop-shadow(0 0 10px var(--accent-glow))' : undefined,
    }),
    [size, themed, withGlow],
  );

  if (!themed) {
    return (
      <img
        src={logoUrl}
        alt={title}
        width={size}
        height={size}
        draggable={false}
        className={['brand-logo', className].filter(Boolean).join(' ')}
        style={{ ...style, objectFit: 'contain' }}
        data-newamp-brand-logo
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={title}
      className={['brand-logo brand-logo-themed', className].filter(Boolean).join(' ')}
      style={{
        ...style,
        WebkitMaskImage: `url(${logoUrl})`,
        maskImage: `url(${logoUrl})`,
      }}
      data-newamp-brand-logo
    />
  );
}
