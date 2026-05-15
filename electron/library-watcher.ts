import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

const AUDIO_EXTS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.m4a',
  '.m4b',
  '.mp4',
  '.aac',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.ape',
  '.wv',
  '.mpc',
  '.tta',
  '.mka',
  '.ac3',
  '.dts',
  '.dsf',
]);

const FOLDER_ART_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const FOLDER_ART_NAMES = new Set(['cover', 'folder', 'front', 'art', 'album']);

export interface LibraryWatcherOptions {
  debounceMs?: number;
}

export type LibraryWatchCallback = (targets: string[]) => void | Promise<void>;

export function normalizeLibraryWatchRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = resolve(root);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    try {
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    normalized.push(resolved);
  }

  return normalized;
}

export function resolveLibraryWatchTarget(root: string, fileName: string | Buffer | null): string | null {
  if (!fileName) return resolve(root);
  const relative = fileName.toString();
  if (!relative.trim()) return resolve(root);

  const target = resolve(join(root, relative));
  const ext = extname(target).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return target;

  const stem = basename(target, ext).toLowerCase();
  if (FOLDER_ART_EXTS.has(ext) && FOLDER_ART_NAMES.has(stem)) return dirname(target);

  return null;
}

export class LibraryWatcher {
  private readonly debounceMs: number;
  private readonly pendingTargets = new Map<string, string>();
  private watchers: FSWatcher[] = [];
  private roots: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onChange: LibraryWatchCallback,
    options: LibraryWatcherOptions = {},
  ) {
    this.debounceMs = Math.max(50, Math.round(options.debounceMs ?? 5000));
  }

  start(roots: string[]): void {
    this.stop();
    this.roots = normalizeLibraryWatchRoots(roots);

    for (const root of this.roots) {
      try {
        const watcher = watch(root, { recursive: true }, (_eventType, fileName) => {
          const target = resolveLibraryWatchTarget(root, fileName);
          if (!target) return;
          this.queueTarget(target);
        });
        watcher.on('error', (err) => {
          console.warn(`[newamp] library watcher failed for ${root}: ${errorMessage(err)}`);
        });
        this.watchers.push(watcher);
      } catch (err) {
        console.warn(`[newamp] library watcher unavailable for ${root}: ${errorMessage(err)}`);
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.pendingTargets.clear();
    this.roots = [];
  }

  isWatching(): boolean {
    return this.watchers.length > 0;
  }

  getWatchedRoots(): string[] {
    return [...this.roots];
  }

  flushNow(): void {
    if (!this.pendingTargets.size) return;
    const targets = [...this.pendingTargets.values()];
    this.pendingTargets.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void Promise.resolve(this.onChange(targets)).catch((err) => {
      console.warn(`[newamp] library watcher scan failed: ${errorMessage(err)}`);
    });
  }

  private queueTarget(target: string): void {
    this.pendingTargets.set(target.toLowerCase(), target);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushNow(), this.debounceMs);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
