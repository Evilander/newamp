// Scene clock contract. A scene may not multiply a growing clock (u_globalTime,
// u_time, u_phase, the energy/pan/band integrals) by anything that follows the
// audio: once a track has been playing a while, a small change in the audio
// moves the animation by many seconds in a single frame. Scenes declare a
// `speed` and animate with u_phase instead.
//
// The check parses each scene's GLSL, tracks which variables hold a clock, which
// hold an audio-derived scalar and which vary with the pixel position, and
// reports every product of a clock and an audio scalar. A value that depends on
// both audio and position (a hash of a cell id on a grid that breathes with the
// bass, say) is a spatial field, not a rate, and is left alone.
// Run: node scripts/eviland-scene-clock-test.mjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/eviland-scene-clock-bundle.mjs');
await build({
  entryPoints: [resolve('src/visualizer/scenes/index.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
});
const { SCENES } = await import(pathToFileURL(outfile).href);
const overlayOut = resolve('tmp/eviland-scene-clock-overlay-bundle.mjs');
await build({
  entryPoints: [resolve('src/visualizer/scene-overlay.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: overlayOut, logLevel: 'silent',
});
const { CLOCK_WRAP_SECONDS } = await import(pathToFileURL(overlayOut).href);

const CLOCKS = new Set(['u_globalTime', 'u_time', 'u_phase', 'u_energyTime', 'u_panTime', 'u_bandTime']);
const AUDIO = new Set([
  'u_energy', 'u_kick', 'u_bass', 'u_snare', 'u_hat', 'u_vocal',
  'u_kickPulse', 'u_snarePulse', 'u_hatPulse', 'u_vocalPulse', 'u_kickCount',
  'u_centroid', 'u_flatness', 'u_crest', 'u_beatPhase', 'u_beatConf',
  'u_novelty', 'u_pan', 'u_width', 'u_bands',
]);
const AUDIO_CALLS = new Set(['bandAvg']);
const CLOCK_CALLS = new Set(['bandClock']);
// Calls whose result keeps the clock in it; every other call (sin, fract, hash,
// noise, user functions...) returns something bounded.
const PASS_THROUGH = new Set([
  'abs', 'min', 'max', 'clamp', 'mix', 'float', 'int', 'uint',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'mat2', 'mat3', 'mat4',
]);
const TYPES = new Set([
  'void', 'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'mat2', 'mat3', 'mat4', 'bvec2', 'bvec3', 'bvec4',
]);
const QUALIFIERS = new Set(['const', 'in', 'out', 'inout', 'highp', 'mediump', 'lowp']);

function tokenize(src) {
  const tokens = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|([A-Za-z_]\w*)|(\d+\.?\d*(?:[eE][+-]?\d+)?[fF]?|\.\d+(?:[eE][+-]?\d+)?[fF]?)|(<=|>=|==|!=|&&|\|\||\^\^|\+=|-=|\*=|\/=|\+\+|--|[-+*/%<>=!?:;,.(){}\[\]&|^~])|(\s+)|([\s\S])/g;
  for (let m; (m = re.exec(src));) {
    if (m[1]) tokens.push({ t: 'id', v: m[1], s: m.index, e: re.lastIndex });
    else if (m[2]) tokens.push({ t: 'num', v: m[2], s: m.index, e: re.lastIndex });
    else if (m[3]) tokens.push({ t: 'op', v: m[3], s: m.index, e: re.lastIndex });
    else if (m[5]) throw new Error(`unexpected character ${JSON.stringify(m[5])} at ${m.index}`);
  }
  return tokens;
}

const BINARY = [
  ['||'], ['^^'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%'],
];
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=']);

function parseProgram(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = (o = 0) => tokens[i + o];
  const isOp = (v, o = 0) => peek(o)?.t === 'op' && peek(o).v === v;
  const expectOp = (v) => {
    if (!isOp(v)) throw new Error(`expected '${v}' near ${JSON.stringify(src.slice(peek()?.s ?? 0, (peek()?.s ?? 0) + 30))}`);
    return tokens[i++];
  };

  function parseExpr() { return parseAssign(); }
  function parseAssign() {
    const left = parseTernary();
    if (peek()?.t === 'op' && ASSIGN.has(peek().v)) {
      const op = tokens[i++].v;
      const right = parseAssign();
      return { k: 'assign', op, l: left, r: right, s: left.s, e: right.e };
    }
    return left;
  }
  function parseTernary() {
    const c = parseBinary(0);
    if (isOp('?')) {
      i++;
      const a = parseAssign();
      expectOp(':');
      const b = parseAssign();
      return { k: 'tern', c, a, b, s: c.s, e: b.e };
    }
    return c;
  }
  function parseBinary(level) {
    if (level >= BINARY.length) return parseUnary();
    let left = parseBinary(level + 1);
    while (peek()?.t === 'op' && BINARY[level].includes(peek().v)) {
      const op = tokens[i++].v;
      const right = parseBinary(level + 1);
      left = { k: 'bin', op, l: left, r: right, s: left.s, e: right.e };
    }
    return left;
  }
  function parseUnary() {
    if (peek()?.t === 'op' && ['-', '+', '!', '~', '++', '--'].includes(peek().v)) {
      const tok = tokens[i++];
      const e = parseUnary();
      return { k: 'un', op: tok.v, ex: e, s: tok.s, e: e.e };
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (isOp('[')) {
        i++;
        const idx = parseExpr();
        const close = expectOp(']');
        node = { k: 'idx', base: node, idx, s: node.s, e: close.e };
      } else if (isOp('.')) {
        i++;
        const name = tokens[i++];
        node = { k: 'mem', base: node, name: name.v, s: node.s, e: name.e };
      } else if (isOp('++') || isOp('--')) {
        const tok = tokens[i++];
        node = { k: 'post', base: node, s: node.s, e: tok.e };
      } else return node;
    }
  }
  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('unexpected end of shader');
    if (tok.t === 'num') { i++; return { k: 'num', s: tok.s, e: tok.e }; }
    if (tok.t === 'id') {
      i++;
      // An array constructor, vec4[3](...), is a call to the type.
      if (TYPES.has(tok.v) && isOp('[')) {
        i++;
        parseExpr();
        expectOp(']');
      }
      if (isOp('(')) {
        i++;
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(parseAssign());
            if (isOp(',')) { i++; continue; }
            break;
          }
        }
        const close = expectOp(')');
        return { k: 'call', name: tok.v, args, s: tok.s, e: close.e };
      }
      return { k: 'id', name: tok.v, s: tok.s, e: tok.e };
    }
    if (isOp('(')) {
      i++;
      const inner = parseExpr();
      const close = expectOp(')');
      return { k: 'group', inner, s: tok.s, e: close.e };
    }
    throw new Error(`unexpected token ${JSON.stringify(tok.v)} near ${JSON.stringify(src.slice(tok.s, tok.s + 30))}`);
  }

  // Statements, flattened: the analysis is flow-insensitive, so block structure
  // only matters for which function a statement sits in.
  const stmts = [];
  const fns = new Map();
  let current = '';
  let depth = 0;
  let fnDepth = -1;

  function parseDeclaration() {
    while (peek()?.t === 'id' && QUALIFIERS.has(peek().v)) i++;
    i++; // type
    for (;;) {
      const name = tokens[i++].v;
      while (isOp('[')) { i++; parseExpr(); expectOp(']'); }
      let init = null;
      if (isOp('=')) { i++; init = parseAssign(); }
      stmts.push({ fn: current, k: 'decl', name, init });
      if (isOp(',')) { i++; continue; }
      break;
    }
  }

  while (i < tokens.length) {
    const tok = peek();
    if (tok.t === 'op') {
      if (tok.v === '{') { depth++; i++; continue; }
      if (tok.v === '}') {
        depth--; i++;
        if (depth === fnDepth) { current = ''; fnDepth = -1; }
        continue;
      }
      if (tok.v === ';') { i++; continue; }
    }
    if (tok.t === 'id') {
      if (tok.v === 'else') { i++; continue; }
      if (tok.v === 'if' || tok.v === 'while') {
        i++; expectOp('(');
        stmts.push({ fn: current, k: 'expr', e: parseExpr() });
        expectOp(')');
        continue;
      }
      if (tok.v === 'for') {
        i++; expectOp('(');
        if (peek().t === 'id' && (TYPES.has(peek().v) || QUALIFIERS.has(peek().v))) parseDeclaration();
        else if (!isOp(';')) stmts.push({ fn: current, k: 'expr', e: parseExpr() });
        expectOp(';');
        if (!isOp(';')) stmts.push({ fn: current, k: 'expr', e: parseExpr() });
        expectOp(';');
        if (!isOp(')')) stmts.push({ fn: current, k: 'expr', e: parseExpr() });
        expectOp(')');
        continue;
      }
      if (tok.v === 'break' || tok.v === 'continue' || tok.v === 'discard') { i++; continue; }
      if (tok.v === 'return') {
        i++;
        if (!isOp(';')) stmts.push({ fn: current, k: 'return', e: parseExpr() });
        continue;
      }
      if (TYPES.has(tok.v) || QUALIFIERS.has(tok.v)) {
        // A function definition is `type name (` ; a constructor call such as
        // `vec3(...)` starting a statement does not occur in these scenes.
        let j = i;
        while (tokens[j]?.t === 'id' && QUALIFIERS.has(tokens[j].v)) j++;
        const nameTok = tokens[j + 1];
        if (depth === 0 && tokens[j]?.t === 'id' && TYPES.has(tokens[j].v) && nameTok?.t === 'id'
          && tokens[j + 2]?.t === 'op' && tokens[j + 2].v === '(') {
          i = j + 2;
          const name = nameTok.v;
          expectOp('(');
          const params = [];
          while (!isOp(')')) {
            const outParam = peek().v === 'out' || peek().v === 'inout';
            while (peek().t === 'id' && QUALIFIERS.has(peek().v)) i++;
            i++; // type
            const pname = tokens[i++].v;
            params.push({ name: pname, out: outParam });
            if (isOp(',')) i++;
          }
          expectOp(')');
          fns.set(name, { name, params });
          if (isOp('{')) { i++; current = name; depth++; fnDepth = depth - 1; }
          else if (isOp(';')) i++;
          continue;
        }
        parseDeclaration();
        continue;
      }
    }
    stmts.push({ fn: current, k: 'expr', e: parseExpr() });
  }
  return { stmts, fns };
}

const NONE = Object.freeze({ clock: false, audio: false, spatial: false });

// Audio only counts as a rate while the value stays a scalar: once it varies
// with the pixel it describes a pattern.
function norm(clock, audio, spatial) {
  return { clock, audio: audio && !spatial, spatial };
}
const join = (...ps) => norm(ps.some((p) => p.clock), ps.some((p) => p.audio), ps.some((p) => p.spatial));

function analyze(sceneId, src) {
  const { stmts, fns } = parseProgram(src);
  const vars = new Map(); // `${fn}:${name}` -> { clock, audio, spatial }
  const retProps = new Map(); // fn -> { clock, audio, spatial }
  const key = (fn, name) => `${fn}:${name}`;
  let changed = true;

  function varProps(fn, name) {
    if (fn === 'scene' && (name === 'uv' || name === 'p')) return { clock: false, audio: false, spatial: true };
    return vars.get(key(fn, name)) ?? vars.get(key('', name));
  }
  function setVar(fn, name, props) {
    const scoped = vars.has(key(fn, name)) || fn === '' || !vars.has(key('', name)) ? key(fn, name) : key('', name);
    const old = vars.get(scoped) ?? NONE;
    const next = join(old, props);
    if (!vars.has(scoped) || next.clock !== old.clock || next.audio !== old.audio || next.spatial !== old.spatial) {
      vars.set(scoped, next);
      changed = true;
    }
  }
  function rootName(node) {
    while (node.k === 'idx' || node.k === 'mem' || node.k === 'group') node = node.base ?? node.inner;
    return node.k === 'id' ? node.name : null;
  }

  const found = new Map();
  function report(node, why) {
    const text = src.slice(node.s, node.e).replace(/\s+/g, ' ');
    found.set(`${why}|${text}`, { why, text });
  }

  function evalNode(fn, n, record) {
    switch (n.k) {
      case 'num': return NONE;
      case 'id': {
        if (n.name === 'gl_FragCoord') return norm(false, false, true);
        if (CLOCKS.has(n.name)) return norm(true, false, false);
        if (AUDIO.has(n.name)) return norm(false, true, false);
        return varProps(fn, n.name) ?? NONE;
      }
      case 'group': return evalNode(fn, n.inner, record);
      case 'mem': return evalNode(fn, n.base, record);
      case 'post': return evalNode(fn, n.base, record);
      case 'un': return evalNode(fn, n.ex, record);
      case 'idx': return join(evalNode(fn, n.base, record), evalNode(fn, n.idx, record));
      case 'tern': return join(evalNode(fn, n.c, record), evalNode(fn, n.a, record), evalNode(fn, n.b, record));
      case 'bin': {
        const l = evalNode(fn, n.l, record);
        const r = evalNode(fn, n.r, record);
        if (n.op === '*' && record && ((l.clock && r.audio) || (r.clock && l.audio))) report(n, 'clock x audio');
        if (n.op === '/' && record && l.clock && r.audio) report(n, 'clock / audio');
        if (['+', '-', '*', '/', '%'].includes(n.op)) return join(l, r);
        return norm(false, l.audio || r.audio, l.spatial || r.spatial);
      }
      case 'assign': {
        const r = evalNode(fn, n.r, record);
        const name = rootName(n.l);
        const cur = name ? (varProps(fn, name) ?? NONE) : NONE;
        if ((n.op === '*=' || n.op === '/=') && record && ((cur.clock && r.audio) || (r.clock && cur.audio && n.op === '*='))) {
          report(n, 'clock x audio');
        }
        if (name) setVar(fn, name, r);
        return r;
      }
      case 'call': {
        const args = n.args.map((a) => evalNode(fn, a, record));
        const all = join(...args, NONE);
        const userFn = fns.get(n.name);
        if (userFn) {
          userFn.params.forEach((p, idx) => {
            if (args[idx]) setVar(n.name, p.name, args[idx]);
            if (p.out && n.args[idx]) {
              const target = rootName(n.args[idx]);
              if (target) setVar(fn, target, join(...args.filter((_, j) => j !== idx), NONE));
            }
          });
          const ret = retProps.get(n.name) ?? NONE;
          return join(norm(ret.clock, false, false), norm(false, ret.audio, ret.spatial), norm(false, all.audio, all.spatial));
        }
        if (AUDIO_CALLS.has(n.name)) return join(norm(false, true, false), norm(false, false, all.spatial));
        if (CLOCK_CALLS.has(n.name)) return join(norm(true, false, false), norm(false, false, all.spatial));
        if (n.name === 'mix' && record && args.length === 3 && (args[0].clock || args[1].clock) && args[2].audio) {
          report(n, 'clock x audio');
        }
        if (PASS_THROUGH.has(n.name)) return all;
        return norm(false, all.audio, all.spatial);
      }
      default: throw new Error(`unhandled node ${n.k}`);
    }
  }

  for (let pass = 0; changed && pass < 30; pass++) {
    changed = false;
    for (const st of stmts) {
      if (st.k === 'decl') {
        if (st.init) setVar(st.fn, st.name, evalNode(st.fn, st.init, false));
        else if (!vars.has(key(st.fn, st.name))) { vars.set(key(st.fn, st.name), NONE); changed = true; }
      } else if (st.k === 'return') {
        const props = evalNode(st.fn, st.e, false);
        const old = retProps.get(st.fn) ?? NONE;
        const next = join(old, props);
        if (next.clock !== old.clock || next.audio !== old.audio || next.spatial !== old.spatial) { retProps.set(st.fn, next); changed = true; }
      } else {
        evalNode(st.fn, st.e, false);
      }
    }
  }
  for (const st of stmts) {
    if (st.k === 'decl' && st.init) evalNode(st.fn, st.init, true);
    else if (st.k === 'return' || st.k === 'expr') evalNode(st.fn, st.e, true);
  }
  return [...found.values()].map((f) => ({ scene: sceneId, ...f }));
}

// What a wrap does to a scene. The overlay hands the shader each clock modulo
// CLOCK_WRAP_SECONDS (4096 turns, scene-overlay.ts), so sin(clock * k) carries
// on untouched when k x 4096 is a whole number; a clock that goes anywhere else
// (fract, mod, noise, a hue ramp, a sine at a fractional rate) jumps once per
// period. A clock that only reaches floor() feeds a pattern that re-rolls on a
// tick anyway, so the wrap is one more tick. Everything else is a phase jump:
// the animation it drives hops to another point of its cycle, once per period.
//
// The check follows a clock up through additions and multiplications by
// literals to the first call it meets, and follows a local that is assigned
// once from such a chain. Anything it cannot follow (a function parameter, a
// product with a non-literal, a vector constructor) counts as a phase jump:
// the audit over-reports and never calls a use continuous that is not.
const WRAP_TURNS = CLOCK_WRAP_SECONDS / (2 * Math.PI);

function childrenOf(n) {
  switch (n.k) {
    case 'group': return [n.inner];
    case 'mem': case 'post': return [n.base];
    case 'un': return [n.ex];
    case 'idx': return [n.base, n.idx];
    case 'tern': return [n.c, n.a, n.b];
    case 'bin': case 'assign': return [n.l, n.r];
    case 'call': return n.args;
    default: return [];
  }
}

function literalValue(src, n) {
  switch (n.k) {
    case 'num': return parseFloat(src.slice(n.s, n.e));
    case 'group': return literalValue(src, n.inner);
    case 'un': {
      const v = literalValue(src, n.ex);
      return v === null ? null : n.op === '-' ? -v : n.op === '+' ? v : null;
    }
    case 'bin': {
      const l = literalValue(src, n.l);
      const r = literalValue(src, n.r);
      if (l === null || r === null) return null;
      return n.op === '+' ? l + r : n.op === '-' ? l - r : n.op === '*' ? l * r : n.op === '/' && r !== 0 ? l / r : null;
    }
    default: return null;
  }
}

/** Every use of a wrapped clock in one scene, each as { clock, kind: 'turns' | 'tick' | 'phase', text }. */
function wrapAudit(src) {
  const { stmts } = parseProgram(src);
  const key = (fn, name) => `${fn}:${name}`;
  const roots = [];
  const declared = new Map();
  const assigned = new Set();
  const rootOf = (node) => {
    while (node.k === 'idx' || node.k === 'mem' || node.k === 'group') node = node.base ?? node.inner;
    return node.k === 'id' ? node.name : null;
  };
  const link = (node, parent, stmt) => {
    node.parent = parent;
    node.stmt = stmt;
    if (node.k === 'assign') {
      const name = rootOf(node.l);
      if (name) assigned.add(key(stmt.fn, name));
    }
    for (const child of childrenOf(node)) link(child, node, stmt);
  };
  for (const st of stmts) {
    const root = st.k === 'decl' ? st.init : st.e;
    if (st.k === 'decl') declared.set(key(st.fn, st.name), (declared.get(key(st.fn, st.name)) ?? 0) + 1);
    if (!root) continue;
    link(root, null, st);
    roots.push(root);
  }
  const ctxOf = (node) => { let r = node; while (r.parent) r = r.parent; return src.slice(r.s, r.e).replace(/\s+/g, ' ').slice(0, 110); };
  const nodes = [];
  const collect = (node) => { nodes.push(node); childrenOf(node).forEach(collect); };
  roots.forEach(collect);

  // Locals assigned once from a clock chain: name -> { clock, coef }.
  const aliases = new Map();
  const aliasFor = (fn, name) => aliases.get(key(fn, name)) ?? aliases.get(key('', name));

  const occurrence = (node) => {
    if (node.k === 'id' && node.name === 'u_bandTime') return null;
    if (node.k === 'idx' && node.base.k === 'id' && node.base.name === 'u_bandTime') return { clock: 'u_bandTime', coef: 1 };
    if (node.k === 'call' && node.name === 'bandClock') return { clock: 'bandClock', coef: 1 };
    if (node.k !== 'id') return null;
    if (CLOCKS.has(node.name)) return { clock: node.name, coef: 1 };
    const alias = aliasFor(node.stmt.fn, node.name);
    return alias ? { ...alias } : null;
  };

  /** Follow a clock up to the call that decides what the wrap does to it. */
  const settle = (start, clock, coef) => {
    let cur = start;
    for (;;) {
      const p = cur.parent;
      if (!p) return { end: cur, coef };
      if (p.k === 'un') {
        if (p.op === '-') coef = -coef;
        else if (p.op !== '+') return { kind: 'phase' };
      } else if (p.k === 'bin') {
        const other = p.l === cur ? p.r : p.l;
        if (p.op === '*') {
          const v = literalValue(src, other);
          if (v === null) return { kind: 'phase' };
          coef *= v;
        } else if (p.op === '/') {
          const v = p.l === cur ? literalValue(src, other) : null;
          if (v === null || v === 0) return { kind: 'phase' };
          coef /= v;
        } else if (p.op === '+' || p.op === '-') {
          if (p.op === '-' && p.r === cur) coef = -coef;
        } else return { kind: 'phase' };
      } else if (p.k === 'tern') {
        if (p.c === cur) return { kind: 'phase' };
      } else if (p.k === 'call') {
        if ((p.name === 'sin' || p.name === 'cos') && clock !== 'bandClock') {
          const turns = coef * WRAP_TURNS;
          return { kind: Math.abs(turns - Math.round(turns)) < 1e-6 ? 'turns' : 'phase' };
        }
        return { kind: p.name === 'floor' ? 'tick' : 'phase' };
      } else if (p.k !== 'group') return { kind: 'phase' };
      cur = p;
    }
  };

  let uses = [];
  for (let pass = 0; pass < 12; pass++) {
    uses = [];
    let grew = false;
    for (const node of nodes) {
      const occ = occurrence(node);
      if (!occ) continue;
      const result = settle(node, occ.clock, occ.coef);
      if (result.kind) {
        uses.push({ clock: occ.clock, kind: result.kind, text: src.slice(node.s, node.e).replace(/\s+/g, ' '), ctx: ctxOf(node) });
        continue;
      }
      // The chain ended at the root of a statement: a local alias when it is a
      // declaration of a name assigned nowhere else, a phase jump otherwise.
      const st = result.end.stmt;
      const alias = st.k === 'decl' && st.init === result.end
        && declared.get(key(st.fn, st.name)) === 1 && !assigned.has(key(st.fn, st.name));
      if (!alias) {
        uses.push({ clock: occ.clock, kind: 'phase', text: src.slice(node.s, node.e).replace(/\s+/g, ' '), ctx: ctxOf(node) });
      } else if (!aliases.has(key(st.fn, st.name))) {
        aliases.set(key(st.fn, st.name), { clock: occ.clock, coef: result.coef });
        grew = true;
      }
    }
    if (!grew) break;
  }
  return uses;
}


const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// Self-check on known-good and known-bad shaders, so a parser that stops
// finding things cannot pass the library by accident.
{
  const bad = (src) => analyze('probe', src).length;
  if (!bad('vec4 scene(vec2 uv, vec2 p) { float w = 1.0 + u_energy; float s = u_globalTime * w; return vec4(s); }')) fail('lint missed a clock multiplied through a local');
  if (!bad('vec4 scene(vec2 uv, vec2 p) { return vec4(sin(u_time * (2.0 + u_bass))); }')) fail('lint missed a clock multiplied inside a call');
  const viaParam = (k) => 'float f(float t, float k) { return t * k; } vec4 scene(vec2 uv, vec2 p) { return vec4(f(u_globalTime, ' + k + ')); }';
  if (!bad(viaParam('u_kick'))) fail('lint missed a clock multiplied through a function parameter');
  if (bad(viaParam('0.5'))) fail('lint flagged a constant passed through a function parameter');
  if (!bad('vec4 scene(vec2 uv, vec2 p) { float t = u_globalTime; vec2 q = p - t * (0.1 + u_bass); return vec4(q, 0.0, 1.0); }')) fail('lint missed a clock multiplied through an alias');
  if (!bad('vec4 scene(vec2 uv, vec2 p) { float a = 0.0; a = mix(u_phase, u_phase * 2.0, u_energy); return vec4(a); }')) fail('lint missed a mix between clocks driven by audio');
  if (bad('vec4 scene(vec2 uv, vec2 p) { float a = sin(u_globalTime * 3.0) * u_energy; return vec4(a + u_phase * 0.5); }')) fail('lint flagged an amplitude modulation');
  if (bad('vec4 scene(vec2 uv, vec2 p) { float k = hash11(u_seed) + 0.5; return vec4(u_globalTime * k); }')) fail('lint flagged a seed constant');
  log.push('lint self-checks hold');
}

const violations = [];
for (const scene of SCENES) {
  try {
    violations.push(...analyze(scene.id, scene.frag));
  } catch (err) {
    fail(`${scene.id}: could not analyse the shader (${err.message})`);
  }
}
for (const v of violations) fail(`${v.scene}: ${v.why}: ${v.text}`);
log.push(`${SCENES.length} scenes checked for clock x audio products`);

{
  // A pattern that re-rolls on a fixed timer ignores the tempo; glitch-bars keys
  // its bars and its flash blocks on the kick count.
  const glitch = SCENES.find((scene) => scene.id === 'glitch-bars');
  if (!glitch) fail('glitch-bars is not registered');
  else if (/floor\(\s*u_globalTime/.test(glitch.frag)) fail('glitch-bars re-rolls something on a fixed timer');
}

// The wrap audit. Most scenes drift something (a noise offset, a rotation, a hue
// ramp, a sine at a fractional rate) off a clock, so for them the wrap is a
// one-frame hop in the scene layer, once per period; the feedback field carries
// on. These carry on through it, and have to stay that way.
const CONTINUOUS_AT_WRAP = ['glitch-bars', 'feather-polyp', 'spectral-slit', 'vu-cathedral'];
{
  const kinds = (body) => wrapAudit('vec4 scene(vec2 uv, vec2 p) { ' + body + ' }').map((u) => u.kind).join();
  const cases = [
    ['float a = sin(u_globalTime * 18.0); return vec4(a);', 'turns'],
    ['float a = cos(u_phase * 0.25 + p.x); return vec4(a);', 'turns'],
    ['float a = sin(u_globalTime * 0.3); return vec4(a);', 'phase'],
    ['float a = fract(u_phase * 0.5); return vec4(a);', 'phase'],
    ['float a = hash11(floor(u_globalTime * 6.0)); return vec4(a);', 'tick'],
    ['float t = u_phase * 0.5; float a = sin(t * 2.0); return vec4(a);', 'turns'],
    ['float t = u_phase * 0.3; float a = sin(t); return vec4(a);', 'phase'],
    ['float a = sin(u_phase * u_seed); return vec4(a);', 'phase'],
    ['float a = sin(u_energyTime * 2.0 - u_panTime * 4.0); return vec4(a);', 'turns,turns'],
  ];
  for (const [body, want] of cases) {
    const got = kinds(body);
    if (got !== want) fail(`wrap audit read "${body}" as [${got}], expected [${want}]`);
  }

  const byScene = new Map(SCENES.map((scene) => [scene.id, wrapAudit(scene.frag)]));
  for (const id of CONTINUOUS_AT_WRAP) {
    const jumps = (byScene.get(id) ?? [{ kind: 'phase', clock: 'missing', text: id }]).filter((u) => u.kind === 'phase');
    for (const use of jumps) fail(`${id} is meant to carry on through a clock wrap, but ${use.clock} goes into a phase: ${use.text}`);
  }
  const hopping = [...byScene].filter(([, uses]) => uses.some((u) => u.kind === 'phase'));
  const viaGlobal = hopping.filter(([, uses]) => uses.some((u) => u.kind === 'phase' && u.clock === 'u_globalTime'));
  log.push(`wrap audit: ${hopping.length} of ${SCENES.length} scenes hop once per period, ${viaGlobal.length} of them through u_globalTime; the rest only through the integrals, which advance slower`);
}

// The speed hooks the scenes rely on must be total functions of the frame.
{
  const frame = {
    energy: 0.5, kick: 0.5, bass: 0.5, snare: 0.5, hat: 0.5, vocal: 0.5, centroid: 0.5, flatness: 0.5, crest: 0.5,
    width: 0.5, pan: 0, novelty: 0.2, beatPhase: 0.3, beatConfidence: 0.5, bands: new Float32Array(24),
  };
  const pulses = { kick: 0.4, snare: 0.2, hat: 0.1, vocal: 0.3 };
  for (const scene of SCENES) {
    if (!scene.speed) continue;
    const speed = scene.speed(frame, pulses);
    if (!Number.isFinite(speed) || speed < 0) fail(`${scene.id}: speed() returned ${speed}`);
  }
  log.push('scene speed hooks are finite and non-negative');
}

console.log(log.join('\n'));
if (!pass) process.exit(1);
console.log('eviland-scene-clock-test: ok');
