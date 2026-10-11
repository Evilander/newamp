// What each skin variable changes, in the words of the interface. Shared by the
// Skin Workshop page and the floating colour editor.
export const SKIN_VARIABLE_HINTS: Record<string, { label: string; hint: string }> = {
  '--bg': { label: 'Background', hint: 'Behind everything' },
  '--panel': { label: 'Panels', hint: 'Sidebar, cards, transport' },
  '--panel-2': { label: 'Raised panels', hint: 'Buttons, inputs, rows' },
  '--panel-3': { label: 'Hover', hint: 'Hovered and pressed surfaces' },
  '--line': { label: 'Lines', hint: 'Borders and dividers' },
  '--accent': { label: 'Accent', hint: 'Highlights, active controls, lit text' },
  '--accent-dim': { label: 'Accent, dimmed', hint: 'Fills under the accent' },
  '--accent-glow': { label: 'Accent glow', hint: 'Halo around lit text and lamps' },
  '--on-accent': { label: 'Text on accent', hint: 'Pressed buttons and other accent fills' },
  '--ink': { label: 'Text', hint: 'Main text' },
  '--ink-2': { label: 'Text, secondary', hint: 'Details and artist lines' },
  '--muted': { label: 'Muted', hint: 'Labels and hints' },
  '--warn': { label: 'Warning', hint: 'Cautions and amber badges' },
  '--error': { label: 'Error', hint: 'Errors, volume past 0 dB' },
  '--display-bg': { label: 'LCD background', hint: 'Transport readout' },
  '--display-fg': { label: 'LCD text', hint: 'Time, title and bitrate readout' },
  '--bevel-light': { label: 'Bevel highlight', hint: 'Top and left edges' },
  '--bevel-dark': { label: 'Bevel shadow', hint: 'Bottom and right edges' },
  '--radius': { label: 'Corner radius', hint: 'Buttons and inputs' },
  '--radius-card': { label: 'Card radius', hint: 'Panels and cards' },
};

/** The floating editor's sections; together they cover every skin variable once. */
export const SKIN_VARIABLE_SECTIONS: ReadonlyArray<{ label: string; keys: readonly string[] }> = [
  { label: 'Surfaces', keys: ['--bg', '--panel', '--panel-2', '--panel-3', '--line'] },
  { label: 'Accent', keys: ['--accent', '--accent-dim', '--accent-glow', '--on-accent'] },
  { label: 'Text', keys: ['--ink', '--ink-2', '--muted'] },
  { label: 'Status', keys: ['--warn', '--error'] },
  { label: 'LCD', keys: ['--display-bg', '--display-fg'] },
  { label: 'Bevels and corners', keys: ['--bevel-light', '--bevel-dark', '--radius', '--radius-card'] },
];
