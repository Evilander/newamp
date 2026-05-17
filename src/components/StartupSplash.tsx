import { BrandLogo } from './BrandLogo';

export function StartupSplash(): JSX.Element {
  return (
    <div className="startup-splash" data-newamp-startup-splash>
      <div className="startup-splash-badge">
        <BrandLogo size={220} title="NewAmp loading" withGlow={false} className="startup-splash-logo" />
      </div>
    </div>
  );
}
