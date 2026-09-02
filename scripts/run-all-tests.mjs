// Runs every `test:*` script in package.json, so a regression test cannot exist
// without being exercised. The August review branch added thirty-odd tests
// that nothing ran automatically; this is the single entry point the release
// gate and CI call instead of naming each one.
//
// Most `test:*` scripts are defined as `npm run build:electron && node …`.
// The Electron build is done once up front and the node command is run
// directly, so the whole set finishes in well under a minute.
//
// Run: npm run test:all        (add --list to print the scripts without running)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const names = Object.keys(pkg.scripts).filter((name) => name.startsWith('test:') && name !== 'test:all');

if (process.argv.includes('--list')) {
  console.log(names.join('\n'));
  process.exit(0);
}

function run(command, label) {
  const started = Date.now();
  const result = spawnSync(command, { cwd: repoRoot, shell: true, encoding: 'utf8', timeout: 10 * 60_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0 && !result.error, seconds, output, label };
}

const build = run('npm run build:electron', 'build:electron');
if (!build.ok) {
  console.error(build.output);
  console.error('[run-all-tests] FAIL: build:electron did not succeed');
  process.exit(1);
}

const failures = [];
for (const name of names) {
  const command = pkg.scripts[name].replace(/^npm run build:electron\s*&&\s*/, '');
  const result = run(command, name);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name} (${result.seconds}s)`);
  if (!result.ok) {
    failures.push(name);
    console.log(result.output.split('\n').slice(-25).map((line) => `    ${line}`).join('\n'));
  }
}

console.log(`[run-all-tests] ${names.length - failures.length}/${names.length} passed${failures.length ? `; failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
