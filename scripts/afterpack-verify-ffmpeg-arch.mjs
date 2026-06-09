// electron-builder afterPack hook: on macOS targets, assert the unpacked
// ffmpeg-static binary's arch matches the arch being packaged. Fails the build
// on mismatch so a wrong-arch ffmpeg can never ship silently (the bug where the
// x64 DMG got an arm64 ffmpeg and every transcoded format 503'd).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Arch } from 'electron-builder';
import { detectMachOArch } from './lib/macho-arch.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const want = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : null;
  if (!want) return;
  const ffmpeg = join(
    context.appOutDir,
    'NewAmp.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    'ffmpeg',
  );
  if (!existsSync(ffmpeg)) {
    throw new Error(`afterPack: bundled ffmpeg not found at ${ffmpeg}`);
  }
  const got = detectMachOArch(ffmpeg);
  if (got !== want && got !== 'universal') {
    throw new Error(`afterPack: bundled ffmpeg arch ${got} does not match packaged arch ${want} (${ffmpeg})`);
  }
  console.log(`afterPack: ffmpeg arch OK (${got}) for ${want}`);
}
