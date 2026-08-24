// togglePin() set phase straight to 'fade-out' when unpinning, with nothing
// to advance it further. The driving effect only reschedules on a
// (trackId, hasPlan) signature change (armedFor guard) — by the time a user
// pins then unpins (routinely >10s after the plan loaded, since that's the
// normal "read the popover then dismiss" flow), the natural fade timers have
// already fully fired, so 'fade-out' was a dead end: the badge <button>
// stayed mounted (and per the CSS, clickable) over the fullscreen
// visualizer indefinitely. A React component test needs a DOM; this repo
// doesn't have one wired up, so — matching this repo's own established
// convention for component fixes (see queue-edit-smoke.mjs's source
// assertions against PlaylistView.tsx) — this verifies the fix in source.
// Run: node scripts/eviland-memory-badge-unpin-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/components/EvilandMemoryBadge.tsx'), 'utf8');
const fnMatch = source.match(/function togglePin\(\): void \{[\s\S]*?\n {2}\}/);
if (!fnMatch) {
  fail('togglePin should exist in EvilandMemoryBadge.tsx');
} else {
  const fn = fnMatch[0];
  if (!/window\.setTimeout\(\(\) => \{\s*setPhase\(\(p\) => \(p === 'pinned' \? p : 'hidden'\)\);\s*\}, 800\);/.test(fn)) {
    fail('unpinning should schedule a timer that lands on \'hidden\' (mirroring the natural fade chain\'s own final step)');
  }
  if (/current === 'pinned' \? 'fade-out' : 'pinned'/.test(fn)) {
    fail('the old dead-end assignment (straight to fade-out, nothing to advance it) should be gone');
  }
  // The scheduled 'hidden' transition must itself respect a re-pin during
  // the 800ms window (same pinned-guard the rest of the file already uses),
  // or a quick pin-unpin-pin could get stomped back to hidden.
  if (!/setPhase\(\(p\) => \(p === 'pinned' \? p : 'hidden'\)\);/.test(fn)) {
    fail('the scheduled hidden transition should guard against a re-pin happening during the 800ms window');
  }
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:eviland-memory-badge-unpin"/.test(packageSource)) fail('package.json should expose the eviland memory badge unpin test');

console.log(log.join('\n') + '\n' + (pass ? '[memory-badge-unpin-test] PASS' : '[memory-badge-unpin-test] FAIL'));
process.exitCode = pass ? 0 : 1;
