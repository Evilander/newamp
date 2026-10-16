// Electron wraps whatever an ipcMain.handle handler throws, so the renderer
// reads "Error invoking remote method 'library:scan': Error: Folder not found".
// The channel is for logs; what the user should see is the part after it.

const REMOTE_METHOD_PREFIX = /^Error invoking remote method '([^']+)': (?:Error: )?/;

export interface IpcFailureMessage {
  channel: string | null;
  message: string;
}

export function splitIpcErrorMessage(message: string): IpcFailureMessage {
  const match = REMOTE_METHOD_PREFIX.exec(message);
  if (!match) return { channel: null, message };
  const rest = message.slice(match[0].length);
  // A handler that threw an empty error leaves nothing to show, so the
  // wrapped text stays.
  if (!rest.trim()) return { channel: match[1], message };
  return { channel: match[1], message: rest };
}

// The same error with the real message; the original stays as `cause` and
// supplies the stack. Anything that is not a wrapped IPC failure comes back
// untouched.
export function cleanIpcError(err: unknown): unknown {
  if (!err || typeof err !== 'object' || typeof (err as { message?: unknown }).message !== 'string') return err;
  const original = err as Error;
  const { channel, message } = splitIpcErrorMessage(original.message);
  if (!channel || message === original.message) return err;
  const clean = new Error(message, { cause: err });
  clean.name = original.name;
  if (original.stack) clean.stack = original.stack;
  return clean;
}
