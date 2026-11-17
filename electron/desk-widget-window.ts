import { BrowserWindow, Menu, screen, type MenuItemConstructorOptions, type WebContents } from 'electron';
import type { DeskWidgetLayout, DeskWidgetLevel, DeskWidgetSnapshot, DeskWidgetState } from '../shared/types.js';
import { deskWidgetLevelCall, deskWidgetLevels, placeDeskWidget, resolveDeskWidgetLevel } from './desk-widget.js';
import { revealWhenReady } from './window-lifecycle-policy.js';

// The desktop widget's window: frameless, transparent, and separate from the
// main window so the library can stay open beside it. The main window is
// opaque on macOS and Electron fixes transparency when a window is created,
// so the widget cannot be the main window resized the way the decks are.
//
// Its page is a pure consumer. Playback snapshots are pushed to it and its
// buttons go back through the transport channel the projector already uses,
// so the audio engine and the store stay in the main window.

export type DeskWidgetPlayback = Omit<DeskWidgetSnapshot, 'layout'>;

export interface DeskWidgetDeps {
  platform: NodeJS.Platform;
  preloadPath: string;
  rendererUrl: () => string;
  iconPath: () => string | undefined;
  getState: () => DeskWidgetState;
  setState: (next: DeskWidgetState) => void;
  getPlayback: () => DeskWidgetPlayback;
  showMainWindow: () => void;
  isQuitting: () => boolean;
  /** The widget opened or closed: menus that name it and the main window's button follow. */
  onChange: () => void;
  onWindow?: (win: BrowserWindow) => void;
}

const LAYOUT_LABELS: Record<DeskWidgetLayout, string> = { platter: 'Record', card: 'Card' };
const LEVEL_LABELS: Record<DeskWidgetLevel, string> = {
  desktop: 'On the Desktop',
  normal: 'Normal Window',
  floating: 'Always on Top',
};
// A drag reports a move for every step; the spot is written once it settles.
const MOVE_SAVE_DELAY_MS = 400;
const MAX_ORIGIN = 100000;

export class DeskWidget {
  private win: BrowserWindow | null = null;
  private ready = false;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DeskWidgetDeps) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  get isOpen(): boolean {
    return this.window !== null;
  }

  owns(sender: WebContents): boolean {
    const win = this.window;
    return !!win && sender === win.webContents;
  }

  /** Brings the widget back at launch when it was open at the last quit. */
  restore(): void {
    if (this.deps.getState().open) this.open();
  }

  toggle(): boolean {
    if (this.isOpen) this.close();
    else this.open();
    return this.isOpen;
  }

  open(): void {
    const existing = this.window;
    if (existing) {
      existing.showInactive();
      return;
    }
    const state = this.deps.getState();
    const bounds = this.placement(state);
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // The page draws its own shadow; a native one follows the window's
      // square bounds, not the record's outline.
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // The first click on a widget under another app's windows should press
      // the button it lands on, not only bring NewAmp forward.
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      title: 'NewAmp Widget',
      icon: this.deps.iconPath(),
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
      },
    });
    this.win = win;
    this.ready = false;
    if (this.deps.platform === 'darwin') win.excludedFromShownWindowsMenu = true;
    this.deps.onWindow?.(win);
    this.applyLevel(win, state.level);

    win.on('move', () => this.scheduleMoveSave());
    // Closing the widget is a choice to remember; the app quitting is not, so
    // a widget that was out at quit comes back at the next launch.
    win.on('close', () => {
      this.flushMoveSave();
      if (!this.deps.isQuitting()) this.deps.setState({ ...this.deps.getState(), open: false });
    });
    win.on('closed', () => {
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = null;
      if (this.win === win) this.win = null;
      this.ready = false;
      this.deps.onChange();
    });
    // A crashed page can leave the window alive but blank, and 'closed' is not
    // guaranteed to follow. Destroying it lets the next open start clean.
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.destroy();
    });
    win.loadURL(this.deps.rendererUrl()).catch((err) => {
      console.error('[newamp] desktop widget failed to load', err);
      if (!win.isDestroyed()) win.destroy();
    });
    revealWhenReady(
      win,
      () => {
        if (!win.isDestroyed()) win.showInactive();
      },
      { platform: this.deps.platform },
    );

    this.deps.setState({ ...state, open: true, origin: { x: bounds.x, y: bounds.y } });
    this.deps.onChange();
  }

  close(): void {
    this.window?.close();
  }

  setLayout(layout: DeskWidgetLayout): void {
    const win = this.window;
    // The saved corner trails a drag by a moment; the window knows where it is.
    const [x, y] = win ? win.getPosition() : [null, null];
    const saved = this.deps.getState();
    const state = { ...saved, layout, origin: x === null || y === null ? saved.origin : { x, y } };
    this.deps.setState(state);
    if (!win) return;
    const bounds = this.placement(state);
    // A window that is not resizable also refuses a size set from here on
    // some platforms, so it is unlocked for the change.
    win.setResizable(true);
    win.setBounds(bounds);
    win.setResizable(false);
    this.pushSnapshot();
  }

  setLevel(level: DeskWidgetLevel): void {
    this.deps.setState({ ...this.deps.getState(), level });
    const win = this.window;
    if (win) this.applyLevel(win, level);
  }

  /** The widget's page has its listener installed and can be sent what is playing. */
  rendererReady(sender: WebContents): void {
    if (!this.owns(sender)) return;
    this.ready = true;
    this.pushSnapshot();
  }

  /** Sends the page what is playing now. Called whenever the playback snapshot changes. */
  pushSnapshot(): void {
    const win = this.window;
    if (!win || !this.ready) return;
    const snapshot: DeskWidgetSnapshot = { layout: this.deps.getState().layout, ...this.deps.getPlayback() };
    win.webContents.send('desk-widget:snapshot', snapshot);
  }

  /**
   * The page drags the window itself: a drag region would swallow the clicks,
   * the hover and the right-click the widget is made of.
   */
  moveTo(sender: WebContents, x: unknown, y: unknown): void {
    const win = this.window;
    if (!win || sender !== win.webContents) return;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x) > MAX_ORIGIN || Math.abs(y) > MAX_ORIGIN) return;
    win.setPosition(Math.round(x), Math.round(y));
  }

  showContextMenu(sender: WebContents): void {
    const win = this.window;
    if (!win || sender !== win.webContents) return;
    Menu.buildFromTemplate(this.menuTemplate()).popup({ window: win });
  }

  menuTemplate(): MenuItemConstructorOptions[] {
    const state = this.deps.getState();
    const level = resolveDeskWidgetLevel(state.level, this.deps.platform);
    return [
      { label: 'Show NewAmp', click: () => this.deps.showMainWindow() },
      { type: 'separator' },
      ...(Object.keys(LAYOUT_LABELS) as DeskWidgetLayout[]).map(
        (layout): MenuItemConstructorOptions => ({
          label: LAYOUT_LABELS[layout],
          type: 'radio',
          checked: state.layout === layout,
          click: () => this.setLayout(layout),
        }),
      ),
      { type: 'separator' },
      ...deskWidgetLevels(this.deps.platform).map(
        (choice): MenuItemConstructorOptions => ({
          label: LEVEL_LABELS[choice],
          type: 'radio',
          checked: level === choice,
          click: () => this.setLevel(choice),
        }),
      ),
      { type: 'separator' },
      { label: 'Close Widget', click: () => this.close() },
    ];
  }

  private placement(state: DeskWidgetState): { x: number; y: number; width: number; height: number } {
    const workAreas = screen.getAllDisplays().map((display) => ({ ...display.workArea }));
    return placeDeskWidget(state.origin, state.layout, workAreas, { ...screen.getPrimaryDisplay().workArea });
  }

  private applyLevel(win: BrowserWindow, level: DeskWidgetLevel): void {
    const call = deskWidgetLevelCall(level, this.deps.platform);
    if (call.onTop) win.setAlwaysOnTop(true, call.level, call.relativeLevel);
    else win.setAlwaysOnTop(false);
    // macOS keeps a window that is off the normal level in the Space it was
    // opened in, so a widget on the desktop would be missing from every other
    // Space. Skipping the process-type transform avoids hiding the Dock icon.
    if (this.deps.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(call.onTop, { visibleOnFullScreen: false, skipTransformProcessType: true });
    }
  }

  private scheduleMoveSave(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.saveOrigin();
    }, MOVE_SAVE_DELAY_MS);
  }

  private flushMoveSave(): void {
    if (!this.moveTimer) return;
    clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.saveOrigin();
  }

  private saveOrigin(): void {
    const win = this.window;
    if (!win) return;
    const [x, y] = win.getPosition();
    const state = this.deps.getState();
    if (state.origin?.x === x && state.origin?.y === y) return;
    this.deps.setState({ ...state, origin: { x, y } });
  }
}
