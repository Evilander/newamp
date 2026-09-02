// Tag DSL hardening checks, each verified behaviorally against the compiled
// shared module (not just source pattern matches):
//   1. `matches` patterns run on a linear-time matcher, so the
//      catastrophic-backtracking shapes that used to slip past the old
//      heuristic guard are simply ordinary patterns now, and syntax the
//      matcher cannot run in linear time is refused when the rule compiles.
//   2. Cross-tag references were case-sensitive against a declaration
//      grammar that only allows lower-case names, so any differently-cased
//      reference silently never resolved.
//   3. A mutually-referencing rule pair used to make topologicalSort() throw
//      inside evaluateRulesForTrack — the per-track recompute entry point —
//      which would abort a whole recompute pass over the rest of an
//      otherwise-valid rule set.
// Run with: npm run test:tag-dsl-hardening

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildEvalEnvironment,
  evaluateRule,
  evaluateRulesForTrack,
  parseRule,
  topologicalSort,
} from '../dist-electron/shared/tag-dsl.js';

function stubContext(overrides = {}) {
  return {
    id: 1, title: 'stub', artist: 'stub', album: 'stub', albumArtist: 'stub', genre: null,
    year: 2020, duration: 200, bitrate: 320000, sampleRate: 44100, size: 1024,
    mtime: Date.now(), bpm: 120, key: null, format: 'flac',
    rating: 0, ratingScore: null, playCount: 0, skipCount: 0, lastPlayed: null,
    lastSkipped: null, loved: false, avoidAutoPlay: false,
    replayGainTrack: null, replayGainAlbum: null, dna: null,
    ...overrides,
  };
}

// ---------- 1. Catastrophic-backtracking shapes are ordinary patterns now ----------
//
// `matches` compiles to a linear-time NFA (shared/safe-regex.ts), so the shapes
// that used to need a heuristic pre-screen — (a{3,})+, (?:a|a)+, a named-group
// alternation — parse, answer correctly and finish fast on a hostile input.

const evilTitle = 'a'.repeat(4096) + '!';
for (const [tagName, pattern] of [
  ['nested_brace', '(a{3,})+b'],
  ['noncap_alt', '(?:a|a)+b'],
  ['alt_named', '(?<dup>a|a)+b'],
]) {
  const parsed = parseRule(`tag(${tagName}) when title matches "${pattern}"`);
  assert.ok(parsed.rule, `${pattern} should compile`);
  const started = Date.now();
  const evaluated = evaluateRule(parsed.rule, stubContext({ title: evilTitle }), buildEvalEnvironment());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `${pattern} must finish in linear time, took ${elapsed}ms`);
  assert.equal(evaluated.matched, false, `${pattern} does not match a title with no "b"`);
}

// Bounded {n,m} still works normally.
const boundedBrace = parseRule('tag(bounded_brace) when title matches "^a{2,4}$"');
assert.ok(boundedBrace.rule);
assert.equal(
  evaluateRule(boundedBrace.rule, stubContext({ title: 'aaa' }), buildEvalEnvironment()).matched,
  true,
  'a plain bounded {n,m} quantifier should match normally',
);

// ---------- 2. Syntax outside the linear-time grammar is refused at compile time ----------

const inlineModifier = parseRule('tag(alt_inline) when title matches "(?i:a|a)+b"');
assert.equal(inlineModifier.rule, null, 'inline modifiers are outside the supported grammar');
assert.match(inlineModifier.errors[0]?.message ?? '', /inline modifiers .* not supported/);

// A named group with genuinely distinct branches is legitimate and must still work.
const safeNamedAlt = parseRule('tag(safe_named) when title matches "(?<pet>cat|dog)"');
assert.ok(safeNamedAlt.rule);
assert.equal(
  evaluateRule(safeNamedAlt.rule, stubContext({ title: 'my dog' }), buildEvalEnvironment()).matched,
  true,
  'a named group with distinct branches must match',
);

// Distinct-branch alternation under a non-capturing group is legitimate and must still work.
const safeNonCapturingAlt = parseRule('tag(safe_noncap) when title matches "(?:cat|dog)"');
assert.ok(safeNonCapturingAlt.rule);
assert.equal(
  evaluateRule(safeNonCapturingAlt.rule, stubContext({ title: 'my cat' }), buildEvalEnvironment()).matched,
  true,
  'a non-capturing group with genuinely distinct branches must match',
);

// ---------- 3. Cross-tag references are case-insensitive ----------

const declared = parseRule('tag(energy_high) when bpm > 100').rule;
const referencer = parseRule('tag(loud_night) when tag(Energy_High) and hour() >= 0').rule;
assert.ok(declared && referencer);
const caseResult = evaluateRulesForTrack({
  rules: [referencer, declared],
  context: stubContext({ bpm: 140 }),
  env: buildEvalEnvironment(),
});
assert.ok(caseResult.tags.has('energy_high'), 'the declared rule should match on its own condition');
assert.ok(
  caseResult.tags.has('loud_night'),
  'a differently-cased tag() reference (Energy_High) must still resolve to the lower-case declared rule (energy_high)',
);

// ---------- 4. A cyclic pair no longer crashes per-track evaluation ----------

const cycleA = parseRule('tag(cyc_a) when tag(cyc_b)').rule;
const cycleB = parseRule('tag(cyc_b) when tag(cyc_a)').rule;
const independent = parseRule('tag(independent) when bpm > 100').rule;
assert.ok(cycleA && cycleB && independent);

// topologicalSort() itself must keep throwing — the save-time validation
// gate in electron/library.ts relies on that to reject a cycle-introducing
// rule before it's ever persisted.
assert.throws(() => topologicalSort([cycleA, cycleB]), /cycle/, 'topologicalSort should still throw for save-time validation');

// But evaluateRulesForTrack — the per-track recompute path — must not throw
// just because a cyclic pair somehow made it into the persisted rule set.
let recomputeResult;
assert.doesNotThrow(() => {
  recomputeResult = evaluateRulesForTrack({
    rules: [cycleA, cycleB, independent],
    context: stubContext({ bpm: 140 }),
    env: buildEvalEnvironment(),
  });
}, 'a mutually-referencing rule pair must not abort evaluation for the rest of the rule set');
assert.ok(recomputeResult.tags.has('independent'), 'an unrelated rule must still evaluate normally alongside a cyclic pair');
assert.equal(recomputeResult.tags.has('cyc_a'), false, 'a rule that is part of a cycle should not produce a tag');
assert.equal(recomputeResult.tags.has('cyc_b'), false, 'a rule that is part of a cycle should not produce a tag');
assert.ok(
  recomputeResult.errors.size > 0,
  'the cyclic rule(s) should be reported through the existing per-rule errors map, not silently dropped',
);

// --- Source assertions ---
const tagDslSource = await readFile(new URL('../shared/tag-dsl.ts', import.meta.url), 'utf8');
assert.match(tagDslSource, /topologicalSortSafe/, 'a non-throwing sort variant should exist for the recompute path');
assert.match(tagDslSource, /from '\.\/safe-regex\.js'/, 'matches must go through the linear-time matcher');
assert.doesNotMatch(tagDslSource, /new RegExp\(/, 'no user-authored pattern may reach the backtracking RegExp engine');
assert.match(tagDslSource, /\.toLowerCase\(\)/, 'tag() reference parsing should normalize case');

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:tag-dsl-hardening"/, 'package.json should expose the tag DSL hardening test');

console.log(JSON.stringify({ ok: true }, null, 2));
