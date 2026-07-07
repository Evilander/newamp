// Module-level toast store — importable from anywhere, including non-React
// modules (audio engine, IPC handlers), so any code path can surface a status
// line without threading callbacks up to the component tree. <ToastHost/> in
// App.tsx subscribes and renders; this file owns the queue and nothing else.
//
// Deliberately dependency-free: a snapshot array + listener set is all the
// state there is, and useSyncExternalStore consumes it directly.

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  title: string;
  detail?: string;
  /** Auto-expire delay. <= 0 or non-finite makes the toast sticky until clicked. */
  durationMs?: number;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  durationMs: number;
}

export const TOAST_DEFAULT_DURATION_MS = 3500;

/** Hard cap on queued toasts — the host shows a short stack, not a log. */
const MAX_TOASTS = 4;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Queue a toast. Returns its id (usable with dismissToast). */
export function pushToast(options: ToastOptions): number {
  const id = nextId++;
  const toast: Toast = {
    id,
    tone: options.tone ?? 'info',
    title: options.title,
    detail: options.detail,
    durationMs: options.durationMs ?? TOAST_DEFAULT_DURATION_MS,
  };
  // Oldest toasts fall off the back when the stack is full — a burst of
  // notifications should never wallpaper the corner of the app.
  toasts = [...toasts, toast].slice(-MAX_TOASTS);
  emit();
  return id;
}

/** Remove a toast immediately. No-op if it already expired. */
export function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function clearToasts(): void {
  if (!toasts.length) return;
  toasts = [];
  emit();
}

/** Stable snapshot for useSyncExternalStore. */
export function getToasts(): readonly Toast[] {
  return toasts;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
