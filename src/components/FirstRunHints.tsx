import { lazy, Suspense } from 'react';

// The hints themselves (timers, placement, the bubble) load in their own chunk:
// nothing here is needed to start playing music, and the startup chunk is
// close to its size budget.
const FirstRunHintsBody = lazy(() =>
  import('./FirstRunHintsBody').then((module) => ({ default: module.FirstRunHintsBody })),
);

export function FirstRunHints(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <FirstRunHintsBody />
    </Suspense>
  );
}
