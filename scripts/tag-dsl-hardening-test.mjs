// Three Tag DSL hardening fixes, each verified behaviorally against the
// compiled shared module (not just source pattern matches):
//   1. ReDoS guard gap: (a{3,})+ and (?:a|a)+ are catastrophic-backtracking
//      shapes that slipped past safeRegex before this fix.
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

// ---------- 1. ReDoS guard: {n,}-nested quantifier ----------

const nestedBrace = parseRule('tag(nested_brace) when title matches "(a{3,})+b"');
assert.ok(nestedBrace.rule, 'a {n,}-nested pattern should still parse (rejection happens at eval, like the existing (a+)+ case)');
const evilTitle = 'a'.repeat(40) + '!';
const t1 = Date.now();
const nestedBraceEval = evaluateRule(nestedBrace.rule, stubContext({ title: evilTitle }), buildEvalEnvironment());
const nestedBraceMs = Date.now() - t1;
assert.ok(nestedBraceMs < 100, `(a{3,})+ must be refused fast like (a+)+, took ${nestedBraceMs}ms`);
assert.equal(nestedBraceEval.matched, false, '(a{3,})+ should be treated as an unsafe pattern (matched: false)');

// Bounded {n,m} on its own is NOT the nested-unbounded shape and must still work normally.
const boundedBrace = parseRule('tag(bounded_brace) when title matches "^a{2,4}$"');
assert.ok(boundedBrace.rule);
assert.equal(
  evaluateRule(boundedBrace.rule, stubContext({ title: 'aaa' }), buildEvalEnvironment()).matched,
  true,
  'a plain bounded {n,m} quantifier should not be treated as unsafe',
);

// ---------- 2. ReDoS guard: non-capturing alternation-of-equivalents ----------

const nonCapturingAlt = parseRule('tag(noncap_alt) when title matches "(?:a|a)+b"');
assert.ok(nonCapturingAlt.rule, 'a non-capturing alternation-repeat pattern should still parse');
const t2 = Date.now();
const nonCapturingAltEval = evaluateRule(nonCapturingAlt.rule, stubContext({ title: 'a'.repeat(40) }), buildEvalEnvironment());
const nonCapturingAltMs = Date.now() - t2;
assert.ok(nonCapturingAltMs < 100, `(?:a|a)+ must be refused fast, took ${nonCapturingAltMs}ms`);
assert.equal(nonCapturingAltEval.matched, false, '(?:a|a)+ should be treated as an unsafe pattern (matched: false)');

// Distinct-branch alternation under a non-capturing group is legitimate and must still work.
const safeNonCapturingAlt = parseRule('tag(safe_noncap) when title matches "(?:cat|dog)"');
assert.ok(safeNonCapturingAlt.rule);
assert.equal(
  evaluateRule(safeNonCapturingAlt.rule, stubContext({ title: 'my cat' }), buildEvalEnvironment()).matched,
  true,
  'a non-capturing group with genuinely distinct branches must not be flagged unsafe',
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
assert.match(tagDslSource, /\.toLowerCase\(\)/, 'tag() reference parsing should normalize case');

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:tag-dsl-hardening"/, 'package.json should expose the tag DSL hardening test');

console.log(JSON.stringify({ ok: true }, null, 2));
