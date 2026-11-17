import type { MenuItemConstructorOptions } from 'electron';
import type { PlayerCommand } from '../shared/types.js';

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
  /**
   * The File menu: Open, Add Folder to Library and Open Recent. Without it the
   * menu bar has no File menu, so it never carries an entry that does nothing.
   */
  files?: { onOpenFiles: () => void; onAddFolder: () => void };
  /**
   * The Controls menu: the Dock menu's transport in the menu bar. Play/Pause
   * says which it will do. Without it the menu bar has no Controls menu.
   */
  playback?: { isPlaying: boolean; onCommand: (command: PlayerCommand) => void };
  /** The desktop widget's item in the Window menu, ticked while it is out. Without it there is no item. */
  widget?: { open: boolean; onToggle: () => void };
}

const REPO_URL = 'https://github.com/evilander/newamp';

/**
 * The application menu template. On macOS we install a real menu so Cmd-Q/W/M
 * and clipboard shortcuts work and the app gets a proper "NewAmp" + File/Edit/
 * View/Window/Help menu. On Windows/Linux we keep the chromeless custom-titlebar
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
  const files = opts.files;
  // Open Recent is filled in by the system from the documents the app has
  // reported (app.addRecentDocument) and empties itself with Clear Menu.
  const fileMenu: MenuItemConstructorOptions[] = files
    ? [
        {
          label: 'File',
          submenu: [
            { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => files.onOpenFiles() },
            { label: 'Add Folder to Library…', accelerator: 'CmdOrCtrl+Shift+O', click: () => files.onAddFolder() },
            { type: 'separator' },
            { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
          ],
        },
      ]
    : [];
  const playback = opts.playback;
  // Previous and Next carry Cmd+Left/Right, the shortcuts the page already
  // reads. A menu key equivalent only fires when the page leaves the key
  // alone: the page's own handler takes it in the window, a text field keeps
  // it for the caret, and with the window closed the menu still skips. Space
  // is not here, because a focused button lets Space through to the menu.
  const controlsMenu: MenuItemConstructorOptions[] = playback
    ? [
        {
          label: 'Controls',
          submenu: [
            { label: playback.isPlaying ? 'Pause' : 'Play', click: () => playback.onCommand('toggle-play') },
            { label: 'Stop', click: () => playback.onCommand('stop') },
            { type: 'separator' },
            { label: 'Next', accelerator: 'Cmd+Right', click: () => playback.onCommand('next') },
            { label: 'Previous', accelerator: 'Cmd+Left', click: () => playback.onCommand('previous') },
          ],
        },
      ]
    : [];
  const widget = opts.widget;
  const widgetItems: MenuItemConstructorOptions[] = widget
    ? [
        { type: 'separator' },
        { label: 'Desktop Widget', type: 'checkbox', checked: widget.open, click: () => widget.onToggle() },
      ]
    : [];
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
    ...fileMenu,
    { role: 'editMenu' },
    { label: 'View', submenu: viewSubmenu },
    ...controlsMenu,
    {
      // Electron's stock macOS Window menu has Minimize and Zoom but no Close,
      // so Cmd+W did nothing. Close goes through the window's close event,
      // which on macOS hides the window and keeps playing.
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        ...widgetItems,
        { type: 'separator' },
        { role: 'front' },
      ],
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
