import { useEffect, useState } from 'react';
import { BrandLogo } from '../BrandLogo';
import { api } from '../../lib/api';

/** Where NewAmp keeps its library and settings. Empty in the browser preview, where there is no data folder. */
export function AboutDataRow({ path }: { path: string }): JSX.Element | null {
  if (!path) return null;
  return (
    <div data-newamp-about-data-path>
      <span>Data folder</span>
      <strong title={path}>{path}</strong>
    </div>
  );
}

export function AboutView(): JSX.Element {
  const [dataPath, setDataPath] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .getSupportDiagnostics()
      .then((diagnostics) => {
        if (!cancelled) setDataPath(diagnostics.userDataPath);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="about-view flex h-full items-center justify-center overflow-auto p-8">
      <section className="about-panel bevel-out">
        <BrandLogo size={188} title="NewAmp" withGlow />
        <div className="about-wordmark">NewAmp</div>
        <div className="about-subtitle">Local music player / visual system</div>

        <div className="about-info">
          <div>
            <span>Created by</span>
            <strong>Tyler "Evilander" Eveland</strong>
          </div>
          <div>
            <span>Company</span>
            <strong>Eveland Digital</strong>
          </div>
          <div>
            <span>Email</span>
            <a href="mailto:j.tyler.eveland@gmail.com">j.tyler.eveland@gmail.com</a>
          </div>
          <div>
            <span>Build</span>
            <strong>NewAmp v{api.appVersion} / {api.platform}</strong>
          </div>
          <AboutDataRow path={dataPath} />
        </div>
      </section>
    </div>
  );
}
