import { existsSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { isFolderArtImage } from './folder-art.js';

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


export interface LibraryWatcherOptions {
  debounceMs?: number;
  // 'recursive' is one fs.watch({ recursive: true }) per root, native on
  // Windows and macOS. Linux has no native recursive watch: Node's fallback
  // walks the tree synchronously, stats every file and holds an inotify watch
  // per FILE. 'per-directory' watches each folder instead (inotify reports
  // changes to a folder's entries), walking the tree asynchronously.
  strategy?: 'recursive' | 'per-directory';
  // How often configured roots are checked for having gone or come back. An
  // unplugged drive or dropped share takes its watcher with it, and nothing
  // else would ever notice it return.
  rootPollMs?: number;
  // A configured root is reachable again and watched again. Main rescans it,
  // which clears the missing marks its tracks got while it was away.
  onRootAvailable?: (root: string) => void;
  // The longest changes wait for a flush while events keep arriving. The
  // debounce restarts on every event, so a long copy would otherwise import
  // nothing until it was over.
  maxWaitMs?: number;
}

// What a flush hands over. force: audio files and folder art the events named,
// read again whatever the stored size and date say. incremental: everything
// else (a root whose event carried no name, a folder that appeared or went
// away), where the stored size and date can skip what has not changed. A
// target is in one list only, force winning.
export interface LibraryWatchPlan {
  force: string[];
  incremental: string[];
}

export type LibraryWatchCallback = (targets: string[], plan: LibraryWatchPlan) => void | Promise<void>;

type LibraryWatchScanMode = 'force' | 'incremental';

// Two paths differing only in case are one folder on Windows and macOS, and
// two real folders on Linux; folding there would lose one of them.
function watchKey(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

// Resolved and de-duplicated, whether or not they exist right now.
function configuredWatchRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = resolve(root);
    const key = watchKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

export function normalizeLibraryWatchRoots(roots: string[]): string[] {
  return configuredWatchRoots(roots).filter((root) => {
    try {
      return existsSync(root) && statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

export function resolveLibraryWatchTarget(root: string, fileName: string | Buffer | null): string | null {
  if (!fileName) return resolve(root);
  const relative = fileName.toString();
  if (!relative.trim()) return resolve(root);

  const target = resolve(join(root, relative));
  const ext = extname(target).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return target;

  // Any image can become an album's cover under the scanner's folder-art rule,
  // so a new one rescans its folder and the scanner decides.
  if (isFolderArtImage(basename(target))) return dirname(target);

  return null;
}

export class LibraryWatcher {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly strategy: 'recursive' | 'per-directory';
  private readonly pendingTargets = new Map<string, { path: string; mode: LibraryWatchScanMode }>();
  // When the oldest change still waiting was queued; the flush deadline counts from here.
  private pendingSince = 0;
  // Keyed by the watched path: one entry per root ('recursive') or per folder.
  private readonly watchers = new Map<string, FSWatcher>();
  private roots: string[] = [];
  // Every configured root, reachable or not; roots holds the watched ones.
  private configuredRoots: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private rootPoll: NodeJS.Timeout | null = null;
  private readonly rootPollMs: number;
  private readonly onRootAvailable: ((root: string) => void) | undefined;
  // Bumped by stop() so an in-flight async tree walk abandons itself.
  private generation = 0;
  private readonly pendingRenames = new Set<string>();
  // One warning per failure reason per run, and a count, so a library that is
  // only half watched can be told apart from one that is watched.
  private readonly warnedWatchFailures = new Set<string>();
  private watchFailures = 0;

  constructor(
    private readonly onChange: LibraryWatchCallback,
    options: LibraryWatcherOptions = {},
  ) {
    this.debounceMs = Math.max(50, Math.round(options.debounceMs ?? 5000));
    this.maxWaitMs = Math.max(this.debounceMs, Math.round(options.maxWaitMs ?? 30_000));
    this.strategy = options.strategy ?? (process.platform === 'linux' ? 'per-directory' : 'recursive');
    this.rootPollMs = Math.max(50, Math.round(options.rootPollMs ?? 15_000));
    this.onRootAvailable = options.onRootAvailable;
  }

  start(roots: string[]): void {
    const configured = configuredWatchRoots(roots);
    const next = normalizeLibraryWatchRoots(roots);
    // Settings saves reach here on every patch. Rebuilding unchanged watchers
    // threw away pending changes and, on Linux, re-walked the whole library.
    // With every root offline there is nothing to rebuild, and restarting
    // would keep resetting the root check before it ever ran.
    if (
      sameRoots(next, this.roots)
      && sameRoots(configured, this.configuredRoots)
      && (this.watchers.size > 0 || !next.length)
    ) {
      return;
    }
    // Same configured roots, a different set of them reachable: a root came
    // back or went away, and a settings save noticed before the root check.
    const sameConfigured = sameRoots(configured, this.configuredRoots);
    const cameBack = sameConfigured ? next.filter((root) => !this.roots.includes(root)) : [];
    const wentAway = sameConfigured ? this.roots.filter((root) => !next.includes(root)) : [];
    this.stop();
    this.roots = next;
    this.configuredRoots = configured;
    const generation = this.generation;
    for (const root of this.roots) this.watchRoot(root, generation);
    if (this.configuredRoots.length) {
      this.rootPoll = setInterval(() => void this.checkRoots(generation), this.rootPollMs);
      this.rootPoll.unref?.();
    }
    for (const root of cameBack) this.onRootAvailable?.(root);
    for (const root of wentAway) this.queueTarget(root);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.rootPoll) {
      clearInterval(this.rootPoll);
      this.rootPoll = null;
    }
    this.configuredRoots = [];
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pendingTargets.clear();
    this.pendingSince = 0;
    this.pendingRenames.clear();
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
    const pending = [...this.pendingTargets.values()];
    const targets = pending.map((entry) => entry.path);
    const plan: LibraryWatchPlan = {
      force: pending.filter((entry) => entry.mode === 'force').map((entry) => entry.path),
      incremental: pending.filter((entry) => entry.mode === 'incremental').map((entry) => entry.path),
    };
    this.pendingTargets.clear();
    this.pendingSince = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void Promise.resolve(this.onChange(targets, plan)).catch((err) => {
      console.warn(`[newamp] library watcher scan failed: ${errorMessage(err)}`);
    });
  }

  private watchRoot(root: string, generation: number): void {
    if (this.strategy === 'per-directory') void this.watchTree(root, generation);
    else this.watchPath(root, true, generation);
  }

  // A root that went away (unplugged, unmounted, share dropped) loses its
  // watchers and is queued like any vanished path, so its tracks are marked
  // unavailable. One that is back is watched again and handed to
  // onRootAvailable for a rescan. Async stats: a hung network share must not
  // stall the main process.
  private async checkRoots(generation: number): Promise<void> {
    for (const root of this.configuredRoots) {
      let present = false;
      try {
        present = (await stat(root)).isDirectory();
      } catch {
        present = false;
      }
      if (generation !== this.generation) return;
      const watched = this.roots.includes(root);
      if (present && !watched) {
        this.roots.push(root);
        this.watchRoot(root, generation);
        this.onRootAvailable?.(root);
      } else if (present && this.strategy === 'recursive' && !this.watchers.has(root)) {
        // Gone and back between two checks: the old watcher died with it.
        if (this.watchPath(root, true, generation)) this.onRootAvailable?.(root);
      } else if (!present && watched) {
        this.roots = this.roots.filter((item) => item !== root);
        for (const [path, watcher] of this.watchers) {
          if (path === root || path.startsWith(`${root}${sep}`)) {
            watcher.close();
            this.watchers.delete(path);
          }
        }
        this.queueTarget(root);
      }
    }
  }

  private queueTarget(target: string, mode: LibraryWatchScanMode = 'incremental'): void {
    const key = watchKey(target);
    // A target asked for twice is read again if either asked for that.
    const forced = mode === 'force' || this.pendingTargets.get(key)?.mode === 'force';
    this.pendingTargets.set(key, { path: target, mode: forced ? 'force' : 'incremental' });
    const now = Date.now();
    if (!this.pendingSince) this.pendingSince = now;
    if (this.timer) clearTimeout(this.timer);
    const untilDeadline = Math.max(0, this.pendingSince + this.maxWaitMs - now);
    this.timer = setTimeout(() => this.flushNow(), Math.min(this.debounceMs, untilDeadline));
  }

  private watchPath(path: string, recursive: boolean, generation = this.generation): boolean {
    if (this.watchers.has(path)) return true;
    try {
      const watcher = watch(path, { recursive }, (eventType, fileName) => {
        this.onWatchEvent(path, recursive, generation, eventType, fileName);
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

  private onWatchEvent(
    path: string,
    recursive: boolean,
    generation: number,
    eventType: string,
    fileName: string | Buffer | null,
  ): void {
    if (generation !== this.generation) return;
    // Events are relative to the watched path, so it doubles as the root.
    const target = resolveLibraryWatchTarget(path, fileName);
    if (target) {
      // An event with no name is the watcher telling us it fell behind (a
      // fast bulk copy overflows the native buffer): something changed under
      // this root and it can't say what. Walk the root and let the stored
      // size and date skip what hasn't changed; re-reading every file of a
      // large library for it was the cost of treating that as a file event.
      const named = fileName != null && fileName.toString().trim() !== '';
      this.queueTarget(target, named ? 'force' : 'incremental');
    }
    if (eventType === 'rename' && fileName) {
      void this.reconcileRenamedPath(join(path, fileName.toString()), recursive, generation);
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
    if (generation === this.generation) this.queueTarget(path);
  }

  private async reconcileRenamedPath(path: string, recursive: boolean, generation: number): Promise<void> {
    if (generation !== this.generation || basename(path).startsWith('.') || this.pendingRenames.has(path)) return;
    // Native rename bursts can contain thousands of children. Bound pending
    // stats, retaining exact paths so removed directories still reconcile.
    if (this.pendingRenames.size >= 128) {
      this.queueTarget(path);
      return;
    }
    this.pendingRenames.add(path);
    try {
      const info = await lstat(path);
      if (generation !== this.generation || !info.isDirectory()) return;
      if (recursive) this.queueTarget(path);
      else await this.adoptDirectory(path, generation);
    } catch (err) {
      if (generation !== this.generation || (err as NodeJS.ErrnoException).code !== 'ENOENT') return;
      // The name alone cannot tell a removed album folder from a file. Main
      // checks the exact path and its descendants without deleting records.
      this.queueTarget(path);
      for (const [watched, watcher] of this.watchers) {
        if (watched === path || watched.startsWith(`${path}${sep}`)) {
          watcher.close();
          this.watchers.delete(watched);
        }
      }
    } finally {
      if (generation === this.generation) this.pendingRenames.delete(path);
    }
  }
}

// Whole-folder walks the watcher asks for. A bulk copy that overflows the
// watcher's buffer asks for the root again at every flush deadline, and a walk
// of a large library can outlast that, so identical walks would stack up
// behind each other. One scan runs at a time; whatever is asked for meanwhile
// waits as a single batch (files may have landed behind the walk), and a
// folder asked for again folds into it.
export class IncrementalScanGate {
  private readonly waiting = new Map<string, string>();
  private draining = false;

  constructor(private readonly scan: (targets: string[]) => Promise<void>) {}

  request(targets: string[]): void {
    for (const target of targets) this.waiting.set(watchKey(target), target);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.waiting.size) {
        const batch = [...this.waiting.values()];
        this.waiting.clear();
        try {
          await this.scan(batch);
        } catch (err) {
          console.warn(`[newamp] library watcher scan failed: ${errorMessage(err)}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((root, i) => root === b[i]);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
