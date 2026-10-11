import type { Session } from 'electron';

// Electron grants every web permission request unless the session says
// otherwise. NewAmp loads only its own pages, but the same session also backs
// the detached projector and any future web content, so the default is deny
// and the few things the app really does are listed here.
//
//   media              output-device labels in the device picker (audio only;
//                      nothing in the app captures a camera)
//   speaker-selection  choosing an output device
//   fullscreen         HTML fullscreen from the app's own pages
//   clipboard-sanitized-write
//                      copying a seed code to the clipboard
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'speaker-selection',
  'fullscreen',
  'clipboard-sanitized-write',
]);

export interface PermissionQuery {
  permission: string;
  /** URL or origin of the frame asking. */
  url: string | undefined;
  /** For `media` only: what is being asked for. */
  mediaTypes?: readonly string[];
  /** `scheme://host` of every page that belongs to the app. */
  allowedOrigins: readonly string[];
}

// URL parsing is not enough on its own: custom schemes registered as
// privileged give `origin === 'null'` in Node, so compare scheme and host.
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.protocol || !parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function isAppOrigin(url: string | undefined, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && allowedOrigins.includes(origin);
}

export function isPermissionAllowed(query: PermissionQuery): boolean {
  if (!ALLOWED_PERMISSIONS.has(query.permission)) return false;
  if (!isAppOrigin(query.url, query.allowedOrigins)) return false;
  if (query.permission !== 'media') return true;
  const types = query.mediaTypes ?? [];
  return types.length > 0 && types.every((type) => type === 'audio');
}

type PermissionSession = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>;

export interface PermissionDenial {
  permission: string;
  url: string;
  /** For `media` only: what was asked for. */
  mediaTypes?: readonly string[];
  /** A silent query (the page asking whether it may) rather than a request. */
  check: boolean;
}

export interface PermissionHandlerOptions {
  allowedOrigins: readonly string[];
  /**
   * Called for every denied request, and once per distinct denied check. Checks
   * run constantly and quietly (Chromium consults them when it decides whether
   * to hand out device labels), so a denial there would otherwise leave no
   * trace of why a label went missing.
   */
  onDenied?: (denial: PermissionDenial) => void;
}

export function installPermissionHandlers(ses: PermissionSession, options: PermissionHandlerOptions): void {
  const reportedChecks = new Set<string>();
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const url = details.requestingUrl;
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const allowed = isPermissionAllowed({ permission, url, mediaTypes, allowedOrigins: options.allowedOrigins });
    if (!allowed) options.onDenied?.({ permission, url: url ?? '', mediaTypes, check: false });
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType ? [details.mediaType] : undefined;
    const url = requestingOrigin || details.requestingUrl;
    const allowed = isPermissionAllowed({ permission, url, mediaTypes, allowedOrigins: options.allowedOrigins });
    if (!allowed && options.onDenied) {
      const key = [permission, mediaTypes?.join(',') ?? '', originOf(url) ?? ''].join('|');
      if (!reportedChecks.has(key)) {
        reportedChecks.add(key);
        options.onDenied({ permission, url: url ?? '', mediaTypes, check: true });
      }
    }
    return allowed;
  });
}
