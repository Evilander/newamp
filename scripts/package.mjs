import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageTemp = join(repoRoot, 'tmp', 'package-temp');
const releaseRoot = join(repoRoot, 'release');
const builderDebugPath = join(releaseRoot, 'builder-debug.yml');
const nsisBuilderDebugPath = join(releaseRoot, 'builder-debug-nsis.yml');

await mkdir(packageTemp, { recursive: true });

run('npm', ['run', 'build']);

const electronBuilder = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);

for (const args of electronBuilderTargetArgs(process.argv.slice(2))) {
  run(electronBuilder, args, {
    env: {
      ...process.env,
      TEMP: packageTemp,
      TMP: packageTemp,
    },
  });
  if (args.includes('--win=nsis')) {
    await copyFile(builderDebugPath, nsisBuilderDebugPath);
  }
}

function electronBuilderTargetArgs(args) {
  if (args.includes('--portable')) return [['--win=portable']];
  if (args.includes('--installer') || args.includes('--nsis')) return [['--win=nsis']];
  return [['--win=nsis'], ['--win=portable']];
}

function run(command, args, options = {}) {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(isWindows ? 'cmd.exe' : command, isWindows
    ? ['/d', '/s', '/c', [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ')]
    : args, {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
