// Detached Eviland window controller for the fullscreen visualizer UI.
//
// Owns the open/closed state of the detached (pop-out) visualizer window and
// surfaces failures the main process reports for display (toggle state,
// busy spinner, error banner). The close/crash/open-failed → producer
// teardown (frameBus.detachPort()) lives in App.tsx's always-mounted effect
// instead of here, because this hook only mounts via Sidebar/
// FullscreenVisualizer — neither is mounted in compact mini-player mode, so
// a projector that dies while compact would otherwise never tell the
// producer to stop.

import { useCallback, useEffect, useState } from 'react';

export interface DetachedDisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  internal: boolean;
}

export interface DetachedVisualizerControls {
  /** True only in the Electron renderer where the preload bridge exists. */
  available: boolean;
  isOpen: boolean;
  busy: boolean;
  error: string | null;
  displays: DetachedDisplayInfo[];
  open: (displayId?: number) => void;
  close: () => void;
  moveToDisplay: (displayId: number) => void;
  clearError: () => void;
}

export function useDetachedVisualizer(): DetachedVisualizerControls {
  const bridge = typeof window !== 'undefined' ? window.detachedViz : undefined;
  const available = !!bridge;
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<DetachedDisplayInfo[]>([]);

  const refreshDisplays = useCallback(() => {
    if (!bridge) return;
    void bridge
      .listDisplays()
      .then((list) =>
        setDisplays(
          list.map((d) => ({ id: d.id, label: d.label, primary: d.primary, internal: d.internal })),
        ),
      )
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    void bridge
      .isOpen()
      .then((open) => {
        if (!cancelled) setIsOpen(open);
      })
      .catch(() => undefined);
    refreshDisplays();

    const offOpened = bridge.onOpened(() => {
      setIsOpen(true);
      setBusy(false);
      setError(null);
    });
    const offClosed = bridge.onClosed(() => {
      setIsOpen(false);
      setBusy(false);
    });
    const offCrashed = bridge.onCrashed((reason) => {
      setIsOpen(false);
      setBusy(false);
      setError(`Detached window crashed (${reason}).`);
    });
    const offFailed = bridge.onOpenFailed((reason) => {
      setIsOpen(false);
      setBusy(false);
      setError(`Couldn't open the detached window: ${reason}.`);
    });
    const offDisplays = bridge.onDisplaysChanged(refreshDisplays);

    return () => {
      cancelled = true;
      offOpened();
      offClosed();
      offCrashed();
      offFailed();
      offDisplays();
    };
  }, [bridge, refreshDisplays]);

  const open = useCallback(
    (displayId?: number) => {
      if (!bridge) return;
      setError(null);
      setBusy(true);
      void bridge
        .open(displayId !== undefined ? { displayId } : {})
        .catch((err: unknown) => {
          setBusy(false);
          setError(err instanceof Error ? err.message : 'Failed to open the detached window.');
        });
      // Success/failure is confirmed by the onOpened / onOpenFailed events the
      // main process fires once the window has actually loaded and wired its
      // frame port — busy clears there, not on the invoke resolving.
    },
    [bridge],
  );

  const close = useCallback(() => {
    if (!bridge) return;
    setBusy(true);
    // Like open(), busy clears on the main process's event ('detached-viz:
    // closed' → onClosed above), NOT when the close invoke resolves — the
    // invoke returns as soon as window.close() is *called*, before the native
    // window is destroyed, which briefly re-enabled the toggle against a
    // stale isOpen. Safety timeout in case the broadcast never arrives.
    void bridge.close().catch(() => setBusy(false));
    window.setTimeout(() => setBusy(false), 3000);
  }, [bridge]);

  const moveToDisplay = useCallback(
    (displayId: number) => {
      if (!bridge) return;
      void bridge.moveToDisplay(displayId).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to move the detached window.');
      });
    },
    [bridge],
  );

  const clearError = useCallback(() => setError(null), []);

  return { available, isOpen, busy, error, displays, open, close, moveToDisplay, clearError };
}
