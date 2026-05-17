import { HeideckerLogo } from './HeideckerLogo';

export function StartupSplash(): JSX.Element {
  return (
    <div className="startup-splash" data-newamp-startup-splash>
      <div className="startup-splash-badge">
        <HeideckerLogo size={172} title="NewAmp loading" withGlow />
        <div className="startup-splash-wordmark">NEWAMP</div>
      </div>
    </div>
  );
}
