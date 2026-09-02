// Unit tests for shouldStayResidentOnWindowAllClosed (electron/window-lifecycle-policy.ts).
// Bug: window-all-closed's early-return condition was
// `!isQuitting && tray && process.platform !== 'darwin'`, which can never be
// true on darwin (process.platform !== 'darwin' is always false there), so
// closing the last window on macOS always fell through to
// scanner.cancel()/library.close()/settings.flushSync() even though the app
// is expected to stay resident in the dock — the next dock reactivation then
// talks to a closed library. Run: npm run build:electron && node scripts/window-lifecycle-policy-test.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldStayResidentOnWindowAllClosed as decide } from '../dist-electron/electron/window-lifecycle-policy.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/window-lifecycle-policy-test-result.txt');
writeFileSync(RESULT, '[window-lifecycle-policy-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const log = [];
let pass = true;
const check = (label, actual, expected) => {
  log.push(`${label}: ${actual}`);
  if (actual !== expected) { pass = false; log.push(`FAIL: ${label} expected ${expected}, got ${actual}`); }
};

// The regression: macOS, last window closed normally (not quitting) — must
// stay resident (true) so the library/tray are never torn down.
check(
  'darwin, !isQuitting, no tray -> stays resident',
  decide({ isQuitting: false, hasTray: false, platform: 'darwin' }),
  true,
);
check(
  'darwin, !isQuitting, with tray -> stays resident',
  decide({ isQuitting: false, hasTray: true, platform: 'darwin' }),
  true,
);
// A real quit in progress on macOS must still run cleanup.
check(
  'darwin, isQuitting -> cleanup runs',
  decide({ isQuitting: true, hasTray: false, platform: 'darwin' }),
  false,
);
check(
  'darwin, isQuitting, with tray -> cleanup runs',
  decide({ isQuitting: true, hasTray: true, platform: 'darwin' }),
  false,
);

// Non-mac behavior must be unchanged: tray keeps the app resident, no tray
// means closing the last window quits.
check(
  'win32, !isQuitting, with tray -> stays resident',
  decide({ isQuitting: false, hasTray: true, platform: 'win32' }),
  true,
);
check(
  'win32, !isQuitting, no tray -> cleanup + quit',
  decide({ isQuitting: false, hasTray: false, platform: 'win32' }),
  false,
);
check(
  'win32, isQuitting, with tray -> cleanup + quit',
  decide({ isQuitting: true, hasTray: true, platform: 'win32' }),
  false,
);
check(
  'linux, !isQuitting, no tray -> cleanup + quit',
  decide({ isQuitting: false, hasTray: false, platform: 'linux' }),
  false,
);

const report = log.join('\n') + '\n' + (pass ? '[window-lifecycle-policy-test] PASS' : '[window-lifecycle-policy-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
