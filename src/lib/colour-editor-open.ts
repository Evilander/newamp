// Whether the floating colour editor is open. Kept apart from the draft store
// so the Settings page and the Quick Play palette can open it, and the host
// that mounts it can listen, without pulling the editor's code into start-up.
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function openColourEditor(): void {
  set(true);
}

export function closeColourEditor(): void {
  set(false);
}

export function isColourEditorOpen(): boolean {
  return open;
}

export function subscribeColourEditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useColourEditorOpen(): boolean {
  return useSyncExternalStore(subscribeColourEditor, isColourEditorOpen, isColourEditorOpen);
}
