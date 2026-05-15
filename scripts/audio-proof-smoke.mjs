import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve('.');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const gateSource = readFileSync(resolve(repoRoot, 'scripts', 'release-gate.mjs'), 'utf8');

assert.equal(
  pkg.scripts?.['smoke:audio-proof'],
  'node scripts/audio-proof-smoke.mjs',
  'package.json should expose the bundled audio proof smoke',
);
assert.match(gateSource, /smoke:audio-proof/, 'release gate should require bundled audio proof');

const commands = [
  { label: 'npm run build', command: 'npm', args: ['run', 'build'] },
  { label: 'node scripts/audio-output-smoke.mjs', command: 'node', args: ['scripts/audio-output-smoke.mjs'] },
  { label: 'node scripts/playback-handoff-smoke.mjs', command: 'node', args: ['scripts/playback-handoff-smoke.mjs'] },
  { label: 'node scripts/ui-handoff-smoke.mjs', command: 'node', args: ['scripts/ui-handoff-smoke.mjs'] },
  { label: 'node scripts/ui-gapless-smoke.mjs', command: 'node', args: ['scripts/ui-gapless-smoke.mjs'] },
];

const results = [];
for (const item of commands) {
  console.error(`[audio-proof] ${item.label}`);
  const result = run(item.command, item.args);
  results.push({
    name: item.label,
    ok: true,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  });
}

console.log(JSON.stringify({ ok: true, checks: results }, null, 2));

function run(command, args) {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(
    isWindows ? 'cmd.exe' : command,
    isWindows ? ['/d', '/s', '/c', [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ')] : args,
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}\n${tail(
        result.stderr || result.stdout || result.error?.message || '',
      )}`,
    );
  }
  return result;
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function tail(text) {
  return (text ?? '').trim().split(/\r?\n/).slice(-20).join('\n');
}
