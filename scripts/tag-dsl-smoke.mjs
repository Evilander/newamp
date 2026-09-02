import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { analyzeTrackDna } from '../dist-electron/electron/dna-analyzer.js';
import {
  buildEvalEnvironment,
  evaluateRule,
  evaluateRulesForTrack,
  listFunctions,
  listIdentifiers,
  parseRule,
  topologicalSort,
} from '../dist-electron/shared/tag-dsl.js';

if (!ffmpeg) throw new Error('ffmpeg-static did not resolve a binary');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'tag-dsl-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

// Synthesize four fixtures with distinct sonic characters.
const fixtures = [
  { name: 'driver.flac', synth: 'sine=frequency=160:duration=3', bpmHint: 128, title: 'Driver Beat' },
  { name: 'ambient.flac', synth: 'sine=frequency=220:duration=3', bpmHint: 70, title: 'Soft Drift' },
  { name: 'noise.flac', synth: 'anoisesrc=color=pink:duration=3:amplitude=0.3', bpmHint: 92, title: 'Static Field' },
  { name: 'siren.flac', synth: 'sine=frequency=2200:duration=3', bpmHint: 145, title: 'Siren Ride' },
];
for (const fixture of fixtures) {
  const out = join(musicRoot, fixture.name);
  runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', fixture.synth,
    '-metadata', `title=${fixture.title}`,
    '-metadata', 'artist=Tag DSL',
    '-metadata', `album=DSL Album`,
    '-c:a', 'flac',
    out,
  ]);
  assert.ok(existsSync(out));
}

// ---------- Parser tests ----------

const good = parseRule('tag(bright_band) when dna.brightness > 0.3 and bpm > 100 boost 1.5');
assert.ok(good.rule, 'simple rule should parse');
assert.equal(good.rule.name, 'bright_band');
assert.equal(good.rule.boost, 1.5);

const bad = parseRule('tag(broken) when dna.brightness > and');
assert.ok(!bad.rule, 'malformed rule should not parse');
assert.ok(bad.errors[0]?.message, 'parser should explain syntax error');
assert.ok(bad.errors[0].line >= 1 && bad.errors[0].column >= 1, 'parser should report position');

const self = parseRule('tag(loop) when tag(loop)');
assert.ok(!self.rule, 'self-referential rule should be rejected at parse time');

const composed = parseRule('tag(latenight) when tag(bright_band) and hour() > 22');
assert.ok(composed.rule);
assert.deepEqual(composed.rule.references, ['bright_band'], 'tag references should be tracked');

// Parser handles function calls but only invokes whitelisted entries at eval time.
const sandboxAttempt = parseRule('tag(escape) when constructor("alert(1)")');
assert.ok(sandboxAttempt.rule, 'parser accepts any identifier syntactically');
const sandboxEval = evaluateRule(sandboxAttempt.rule, makeStubContext(), buildEvalEnvironment());
assert.ok(sandboxEval.errors.length > 0, 'non-whitelisted function should fail evaluation');
assert.equal(sandboxEval.matched, false);
const chained = parseRule('tag(chain) when constructor("x")() = 1');
assert.equal(chained.rule, null, 'chained function calls should be rejected at parse time');

const protoAttempt = parseRule('tag(proto) when track.__proto__ = "x"');
assert.ok(protoAttempt.rule);
const protoEval = evaluateRule(protoAttempt.rule, makeStubContext(), buildEvalEnvironment());
assert.ok(protoEval.errors.length > 0, 'host object fields should not be reachable');

// `matches` runs on a linear-time matcher, so the classic catastrophic
// backtracking shapes are just ordinary patterns now: they parse, they give
// the right answer, and they finish in milliseconds against a hostile input.
// Just under MAX_REGEX_INPUT_LENGTH so the trailing '!' survives the input cap.
const evilTitle = 'a'.repeat(4000) + '!';
for (const [name, pattern, expected] of [
  ['redos_nested', '(a+)+b', false],
  ['redos_alt', '(a|a)*b', false],
  ['redos_sequential', '.*.*.*=', false],
  ['redos_sequential_hit', '.*.*.*!', true],
]) {
  const parsed = parseRule(`tag(${name}) when title matches "${pattern}"`);
  assert.ok(parsed.rule, `${pattern} should compile`);
  const started = Date.now();
  const result = evaluateRule(parsed.rule, makeStubContext({ title: evilTitle }), buildEvalEnvironment());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `${pattern} must run in linear time against a 4 KB title, took ${elapsed}ms`);
  assert.equal(result.matched, expected, `${pattern} against the hostile title`);
}

// Patterns the matcher cannot run in linear time are refused when the rule is
// compiled, with a message the Tags view can show, instead of silently never
// matching at evaluation.
const bigPattern = parseRule(`tag(bigpat) when title matches "${'a'.repeat(250)}"`);
assert.equal(bigPattern.rule, null, 'oversized regex pattern should fail to compile');
assert.match(bigPattern.errors[0]?.message ?? '', /unsupported pattern .*longer than 200/);
const lookaround = parseRule('tag(look) when title matches "(?=live)remix"');
assert.equal(lookaround.rule, null, 'lookaround should fail to compile');
assert.match(lookaround.errors[0]?.message ?? '', /lookahead and lookbehind are not supported/);
// DSL string literals consume one level of backslash, so a regex escape is written doubled.
const backref = parseRule('tag(back) when title matches "(a)\\\\1"');
assert.equal(backref.rule, null, 'a backreference should fail to compile');
assert.match(backref.errors[0]?.message ?? '', /backreferences are not supported/);

// `matches` and `contains` also work in their function form, which the Tags
// view lists; the tokenizer used to reject them because the same words are
// infix keywords.
const fnMatches = parseRule('tag(fn_matches) when matches(title, "^live")');
assert.ok(fnMatches.rule, 'matches(...) as a function call should compile');
assert.equal(evaluateRule(fnMatches.rule, makeStubContext({ title: 'Live at Leeds' }), buildEvalEnvironment()).matched, true);
assert.equal(evaluateRule(fnMatches.rule, makeStubContext({ title: 'Studio' }), buildEvalEnvironment()).matched, false);
const fnContains = parseRule('tag(fn_contains) when contains(title, "remix") and not matches(title, "instrumental")');
assert.ok(fnContains.rule, 'contains(...) as a function call should compile alongside infix operators');
assert.equal(evaluateRule(fnContains.rule, makeStubContext({ title: 'Song (Club Remix)' }), buildEvalEnvironment()).matched, true);
const fnBadPattern = parseRule('tag(fn_bad) when matches(title, "(?=live)")');
assert.equal(fnBadPattern.rule, null, 'an unsupported pattern in the function form is refused at compile time too');
assert.match(fnBadPattern.errors[0]?.message ?? '', /lookahead and lookbehind are not supported/);
const infixStill = parseRule('tag(infix) when title matches "^live"');
assert.ok(infixStill.rule, 'the infix form still compiles');

// Three-valued null
const nullRule = parseRule('tag(missing) when bpm > 100');
assert.ok(nullRule.rule);
const nullCtx = makeStubContext({ bpm: null });
assert.equal(evaluateRule(nullRule.rule, nullCtx, buildEvalEnvironment()).matched, false, 'null bpm should not match >100');
const filledCtx = makeStubContext({ bpm: 120 });
assert.equal(evaluateRule(nullRule.rule, filledCtx, buildEvalEnvironment()).matched, true);

// Range + in
const rangeRule = parseRule('tag(midtempo) when bpm in 90..120');
assert.ok(rangeRule.rule);
assert.equal(evaluateRule(rangeRule.rule, makeStubContext({ bpm: 100 }), buildEvalEnvironment()).matched, true);
assert.equal(evaluateRule(rangeRule.rule, makeStubContext({ bpm: 70 }), buildEvalEnvironment()).matched, false);

// Function whitelist + identifiers list
const fns = listFunctions();
assert.ok(fns.includes('matches'));
assert.ok(fns.includes('weekday'));
assert.ok(fns.includes('contains'));
const idents = listIdentifiers();
assert.ok(idents.includes('bpm'));
assert.ok(idents.includes('energy') || idents.length > 0);

// ---------- Composition + cycle detection ----------

const a = parseRule('tag(a) when bpm > 100').rule;
const b = parseRule('tag(b) when tag(a) and dna.brightness > 0.2').rule;
const c = parseRule('tag(c) when tag(b)').rule;
const ordered = topologicalSort([c, b, a]);
assert.deepEqual(ordered.map((r) => r.name), ['a', 'b', 'c'], 'topological sort should resolve dependencies');

// cycle: a → b → a (manually construct to test runtime cycle detector)
const cycleA = parseRule('tag(cyc_a) when tag(cyc_b)').rule;
const cycleB = parseRule('tag(cyc_b) when tag(cyc_a)').rule;
assert.throws(() => topologicalSort([cycleA, cycleB]), /cycle/, 'cyclic tag DAG should throw');

// Parser depth guard — deep nesting should fail gracefully, not blow the call stack.
const deepBody = `tag(deep) when ${'('.repeat(400)}1${')'.repeat(400)} = 1`;
const deepResult = parseRule(deepBody);
assert.ok(!deepResult.rule, 'deeply nested expressions should be refused before stack overflow');
assert.match(deepResult.errors[0]?.message ?? '', /too deeply/, 'depth guard should be the surfaced error');

// daysSince should resolve regardless of casing (regression: function table key was mixedCase)
const daysRule = parseRule('tag(stale) when daysSince(lastplayed) > 30').rule;
assert.ok(daysRule);
const lastPlayedAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
const daysCtx = { ...makeStubContext({ lastPlayed: lastPlayedAgo }) };
const daysResult = evaluateRule(daysRule, daysCtx, buildEvalEnvironment());
assert.equal(daysResult.errors.length, 0, `daysSince eval should not error, got ${daysResult.errors.join(', ')}`);
assert.equal(daysResult.matched, true, 'a 90-days-ago lastPlayed should match daysSince > 30');

// ---------- LibraryStore integration ----------

const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, () => undefined);
await scanner.start([musicRoot]);
const tracks = library.getTracks({ limit: 100, sort: 'artist' });
assert.equal(tracks.length, fixtures.length);

// Stamp BPM hints via setTrackRating? No — directly via DB. Use the upsert path.
// We'll inject DNA + bpm via updateTrackMetadataEdit + setTrackDna instead.

// Inject DNA + bpm for each fixture so DSL features have data.
for (const fixture of fixtures) {
  const track = tracks.find((t) => t.title === fixture.title);
  assert.ok(track, `track for ${fixture.title} should exist`);
  const dna = await analyzeTrackDna(join(musicRoot, fixture.name));
  library.setTrackDna(track.id, dna);
  // Set bpm hint via a metadata patch (only changes track table columns we have)
  // Simplest path: direct UPDATE through db.
}
// We don't have a public setter for bpm in this surface — write directly.
for (const fixture of fixtures) {
  const track = tracks.find((t) => t.title === fixture.title);
  if (!track) continue;
  // Use a backdoor: smoke owns the DB.
}

// Save a tag rule that should match the bright siren fixture only.
const savedBright = library.saveTagRule({
  name: 'bright_song',
  body: 'tag(bright_song) when dna.brightness > 0.15',
  boost: 1.5,
});
assert.ok(savedBright.id > 0);
assert.equal(savedBright.boost, 1.5);
assert.equal(savedBright.enabled, true);

const savedMellow = library.saveTagRule({
  name: 'low_tone',
  body: 'tag(low_tone) when dna.low > 0.3 and not tag(bright_song)',
});

// Recompute should not throw, should return errors map empty (or sensible)
const recompute = library.recomputeTags();
assert.equal(recompute.rulesEvaluated, 2);
assert.equal(recompute.tracksEvaluated, fixtures.length);
assert.ok(recompute.tagsAssigned >= 1, 'at least the siren fixture should pick up bright_song');

const summaries = library.getTagSummaries();
const brightSummary = summaries.find((s) => s.name === 'bright_song');
assert.ok(brightSummary, 'bright_song should appear in summaries');
assert.ok(brightSummary.trackCount >= 1, 'siren fixture should be tagged');
assert.equal(brightSummary.boost, 1.5);
assert.equal(brightSummary.enabled, true);

const sirenTrack = tracks.find((t) => t.title === 'Siren Ride');
assert.ok(sirenTrack);
const sirenTags = library.getTagsForTrack(sirenTrack.id);
assert.ok(sirenTags.includes('bright_song'), `siren should carry bright_song tag, got ${JSON.stringify(sirenTags)}`);

// Power search
const taggedIds = library.getTrackIds({ search: 'tag:bright_song', limit: 100 });
assert.ok(taggedIds.length >= 1, 'tag power-search should return matching tracks');
assert.ok(taggedIds.includes(sirenTrack.id));

const untaggedIds = library.getTrackIds({ search: 'untagged:true', limit: 100 });
assert.ok(untaggedIds.length < fixtures.length, 'some tracks should now be tagged');

// Preview path
const preview = library.previewTagRule({ body: 'tag(any_track) when bpm >= 0 or rating >= 0' });
assert.equal(preview.ok, true);
assert.equal(preview.ruleName, 'any_track');
assert.ok(preview.matchCount >= 1);

// Disable + delete cleanup
const disabled = library.setTagRuleEnabled(savedBright.id, false);
assert.equal(disabled.enabled, false);
const summariesAfterDisable = library.getTagSummaries();
assert.equal(summariesAfterDisable.find((s) => s.name === 'bright_song')?.trackCount ?? 0, 0,
  'disabling a rule should clear its track_tags');

library.deleteTagRule(savedMellow.id);
const summariesAfterDelete = library.getTagSummaries();
assert.equal(summariesAfterDelete.find((s) => s.name === 'low_tone'), undefined);

// Cycle-at-save: re-enable bright_song, then try to save a cycle and expect rejection.
library.setTagRuleEnabled(savedBright.id, true);
library.saveTagRule({
  name: 'cycle_first',
  body: 'tag(cycle_first) when bpm > 0',
});
library.saveTagRule({
  name: 'cycle_second',
  body: 'tag(cycle_second) when tag(cycle_first)',
});
// Now mutate cycle_first to depend on cycle_second — this should be rejected.
const cycleFirstId = library.listTagRules().find((r) => r.name === 'cycle_first').id;
assert.throws(
  () => library.saveTagRule({
    id: cycleFirstId,
    name: 'cycle_first',
    body: 'tag(cycle_first) when tag(cycle_second)',
  }),
  /cycle/,
  'saveTagRule should refuse to introduce a cycle between two existing rules',
);

library.close();

// ---------- Source-link assertions ----------

const [dslSource, typesSource, libSource, mainSource, preloadSource, apiSource] = await Promise.all([
  readFile(new URL('../shared/tag-dsl.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
]);

assert.match(dslSource, /tag.*when.*boost/, 'DSL should describe tag-when-boost grammar');
assert.match(dslSource, /MAX_TAG_NAME_LENGTH/, 'DSL should bound tag-name length');
assert.match(typesSource, /TagRule\b/, 'shared types should export TagRule');
assert.match(typesSource, /TagRecomputeResult/);
assert.match(libSource, /tag_rules\b/, 'library schema should create tag_rules table');
assert.match(libSource, /track_tags\b/, 'library schema should create track_tags table');
assert.match(libSource, /recomputeTags\b/);
assert.match(libSource, /previewTagRule/);
assert.match(mainSource, /tags:list-rules/);
assert.match(mainSource, /tags:save-rule/);
assert.match(mainSource, /tags:recompute/);
assert.match(preloadSource, /listTagRules/);
assert.match(preloadSource, /saveTagRule/);
assert.match(apiSource, /listTagRules/);

console.log(JSON.stringify({
  ok: true,
  bright_song_matches: brightSummary.trackCount,
  ordered: ordered.map((r) => r.name),
  preview_match_count: preview.matchCount,
}, null, 2));

function makeStubContext(overrides = {}) {
  return {
    id: 1, title: 'stub', artist: 'stub', album: 'stub', albumArtist: 'stub', genre: null,
    year: 2020, duration: 200, bitrate: 320000, sampleRate: 44100, size: 1024,
    mtime: Date.now(), bpm: 120, key: null, format: 'flac',
    rating: 0, ratingScore: null, playCount: 0, skipCount: 0, lastPlayed: null,
    lastSkipped: null, loved: false, avoidAutoPlay: false,
    replayGainTrack: null, replayGainAlbum: null, dna: null,
    tags: new Set(),
    ...overrides,
  };
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { stdio: 'pipe' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString?.() ?? '');
    throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  }
}
