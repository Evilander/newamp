import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import logoUrl from '../../build/logo.png';

interface BrandLogoProps {
  size?: number;
  title?: string;
  withGlow?: boolean;
  className?: string;
}

export function BrandLogo({
  size = 22,
  title = 'Newamp',
  withGlow = true,
  className,
}: BrandLogoProps): JSX.Element {
  const style = useMemo<CSSProperties>(
    () => ({
      width: size,
      height: size,
      objectFit: 'contain',
      filter: withGlow ? 'drop-shadow(0 0 10px var(--accent-glow))' : undefined,
    }),
    [size, withGlow],
  );

  return (
    <img
      src={logoUrl}
      alt={title}
      width={size}
      height={size}
      draggable={false}
      className={['brand-logo', className].filter(Boolean).join(' ')}
      style={style}
      data-newamp-brand-logo
    />
  );
}
