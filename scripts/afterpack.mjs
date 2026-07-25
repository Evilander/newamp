// electron-builder afterPack hook. Two jobs:
//
//   1. macOS: assert the unpacked ffmpeg-static binary's arch matches the arch
//      being packaged. Fails the build on mismatch so a wrong-arch ffmpeg can
//      never ship silently (the bug where the x64 DMG got an arm64 ffmpeg and
//      every transcoded format 503'd).
//
//   2. Windows/Linux: delete Chromium's DirectX shader compiler. Electron ships
//      dxcompiler.dll + dxil.dll for WebGPU/Dawn. NewAmp renders on WebGL2 and
//      never touches navigator.gpu, so they are ~26 MB of dead weight. Kept on
//      purpose: vk_swiftshader.dll and vulkan-1.dll, which are the software-GL
//      fallback for machines whose GPU is blocklisted.
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Arch } from 'electron-builder';
import { detectMachOArch } from './lib/macho-arch.mjs';

// Only safe to drop while the app has no WebGPU code path. If that changes,
// delete this list — the smoke suite will not catch a missing shader compiler.
const WEBGPU_ONLY_BINARIES = ['dxcompiler.dll', 'dxil.dll'];

function verifyMacFfmpegArch(context) {
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

function dropWebGpuBinaries(context) {
  let freed = 0;
  for (const name of WEBGPU_ONLY_BINARIES) {
    const target = join(context.appOutDir, name);
    if (!existsSync(target)) continue;
    freed += statSync(target).size;
    rmSync(target);
  }
  if (freed > 0) {
    console.log(`afterPack: dropped WebGPU shader compiler (${(freed / 1048576).toFixed(1)} MB)`);
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    verifyMacFfmpegArch(context);
    return;
  }
  dropWebGpuBinaries(context);
}
