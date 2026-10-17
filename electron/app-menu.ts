import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuOptions {
  appName: string;
  appVersion: string;
  /** Packaged builds drop Reload and DevTools: a stray Cmd+R would reload the page and end playback. */
  isPackaged: boolean;
  /**
   * Opens Settings (Cmd+, on macOS). Without it the menu has no Settings item,
   * so it never carries an entry that does nothing.
   */
  onPreferences?: () => void;
  onOpenExternal?: (url: string) => void;
}

const REPO_URL = 'https://github.com/evilander/newamp';

/**
 * The application menu template. On macOS we install a real menu so Cmd-Q/W/M
 * and clipboard shortcuts work and the app gets a proper "NewAmp" + Edit/View/
 * Window/Help menu. On Windows/Linux we keep the chromeless custom-titlebar
 * look by returning an empty template (caller sets the menu to null). Pure —
 * no Electron runtime calls — so it is unit-testable in Node.
 */
export function buildAppMenuTemplate(
  platform: NodeJS.Platform,
  opts: AppMenuOptions,
): MenuItemConstructorOptions[] {
  if (platform !== 'darwin') return [];
  const openExternal = (url: string) => () => opts.onOpenExternal?.(url);
  const onPreferences = opts.onPreferences;
  const settingsItems: MenuItemConstructorOptions[] = onPreferences
    ? [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => onPreferences() }, { type: 'separator' }]
    : [];
  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...(opts.isPackaged
      ? []
      : ([
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
        ] as MenuItemConstructorOptions[])),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  return [
    {
      label: opts.appName,
      // Role labels are built from app.name, the package name; these three
      // carry it, so they get the product name spelled out.
      submenu: [
        { role: 'about', label: `About ${opts.appName}` },
        { type: 'separator' },
        ...settingsItems,
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${opts.appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${opts.appName}` },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: viewSubmenu },
    {
      // Electron's stock macOS Window menu has Minimize and Zoom but no Close,
      // so Cmd+W did nothing. Close goes through the window's close event,
      // which on macOS hides the window and keeps playing.
      label: 'Window',
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      role: 'help',
      submenu: [
        { label: `${opts.appName} on GitHub`, click: openExternal(REPO_URL) },
        { label: 'Report an Issue', click: openExternal(`${REPO_URL}/issues`) },
      ],
    },
  ];
}
