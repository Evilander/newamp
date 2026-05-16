// Shell picker. The "shell" is the layout/chrome style — independent of the
// skin (which controls colors). Four shells: Retro (the original Bloomberg-
// terminal Winamp homage), Modern (rounded, content-forward), Liquid Glass
// (frosted translucent layers), and Concourse (a split operator console).
//
// The selection is persisted in localStorage and reflected on
// <html data-shell="..."> so CSS can re-skin the chrome without React having
// to know about which shell is active.

import { useEffect, useState } from 'react';

export type Shell = 'retro' | 'modern' | 'liquid-glass' | 'concourse';

export const SHELLS: { id: Shell; label: string; tagline: string }[] = [
  { id: 'retro',        label: 'Retro',        tagline: 'Bloomberg-density Winamp 2 homage' },
  { id: 'modern',       label: 'Modern',       tagline: 'Soft shadows, content-forward, big covers' },
  { id: 'liquid-glass', label: 'Liquid Glass', tagline: 'Apple-style translucent stacked panes' },
  { id: 'concourse',    label: 'Concourse',    tagline: 'Operator console / split-pane mission control' },
];

const SHELL_KEY = 'newamp:shell';

export function loadInitialShell(): Shell {
  if (typeof window === 'undefined') return 'retro';
  const raw = window.localStorage.getItem(SHELL_KEY);
  if (raw && SHELLS.some((shell) => shell.id === raw)) return raw as Shell;
  return 'retro';
}

export function applyShell(shell: Shell): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.shell = shell;
  window.localStorage.setItem(SHELL_KEY, shell);
}

export function ShellPicker(): JSX.Element {
  const [shell, setShell] = useState<Shell>(() => loadInitialShell());
  useEffect(() => applyShell(shell), [shell]);

  return (
    <div className="shell-picker">
      <span className="shell-picker-label">Shell</span>
      <div className="shell-picker-buttons" role="radiogroup">
        {SHELLS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={shell === option.id}
            className={`pxbtn shell-picker-btn ${shell === option.id ? 'is-active' : ''}`}
            onClick={() => setShell(option.id)}
            title={option.tagline}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
