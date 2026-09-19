import { existsSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
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
  '.dff',
]);

const FOLDER_ART_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const FOLDER_ART_NAMES = new Set(['cover', 'folder', 'front', 'art', 'album']);

export interface LibraryWatcherOptions {
  debounceMs?: number;
  // 'recursive' is one fs.watch({ recursive: true }) per root, native on
  // Windows and macOS. Linux has no native recursive watch: Node's fallback
  // walks the tree synchronously, stats every file and holds an inotify watch
  // per FILE. 'per-directory' watches each folder instead (inotify reports
  // changes to a folder's entries), walking the tree asynchronously.
  strategy?: 'recursive' | 'per-directory';
}

export type LibraryWatchCallback = (targets: string[]) => void | Promise<void>;

export function normalizeLibraryWatchRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = resolve(root);
    // Two roots differing only in case are one folder on Windows and macOS,
    // and two real folders on Linux; dropping one there loses its tracks.
    const key = process.platform === 'win32' || process.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved;
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
  private readonly strategy: 'recursive' | 'per-directory';
  private readonly pendingTargets = new Map<string, string>();
  // Keyed by the watched path: one entry per root ('recursive') or per folder.
  private readonly watchers = new Map<string, FSWatcher>();
  private roots: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  // Bumped by stop() so an in-flight async tree walk abandons itself.
  private generation = 0;
  // One warning per failure reason per run, and a count, so a library that is
  // only half watched can be told apart from one that is watched.
  private readonly warnedWatchFailures = new Set<string>();
  private watchFailures = 0;

  constructor(
    private readonly onChange: LibraryWatchCallback,
    options: LibraryWatcherOptions = {},
  ) {
    this.debounceMs = Math.max(50, Math.round(options.debounceMs ?? 5000));
    this.strategy = options.strategy ?? (process.platform === 'linux' ? 'per-directory' : 'recursive');
  }

  start(roots: string[]): void {
    const next = normalizeLibraryWatchRoots(roots);
    // Settings saves reach here on every patch. Rebuilding unchanged watchers
    // threw away pending changes and, on Linux, re-walked the whole library.
    if (this.watchers.size > 0 && sameRoots(next, this.roots)) return;
    this.stop();
    this.roots = next;
    const generation = this.generation;
    for (const root of this.roots) {
      if (this.strategy === 'per-directory') void this.watchTree(root, generation);
      else this.watchPath(root, true);
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pendingTargets.clear();
    this.roots = [];
    // A new set of roots gets a fresh accounting, and its warnings again.
    this.warnedWatchFailures.clear();
    this.watchFailures = 0;
  }

  isWatching(): boolean {
    return this.watchers.size > 0;
  }

  watchFailureCount(): number {
    return this.watchFailures;
  }

  private reportWatchFailure(path: string, err: unknown): void {
    this.watchFailures += 1;
    const code = (err as { code?: string } | null)?.code ?? errorMessage(err);
    if (this.warnedWatchFailures.has(code)) return;
    this.warnedWatchFailures.add(code);
    const hint = code === 'ENOSPC'
      ? ' (the system ran out of watches; raise fs.inotify.max_user_watches)'
      : '';
    console.warn(`[newamp] library watcher failed for ${path}: ${errorMessage(err)}${hint}`);
  }

  watchedPathCount(): number {
    return this.watchers.size;
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

  private watchPath(path: string, recursive: boolean, generation = this.generation): boolean {
    if (this.watchers.has(path)) return true;
    try {
      const watcher = watch(path, { recursive }, (eventType, fileName) => {
        // Events are relative to the watched path, so it doubles as the root.
        const target = resolveLibraryWatchTarget(path, fileName);
        if (target) this.queueTarget(target);
        if (!recursive && eventType === 'rename' && fileName) {
          void this.adoptDirectory(join(path, fileName.toString()), generation);
        }
      });
      watcher.on('error', (err) => {
        // Deleting a watched folder errors its watcher. Drop it so the map
        // stays honest and a later start() with the same roots can rebuild.
        watcher.close();
        if (this.watchers.get(path) === watcher) this.watchers.delete(path);
        // Warn for any watcher, not just a root: watching per directory means
        // a library's roots are a handful of thousands of watchers, so a root
        // test would silence almost everything that can go wrong.
        this.reportWatchFailure(path, err);
      });
      this.watchers.set(path, watcher);
      return true;
    } catch (err) {
      // ENOSPC here is the inotify watch limit (fs.inotify.max_user_watches).
      this.reportWatchFailure(path, err);
      return false;
    }
  }

  // Same folders the scanner descends into (scanner.ts skips dot-folders).
  private async watchTree(dir: string, generation: number): Promise<void> {
    const pending = [dir];
    while (pending.length) {
      if (generation !== this.generation) return;
      const current = pending.pop()!;
      // Keep descending even when this folder could not be watched. Stopping
      // here would leave everything under it unwatched because one folder hit
      // the system's limit, and the walk is depth-first, so which subtree that
      // is would be arbitrary.
      this.watchPath(current, false, generation);
      let entries: Dirent[];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (err) {
        this.reportWatchFailure(current, err);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'System Volume Information') continue;
        pending.push(join(current, entry.name));
      }
    }
  }

  // A folder created or moved in under a per-directory watch: watch it, and
  // rescan it, since files may have landed before its watcher existed.
  private async adoptDirectory(path: string, generation: number): Promise<void> {
    if (this.watchers.has(path) || basename(path).startsWith('.')) return;
    try {
      // lstat, not stat: the tree walk lists directories with Dirent, which
      // does not follow symlinks, so adopting one here would watch a tree the
      // initial walk skipped.
      if (!(await lstat(path)).isDirectory()) return;
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    await this.watchTree(path, generation);
    this.queueTarget(path);
  }
}

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((root, i) => root === b[i]);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
