import { execFile } from 'node:child_process';
import { existsSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { isFolderArtImage } from './folder-art.js';
import { AUDIO_EXTS, isHiddenName, isSkippedLibraryFolder, isSkippedLibraryPath } from './library-skip.js';
import { whenPlaybackFed } from './playback-io.js';

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
  // How many root checks in a row must find a root gone before it is treated
  // as gone. One failed stat is as likely to be a share having a bad moment.
  rootGoneChecks?: number;
  // How often a root on a network volume is handed to onRootAvailable for a
  // rescan. Changes another machine makes to a network volume never reach the
  // file system watcher, so this is the only way they show up before the next
  // launch. 0 turns it off.
  remotePollMs?: number;
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

// A root check that takes longer than this learns nothing, and the next check
// tries again.
const ROOT_PROBE_TIMEOUT_MS = 5000;
const REMOTE_POLL_DEFAULT_MS = 60 * 60_000;

export interface MountEntry {
  mountPoint: string;
  type: string;
}

// Volume types whose changes made elsewhere the operating system never reports
// to a watcher: network file systems and the FUSE mounts that front a remote
// server. A bare "fuseblk" (ntfs-3g or exFAT on a local disk) and macFUSE
// volumes are left out because they are as often a local drive, where the
// watcher works and an hourly full rescan would only cost reads.
const REMOTE_FS_TYPES = new Set([
  'nfs', 'nfs4', 'smbfs', 'smb3', 'cifs', 'afpfs', 'webdav', 'ftp',
  'fuse.rclone', 'fuse.sshfs', 'fuse.s3fs', 'fuse.gvfsd-fuse', 'fuse.davfs', 'fuse.curlftpfs', 'fuse.gcsfuse', 'fuse.goofys',
]);

function isRemoteFsType(type: string): boolean {
  return REMOTE_FS_TYPES.has(type.toLowerCase());
}

/**
 * The mounts a `mount` listing (macOS, "device on /path (type, option, ...)")
 * or /proc/self/mounts (Linux, "device /path type options 0 0") describes.
 */
export function parseMountTable(text: string, format: 'mount' | 'proc'): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (format === 'mount') {
      const m = /^.+? on (.+) \(([^,)\s]+)[,)]/.exec(line);
      if (m) entries.push({ mountPoint: m[1]!, type: m[2]! });
    } else {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      // /proc writes a space in a path as \040.
      const mountPoint = parts[1]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      entries.push({ mountPoint, type: parts[2]! });
    }
  }
  return entries;
}

/** Whether `path` sits on a network or FUSE volume: the type of the longest mount point that holds it. */
export function isOnRemoteMount(path: string, mounts: MountEntry[]): boolean {
  const fold = (value: string): string => (process.platform === 'linux' ? value : value.toLowerCase());
  const target = fold(path);
  let best: MountEntry | null = null;
  let bestLength = -1;
  for (const mount of mounts) {
    const point = fold(mount.mountPoint).replace(/\/+$/, '');
    const holds = target === point || target.startsWith(`${point}/`);
    if (holds && point.length > bestLength) {
      best = mount;
      bestLength = point.length;
    }
  }
  return !!best && isRemoteFsType(best.type);
}

/** A path on a Windows network share: a UNC name (\\server\share), or the \\?\UNC\ form a mapped drive resolves to. */
export function isWindowsNetworkPath(path: string): boolean {
  return /^\\\\(?![?.]\\)/.test(path) || /^\\\\\?\\UNC\\/i.test(path);
}

/** The drive letters a `net use` listing shows as mapped to a share. Its headings are translated; its columns are not. */
export function parseNetUse(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /(?:^|\s)([A-Za-z]:)\s+\\\\\S/.exec(line);
    if (m) entries.push({ mountPoint: m[1]!.toLowerCase(), type: 'network' });
  }
  return entries;
}

// On Windows a share shows in the path (a UNC name), or in what a mapped drive
// letter resolves to; a letter whose share is down resolves to nothing, so the
// letters `net use` lists are the other way to tell.
export function isOnRemoteVolume(path: string, mounts: MountEntry[]): boolean {
  if (process.platform !== 'win32') return isOnRemoteMount(path, mounts);
  if (isWindowsNetworkPath(path)) return true;
  const drive = /^([A-Za-z]:)/.exec(path)?.[1]?.toLowerCase();
  return !!drive && mounts.some((mount) => mount.mountPoint === drive);
}

async function readMountTable(): Promise<MountEntry[]> {
  if (process.platform === 'linux') {
    return parseMountTable(await readFile('/proc/self/mounts', 'utf8'), 'proc');
  }
  if (process.platform === 'darwin') {
    const output = await new Promise<string>((resolveOutput, reject) => {
      execFile('/sbin/mount', [], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolveOutput(stdout)));
    });
    return parseMountTable(output, 'mount');
  }
  if (process.platform === 'win32') {
    const net = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe');
    try {
      const output = await new Promise<string>((resolveOutput, reject) => {
        execFile(net, ['use'], { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolveOutput(stdout)));
      });
      return parseNetUse(output);
    } catch {
      // UNC paths are still recognised from their spelling.
      return [];
    }
  }
  return [];
}

/** The real path of a root, or the root as given when the volume does not answer within `ms`. */
export async function resolvedWithin(path: string, ms = ROOT_PROBE_TIMEOUT_MS): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(path), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([realpath(path).catch(() => path), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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

  if (isSkippedLibraryPath(relative, basename(root))) return null;
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
  private readonly rootGoneChecks: number;
  // Consecutive checks that found each root gone; a root that answers resets it.
  private readonly rootMisses = new Map<string, number>();
  // The generation a root check is running for, so a slow one is not stacked on.
  private rootCheckGeneration = -1;
  private readonly remotePollMs: number;
  private remoteRoots: string[] = [];
  private remotePoll: NodeJS.Timeout | null = null;
  // The volume each root was on at its last check, and what the check in
  // progress saw. A different one means something was mounted over the folder
  // or taken from under it, which no watcher event reports.
  private readonly rootDevices = new Map<string, number>();
  private readonly probedDevices = new Map<string, number>();
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
    this.rootGoneChecks = Math.max(1, Math.round(options.rootGoneChecks ?? 2));
    this.remotePollMs = Math.max(0, Math.round(options.remotePollMs ?? REMOTE_POLL_DEFAULT_MS));
  }

  start(roots: string[]): void {
    const configured = configuredWatchRoots(roots);
    // A Windows share is not looked at with a blocking stat: with its server
    // down that holds the whole app for as long as Windows takes to give up.
    // Those roots are probed after this returns (watchNetworkRoots).
    const network = configured.filter(isWindowsNetworkPath);
    const next = normalizeLibraryWatchRoots(configured.filter((root) => !isWindowsNetworkPath(root)));
    const watchedNow = this.roots.filter((root) => !isWindowsNetworkPath(root));
    // Settings saves reach here on every patch. Rebuilding unchanged watchers
    // threw away pending changes and, on Linux, re-walked the whole library.
    // With every root offline there is nothing to rebuild, and restarting
    // would keep resetting the root check before it ever ran.
    if (
      sameRoots(next, watchedNow)
      && sameRoots(configured, this.configuredRoots)
      && (this.watchers.size > 0 || !(next.length + network.length))
    ) {
      return;
    }
    // Same configured roots, a different set of them reachable: a root came
    // back or went away, and a settings save noticed before the root check.
    const sameConfigured = sameRoots(configured, this.configuredRoots);
    const cameBack = sameConfigured ? next.filter((root) => !watchedNow.includes(root)) : [];
    const wentAway = sameConfigured ? watchedNow.filter((root) => !next.includes(root)) : [];
    this.stop();
    this.roots = next;
    this.configuredRoots = configured;
    const generation = this.generation;
    for (const root of this.roots) this.watchRoot(root, generation);
    if (this.configuredRoots.length) {
      this.rootPoll = setInterval(() => void this.checkRoots(generation), this.rootPollMs);
      this.rootPoll.unref?.();
    }
    if (network.length) void this.watchNetworkRoots(network, generation);
    void this.detectRemoteRoots(generation);
    for (const root of cameBack) this.onRootAvailable?.(root);
    for (const root of wentAway) this.queueTarget(root);
  }

  // The network roots that answer are watched, as they would have been had
  // start() been able to ask. Those that do not are left to the root check,
  // which watches them and asks for a rescan when they come back.
  private async watchNetworkRoots(roots: string[], generation: number): Promise<void> {
    const states = await Promise.all(roots.map((root) => this.probeRoot(root)));
    if (generation !== this.generation) return;
    roots.forEach((root, i) => {
      if (states[i] !== 'present' || this.roots.includes(root)) return;
      this.roots.push(root);
      this.watchRoot(root, generation);
    });
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
    this.rootMisses.clear();
    if (this.remotePoll) {
      clearInterval(this.remotePoll);
      this.remotePoll = null;
    }
    this.remoteRoots = [];
    this.rootDevices.clear();
    this.probedDevices.clear();
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

  /** Watched roots on a network volume, which no watcher can see other machines change: they are rescanned on a timer instead. */
  getPollingRoots(): string[] {
    return this.remoteRoots.filter((root) => this.roots.includes(root));
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
  // stall the main process. Only "no such folder" counts as gone, and only
  // after a few checks in a row: a share that times out, or answers an I/O
  // error, is slow rather than away, and dropping it would rescan the whole
  // library when it answered again. On a network volume "no such folder" also
  // has to come from a volume that is up (see probeRoot).
  private async checkRoots(generation: number): Promise<void> {
    if (this.rootCheckGeneration === generation) return;
    this.rootCheckGeneration = generation;
    try {
      const roots = [...this.configuredRoots];
      const states = await Promise.all(roots.map((root) => this.probeRoot(root)));
      if (generation !== this.generation) return;
      roots.forEach((root, i) => {
        const state = states[i]!;
        if (state === 'unknown') return;
        const present = state === 'present';
        if (present) this.rootMisses.delete(root);
        else {
          const misses = (this.rootMisses.get(root) ?? 0) + 1;
          this.rootMisses.set(root, misses);
          if (misses < this.rootGoneChecks) return;
        }
        const watched = this.roots.includes(root);
        const device = this.probedDevices.get(root);
        const before = this.rootDevices.get(root);
        if (present && device !== undefined) this.rootDevices.set(root, device);
        if (present && !watched) {
          this.roots.push(root);
          this.watchRoot(root, generation);
          this.onRootAvailable?.(root);
          void this.detectRemoteRoots(generation);
        } else if (present && this.strategy === 'recursive' && !this.watchers.has(root)) {
          // Gone and back between two checks: the old watcher died with it.
          if (this.watchPath(root, true, generation)) this.onRootAvailable?.(root);
        } else if (present && before !== undefined && device !== undefined && device !== before) {
          // A share was mounted over the folder, or the volume under it was
          // swapped. The watcher still holds the folder as it was, and what
          // is there now has not been scanned.
          this.dropWatchers(root);
          this.watchRoot(root, generation);
          this.onRootAvailable?.(root);
        } else if (!present && watched) {
          this.roots = this.roots.filter((item) => item !== root);
          this.dropWatchers(root);
          this.queueTarget(root);
        }
      });
    } finally {
      if (this.rootCheckGeneration === generation) this.rootCheckGeneration = -1;
    }
  }

  private dropWatchers(root: string): void {
    for (const [path, watcher] of this.watchers) {
      if (path === root || path.startsWith(`${root}${sep}`)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
  }

  private async probeRoot(root: string): Promise<'present' | 'gone' | 'unknown'> {
    const state = await this.statFolder(root);
    if (state !== 'gone' || !this.remoteRoots.includes(root)) return state;
    // Windows answers "no such folder" for a share that is only unreachable (a
    // dropped VPN, a server that is down), and an unmounted share on any system
    // looks like one that was never there. A root on a network volume is only
    // gone when the folder that holds it answers and it is not in it.
    const parent = dirname(root);
    if (parent === root) return 'unknown';
    return (await this.statFolder(parent)) === 'present' ? 'gone' : 'unknown';
  }

  private async statFolder(path: string): Promise<'present' | 'gone' | 'unknown'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'unknown'>((resolveProbe) => {
      timer = setTimeout(() => resolveProbe('unknown'), ROOT_PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const probe = stat(path).then(
      (info): 'present' | 'gone' => {
        this.probedDevices.set(path, Number(info.dev));
        return info.isDirectory() ? 'present' : 'gone';
      },
      (err: unknown): 'gone' | 'unknown' => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown';
      },
    );
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The file system watcher of a network volume (FSEvents on macOS, inotify on
  // Linux) starts without complaint and then never reports what another
  // machine writes there, so isWatching() would say yes while nothing could
  // ever arrive. Those roots are rescanned on a slow timer instead; a rescan
  // waits while playback is short of audio.
  private async detectRemoteRoots(generation: number): Promise<void> {
    if (!this.remotePollMs) return;
    let mounts: MountEntry[];
    try {
      mounts = await readMountTable();
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    // All at once and each with a limit: a root on a hung mount would otherwise
    // keep every root after it from being classified.
    const configured = [...this.configuredRoots];
    const real = await Promise.all(configured.map((root) => resolvedWithin(root)));
    if (generation !== this.generation) return;
    const remote = configured.filter((root, i) => isOnRemoteVolume(root, mounts) || isOnRemoteVolume(real[i]!, mounts));
    this.remoteRoots = remote;
    if (remote.length && !this.remotePoll) {
      this.remotePoll = setInterval(() => void this.pollRemoteRoots(generation), this.remotePollMs);
      this.remotePoll.unref?.();
    } else if (!remote.length && this.remotePoll) {
      clearInterval(this.remotePoll);
      this.remotePoll = null;
    }
  }

  private async pollRemoteRoots(generation: number): Promise<void> {
    for (const root of this.getPollingRoots()) {
      await whenPlaybackFed();
      if (generation !== this.generation || !this.roots.includes(root)) return;
      this.onRootAvailable?.(root);
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
    // A folder created or removed inside a skipped one (a Logic project
    // package, Ableton's packs, a hidden folder) is not a change to the
    // library, however its own name looks.
    if (eventType === 'rename' && fileName && !isSkippedLibraryPath(fileName.toString(), basename(path))) {
      void this.reconcileRenamedPath(join(path, fileName.toString()), recursive, generation);
    }
  }

  // Same folders the scanner descends into (see library-skip.ts).
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
        if (isSkippedLibraryFolder(entry.name, basename(current))) continue;
        pending.push(join(current, entry.name));
      }
    }
  }

  // A folder created or moved in under a per-directory watch: watch it, and
  // rescan it, since files may have landed before its watcher existed.
  private async adoptDirectory(path: string, generation: number): Promise<void> {
    if (this.watchers.has(path) || isSkippedLibraryFolder(basename(path), basename(dirname(path)))) return;
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
    if (generation !== this.generation || isHiddenName(basename(path)) || this.pendingRenames.has(path)) return;
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

// The same roots in any order: one that came back after the others is last in
// the watched list but not in the configured one, and that is not a change.
function sameRoots(a: string[], b: string[]): boolean {
  const keys = new Set(b.map(watchKey));
  return a.length === b.length && a.every((root) => keys.has(watchKey(root)));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
