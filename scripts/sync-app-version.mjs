import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = String(packageJson.version ?? '').trim();

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version is not a publishable semver: ${version}`);
}

const source = [
  `export const NEWAMP_VERSION = '${version}';`,
  "export const NEWAMP_USER_AGENT = `NewAmp/${NEWAMP_VERSION}`;",
  "export const NEWAMP_REPO_USER_AGENT = `${NEWAMP_USER_AGENT} (https://github.com/evilander/newamp)`;",
  '',
].join('\n');

const target = resolve(root, 'shared', 'app-version.ts');
const existing = await readFile(target, 'utf8').catch(() => '');
if (existing !== source) {
  await writeFile(target, source, 'utf8');
}
