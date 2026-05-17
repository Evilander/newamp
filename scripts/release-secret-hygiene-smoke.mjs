import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { checkReleaseBundle } from './release-bundle.mjs';

const repoRoot = resolve('.');
const packageMeta = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = String(packageMeta.version ?? '').trim() || '0.0.0';

const forbiddenPathPatterns = [
  /(^|[/\\])\.env($|[./\\])/i,
  /\.(pem|key|pfx|p12|cer|crt)$/i,
  /(^|[/\\])(codex\.md|\.claude\.json)$/i,
];
const ignoredRoots = new Set([
  '.git',
  '.newamp-git',
  '.serena',
  '.vite',
  'dist',
  'dist-electron',
  'node_modules',
  'release',
  'studio',
  'tmp',
]);
const binaryExtensions = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.ape',
  '.asar',
  '.bmp',
  '.dts',
  '.exe',
  '.flac',
  '.gif',
  '.ico',
  '.jpg',
  '.jpeg',
  '.m4a',
  '.mp3',
  '.mp4',
  '.ogg',
  '.opus',
  '.png',
  '.wasm',
  '.wav',
  '.webp',
  '.wma',
  '.wv',
  '.zip',
]);
const secretEnvNames = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LASTFM_API_KEY',
  'LASTFM_SESSION_KEY',
  'LASTFM_SHARED_SECRET',
  'NEWAMP_LASTFM_API_KEY',
  'NEWAMP_LASTFM_SESSION_KEY',
  'NEWAMP_LASTFM_SHARED_SECRET',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
];

const trackedFiles = listTrackedFiles();
const forbiddenTrackedFiles = trackedFiles.filter((path) => isForbiddenPublicPath(path));
assert.deepEqual(forbiddenTrackedFiles, [], `secret-bearing files must not be tracked: ${forbiddenTrackedFiles.join(', ')}`);

const secretValues = collectSecretValues();
const scannedFiles = [];
const hits = [];
for (const file of trackedFiles) {
  if (!isTextCandidate(file)) continue;
  const absolute = join(repoRoot, file);
  if (!existsSync(absolute)) continue;
  const text = readFileSync(absolute, 'utf8');
  scannedFiles.push(file);
  for (const secret of secretValues) {
    if (text.includes(secret.value)) {
      hits.push({
        file,
        source: secret.name,
        fingerprint: fingerprint(secret.value),
      });
    }
  }
}

assert.deepEqual(
  hits,
  [],
  `runtime secret values must not be persisted in tracked source: ${hits
    .map((hit) => `${hit.file}(${hit.source}:${hit.fingerprint})`)
    .join(', ')}`,
);

const releaseBundle = checkReleaseBundle({ root: repoRoot, version });
const releaseArchiveChecked = releaseBundle.ok === true;
if (releaseArchiveChecked) {
  assert.equal(releaseBundle.sourceArchive?.ok, true, releaseBundle.sourceArchive?.reason ?? releaseBundle.reason);
  assert.deepEqual(releaseBundle.sourceArchive?.forbiddenEntries ?? [], [], 'release source archive must exclude secret-bearing entries');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      trackedFiles: trackedFiles.length,
      scannedFiles: scannedFiles.length,
      envSecretValuesChecked: secretValues.length,
      releaseArchiveChecked,
      releaseBundleReason: releaseArchiveChecked ? null : releaseBundle.reason,
      releaseSourceEntries: releaseBundle.sourceArchive?.entryCount ?? null,
      forbiddenReleaseEntries: releaseBundle.sourceArchive?.forbiddenEntries ?? [],
    },
    null,
    2,
  ),
);

function listTrackedFiles() {
  const git = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (git.status === 0 && !git.error) {
    return git.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizePath)
      .sort();
  }
  return walkPublicSource(repoRoot).sort();
}

function walkPublicSource(root, prefix = '') {
  const entries = [];
  for (const name of readdirSync(root)) {
    if (ignoredRoots.has(name)) continue;
    const absolute = join(root, name);
    const relativePath = normalizePath(prefix ? `${prefix}/${name}` : name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.push(...walkPublicSource(absolute, relativePath));
    } else if (stat.isFile()) {
      entries.push(relativePath);
    }
  }
  return entries;
}

function collectSecretValues() {
  const values = [];
  for (const name of secretEnvNames) {
    const value = cleanSecretValue(process.env[name]);
    if (value) values.push({ name, value });
  }
  for (const [index, value] of splitSecretList(process.env.NEWAMP_SECRET_SCAN_VALUES).entries()) {
    const cleaned = cleanSecretValue(value);
    if (cleaned) values.push({ name: `NEWAMP_SECRET_SCAN_VALUES[${index}]`, value: cleaned });
  }

  const seen = new Set();
  return values.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

function splitSecretList(value) {
  return String(value ?? '')
    .split(/\r?\n|[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanSecretValue(value) {
  const text = String(value ?? '').trim();
  if (text.length < 8) return null;
  if (/^(missing|redacted|placeholder|example|test|smoke)$/i.test(text)) return null;
  return text;
}

function isForbiddenPublicPath(path) {
  return forbiddenPathPatterns.some((pattern) => pattern.test(path));
}

function isTextCandidate(path) {
  if (isForbiddenPublicPath(path)) return false;
  return !binaryExtensions.has(extname(path).toLowerCase());
}

function normalizePath(path) {
  return relative(repoRoot, resolve(repoRoot, path)).split(sep).join('/');
}

function fingerprint(value) {
  return `${value.slice(0, 2)}...${value.slice(-2)}:${value.length}`;
}
