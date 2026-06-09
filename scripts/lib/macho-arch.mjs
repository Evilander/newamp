import { openSync, readSync, closeSync } from 'node:fs';

// Mach-O cputype values (low 24 bits; bit 0x01000000 = 64-bit flag).
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/**
 * Detect the architecture of a Mach-O (macOS) binary from its leading bytes.
 * Returns 'arm64' | 'x64' | 'universal' | 'unknown'.
 */
export function detectMachOArchFromBytes(buf) {
  if (!buf || buf.length < 8) return 'unknown';
  const beMagic = buf.readUInt32BE(0);
  if (beMagic === 0xcafebabe || beMagic === 0xbebafeca) return 'universal';
  const leMagic = buf.readUInt32LE(0);
  const isMacho64 = leMagic === 0xfeedfacf || beMagic === 0xfeedfacf;
  if (!isMacho64) return 'unknown';
  const cpuLE = buf.readUInt32LE(4);
  const cpuBE = buf.readUInt32BE(4);
  const cpu = leMagic === 0xfeedfacf ? cpuLE : cpuBE;
  if (cpu === CPU_TYPE_ARM64) return 'arm64';
  if (cpu === CPU_TYPE_X86_64) return 'x64';
  return 'unknown';
}

/** Detect the arch of a Mach-O binary at `path`. */
export function detectMachOArch(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8);
    readSync(fd, buf, 0, 8, 0);
    return detectMachOArchFromBytes(buf);
  } finally {
    closeSync(fd);
  }
}
