// Shared prefers-reduced-motion hook. Honors the OS media query plus NewAmp's
// custom 'newamp:reduced-motion-change' event and the smoke-test override
// window.__newampForceReducedMotion.

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

declare global {
  interface Window {
    __newampForceReducedMotion?: boolean;
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__newampForceReducedMotion === true) return true;
  if (window.__newampForceReducedMotion === false) return false;
  return window.matchMedia?.(QUERY).matches ?? false;
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mq = window.matchMedia?.(QUERY);
  mq?.addEventListener('change', cb);
  window.addEventListener('newamp:reduced-motion-change', cb);
  return () => {
    mq?.removeEventListener('change', cb);
    window.removeEventListener('newamp:reduced-motion-change', cb);
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
