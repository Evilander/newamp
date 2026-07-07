import { readdir, readFile } from 'node:fs/promises';

/**
 * Reads every CSS module under src/styles as one joined bundle.
 *
 * The design system used to be a single src/styles/index.css; it is now split
 * into ordered modules (see src/styles/all.ts). Source-level smokes that grep
 * the stylesheet should use this helper so they keep working regardless of
 * which module a rule lives in. Files are joined in path order — fine for
 * presence checks; runtime cascade order is owned by src/styles/all.ts.
 */
export async function readStyleBundle() {
  const root = new URL('../src/styles/', import.meta.url);
  const entries = await readdir(root, { recursive: true });
  const cssFiles = entries
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.css'))
    .sort();
  const sources = await Promise.all(cssFiles.map((file) => readFile(new URL(file, root), 'utf8')));
  return sources.map((source, i) => `/* === src/styles/${cssFiles[i]} === */\n${source}`).join('\n');
}
