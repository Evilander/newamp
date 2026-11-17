// Projector controls use DOM APIs, like its transport bar; no React or store.
import type { VisualizerPreset } from '@shared/types';
import { PRESETS, PRESET_GROUPS } from '../visualizer/modes';
import { placeMenu, isLookLocked, toggleLookLock } from '../components/visualizer-input';
import { flashGuardEnabled, setFlashGuardEnabled, VIZ_FLASH_GUARD_KEY, VIZ_PALETTE_KEY, VIZ_REACTIVITY_KEY } from '../lib/vizPrefs';
import { readVjDwell, setVjDwell, watchVjDwell, VJ_DWELL_OPTIONS } from '../lib/vizVj';
import type { DetachedLookCommand } from '../visualizer/frame-bus';

export function createProjectorMenu(host: {
  mode(): VisualizerPreset;
  select(mode: VisualizerPreset): void;
  command(command: DetachedLookCommand): void;
  director(): boolean;
  autoVj(): boolean;
  toggleAutoVj(): void;
  fullscreen(): void;
  close(): void;
  onClose(): void;
}): { open(at?: { x: number; y: number }): void; isOpen(): boolean; refresh(): void; close(): void } {
  let layer: HTMLDivElement | null = null;
  let opener: HTMLElement | null = null;
  let browsing = false;
  let point = { x: 16, y: 60 };
  function place(panel: HTMLDivElement): void {
    const pos = placeMenu(point, panel.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    panel.style.left = `${pos.left}px`; panel.style.top = `${pos.top}px`;
  }
  const close = (): void => {
    if (!layer) return;
    layer.remove();
    layer = null;
    opener?.focus({ preventScroll: true });
    host.onClose();
  };
  const button = (parent: HTMLElement, text: string, action: () => void): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = text;
    el.addEventListener('click', () => {
      action();
      if (parent.isConnected && !parent.contains(document.activeElement)) parent.focus({ preventScroll: true });
    });
    parent.append(el);
    return el;
  };
  const fill = (input: HTMLSelectElement, options: ReadonlyArray<{ id: string; label: string }>, value: string): void => {
    input.replaceChildren(...options.map((option) => {
      const el = document.createElement('option');
      el.value = option.id;
      el.textContent = option.label;
      return el;
    }));
    input.value = value;
  };
  const select = (parent: HTMLElement, label: string, options: ReadonlyArray<{ id: string; label: string }>, value: string, change: (value: string) => void): HTMLSelectElement => {
    const row = document.createElement('label');
    row.textContent = label;
    const input = document.createElement('select');
    input.setAttribute('aria-label', label);
    fill(input, options, value);
    input.addEventListener('change', () => change(input.value));
    row.append(input);
    parent.append(row);
    return input;
  };
  const dwellOptions = (dwell: number): Array<{ id: string; label: string }> => [
    ...VJ_DWELL_OPTIONS.map((option) => ({ id: String(option.seconds), label: option.label })),
    ...(!VJ_DWELL_OPTIONS.some((option) => option.seconds === dwell) ? [{ id: String(dwell), label: `${dwell} seconds` }] : []),
  ];
  const flashLabel = (): string => `Flash protection: ${flashGuardEnabled() ? 'On — turn off…' : 'Off — turn on'}`;
  const pref = (key: string, fallback: string): string => {
    try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const store = (key: string, value: string): void => {
    try { window.localStorage.setItem(key, value); } catch { /* session only */ }
  };
  function refresh(): void {
    if (!layer) return;
    const heading = layer.querySelector<HTMLElement>('[data-projector-heading]');
    if (heading && !browsing) heading.textContent = PRESETS.find((p) => p.id === host.mode())?.label ?? 'Visualizer';
    const eviland = host.mode() === 'eviland' || host.mode() === 'eviland-live';
    const lock = layer.querySelector<HTMLButtonElement>('[data-projector-lock]');
    if (lock) lock.textContent = isLookLocked({ eviland, director: host.director(), autoVj: host.autoVj() }) ? 'Unlock look' : 'Lock look';
    const auto = layer.querySelector<HTMLButtonElement>('[data-projector-auto-vj]');
    if (auto) auto.textContent = `Auto-VJ: ${host.autoVj() ? 'On' : 'Off'}`;
    const previous = layer.querySelector<HTMLButtonElement>('[data-projector-previous]');
    if (previous) previous.disabled = eviland && !host.director();
    layer.querySelectorAll<HTMLButtonElement>('[data-projector-mode]').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.projectorMode === host.mode()));
    });
    // Settings follow in place, here and from other windows: a rebuild would
    // take the focus from the control in use, or from the one a Tab or a click
    // is moving it to.
    const dwell = readVjDwell();
    const duration = layer.querySelector<HTMLSelectElement>('[data-projector-dwell]');
    if (duration && duration.value !== String(dwell)) fill(duration, dwellOptions(dwell), String(dwell));
    const seconds = layer.querySelector<HTMLInputElement>('[data-projector-dwell-seconds]');
    if (seconds && seconds !== document.activeElement) seconds.value = String(dwell);
    const palette = layer.querySelector<HTMLSelectElement>('[data-projector-palette]');
    if (palette) palette.value = pref(VIZ_PALETTE_KEY, 'look');
    const reactivity = layer.querySelector<HTMLSelectElement>('[data-projector-reactivity]');
    if (reactivity) reactivity.value = pref(VIZ_REACTIVITY_KEY, 'punch');
    // An armed confirm is left as it is; its click reads the setting again.
    const protection = layer.querySelector<HTMLButtonElement>('[data-projector-flash]');
    if (protection && !protection.disabled) protection.textContent = flashLabel();
  }
  function render(panel: HTMLDivElement): void {
    panel.replaceChildren();
    const heading = document.createElement('strong');
    heading.dataset.projectorHeading = '';
    heading.textContent = browsing ? 'Browse all modes' : PRESETS.find((p) => p.id === host.mode())?.label ?? 'Visualizer';
    panel.append(heading);
    button(panel, 'Close menu ✕', close).setAttribute('aria-label', 'Close visualizer menu');
    if (browsing) {
      button(panel, '‹ Settings and looks', () => { browsing = false; render(panel); });
      for (const group of PRESET_GROUPS) {
        const label = document.createElement('h3');
        label.textContent = group.label;
        panel.append(label);
        for (const preset of PRESETS.filter((p) => p.group === group.id)) {
          const el = button(panel, preset.label, () => { host.select(preset.id); refresh(); });
          el.dataset.projectorMode = preset.id;
        }
      }
      refresh();
      place(panel);
      return;
    }
    const eviland = host.mode() === 'eviland' || host.mode() === 'eviland-live';
    const step = (direction: -1 | 1): void => {
      if (eviland) host.command(direction > 0 ? 'next-look' : 'previous-look');
      else {
        const index = PRESETS.findIndex((p) => p.id === host.mode());
        host.select(PRESETS[(index + direction + PRESETS.length) % PRESETS.length]!.id);
      }
      render(panel);
    };
    button(panel, 'Next look', () => step(1));
    const previous = button(panel, 'Previous look', () => step(-1));
    previous.disabled = eviland && !host.director();
    previous.dataset.projectorPrevious = '';
    button(panel, 'Randomize', () => {
      if (eviland) host.command('randomize');
      else host.select(PRESETS.filter((p) => p.id !== host.mode())[Math.floor(Math.random() * (PRESETS.length - 1))]!.id);
      render(panel);
    });
    const locked = isLookLocked({ eviland, director: host.director(), autoVj: host.autoVj() });
    const lock = button(panel, locked ? 'Unlock look' : 'Lock look', () => {
      const next = toggleLookLock({ eviland, director: host.director(), autoVj: host.autoVj() });
      if (next.autoVj !== host.autoVj()) host.toggleAutoVj();
      if (next.director !== host.director()) host.command('toggle-director');
      render(panel);
    });
    lock.dataset.projectorLock = '';
    button(panel, 'Mode / Browse all modes…', () => { browsing = true; render(panel); });
    button(panel, `Auto-VJ: ${host.autoVj() ? 'On' : 'Off'}`, () => { host.toggleAutoVj(); render(panel); }).dataset.projectorAutoVj = '';
    const dwell = readVjDwell();
    select(panel, 'Auto-VJ duration', dwellOptions(dwell), String(dwell), (value) => setVjDwell(Number(value))).dataset.projectorDwell = '';
    const custom = document.createElement('label');
    custom.textContent = 'Seconds (5–3600; 0 = Auto)';
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '3600'; input.step = '1'; input.value = String(dwell);
    input.setAttribute('aria-label', 'Custom Auto-VJ duration in seconds');
    input.dataset.projectorDwellSeconds = '';
    input.addEventListener('change', () => { setVjDwell(Number(input.value)); input.value = String(readVjDwell()); });
    custom.append(input); panel.append(custom);
    select(panel, 'Palette', [{ id: 'look', label: 'Per look' }, { id: 'theme', label: 'Theme' }, { id: 'phosphor', label: 'Phosphor' }, { id: 'ice', label: 'Ice' }, { id: 'sunset', label: 'Sunset' }, { id: 'rainbow', label: 'Cycle' }], pref(VIZ_PALETTE_KEY, 'look'), (value) => store(VIZ_PALETTE_KEY, value)).dataset.projectorPalette = '';
    select(panel, 'Reactivity', [{ id: 'truth', label: 'Truth' }, { id: 'punch', label: 'Punch' }, { id: 'wild', label: 'Wild' }], pref(VIZ_REACTIVITY_KEY, 'punch'), (value) => store(VIZ_REACTIVITY_KEY, value)).dataset.projectorReactivity = '';
    const note = document.createElement('p');
    note.textContent = 'Flash protection limits bright and red flashes, using the usual motion cadence. Turning it off may expose viewers to seizure-triggering flashes.';
    panel.append(note);
    const protection = button(panel, flashLabel(), () => {
      if (!flashGuardEnabled()) { setFlashGuardEnabled(true); render(panel); return; }
      const armedAt = performance.now();
      protection.disabled = true;
      const confirm = button(panel, 'Turn off flash protection anyway?', () => {
        if (performance.now() - armedAt < 500) return;
        setFlashGuardEnabled(false); render(panel);
      });
      confirm.focus();
    });
    protection.dataset.projectorFlash = '';
    button(panel, 'Toggle fullscreen', host.fullscreen);
    button(panel, 'Close Projector', host.close);
    place(panel);
  }
  function open(at = { x: 16, y: 60 }): void {
    close(); browsing = false; point = at;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layer = document.createElement('div');
    layer.className = 'projector-menu-layer';
    layer.dataset.newampProjectorMenu = '';
    const panel = document.createElement('div');
    panel.className = 'projector-menu'; panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Visualizer menu');
    layer.addEventListener('pointerdown', (event) => { if (event.target === layer) close(); });
    layer.append(panel); document.body.append(layer);
    render(panel);
    place(panel);
    panel.focus({ preventScroll: true });
  }
  window.addEventListener('keydown', (event) => {
    if (!layer) return;
    if (event.key === 'Tab') {
      const controls = Array.from(layer.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
      event.preventDefault(); event.stopImmediatePropagation();
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) { event.stopImmediatePropagation(); return; }
      const buttons = Array.from(layer.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); event.preventDefault(); event.stopImmediatePropagation();
    } else if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      // A held Enter repeats the focused button's activation, and the flash
      // protection confirm takes focus; only a fresh press can confirm.
      event.preventDefault(); event.stopImmediatePropagation();
    } else if (event.key !== 'F11') event.stopImmediatePropagation();
  }, true);
  watchVjDwell(() => refresh());
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === VIZ_PALETTE_KEY || event.key === VIZ_REACTIVITY_KEY || event.key === VIZ_FLASH_GUARD_KEY) refresh();
  });
  return { open, isOpen: () => layer !== null, refresh, close };
}
