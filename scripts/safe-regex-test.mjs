// shared/safe-regex.ts is the matcher behind the Living Tags `matches`
// operator. These checks pin three things: the supported grammar matches the
// way RegExp would, everything outside the grammar is rejected with a stable
// error code, and the classic catastrophic-backtracking shapes run in
// milliseconds against a 4 KB input — which is the whole reason it exists.
// Run with: npm run test:safe-regex
import assert from 'node:assert/strict';
import { SafeRegex, SafeRegexError } from '../dist-electron/shared/safe-regex.js';

const yes = (p, s) => assert.equal(SafeRegex.compile(p).test(s), true, `${p} should match ${JSON.stringify(s)}`);
const no = (p, s) => assert.equal(SafeRegex.compile(p).test(s), false, `${p} should NOT match ${JSON.stringify(s)}`);
const rejects = (p, code) => {
  try {
    SafeRegex.compile(p);
    assert.fail(`${p} should be rejected`);
  } catch (err) {
    assert.ok(err instanceof SafeRegexError, `${p}: expected SafeRegexError, got ${err}`);
    assert.equal(err.code, code, `${p} should be rejected as ${code}`);
  }
};

// Literals, anchors, case-insensitivity, unanchored search.
yes('live', 'Live at Wembley'); yes('LIVE', 'live'); no('live', 'Studio');
yes('^live', 'live x'); no('^live', 'x live'); yes('x$', 'live x'); no('live$', 'live x');
yes('l.ve', 'lIve'); no('l.ve', 'l\nve'); yes('re-?mix', 'remix'); yes('re-?mix', 'Re-Mix');

// Alternation and groups.
yes('rock|metal', 'Heavy Metal'); yes('^(rock|metal)$', 'ROCK'); no('^(rock|metal)$', 'rockabilly');
yes('(?:ab)+c', 'xxababc'); no('(?:ab)+c', 'ac'); yes('(a|b)*c', 'ababc'); yes('(|a)b', 'b'); yes('(a|)b', 'ab');
yes('(?<pet>cat|dog)', 'my DOG'); yes('(?<pet>cat|dog)s', 'cats');

// Quantifiers, including literal braces that are not quantifiers.
yes('a*', ''); yes('a{2}', 'baab'); no('a{3}', 'baab'); yes('a{2,}', 'aaaa'); yes('a{1,3}b', 'aab');
no('^a{1,3}b', 'aaaab'); yes('x{', 'x{'); yes('a{,3}', 'a{,3}');

// Classes and shorthands.
yes('[abc]+', 'zzcz'); no('[abc]', 'xyz'); yes('[^abc]', 'abcd'); no('[^abc]', 'ABC'); yes('[a-c]', 'B');
yes('[\\d]+', 'track 12'); yes('\\d{4}', 'year 1994'); no('\\d{4}', 'year 94'); yes('\\w+\\s\\w+', 'two words');
yes('[\\]]', 'a]'); yes('[\\-a]', '-'); yes('[a\\-z]', '-'); no('[a\\-z]', 'm'); yes('[\\w.-]+@', 'me.x-y@');

// Word boundaries and escapes that show up in real tag rules.
yes('\\bremix\\b', 'the remix edit'); no('\\bmix\\b', 'remixed');
yes('\\.flac$', 'song.FLAC'); no('\\.flac$', 'songxflac');
yes('\\\\Compilations\\\\', 'K:\\Compilations\\x'); yes('\\/live\\/', '/live/'); yes('\\[live\\]', 'Song [Live]');
yes('é', 'café'); no('é', 'cafe');

// The pattern that hung the main process before this matcher existed.
yes('.*.*.*=', 'a=b'); no('.*.*.*=', 'aaaa');

// Everything outside the grammar is refused with a named reason.
rejects('', 'empty'); rejects('a'.repeat(201), 'too-long');
rejects('(a', 'syntax'); rejects('a)', 'syntax'); rejects('*a', 'syntax'); rejects('[a', 'syntax');
rejects('[z-a]', 'syntax'); rejects('^*', 'syntax'); rejects('a{3,1}', 'syntax'); rejects('(?<n', 'syntax');
rejects('a*?', 'unsupported'); rejects('a++', 'unsupported'); rejects('(?=a)', 'unsupported'); rejects('(?!a)', 'unsupported');
rejects('(?<=a)', 'unsupported'); rejects('(?<!a)', 'unsupported'); rejects('(?i:a)', 'unsupported');
rejects('(a)\\1', 'unsupported'); rejects('\\B', 'unsupported'); rejects('\\p{L}', 'unsupported'); rejects('\\x41', 'unsupported');
rejects('a{65}', 'repeat-too-large'); rejects('a{1,999}', 'repeat-too-large'); rejects('((a{64}){64}){64}', 'too-complex');

// Linear time: every classic ReDoS shape against a 4 KB input built to make a
// backtracking engine explode ((\w+\s?)*$ legitimately matches it; the rest do not).
const hostile = 'a'.repeat(4096) + '!';
const timings = {};
for (const pattern of ['(a+)+$', '(a*)*b', '(a|a)*b', '(a|aa)+$', '.*.*.*.*=', '(.*a){20}$', '(\\w+\\s?)*$', '(a{1,16}){1,16}$']) {
  const re = SafeRegex.compile(pattern);
  const started = performance.now();
  for (let i = 0; i < 5; i++) re.test(hostile);
  const ms = (performance.now() - started) / 5;
  timings[pattern] = Number(ms.toFixed(2));
  assert.ok(ms < 150, `${pattern} took ${ms.toFixed(1)} ms against a 4 KB input`);
}

console.log(JSON.stringify({ ok: true, hostileInputMs: timings }, null, 2));
