// What the Settings row for the window's close button says. The stored value is
// the same on every platform ('minimize-to-tray' keeps the app running,
// 'close-app' quits), but the thing that keeps it running differs: the Dock on
// a Mac, the tray elsewhere.

export interface CloseButtonCopy {
  label: string;
  keepRunning: string;
  quit: string;
  hint: string;
}

export function closeButtonCopy(platform: string): CloseButtonCopy {
  if (platform === 'darwin') {
    return {
      label: 'Close button',
      keepRunning: 'Keep playing in the Dock',
      quit: 'Quit NewAmp',
      hint: 'Choose what happens when you close the window. Cmd+Q always quits.',
    };
  }
  return {
    label: 'Close button (X)',
    keepRunning: 'Minimize to tray',
    quit: 'Close the app',
    hint: 'Choose what happens when you click the X button in the title bar. Without a tray icon, X minimizes to the taskbar instead.',
  };
}
