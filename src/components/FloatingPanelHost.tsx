// Mounts the floating panels. It sits next to <App /> in main.tsx, outside
// .app-chrome, so a panel keeps showing over the fullscreen visualizer (the
// chrome is hidden then). The panels' code loads the first time one opens.
import { lazy, Suspense, useEffect } from 'react';
import { closeColourEditor, useColourEditorOpen } from '../lib/colour-editor-open';
import { usePlayerStore } from '../store/usePlayerStore';
import { ErrorBoundary } from './ErrorBoundary';

const ColourEditorPanel = lazy(() =>
  import('./ColourEditor').then((module) => ({ default: module.ColourEditorPanel })),
);

// A panel that throws closes itself rather than taking the app down with it.
function CloseOnError(): null {
  useEffect(() => closeColourEditor(), []);
  return null;
}

export function FloatingPanelHost(): JSX.Element | null {
  const colourEditorOpen = useColourEditorOpen();
  // The deck window is too small to hold a panel; the panel stays open for when the app comes back.
  const compact = usePlayerStore((s) => s.compactMode);
  if (!colourEditorOpen || compact) return null;
  return (
    <ErrorBoundary fallback={<CloseOnError />}>
      <Suspense fallback={null}>
        <ColourEditorPanel />
      </Suspense>
    </ErrorBoundary>
  );
}
