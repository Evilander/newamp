import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import type { RecoveryEvent } from '../shared/types.js';

export function quarantineCorruptFile(
  filePath: string,
  store: RecoveryEvent['store'],
  reason: string,
): RecoveryEvent | null {
  if (!existsSync(filePath)) return null;
  const recoveredAt = Date.now();
  const backupPath = `${filePath}.corrupt-${stamp(recoveredAt)}`;
  try {
    renameSync(filePath, backupPath);
  } catch {
    copyFileSync(filePath, backupPath);
    unlinkSync(filePath);
  }
  return { store, filePath, backupPath, reason, recoveredAt };
}

export function recoveryReason(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err || 'Unknown recovery error');
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
}
