// Ensure node_modules/ffmpeg-static/ffmpeg is the binary for the requested mac
// arch by re-running ffmpeg-static's installer with npm_config_platform/arch
// (its install script honors these env vars — a pure download, no execution of
// the cross-arch binary). Verifies the result with detectMachOArch and exits
// non-zero on mismatch. Usage: node scripts/stage-ffmpeg-for-arch.mjs <arm64|x64>
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectMachOArch } from './lib/macho-arch.mjs';

const target = process.argv[2];
if (target !== 'arm64' && target !== 'x64') {
  console.error(`stage-ffmpeg-for-arch: expected arch arm64|x64, got ${target}`);
  process.exit(2);
}

const installer = resolve('node_modules/ffmpeg-static/install.js');
if (!existsSync(installer)) {
  console.error(`stage-ffmpeg-for-arch: ${installer} not found (run npm ci first)`);
  process.exit(2);
}

const r = spawnSync(process.execPath, [installer], {
  stdio: 'inherit',
  env: { ...process.env, npm_config_platform: 'darwin', npm_config_arch: target },
});
if (r.status !== 0) {
  console.error(`stage-ffmpeg-for-arch: ffmpeg-static install failed for ${target}`);
  process.exit(r.status ?? 1);
}

const bin = resolve('node_modules/ffmpeg-static/ffmpeg');
if (!existsSync(bin)) {
  console.error(`stage-ffmpeg-for-arch: installer exited 0 but no binary at ${bin}`);
  process.exit(1);
}
const got = detectMachOArch(bin);
if (got !== target && got !== 'universal') {
  console.error(`stage-ffmpeg-for-arch: staged ffmpeg arch ${got} != requested ${target}`);
  process.exit(1);
}
console.log(`stage-ffmpeg-for-arch: ffmpeg staged for ${target} (detected ${got})`);
