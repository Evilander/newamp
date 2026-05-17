import type { CSSProperties } from 'react';
import logoUrl from '../../build/logo-app.webp';

interface BrandLogoProps {
  size?: number;
  title?: string;
  withGlow?: boolean;
  className?: string;
}

export function BrandLogo({
  size = 22,
  title = 'NewAmp',
  className,
}: BrandLogoProps): JSX.Element {
  const style: CSSProperties = {
    width: size,
    height: size,
    objectFit: 'contain',
  };

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
