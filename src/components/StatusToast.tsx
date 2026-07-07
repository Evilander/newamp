// <ToastHost/> — the single render surface for src/lib/toast.ts. Mounted once
// in App.tsx (both the full app and the compact deck branch) as a fixed
// bottom-right stack. All styling lives in styles/components/primitives.css;
// each toast wears .bevel-out so every shell dresses it in its own material
// (retro bevels, modern card, liquid glass, concourse cell).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { dismissToast, getToasts, subscribeToasts, type Toast } from '../lib/toast';

/** Matches the exit transition duration in primitives.css (var(--dur-base)). */
const TOAST_EXIT_MS = 200;

export function ToastHost(): JSX.Element | null {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  // Toasts play their exit motion before leaving the store: `leaving` ids stay
  // rendered with data-state="leaving" until the transition finishes.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(() => new Set());
  const [hovered, setHovered] = useState(false);
  // Remaining lifetime per toast id — lets hover pause/resume the clock.
  const remainingRef = useRef(new Map<number, number>());

  const beginLeave = useCallback((id: number) => {
    setLeaving((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      dismissToast(id);
      remainingRef.current.delete(id);
      setLeaving((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, TOAST_EXIT_MS);
  }, []);

  // Expiry clock. Hovering the stack pauses every timer (cleanup snapshots the
  // elapsed time back into remainingRef); unhovering re-arms with what's left.
  useEffect(() => {
    // Prune lifetimes for toasts that fell out of the store (stack overflow).
    const live = new Set(toasts.map((toast) => toast.id));
    for (const id of [...remainingRef.current.keys()]) {
      if (!live.has(id)) remainingRef.current.delete(id);
    }
    if (hovered) return undefined;
    const armedAt = Date.now();
    const handles = new Map<number, number>();
    for (const toast of toasts) {
      if (leaving.has(toast.id)) continue;
      if (!Number.isFinite(toast.durationMs) || toast.durationMs <= 0) continue; // sticky
      const remaining = remainingRef.current.get(toast.id) ?? toast.durationMs;
      remainingRef.current.set(toast.id, remaining);
      handles.set(toast.id, window.setTimeout(() => beginLeave(toast.id), Math.max(16, remaining)));
    }
    return () => {
      const elapsed = Date.now() - armedAt;
      for (const [id, handle] of handles) {
        window.clearTimeout(handle);
        const remaining = remainingRef.current.get(id);
        if (remaining !== undefined) remainingRef.current.set(id, Math.max(0, remaining - elapsed));
      }
    };
  }, [toasts, hovered, leaving, beginLeave]);

  if (!toasts.length) return null;

  return (
    <div
      className="toast-host"
      data-newamp-toast-host
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} leaving={leaving.has(toast.id)} onDismiss={beginLeave} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  leaving,
  onDismiss,
}: {
  toast: Toast;
  leaving: boolean;
  onDismiss: (id: number) => void;
}): JSX.Element {
  return (
    <div
      role="status"
      className={`status-toast bevel-out status-toast-${toast.tone}`}
      data-state={leaving ? 'leaving' : 'shown'}
      data-newamp-toast={toast.tone}
      title="Dismiss"
      onClick={() => onDismiss(toast.id)}
    >
      <div className="status-toast-copy">
        <div className="status-toast-title">{toast.title}</div>
        {toast.detail ? <div className="status-toast-detail">{toast.detail}</div> : null}
      </div>
    </div>
  );
}
