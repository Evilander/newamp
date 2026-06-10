# Audio Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the deferred-seek wrong-track race in the audio engine and make first play of ffmpeg-mode tracks start instantly while the seekable FLAC cache warms in the background.

**Architecture:** A1 adds a guarded `scheduleMetadataSeek` helper (src-captured, per-deck pending ref, torn down in `silenceDeck`) replacing two unguarded `loadedmetadata` listeners. A2 adds a non-blocking `peekCachedFlac` probe to the transcode cache and reorders the `newamp:` handler: cache hit → seekable FLAC (unchanged); miss → fire-and-forget warm + immediate streaming WAV response (both paths already exist and are battle-tested).

**Tech Stack:** TypeScript (renderer engine + electron main), dist-electron Node test harness (like `scripts/library-query-test.mjs`), ffmpeg-static fixtures (like `scripts/transcode-smoke.mjs`).

Spec: `docs/superpowers/specs/2026-06-09-audio-correctness-design.md`. Branch `audio-correctness` (created; spec committed).

---

## Task 1 (A2): `peekCachedFlac` + stream-first handler

**Files:** Modify `electron/transcode-cache.ts`, `electron/main.ts`; Create `scripts/transcode-peek-test.mjs`; Modify `package.json`.

- [ ] **Step 1: Write the failing test**

Create `scripts/transcode-peek-test.mjs`:

```js
// Unit test for peekCachedFlac (non-blocking cache probe) — builds electron to
// dist-electron, points the cache at a temp dir, generates a tiny wma fixture
// with ffmpeg-static (same approach as transcode-smoke), and asserts the probe
// never transcodes, returns the path only once finalized, and ignores .part files.
// Run: npm run build:electron && node scripts/transcode-peek-test.mjs
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/transcode-peek-test-result.txt');
writeFileSync(RESULT, '[transcode-peek-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const { initTranscodeCache, getOrTranscodeToFlac, peekCachedFlac } = await import(
  new URL('../dist-electron/electron/transcode-cache.js', import.meta.url).href
);

const root = join(repoRoot, 'tmp', 'transcode-peek-test');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'cache'), { recursive: true });
await mkdir(join(root, 'music'), { recursive: true });

const src = join(root, 'music', 'probe.wma');
const gen = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'wmav2', src], { encoding: 'utf8' });
if (gen.status !== 0) { writeFileSync(RESULT, 'fixture generation failed\n' + gen.stderr); console.error('fixture failed'); process.exit(1); }

initTranscodeCache(join(root, 'cache'));

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// 1) Probe before any transcode → null, and creates NOTHING in the cache dir.
const before = await peekCachedFlac(src);
if (before !== null) fail(`peek before transcode should be null, got ${before}`);
if (readdirSync(join(root, 'cache')).length !== 0) fail('peek must not create cache files');
log.push('peek-before: null, no side effects');

// 2) Full transcode, then probe → the finalized path.
const full = await getOrTranscodeToFlac(src);
if (!full.ok) fail(`getOrTranscodeToFlac failed: ${full.reason}`);
const after = await peekCachedFlac(src);
if (!after || after !== full.path) fail(`peek after transcode should equal ${full.path}, got ${after}`);
if (!existsSync(after)) fail('peeked path does not exist');
log.push('peek-after: returns finalized path');

// 3) A lone .part must NOT satisfy the probe.
unlinkSync(full.path);
renameSync !== undefined; // (no-op; keep imports honest)
writeFileSync(full.path + '.123.flac.part', 'partial');
const partOnly = await peekCachedFlac(src);
if (partOnly !== null) fail(`peek with only a .part present should be null, got ${partOnly}`);
log.push('peek-part-only: null');

const report = log.join('\n') + '\n' + (pass ? '[transcode-peek-test] PASS' : '[transcode-peek-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

(Remove the stray `renameSync !== undefined;` line and the unused `renameSync` import when writing the file — they're plan-edit artifacts; keep imports minimal and clean.)

- [ ] **Step 2: Build + run — verify FAIL** (`npm run build:electron && node scripts/transcode-peek-test.mjs` → import error: `peekCachedFlac` not exported). Confirm RED.

- [ ] **Step 3: Implement `peekCachedFlac` in `electron/transcode-cache.ts`**

Add after `getOrTranscodeToFlac` (which ends ~line 140), mirroring its prefix exactly:

```ts
/**
 * Non-blocking probe: returns the finalized cached FLAC's path, or null.
 * Never transcodes, never touches the semaphore or inflight map — safe to call
 * on the hot serve path. (`finalPath` only exists post-atomic-rename, so a
 * half-written `.part` can never satisfy this.)
 */
export async function peekCachedFlac(filePath: string): Promise<string | null> {
  await ensureReady();
  if (!cacheEnabled) return null;
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }
  const key = await canonicalKey(filePath, st.size, st.mtimeMs);
  const finalPath = join(cacheDir, `${key}.flac`);
  if (!existsSync(finalPath)) return null;
  // Bump mtime so frequently played tracks survive LRU eviction (best-effort).
  void utimes(finalPath, new Date(), new Date()).catch(() => {});
  return finalPath;
}
```

(`ensureReady`, `cacheEnabled`, `stat`, `canonicalKey`, `cacheDir`, `utimes`, `existsSync`, `join` all already exist/are imported in this file — verify the exact identifiers by reading `getOrTranscodeToFlac` at :102-120 and mirror them.)

- [ ] **Step 4: Rewire the `newamp:` handler in `electron/main.ts`**

Replace the ffmpeg branch (currently `:1123-1161`, starting `if (playbackMode(filePath) === 'ffmpeg') {`) body with:

```ts
      if (playbackMode(filePath) === 'ffmpeg') {
        // Preserve the clean 503 contract when ffmpeg is genuinely unavailable.
        if (!transcodeCacheStatus().ffmpeg) {
          return new Response('ffmpeg unavailable', {
            status: 503,
            headers: { 'X-Newamp-Reason': 'ffmpeg-missing' },
          });
        }
        // Seekable path: serve the finalized cached FLAC (range-capable) when it
        // already exists. First play streams the live WAV pipe INSTEAD of
        // awaiting the full encode (todo 001) — audio starts in tens of ms —
        // while the cache warms in the background; the next play is seekable.
        const ready = await peekCachedFlac(filePath);
        if (ready) {
          const forwardHeaders: Record<string, string> = {};
          const range = request.headers.get('Range');
          if (range) forwardHeaders.Range = range;
          const ifRange = request.headers.get('If-Range');
          if (ifRange) forwardHeaders['If-Range'] = ifRange;
          const cachedResp = await net.fetch(pathToFileURL(ready).toString(), {
            bypassCustomProtocolHandlers: true,
            headers: forwardHeaders,
          });
          const headers = new Headers(cachedResp.headers);
          headers.set('Access-Control-Allow-Origin', '*');
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          headers.set('Content-Type', 'audio/flac');
          headers.set('X-Newamp-Playback', 'ffmpeg-cached-flac');
          return new Response(cachedResp.body, {
            status: cachedResp.status,
            statusText: cachedResp.statusText,
            headers,
          });
        }
        // Cache miss: warm it in the background (semaphore-bounded, inflight-
        // deduped — duplicate warms coalesce) and stream immediately.
        void getOrTranscodeToFlac(filePath).catch(() => {});
        return transcodeToWavResponse(filePath, request);
      }
```

Add `peekCachedFlac` and (if not present) `transcodeCacheStatus` to the existing `./transcode-cache.js` import in main.ts. Note the OLD code's `cached.reason === 'ffmpeg-missing'` 503 and the `cached.ok === false` fallback are subsumed: ffmpeg-missing is checked up front; any other cache failure now reaches the wav pipe via the miss path, same end state as before.

- [ ] **Step 5: Build + run the test — verify PASS** (`npm run build:electron && node scripts/transcode-peek-test.mjs`).

- [ ] **Step 6: Existing transcode smokes**

Run `npm run smoke:transcode` and `npm run smoke:transcode-seek`. EXPECTATION CHECK: read each smoke first — if one asserts that the FIRST request returns `X-Newamp-Playback: ffmpeg-cached-flac`, the new contract is: first request returns the wav-pipe response, a request AFTER the cache warm completes returns `ffmpeg-cached-flac`. Update such assertions to (a) accept the live-stream header on first fetch, then (b) await `getOrTranscodeToFlac` (or poll peek) and assert the second fetch serves `ffmpeg-cached-flac`. The smoke must still FAIL if seeking never becomes available. Keep diffs minimal and explain each assertion change in the commit message.

- [ ] **Step 7: npm script, typecheck, todo log, commit**

`package.json`: `"test:transcode-peek": "npm run build:electron && node scripts/transcode-peek-test.mjs",`
Append to `todos/001-pending-p1-transcode-first-play-latency.md` work log: stream-first fix shipped (peek + background warm + wav pipe first play); flip its `status: pending` → `complete` and rename the file `001-complete-...` (match how 003/004 completed todos are named). `npm run typecheck` clean.
```bash
git add electron/transcode-cache.ts electron/main.ts scripts/transcode-peek-test.mjs package.json todos/
git commit -m "audio: first play of ffmpeg-mode tracks streams instantly (todo 001)

Cache hit serves the seekable FLAC as before; cache miss now fire-and-forgets
the warm (semaphore-bounded, inflight-deduped) and immediately streams the
existing WAV pipe instead of awaiting the full encode — audio in tens of ms
instead of seconds-to-minutes; the next play is seekable. ffmpeg-missing 503
contract preserved. New non-blocking peekCachedFlac probe is unit-tested.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2 (A1): Guarded deferred-metadata seeks

**Files:** Modify `src/audio/engine.ts`.

- [ ] **Step 1: Extend the Deck record**

`src/audio/engine.ts` `interface Deck` (:32-37) — add:
```ts
  /** Pending deferred seek listener (loadedmetadata) so it can be cancelled
   *  when the deck is silenced or a newer deferred seek replaces it. */
  pendingSeek?: { handler: () => void } | null;
```
(Deck objects are created in `createDeck` ~:319 — no initialization needed for an optional field, but confirm the literal compiles.)

- [ ] **Step 2: Add the guarded helper**

Add as a private method next to `applyStartPosition` (:596):
```ts
  /**
   * Land a seek once metadata arrives — guarded against the deck's src
   * changing first (prepareNext B then play C on the same deck used to seek C
   * to B's offset), and cancellable via silenceDeck. Mirrors the seekSeq /
   * scheduledSrc guard the VBR diagnostic already uses.
   */
  private scheduleMetadataSeek(deck: Deck, target: number): void {
    this.cancelPendingSeek(deck);
    const scheduledSrc = deck.el.currentSrc;
    const handler = (): void => {
      deck.pendingSeek = null;
      if (deck.el.currentSrc !== scheduledSrc) return; // src changed — stale seek
      try {
        const max = Number.isFinite(deck.el.duration) && deck.el.duration > 0 ? deck.el.duration : target;
        deck.el.currentTime = Math.max(0, Math.min(max, target));
      } catch {
        /* still not seekable (non-seekable stream); nothing more we can do */
      }
    };
    deck.pendingSeek = { handler };
    deck.el.addEventListener('loadedmetadata', handler, { once: true });
  }

  private cancelPendingSeek(deck: Deck): void {
    if (!deck.pendingSeek) return;
    deck.el.removeEventListener('loadedmetadata', deck.pendingSeek.handler);
    deck.pendingSeek = null;
  }
```

- [ ] **Step 3: Use it at both sites**

(a) `applyStartPosition` (:596-616): replace the `const seek = () => {...}` + `if (...) seek(); else deck.el.addEventListener('loadedmetadata', seek, { once: true });` tail with:
```ts
    if (Number.isFinite(deck.el.duration) && deck.el.duration > 0) {
      try {
        deck.el.currentTime = Math.max(0, Math.min(deck.el.duration, target));
      } catch {
        /* metadata may not be ready */
      }
      return;
    }
    this.scheduleMetadataSeek(deck, target);
```
(b) The seek-retry (:848-860, inside the public seek path's `catch`): it operates on `el` — find the deck owning that element (the seek path resolves the active deck; read the surrounding method to get the deck variable — if only `el` is in scope, look up `const deck = this.graph?.decks.find((d) => d.el === el);` and fall back to the old inline listener ONLY if no deck matches, which shouldn't happen). Replace the inline `el.addEventListener('loadedmetadata', ...)` block with `if (deck) this.scheduleMetadataSeek(deck, target); ` keeping the `console.warn` line.

(c) `silenceDeck` (:579): add `this.cancelPendingSeek(deck);` as the first statement inside the `try`.

- [ ] **Step 4: Verify**

`npm run typecheck` clean. Run `npm run smoke:playback-start`, `npm run smoke:playback-controls`, `npm run smoke:session` (resume-at-position exercises `applyStartPosition`), `npm run smoke:transcode-seek` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio/engine.ts
git commit -m "audio: guard deferred-metadata seeks against deck src changes

The two loadedmetadata seek listeners (applyStartPosition + the seek retry)
could fire against a DIFFERENT track if the deck's src was replaced before
metadata arrived (prepare B then play C seeked C to B's offset) — or leak.
scheduleMetadataSeek captures currentSrc and bails when it changed; pending
listeners are cancelled by silenceDeck and superseded schedules.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: CI + gate

- [ ] **Step 1:** `.github/workflows/ci.yml` — after the library-query test step add:
```yaml
      - name: Test — transcode cache probe (stream-first first play)
        run: npm run test:transcode-peek
```
- [ ] **Step 2: Full gate** — typecheck; `test:transcode-peek`; `smoke:transcode`; `smoke:transcode-seek`; `smoke:playback-start`; `smoke:session`; `smoke:library`; `smoke:visualizer`. All green.
- [ ] **Step 3: Commit**
```bash
git add .github/workflows/ci.yml
git commit -m "audio: gate the transcode-peek test in CI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes
- **Spec coverage:** A2→T1, A1→T2, CI→T3. The ffmpeg-missing 503 contract is explicitly preserved (T1 Step 4); smoke-assertion updates are bounded and justified (T1 Step 6).
- **Name consistency:** `peekCachedFlac`, `transcodeCacheStatus`, `scheduleMetadataSeek`/`cancelPendingSeek`/`pendingSeek` used consistently.
- **Execution-time verifications:** exact identifier names inside transcode-cache (ensureReady/cacheEnabled/cacheDir) and the deck variable in the seek-retry scope must be read from the files; anchors given.
- **Honesty:** A1 has no pure seam — verified by typecheck + playback/session smokes + review; A2's probe is unit-tested and the handler behavior by the transcode smokes.
