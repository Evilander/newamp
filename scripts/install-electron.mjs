import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempDir = resolve(repoRoot, 'tmp', 'electron-temp');
const cacheDir = resolve(repoRoot, 'tmp', 'electron-cache');
const installScript = resolve(repoRoot, 'node_modules', 'electron', 'install.js');

await Promise.all([
  mkdir(tempDir, { recursive: true }),
  mkdir(cacheDir, { recursive: true }),
]);

const child = spawn(process.execPath, [installScript], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    TEMP: tempDir,
    TMP: tempDir,
    electron_config_cache: cacheDir,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`install-electron terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
