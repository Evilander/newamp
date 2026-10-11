// Visual phases must be integrated, never read as a clock times an audio level.
//
// A shader that moves with `u_time * (0.6 + u_bass)` is fine in the first
// seconds. The phase it computes is the clock times the speed, so every change
// in the speed moves the phase by the clock times that change: an hour in, a
// 0.05 step in the bass moves it by ~170 rad in one frame and the picture
// re-randomises every frame. The same holds for `Date.now() * level` in
// canvas code, where the clock is 1.7e9 seconds from the start. Speed-ups
// have to be integrated (`phase += dt * speed`) and the integral used instead.
//
// This reads the GLSL in the visualizer sources and the TypeScript that drives
// the canvas modes, tracks which values carry a clock (uptime, rAF timestamps,
// Date.now(), integrated phases) and which carry an audio level, and reports
// every product of one with the other. Calls to periodic or bounded functions
// (sin, fract, hash...) end a clock: `sin(clock) * level` is an amplitude, not
// a phase. A short run of fixtures first proves the check catches the defects
// it exists for and leaves the integrated forms alone.
// Run: node scripts/viz-phase-lint-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// ── GLSL ─────────────────────────────────────────────────────────────────────

const GLSL_CLOCK = /^(u_time|u_globalTime|u_bassTime|u_midTime|u_beatTime|u_bandTime\d*)$/;
const GLSL_AUDIO = /^(u_bass|u_lowMid|u_mid|u_treble|u_rms|u_beat|u_kick|u_energy|u_level|u_bands\d*)$/;
const GLSL_CLOCK_CALLS = new Set(['bandTimeAt']);
const GLSL_AUDIO_CALLS = new Set(['bandAt']);
// Calls that keep a clock a clock; every other call returns something bounded.
const GLSL_CLOCK_PASS = new Set(['abs', 'float', 'vec2', 'vec3', 'vec4', 'min', 'max']);
const GLSL_TYPES = new Set(['void', 'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'mat2', 'mat3', 'mat4']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=']);

function tokenize(src) {
  const tokens = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|([A-Za-z_]\w*)|(\d+\.?\d*(?:[eE][+-]?\d+)?[fF]?|\.\d+(?:[eE][+-]?\d+)?[fF]?)|(<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|[-+*/%<>=!?:;,.(){}\[\]])|(\s+)|([\s\S])/g;
  let line = 1;
  for (let m; (m = re.exec(src));) {
    const text = m[0];
    if (m[1]) tokens.push({ t: 'id', v: m[1], line });
    else if (m[2]) tokens.push({ t: 'num', v: m[2], line });
    else if (m[3]) tokens.push({ t: 'op', v: m[3], line });
    else if (m[5]) throw new Error(`unexpected character ${JSON.stringify(m[5])} on line ${line}`);
    line += text.split('\n').length - 1;
  }
  return tokens;
}

// One statement is the tokens up to a ';' or a brace outside parentheses.
function statements(tokens) {
  const out = [];
  let current = [];
  let depth = 0;
  const flush = () => { if (current.length) out.push(current); current = []; };
  for (const tok of tokens) {
    if (tok.t === 'op' && tok.v === '(') depth += 1;
    if (tok.t === 'op' && tok.v === ')') depth -= 1;
    if (depth === 0 && tok.t === 'op' && (tok.v === ';' || tok.v === '{' || tok.v === '}')) { flush(); continue; }
    current.push(tok);
  }
  flush();
  return out;
}

const BINARY_LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];

function parseGlslExpression(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  function ternary() {
    const cond = binary(0);
    if (!isOp('?')) return cond;
    i += 1;
    const a = ternary();
    if (!isOp(':')) throw new Error('expected ":"');
    i += 1;
    const b = ternary();
    return { k: 'tern', parts: [cond, a, b], line: cond.line };
  }
  function binary(level) {
    if (level >= BINARY_LEVELS.length) return unary();
    let left = binary(level + 1);
    while (peek()?.t === 'op' && BINARY_LEVELS[level].includes(peek().v)) {
      const op = tokens[i++];
      const right = binary(level + 1);
      left = { k: 'bin', op: op.v, l: left, r: right, line: op.line };
    }
    return left;
  }
  function unary() {
    if (peek()?.t === 'op' && ['-', '+', '!'].includes(peek().v)) {
      const op = tokens[i++];
      return { k: 'un', x: unary(), line: op.line };
    }
    return postfix();
  }
  function postfix() {
    let node = primary();
    for (;;) {
      if (isOp('.')) {
        i += 1;
        i += 1; // swizzle or member name
        node = { k: 'un', x: node, line: node.line };
      } else if (isOp('[')) {
        i += 1;
        ternary();
        if (!isOp(']')) throw new Error('expected "]"');
        i += 1;
        node = { k: 'un', x: node, line: node.line };
      } else break;
    }
    return node;
  }
  function primary() {
    const tok = tokens[i++];
    if (!tok) throw new Error('unexpected end of expression');
    if (tok.t === 'num') return { k: 'num', line: tok.line };
    if (tok.t === 'op' && tok.v === '(') {
      const inner = ternary();
      if (!isOp(')')) throw new Error('expected ")"');
      i += 1;
      return inner;
    }
    if (tok.t === 'id') {
      if (isOp('(')) {
        i += 1;
        const args = [];
        while (!isOp(')')) {
          args.push(ternary());
          if (isOp(',')) i += 1;
          else if (!isOp(')')) throw new Error('expected "," or ")"');
        }
        i += 1;
        return { k: 'call', name: tok.v, args, line: tok.line };
      }
      return { k: 'id', name: tok.v, line: tok.line };
    }
    throw new Error(`unexpected "${tok.v}" on line ${tok.line}`);
  }
  const node = ternary();
  return { node, rest: tokens.slice(i) };
}

const none = () => ({ clock: false, audio: false });
const union = (...parts) => ({ clock: parts.some((p) => p.clock), audio: parts.some((p) => p.audio) });

// Walks one GLSL expression; `report` gets every product of a clock and a level.
function classifyGlsl(node, env, report) {
  switch (node.k) {
    case 'num': return none();
    case 'id':
      if (env.has(node.name)) return env.get(node.name);
      return { clock: GLSL_CLOCK.test(node.name), audio: GLSL_AUDIO.test(node.name) };
    case 'un': return classifyGlsl(node.x, env, report);
    case 'tern': return union(...node.parts.map((p) => classifyGlsl(p, env, report)));
    case 'call': {
      const args = node.args.map((a) => classifyGlsl(a, env, report));
      const any = union(...args);
      return {
        clock: GLSL_CLOCK_CALLS.has(node.name) || (GLSL_CLOCK_PASS.has(node.name) && any.clock),
        audio: GLSL_AUDIO_CALLS.has(node.name) || any.audio,
      };
    }
    case 'bin': {
      const l = classifyGlsl(node.l, env, report);
      const r = classifyGlsl(node.r, env, report);
      if (node.op === '*' || node.op === '/' || node.op === '%') {
        if ((l.clock && r.audio) || (l.audio && r.clock)) report(node.line);
        return union(l, r);
      }
      if (node.op === '-' && l.clock && r.clock) return { clock: false, audio: l.audio || r.audio };
      if (node.op === '+' || node.op === '-') return union(l, r);
      return none();
    }
    default: return none();
  }
}

/** Hits (line numbers within `src`) where a GLSL source multiplies a clock by an audio level. */
export function lintGlsl(src) {
  const hits = [];
  const report = (line) => { if (!hits.includes(line)) hits.push(line); };
  const env = new Map();
  for (const tokens of statements(tokenize(src))) {
    let body = tokens;
    while (body[0]?.t === 'id' && body[0].v === 'else') body = body.slice(1);
    const head = body[0];
    if (!head || head.t !== 'id') continue;
    if (['if', 'for', 'while', 'uniform', 'precision', 'in', 'out', 'varying', 'attribute', 'break', 'continue', 'discard'].includes(head.v)) continue;
    let start = 0;
    let declared = false;
    if (head.v === 'return') start = 1;
    else {
      while (body[start]?.t === 'id' && (body[start].v === 'const' || GLSL_TYPES.has(body[start].v))) { declared = true; start += 1; }
      // A function header: a type, a name and a parameter list.
      if (declared && body[start]?.t === 'id' && body[start + 1]?.v === '(') continue;
    }
    // Only the first declarator of a statement is read; the rest are rare here.
    const rest = body.slice(start);
    let target = null;
    let op = null;
    let exprTokens = rest;
    if (rest[0]?.t === 'id') {
      let j = 1;
      // Swizzles and indices on the target keep the same variable.
      while (rest[j]?.v === '.' && rest[j + 1]?.t === 'id') j += 2;
      if (rest[j]?.t === 'op' && ASSIGN_OPS.has(rest[j].v)) {
        target = rest[0].v;
        op = rest[j].v;
        exprTokens = rest.slice(j + 1);
      }
    }
    let parsed;
    try {
      parsed = parseGlslExpression(exprTokens);
    } catch {
      continue;
    }
    const value = classifyGlsl(parsed.node, env, report);
    if (!target) continue;
    const previous = env.get(target) ?? { clock: GLSL_CLOCK.test(target), audio: GLSL_AUDIO.test(target) };
    if (op === '=') env.set(target, value);
    else {
      if ((op === '*=' || op === '/=') && ((previous.clock && value.audio) || (previous.audio && value.clock))) report(rest[0].line);
      env.set(target, op === '-=' || op === '+=' || op === '*=' || op === '/=' ? union(previous, value) : value);
    }
  }
  return hits;
}

/// ── TypeScript ───────────────────────────────────────────────────────────────

// Names that carry a clock or a level when nothing in the code says otherwise:
// parameters (the animation-frame timestamp) and values from outside the file.
const JS_CLOCK_NAMES = /^(now|timestamp|uptime|time|clock)$/;
const JS_AUDIO_NAMES = /^(bass|lowMid|mid|treble|rms|beat|beatBoost|kick|energy|level|loudness|onset|spectrum|freq|onsetFreq|wave|bands)$/;
// A variable named for what it accumulates is a growing time, however it is fed.
const JS_TIME_SUFFIX = /[a-z0-9](Time|Clock)$/;
const JS_AUDIO_OBJECTS = new Set(['features', 'f', 'frame', 'rawFrame', 'tuned', 'analysis']);
const JS_AUDIO_CALLS = new Set(['avg', 'bandValue', 'waveRms']);
const JS_CLOCK_PASS = new Set(['Math.abs', 'Math.max', 'Math.min', 'Number']);

function callName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
  if (ts.isPropertyAccessExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
    return `${e.expression.expression.text}.${e.expression.name.text}.${e.name.text}`;
  }
  return '';
}

const isScope = (n) =>
  ts.isBlock(n) || ts.isSourceFile(n) || ts.isFunctionLike(n) || ts.isForStatement(n) || ts.isForOfStatement(n) ||
  ts.isForInStatement(n) || ts.isCaseBlock(n) || ts.isModuleBlock(n);

function scopeOf(node) {
  for (let p = node.parent; p; p = p.parent) if (isScope(p)) return p;
  return null;
}

// Where `name` is declared as seen from `node`, or null for a global.
function declaringScope(node, name, declared) {
  for (let s = isScope(node) ? node : scopeOf(node); s; s = scopeOf(s)) {
    if (declared.get(s)?.has(name)) return s;
  }
  return null;
}

function classifyJs(node, ctx, report) {
  const { sf, env, declared } = ctx;
  const line = () => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const go = (n) => classifyJs(n, ctx, report);
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return go(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) return go(node.operand);
  if (ts.isNumericLiteral(node) || ts.isStringLiteralLike(node)) return none();
  if (ts.isIdentifier(node)) {
    const scope = declaringScope(node, node.text, declared);
    const kind = scope ? declared.get(scope).get(node.text) : 'global';
    if (kind === 'var') {
      const flow = env.get(scope)?.get(node.text) ?? none();
      return { clock: flow.clock || JS_TIME_SUFFIX.test(node.text), audio: flow.audio };
    }
    return { clock: JS_CLOCK_NAMES.test(node.text) || JS_TIME_SUFFIX.test(node.text), audio: JS_AUDIO_NAMES.test(node.text) };
  }
  if (ts.isPropertyAccessExpression(node)) {
    let root = node.expression;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
    return { clock: false, audio: ts.isIdentifier(root) && JS_AUDIO_OBJECTS.has(root.text) };
  }
  if (ts.isElementAccessExpression(node)) {
    go(node.argumentExpression);
    return { clock: false, audio: ts.isIdentifier(node.expression) && JS_AUDIO_NAMES.test(node.expression.text) };
  }
  if (ts.isCallExpression(node)) {
    const name = callName(node);
    const args = node.arguments.map(go);
    if (/^(Date\.now|(window\.)?performance\.now)$/.test(name)) return { clock: true, audio: false };
    const any = union(...args);
    return { clock: JS_CLOCK_PASS.has(name) && any.clock, audio: JS_AUDIO_CALLS.has(name) || any.audio };
  }
  if (ts.isConditionalExpression(node)) {
    go(node.condition);
    return union(go(node.whenTrue), go(node.whenFalse));
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const l = go(node.left);
    const r = go(node.right);
    if (op === ts.SyntaxKind.AsteriskToken || op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.PercentToken) {
      if ((l.clock && r.audio) || (l.audio && r.clock)) report(line());
      return union(l, r);
    }
    if (op === ts.SyntaxKind.MinusToken && l.clock && r.clock) return { clock: false, audio: l.audio || r.audio };
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken) return union(l, r);
    return none();
  }
  return none();
}

/** Hits (line numbers) where TypeScript multiplies a clock by an audio level. */
export function lintTs(source, fileName = 'file.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Variables are tracked per scope, so a name reused in another branch is
  // another variable; what one holds is the union over everything assigned to
  // it (a loop reads it before the assignment further down).
  const declared = new Map();
  const declare = (scope, name, kind) => {
    if (!declared.has(scope)) declared.set(scope, new Map());
    declared.get(scope).set(name, kind);
  };
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  walk(sf, (node) => {
    if (ts.isFunctionLike(node)) for (const p of node.parameters ?? []) if (ts.isIdentifier(p.name)) declare(node, p.name.text, 'param');
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declare(scopeOf(node), node.name.text, 'var');
  });
  const assignments = [];
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      assignments.push({ scope: scopeOf(node), name: node.name.text, expr: node.initializer });
    }
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
      const k = node.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.PlusEqualsToken || k === ts.SyntaxKind.MinusEqualsToken) {
        const scope = declaringScope(node, node.left.text, declared);
        if (scope) assignments.push({ scope, name: node.left.text, expr: node.right });
      }
    }
  });
  // Each pass reads the previous one, so a difference of two clocks (a frame
  // delta) is seen as one once both ends are known to hold a clock.
  let env = new Map();
  for (let pass = 0; pass < 6; pass += 1) {
    const next = new Map();
    for (const { scope, name, expr } of assignments) {
      if (!next.has(scope)) next.set(scope, new Map());
      const into = next.get(scope);
      into.set(name, union(into.get(name) ?? none(), classifyJs(expr, { sf, env, declared }, () => {})));
    }
    env = next;
  }
  const ctx = { sf, env, declared };
  const hits = [];
  const report = (line) => { if (!hits.includes(line)) hits.push(line); };
  walk(sf, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    const k = node.operatorToken.kind;
    if (k === ts.SyntaxKind.AsteriskToken || k === ts.SyntaxKind.SlashToken || k === ts.SyntaxKind.PercentToken) classifyJs(node, ctx, report);
    if (k === ts.SyntaxKind.AsteriskEqualsToken || k === ts.SyntaxKind.SlashEqualsToken) {
      const l = classifyJs(node.left, ctx, report);
      const r = classifyJs(node.right, ctx, report);
      if ((l.clock && r.audio) || (l.audio && r.clock)) report(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
  });
  return hits;
}

/** Template literals and strings in a TypeScript file that hold a fragment shader. */
export function glslSources(source, fileName = 'file.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const found = [];
  const visit = (node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      if (/void\s+main\s*\(/.test(node.text)) found.push({ text: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    } else if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((s) => `0${s.literal.text}`).join('');
      if (/void\s+main\s*\(/.test(text)) found.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ── Fixtures: the defects this exists for, and the forms that replace them ───

const glslHits = (body) => lintGlsl(`void main() {\n${body}\n}`);

// The five shader lines that jittered, as they were.
for (const [name, line] of [
  ['neon waves', 'float xphase = uv.x * 5.0 + u_time * (0.74 + b * 0.95);'],
  ['burning cloud', 'float heat = fbm(q + vec2(0.0, -u_time * (0.38 + u_bass)));'],
  ['kaleido spin', 'float a = mod(theta + u_time * (0.12 + u_mid * 0.6), sector);'],
  ['aurora ribbons', 'float xphase = uv.x * 3.0 + u_time * (0.62 + b * 1.4) + wind;'],
  ['starfield warp', 'float warp = u_time * (0.6 + u_bass * 1.4 + u_beat * 0.8);'],
]) {
  const hits = glslHits(`float b = bandAt(0.5);\n${line}`);
  assert.ok(hits.length > 0, `${name}: the clock times a level was not reported`);
}
// The same, reached through a variable on either side.
assert.ok(glslHits('float speed = 0.6 + u_bass;\nfloat warp = u_time * speed;').length > 0, 'a speed held in a variable');
assert.ok(glslHits('float t = u_time * 0.5;\nfloat warp = t * (1.0 + u_beat);').length > 0, 'a scaled clock held in a variable');
assert.ok(glslHits('float warp = (u_bass + 1.0) * u_time;').length > 0, 'the level on the left');
assert.ok(glslHits('float warp = u_time;\nwarp *= 1.0 + u_bass;').length > 0, 'a compound product');
// An integrated phase times a level is the same defect, one step removed.
assert.ok(glslHits('float warp = u_bassTime * (1.0 + u_beat);').length > 0, 'an integral times a level');

// The integrated forms and the amplitude modulation that are fine.
for (const [name, body] of [
  ['phase added to the clock', 'float b = bandAt(0.5);\nfloat xphase = uv.x * 5.0 + u_time * 0.74 + bandTimeAt(0.5) * 0.95;'],
  ['integral uniforms', 'float warp = u_time * 0.6 + u_bassTime * 1.4 + u_beatTime * 0.8;'],
  ['level added to a clock', 'float halo = fract(u_time * 0.55 + u_beat);'],
  ['a level inside the periodic function', 'float y = sin(u_time * 0.65 + u_bass * 4.0) * (0.018 + u_bass * 0.075);'],
  ['amplitude from a periodic clock', 'float wave = sin(u_time * 1.2) * (0.04 + u_bass * 0.09);'],
  ['a level scaling a position', 'vec2 q = uv * (3.0 + u_mid * 4.0) + vec2(u_time * 0.22, -u_time * 0.16);\nfloat plasma = fbm(q);'],
  ['a hash of the clock', 'float bolt = hash(vec2(floor(u_time * 4.0), 1.0));'],
  ['a clock difference', 'float dt = u_time - u_time;\nfloat step1 = dt * u_bass;'],
]) {
  assert.deepEqual(glslHits(body), [], `${name} was reported`);
}

const tsHits = (body) => lintTs(`function frame(now: number) {\n${body}\n}`);

// Confetti as it was: epoch seconds times the beat envelope.
assert.ok(tsHits('const time = Date.now() / 1000;\nconst angle = time * (0.35 + lane + beatBoost * 0.6) + i * 2.399;').length > 0, 'Date.now() times a beat envelope');
assert.ok(tsHits('const angle = (now / 1000) * features.beat;').length > 0, 'a timestamp times a feature');
assert.ok(tsHits('const t = performance.now();\nconst a = t * (1 + features.bass);').length > 0, 'performance.now() times a feature');
assert.ok(tsHits('const a = Math.sin(Date.now() / 100 * bass);').length > 0, 'a clock times a level inside sin()');
assert.ok(tsHits('let bassTime = 0;\nbassTime *= 1 + features.beat;').length > 0, 'an accumulated time scaled by a level');
assert.ok(tsHits('let spin = 0;\nspin += dt;\nconst a = spinTime * features.bass;').length > 0, 'a name that says it is a time');

for (const [name, body] of [
  ['integrated angle', 'confettiTime += dt;\nconfettiBeatTime += dt * beatBoost;\nconst angle = confettiTime * (0.35 + lane) + confettiBeatTime * 0.6 + i * 2.399;'],
  ['frame delta times a level', 'let lastNow = 0;\nconst dt = lastNow ? (now - lastNow) / 1000 : 1 / 60;\nlastNow = now;\nconst step = dt * features.beat;'],
  ['periodic clock as an amplitude', 'const y = h / 2 + Math.sin(x / 28 + now / 140) * (18 + mid * 70);'],
  ['clock added to a level', 'const hue = (i * 5.4 + now / 80 + bass * 110) % 360;'],
  ['level times a constant', 'const size = 2 + bin * 13 + features.beat * 8;'],
  ['elapsed since a mark times a constant', 'const held = (now - markedAt) * 0.001;\nmarkedAt = now;'],
]) {
  assert.deepEqual(tsHits(body), [], `${name} was reported`);
}

// A shader template with a substitution still reads.
{
  const found = glslSources('const f = `void main() {\n float w = u_time * (1.0 + u_bass) + ${"${x}"};\n}`;');
  assert.equal(found.length, 1);
  assert.ok(lintGlsl(found[0].text).length > 0);
}

// ── The visualizer sources ───────────────────────────────────────────────────

// Paths on the command line replace the default list.
const FILES = process.argv.length > 2 ? process.argv.slice(2) : [
  'src/components/Visualizer.tsx',
  'src/components/WrappedLiveExport.tsx',
  'src/lib/pacedFrame.ts',
  'src/visualizer/eviland-producer.ts',
  'src/visualizer/viz-features.ts',
  'src/visualizer/particle-flow.ts',
  'src/visualizer/reactor-overlay.ts',
  'src/visualizer/wrapped-live-scene.ts',
  'src/butterchurn-iframe/main.ts',
  'src/butterchurn-iframe/feed.ts',
];

const failures = [];
let shaders = 0;
for (const file of FILES) {
  const source = readFileSync(file, 'utf8');
  for (const line of lintTs(source, file)) failures.push(`${file}:${line}: a clock is multiplied by an audio level`);
  for (const shader of glslSources(source, file)) {
    shaders += 1;
    for (const line of lintGlsl(shader.text)) failures.push(`${file}:${shader.line + line - 1}: shader multiplies a clock by an audio level`);
  }
}
assert.ok(shaders >= 1, 'no shader was found to check; the extraction is out of date');
assert.deepEqual(failures, [], `visual phases computed as a clock times an audio level:\n  ${failures.join('\n  ')}`);

console.log('[viz-phase-lint-test] PASS');
