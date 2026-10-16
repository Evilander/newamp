// Settings must only describe what the app does. The Assist section listed
// "Missing art scout", "Review seed" and "Artist dossier" cards for features
// that do not exist, and its intro promised artist context, review prompts and
// discussion seeds. Only liner notes (the AI Notes button on Now Playing) are
// real, and the Last.fm help text now says what the API key is for.
// Run: node scripts/settings-assist-copy-test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const settings = read('src/components/views/SettingsView.tsx');

const sectionOf = (id) => {
  const start = settings.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `${id} section exists`);
  const next = settings.indexOf('<section id=', start + 1);
  return settings.slice(start, next < 0 ? undefined : next);
};

// --- The phantom features are gone from the app ------------------------------
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css)$/.test(name) ? [full] : [];
  });
}
for (const phantom of ['Missing art scout', 'Review seed', 'Artist dossier', 'discussion seeds', 'review prompts']) {
  const hits = sourceFiles('src').filter((full) => readFileSync(full, 'utf8').includes(phantom));
  assert.deepEqual(hits, [], `"${phantom}" is not advertised anywhere in src`);
}

const { code } = await transform(read('src/lib/aiAssist.ts'), { loader: 'ts', format: 'esm' });
const { AI_ASSIST_OPTIONS, aiAssistSummary } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
assert.deepEqual(AI_ASSIST_OPTIONS.map((option) => option.id), ['liner-notes'], 'liner notes is the only assist feature');
assert.equal(aiAssistSummary(), 'liner notes');

// The one feature kept really exists end to end.
assert.match(read('electron/preload.ts'), /ai:liner-notes/, 'liner notes has an IPC channel');
assert.match(read('src/components/LinerNotesPanel.tsx'), /AI Notes/, 'Now Playing has the AI Notes button');

// --- The Settings section ------------------------------------------------------
{
  const assist = sectionOf('settings-assist');
  assert.match(assist, /<h2 className="eyebrow">Liner notes \(OpenAI\)<\/h2>/);
  assert.doesNotMatch(assist, /ChatGPT Assist/);
  assert.doesNotMatch(assist, /ai-assist-option/, 'the feature cards are gone');
  assert.doesNotMatch(assist, /AI_ASSIST_OPTIONS/);
  assert.match(assist, /AI Notes button on Now Playing/, 'the intro names the real feature');
  assert.match(assist, /sends that track's tags and lyrics to OpenAI/, 'the intro says what leaves the machine');
  assert.match(assist, /aria-label="OpenAI API key"/, 'the key field stays');
  assert.match(assist, /Save ChatGPT key/, 'saving the key stays');
  assert.doesNotMatch(assist, /showTutorialOnNextLaunch/, 'the tutorial button does not belong here');
  assert.doesNotMatch(settings, /import \{ AI_ASSIST_OPTIONS \}/);
  assert.match(settings, /\{ id: 'settings-assist', label: 'Liner notes' \}/, 'the section nav names the section');
}

// The tutorial button moved to Support, with a status line of its own.
{
  const support = sectionOf('settings-support');
  assert.match(support, /onClick=\{\(\) => void showTutorialOnNextLaunch\(\)\}[\s\S]*?Show first-launch tutorial/);
  assert.match(support, /\{tutorialStatus && /);
  assert.match(settings, /setTutorialStatus\('The tutorial will show the next time NewAmp opens\.'\)/);
  assert.doesNotMatch(settings, /setOpenAiStatus\('First-launch tutorial/, 'the tutorial no longer reports through the OpenAI status');
}

// --- Last.fm help text ------------------------------------------------------------
{
  const lastfm = sectionOf('settings-lastfm');
  const guide = lastfm.slice(lastfm.indexOf('data-newamp-lastfm-setup-guide'), lastfm.indexOf('<div className="grid'));
  const text = guide.replace(/<[^>]+>/g, ' ').replace(/\{' '\}/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /identity/, 'scrobbling is not the reason you need your own key');
  assert.doesNotMatch(text, /shared NewAmp account/);
  assert.match(text, /requires an API key to identify the app and a shared secret to sign scrobbles/);
  assert.match(text, /NewAmp does not include its own/);
  assert.match(guide, /href="https:\/\/www\.last\.fm\/api\/account\/create"/, 'the registration link stays');
  // What the claim rests on: the key is sent on every call and the secret signs them.
  const lastfmApi = read('electron/lastfm.ts');
  assert.match(lastfmApi, /api_key: apiKey/);
  assert.match(lastfmApi, /signLastfmParams\(params, sharedSecret\)/);
  assert.match(read('electron/settings.ts'), /lastfmApiKey: null/, 'no key ships with the app');
}

console.log('PASS settings assist copy');
