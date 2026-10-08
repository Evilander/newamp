// Stopping an ffmpeg child for good, whatever state its pipes are in. Shared
// by every path that streams ffmpeg output with backpressure: the gapless
// transport, the seekable WAV responses and Bit-Perfect Exclusive.

import type { ChildProcess } from 'node:child_process';

// A killed child that is still running this much later gets SIGKILL.
const KILL_GRACE_MS = 2000;

/**
 * SIGTERM alone doesn't do it on macOS and Linux: ffmpeg installs its handler
 * with SA_RESTART, so one blocked writing into a pipe its reader has paused
 * (backpressure's normal state) never comes back from that write to notice,
 * and lives on, file open, until NewAmp exits. Closing our ends of its pipes
 * fails the write with EPIPE; SIGKILL covers one stuck anywhere else.
 * Windows terminates outright.
 */
export function killChild(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (child.exitCode != null || child.signalCode != null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const escalate = setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, KILL_GRACE_MS);
  escalate.unref();
  child.once('exit', () => clearTimeout(escalate));
}
