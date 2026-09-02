// Nearly every async action handler in HomeView.tsx had no error handling,
// and pushToast wasn't even imported — a transient IPC/DB error made a click
// silently do nothing, and a failed initial Promise.all left the view stuck
// on "No library scanned yet" with reclicking Refresh failing the same
// silent way every time. AlbumsView/ArtistsView/FoldersView/EmptyLibrary all
// already wrap fallible IPC calls in try/catch + pushToast; this brings
// HomeView in line and verifies it against source (a DOM/React harness
// isn't wired up in this repo — matching the established convention for
// such fixes, see queue-edit-smoke.mjs).
// Run: node scripts/home-view-error-handling-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/components/views/HomeView.tsx'), 'utf8');

if (!/import \{ pushToast \} from '\.\.\/\.\.\/lib\/toast';/.test(source)) {
  fail('HomeView.tsx should import pushToast, matching every sibling view');
}

const HANDLERS = ['refreshHome', 'saveSet', 'playSavedPlaylist', 'playSmartRule', 'startSmartRuleRadio', 'startSuggestedStation', 'stopStation'];
for (const name of HANDLERS) {
  const match = source.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n {2}\\}`));
  if (!match) {
    fail(`${name} should exist`);
    continue;
  }
  const fn = match[0];
  if (!/\bcatch\b/.test(fn)) {
    fail(`${name} should catch failures instead of letting them fail silently`);
    continue;
  }
  if (!/pushToast\(\{/.test(fn)) {
    fail(`${name} should surface failures via pushToast, matching AlbumsView/ArtistsView/FoldersView`);
  }
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:home-view-error-handling"/.test(packageSource)) fail('package.json should expose the HomeView error handling test');

console.log(log.join('\n') + '\n' + (pass ? '[home-view-error-handling-test] PASS' : '[home-view-error-handling-test] FAIL'));
process.exitCode = pass ? 0 : 1;
