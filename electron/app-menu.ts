import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuOptions {
  appName: string;
  appVersion: string;
}

/**
 * The application menu template. On macOS we install a real menu so Cmd-Q/W/M
 * and clipboard shortcuts work and the app gets a proper "NewAmp" + Edit/View/
 * Window menu. On Windows/Linux we keep the chromeless custom-titlebar look by
 * returning an empty template (caller sets the menu to null). Pure — no Electron
 * runtime calls — so it is unit-testable in Node.
 */
export function buildAppMenuTemplate(
  platform: NodeJS.Platform,
  _opts: AppMenuOptions,
): MenuItemConstructorOptions[] {
  if (platform !== 'darwin') return [];
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
