// Unit test for the custom-skin value allowlist grammar (shared/custom-skin.ts).
// Guards against the privacy leak where an imported .newampskin.json could
// put a `url(https://host/id)` value on a background/color slot and trigger
// an outbound request the moment the skin was applied (the renderer CSP
// allows https: images). Requires a prior `npm run build:electron`.
// Run: npm run test:custom-skin-guard
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { normalizeSkinVariableValue, COLOR_SKIN_VARIABLES, LENGTH_SKIN_VARIABLES } =
  await import('../dist-electron/shared/custom-skin.js');

// --- Malicious / disguised values must be rejected on a color variable ----
const rejectedColorValues = [
  'url(https://x)',
  'URL( https://x )',
  'u\\72l(https://x)', // CSS hex escape spells "url(" via \72 = "r"
  'url(/*c*/https://x)', // comment splits the token but still resolves to url(
  'image-set(url(https://x) 1x)',
  'var(--bg)',
];
for (const value of rejectedColorValues) {
  assert.equal(
    normalizeSkinVariableValue('--bg', value),
    null,
    `expected --bg to reject ${JSON.stringify(value)}`,
  );
}

// A color value placed in a length (radius) field must also be rejected.
assert.equal(normalizeSkinVariableValue('--radius', '#ff0000'), null, 'a color must not pass as a radius value');

// An absurdly large length must be rejected (bounded grammar, not just "a number").
assert.equal(normalizeSkinVariableValue('--radius', '9999999px'), null, 'an out-of-range length must be rejected');

// Any value containing a backslash is rejected outright, regardless of shape.
assert.equal(normalizeSkinVariableValue('--bg', '#fff\\'), null, 'a value with a backslash must be rejected');
assert.equal(normalizeSkinVariableValue('--radius', '4px\\'), null, 'a value with a backslash must be rejected');

// --- Every built-in skin's actual values must still round-trip unchanged --
const tokensCss = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const skinVariableNames = new Set([...COLOR_SKIN_VARIABLES, ...LENGTH_SKIN_VARIABLES]);
const blockRe = /(:root|\[data-theme='[^']+'\])\s*\{([^}]*)\}/g;
const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;

let checkedBlocks = 0;
let checkedValues = 0;
let block;
while ((block = blockRe.exec(tokensCss))) {
  checkedBlocks += 1;
  const body = block[2];
  let decl;
  while ((decl = declRe.exec(body))) {
    const [, name, rawValue] = decl;
    if (!skinVariableNames.has(name)) continue; // e.g. --titlebar, --shadow-card, fonts — not skin variables
    checkedValues += 1;
    const value = rawValue.trim();
    const normalized = normalizeSkinVariableValue(name, value);
    assert.equal(
      normalized,
      value,
      `built-in skin value for ${name} in ${block[1]} should round-trip unchanged (got ${JSON.stringify(normalized)} from ${JSON.stringify(value)})`,
    );
  }
}
assert.ok(checkedBlocks >= 13, `expected to check :root plus every [data-theme] block, only found ${checkedBlocks}`);
assert.ok(checkedValues > 100, `expected to check every skin variable across every built-in theme, only found ${checkedValues}`);

// Modern colour syntax (what browser dev tools copy) and a bare 0 length are
// valid CSS and were accepted by 2.1.0's blacklist; the grammar admits them too.
for (const [key, value] of [
  ['--accent', 'rgb(255 255 255)'],
  ['--accent', 'rgb(255 255 255 / 0.5)'],
  ['--accent', 'rgba(255, 255, 255, .5)'],
  ['--accent', 'hsl(120deg 50% 50%)'],
  ['--accent', 'hsl(120 50% 50% / 40%)'],
  ['--radius', '0'],
  ['--radius', '12px'],
]) {
  if (normalizeSkinVariableValue(key, value) !== value) fail(`${key}=${JSON.stringify(value)} should be accepted unchanged`);
}
for (const [key, value] of [
  ['--accent', 'rgb(255 255)'],
  ['--accent', 'rgb(255 255 255 255 255)'],
  ['--accent', 'url( https://x )'],
  ['--radius', '0 0'],
  ['--radius', '5'],
]) {
  if (normalizeSkinVariableValue(key, value) !== null) fail(`${key}=${JSON.stringify(value)} should be rejected`);
}
console.log(JSON.stringify({ ok: true, checkedBlocks, checkedValues }, null, 2));
