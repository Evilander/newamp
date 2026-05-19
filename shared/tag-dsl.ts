// Living Tags DSL — a tiny embedded expression language for reactive,
// composable auto-tagging on top of a NewAmp track + DNA + listening state.
//
// Goals:
//   - One language for `tag(name) when <expr> [boost N]` rule declarations.
//   - Sandboxed: no eval, no Function, no host-object reachability. Only the
//     whitelisted function table and the read-only track context are exposed.
//   - Three-valued logic for missing fields (SQL-style NULL semantics).
//   - Cycle-safe tag composition: rules can reference other tags via
//     tag("name"), and a topological sort over the rule DAG prevents loops.
//   - Bounded: no loops or recursion in user-written expressions; tag
//     references compose, but cycles are rejected at definition time.
//
// Parser is hand-rolled recursive descent (Pratt-style precedence for binary
// operators). Evaluator walks the AST against a TrackContext bag.

import type { TrackDna } from './audio-dna.js';

export const TAG_DSL_VERSION = 1;
export const MAX_TAG_NAME_LENGTH = 48;
export const MAX_RULE_BODY_LENGTH = 4000;
export const MAX_REGEX_PATTERN_LENGTH = 200;
export const MAX_REGEX_INPUT_LENGTH = 4096;

// Reject patterns that the JS engine evaluates with catastrophic
// backtracking. We don't ship a real DFA matcher (would mean re2), so we
// pre-screen common evil shapes: nested quantifiers like (a+)+, (a*)*,
// (a+)*, (a*)+, (a+)?+, and alternations of equivalent branches like (a|a)*
// or (a|aa)*. Anything matching these refuses to compile-into-regex and the
// `matches` operator returns null. This is conservative — some legitimate
// patterns are blocked — but rule authors can always rewrite.
const REDOS_NESTED_QUANT = /\([^)]*[+*][^)]*\)\s*[+*?]/;
const REDOS_ALT_REPEAT = /\(([^|()]+)\|[^)]*\1[^)]*\)\s*[+*]/;

function safeRegex(pattern: string): RegExp | null {
  if (typeof pattern !== 'string') return null;
  if (pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LENGTH) return null;
  if (REDOS_NESTED_QUANT.test(pattern)) return null;
  if (REDOS_ALT_REPEAT.test(pattern)) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function safeRegexTest(pattern: string, input: string): boolean | null {
  const re = safeRegex(pattern);
  if (!re) return null;
  const slice = input.length > MAX_REGEX_INPUT_LENGTH ? input.slice(0, MAX_REGEX_INPUT_LENGTH) : input;
  try {
    return re.test(slice);
  } catch {
    return null;
  }
}

export interface TrackContext {
  id: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  size: number | null;
  mtime: number | null;
  bpm: number | null;
  key: string | null;
  format: string | null;
  rating: number;
  ratingScore: number | null;
  playCount: number;
  skipCount: number;
  lastPlayed: number | null;
  lastSkipped: number | null;
  loved: boolean;
  avoidAutoPlay: boolean;
  replayGainTrack: number | null;
  replayGainAlbum: number | null;
  dna: TrackDna | null;
  tags: ReadonlySet<string>;
}

export interface EvalEnvironment {
  now: number;        // unix ms used for time-based functions
  weekday: string;    // "mon".."sun" derived from now
  hour: number;       // 0..23
  month: number;      // 1..12
  season: string;     // winter|spring|summer|fall
}

export interface ParsedRule {
  name: string;
  body: string;
  ast: AstNode;
  boost: number;
  references: string[]; // other tag names this rule depends on
}

export interface CompileResult {
  rule: ParsedRule | null;
  errors: CompileError[];
}

export interface CompileError {
  message: string;
  line: number;
  column: number;
}

export interface EvalResult {
  matched: boolean;
  errors: string[];
}

export type AstNode =
  | { kind: 'literal'; value: Value }
  | { kind: 'identifier'; name: string }
  | { kind: 'field'; path: string[] }
  | { kind: 'range'; lo: number; hi: number }
  | { kind: 'binary'; op: BinaryOp; left: AstNode; right: AstNode }
  | { kind: 'unary'; op: 'not' | 'neg'; argument: AstNode }
  | { kind: 'call'; name: string; args: AstNode[] }
  | { kind: 'tag'; name: string };

export type BinaryOp =
  | 'and'
  | 'or'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'matches'
  | 'contains'
  | 'in'
  | '+'
  | '-'
  | '*'
  | '/';

type Value = number | string | boolean | null | { range: [number, number] };

export function parseRule(source: string): CompileResult {
  if (typeof source !== 'string') {
    return { rule: null, errors: [{ message: 'rule body must be a string', line: 1, column: 1 }] };
  }
  if (source.length > MAX_RULE_BODY_LENGTH) {
    return {
      rule: null,
      errors: [{ message: `rule exceeds ${MAX_RULE_BODY_LENGTH} chars`, line: 1, column: 1 }],
    };
  }
  try {
    const tokens = tokenize(source);
    const parser = new Parser(tokens);
    const rule = parser.parseRule();
    return { rule, errors: [] };
  } catch (err) {
    const compileErr = err instanceof CompileException
      ? { message: err.message, line: err.line, column: err.column }
      : { message: err instanceof Error ? err.message : String(err), line: 1, column: 1 };
    return { rule: null, errors: [compileErr] };
  }
}

export function evaluateRule(rule: ParsedRule, context: TrackContext, env: EvalEnvironment): EvalResult {
  try {
    const value = evalNode(rule.ast, context, env);
    return { matched: truthy(value), errors: [] };
  } catch (err) {
    return { matched: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

export interface TagEvaluationInput {
  rules: ParsedRule[];
  context: Omit<TrackContext, 'tags'>;
  env: EvalEnvironment;
}

export interface TagEvaluationOutput {
  tags: Set<string>;
  boost: number;        // product of boosts of matched tags; 1 if none
  errors: Map<string, string[]>;
}

export function evaluateRulesForTrack(input: TagEvaluationInput): TagEvaluationOutput {
  const ordered = topologicalSort(input.rules);
  const matched = new Set<string>();
  const errors = new Map<string, string[]>();
  let boost = 1;
  for (const rule of ordered) {
    const context: TrackContext = { ...input.context, tags: matched };
    const result = evaluateRule(rule, context, input.env);
    if (result.errors.length) errors.set(rule.name, result.errors);
    if (result.matched) {
      matched.add(rule.name);
      if (rule.boost > 0 && rule.boost !== 1) boost *= rule.boost;
    }
  }
  return { tags: matched, boost, errors };
}

export function topologicalSort(rules: ParsedRule[]): ParsedRule[] {
  const byName = new Map<string, ParsedRule>();
  for (const rule of rules) byName.set(rule.name, rule);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ParsedRule[] = [];
  const visit = (rule: ParsedRule): void => {
    if (visited.has(rule.name)) return;
    if (visiting.has(rule.name)) {
      throw new Error(`tag rule cycle detected at "${rule.name}"`);
    }
    visiting.add(rule.name);
    for (const ref of rule.references) {
      const next = byName.get(ref);
      if (next) visit(next);
    }
    visiting.delete(rule.name);
    visited.add(rule.name);
    ordered.push(rule);
  };
  for (const rule of rules) visit(rule);
  return ordered;
}

export function buildEvalEnvironment(now = Date.now()): EvalEnvironment {
  const date = new Date(now);
  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  const month = date.getMonth() + 1;
  const season =
    month <= 2 || month === 12 ? 'winter'
    : month <= 5 ? 'spring'
    : month <= 8 ? 'summer'
    : 'fall';
  return {
    now,
    weekday: weekdays[date.getDay()]!,
    hour: date.getHours(),
    month,
    season,
  };
}

export function listIdentifiers(): string[] {
  return [...TRACK_FIELDS.keys(), ...DNA_FIELDS.keys()];
}

export function listFunctions(): string[] {
  return Object.keys(FUNCTIONS);
}

// ---------- Tokenizer ----------

interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

type TokenType =
  | 'ident'
  | 'number'
  | 'string'
  | 'keyword'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'dot'
  | 'range'
  | 'eof';

const KEYWORDS = new Set([
  'tag', 'when', 'and', 'or', 'not', 'true', 'false', 'null',
  'matches', 'contains', 'in', 'boost',
]);
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '..']);
const SINGLE_CHAR_OPS = new Set(['<', '>', '=', '+', '-', '*', '/']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const col = () => i - lineStart + 1;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === '\n') { i++; line++; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }

    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = col();
      i++;
      let raw = '';
      while (i < source.length && source[i] !== quote) {
        const c = source[i]!;
        if (c === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          raw += next === 'n' ? '\n' : next === 't' ? '\t' : next === '\\' ? '\\' : next === quote ? quote : next;
          i += 2;
          continue;
        }
        if (c === '\n') throw new CompileException('unterminated string', line, start);
        raw += c;
        i++;
      }
      if (i >= source.length) throw new CompileException('unterminated string', line, start);
      i++;
      tokens.push({ type: 'string', value: raw, line, column: start });
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = col();
      let raw = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        if (source[i] === '.' && source[i + 1] === '.') break;
        raw += source[i++];
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new CompileException(`bad number: ${raw}`, line, start);
      tokens.push({ type: 'number', value: String(value), line, column: start });
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = col();
      let ident = '';
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i]!)) ident += source[i++];
      const lower = ident.toLowerCase();
      const type: TokenType = KEYWORDS.has(lower) ? 'keyword' : 'ident';
      tokens.push({ type, value: KEYWORDS.has(lower) ? lower : ident, line, column: start });
      continue;
    }

    if (ch === '(') { tokens.push({ type: 'lparen', value: '(', line, column: col() }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')', line, column: col() }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',', line, column: col() }); i++; continue; }
    if (ch === '.') {
      if (source[i + 1] === '.') {
        tokens.push({ type: 'range', value: '..', line, column: col() });
        i += 2;
        continue;
      }
      tokens.push({ type: 'dot', value: '.', line, column: col() });
      i++;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two, line, column: col() });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ type: 'op', value: ch, line, column: col() });
      i++;
      continue;
    }
    throw new CompileException(`unexpected character "${ch}"`, line, col());
  }
  tokens.push({ type: 'eof', value: '', line, column: col() });
  return tokens;
}

// ---------- Parser ----------

class CompileException extends Error {
  line: number;
  column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token { return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!; }
  private next(): Token { return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1]!; }
  private check(type: TokenType, value?: string): boolean {
    const tok = this.peek();
    return tok.type === type && (value === undefined || tok.value === value);
  }
  private accept(type: TokenType, value?: string): Token | null {
    if (this.check(type, value)) return this.next();
    return null;
  }
  private expect(type: TokenType, value?: string): Token {
    if (this.check(type, value)) return this.next();
    const tok = this.peek();
    throw new CompileException(
      `expected ${value ?? type}, got "${tok.value || tok.type}"`,
      tok.line,
      tok.column,
    );
  }

  parseRule(): ParsedRule {
    this.expect('keyword', 'tag');
    this.expect('lparen');
    const nameTok = this.peek();
    if (nameTok.type !== 'ident' && nameTok.type !== 'string') {
      throw new CompileException(`expected tag name, got "${nameTok.value || nameTok.type}"`, nameTok.line, nameTok.column);
    }
    const name = this.next().value;
    validateTagName(name, nameTok.line, nameTok.column);
    this.expect('rparen');
    this.expect('keyword', 'when');
    const ast = this.parseExpr();
    let boost = 1;
    if (this.accept('keyword', 'boost')) {
      const tok = this.expect('number');
      boost = Number(tok.value);
      if (!Number.isFinite(boost) || boost <= 0) {
        throw new CompileException('boost must be a positive number', tok.line, tok.column);
      }
    }
    const tail = this.peek();
    if (tail.type !== 'eof') {
      throw new CompileException(`unexpected trailing token "${tail.value || tail.type}"`, tail.line, tail.column);
    }
    const references = collectTagReferences(ast);
    if (references.includes(name)) {
      throw new CompileException(`rule "${name}" cannot reference itself`, nameTok.line, nameTok.column);
    }
    return { name, body: '', ast, boost, references };
  }

  parseExpr(): AstNode { return this.parseOr(); }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.accept('keyword', 'or')) {
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.accept('keyword', 'and')) {
      const right = this.parseNot();
      left = { kind: 'binary', op: 'and', left, right };
    }
    return left;
  }

  private parseNot(): AstNode {
    if (this.accept('keyword', 'not')) {
      return { kind: 'unary', op: 'not', argument: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    let left = this.parseAdd();
    const tok = this.peek();
    let op: BinaryOp | null = null;
    if (tok.type === 'op') {
      if (tok.value === '==' || tok.value === '=' || tok.value === '!=' || tok.value === '<' || tok.value === '<=' || tok.value === '>' || tok.value === '>=') {
        op = (tok.value === '=' ? '==' : tok.value) as BinaryOp;
      }
    } else if (tok.type === 'keyword' && (tok.value === 'matches' || tok.value === 'contains' || tok.value === 'in')) {
      op = tok.value as BinaryOp;
    }
    if (op) {
      this.next();
      const right = this.parseAdd();
      return { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdd(): AstNode {
    let left = this.parseMul();
    while (this.check('op', '+') || this.check('op', '-')) {
      const op = this.next().value as BinaryOp;
      const right = this.parseMul();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMul(): AstNode {
    let left = this.parseUnary();
    while (this.check('op', '*') || this.check('op', '/')) {
      const op = this.next().value as BinaryOp;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.accept('op', '-')) {
      return { kind: 'unary', op: 'neg', argument: this.parsePrimary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const tok = this.peek();

    if (this.accept('lparen')) {
      const inner = this.parseExpr();
      this.expect('rparen');
      return inner;
    }

    if (tok.type === 'number') {
      this.next();
      const value = Number(tok.value);
      if (this.accept('range')) {
        const hiTok = this.expect('number');
        return { kind: 'range', lo: value, hi: Number(hiTok.value) };
      }
      return { kind: 'literal', value };
    }

    if (tok.type === 'string') {
      this.next();
      return { kind: 'literal', value: tok.value };
    }

    if (tok.type === 'keyword' && (tok.value === 'true' || tok.value === 'false' || tok.value === 'null')) {
      this.next();
      const literal: Value = tok.value === 'true' ? true : tok.value === 'false' ? false : null;
      return { kind: 'literal', value: literal };
    }

    if (tok.type === 'keyword' && tok.value === 'tag') {
      this.next();
      this.expect('lparen');
      const nameTok = this.peek();
      if (nameTok.type !== 'ident' && nameTok.type !== 'string') {
        throw new CompileException('expected tag name', nameTok.line, nameTok.column);
      }
      const name = this.next().value;
      this.expect('rparen');
      return { kind: 'tag', name };
    }

    if (tok.type === 'ident') {
      this.next();
      if (this.accept('lparen')) {
        const args: AstNode[] = [];
        if (!this.check('rparen')) {
          args.push(this.parseExpr());
          while (this.accept('comma')) args.push(this.parseExpr());
        }
        this.expect('rparen');
        return { kind: 'call', name: tok.value, args };
      }
      const path = [tok.value];
      while (this.accept('dot')) {
        const member = this.expect('ident');
        path.push(member.value);
      }
      if (path.length === 1) {
        return { kind: 'identifier', name: path[0]! };
      }
      return { kind: 'field', path };
    }

    throw new CompileException(`unexpected token "${tok.value || tok.type}"`, tok.line, tok.column);
  }
}

function validateTagName(name: string, line: number, column: number): void {
  if (!name) throw new CompileException('tag name cannot be empty', line, column);
  if (name.length > MAX_TAG_NAME_LENGTH) {
    throw new CompileException(`tag name exceeds ${MAX_TAG_NAME_LENGTH} chars`, line, column);
  }
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
    throw new CompileException('tag names must be lower-case slugs ([a-z_][a-z0-9_-]*)', line, column);
  }
}

function collectTagReferences(ast: AstNode): string[] {
  const out = new Set<string>();
  visit(ast, (node) => {
    if (node.kind === 'tag') out.add(node.name);
  });
  return [...out];
}

function visit(node: AstNode, fn: (node: AstNode) => void): void {
  fn(node);
  switch (node.kind) {
    case 'binary':
      visit(node.left, fn);
      visit(node.right, fn);
      return;
    case 'unary':
      visit(node.argument, fn);
      return;
    case 'call':
      for (const arg of node.args) visit(arg, fn);
      return;
    case 'literal':
    case 'identifier':
    case 'field':
    case 'range':
    case 'tag':
      return;
  }
}

// ---------- Evaluator ----------

const TRACK_FIELDS = new Map<string, (ctx: TrackContext) => Value>([
  ['title', (c) => c.title],
  ['artist', (c) => c.artist],
  ['album', (c) => c.album],
  ['albumartist', (c) => c.albumArtist],
  ['genre', (c) => c.genre],
  ['year', (c) => c.year],
  ['duration', (c) => c.duration],
  ['bitrate', (c) => c.bitrate],
  ['samplerate', (c) => c.sampleRate],
  ['size', (c) => c.size],
  ['bpm', (c) => c.bpm],
  ['key', (c) => c.key],
  ['format', (c) => c.format],
  ['rating', (c) => c.rating],
  ['ratingscore', (c) => c.ratingScore],
  ['playcount', (c) => c.playCount],
  ['skipcount', (c) => c.skipCount],
  ['lastplayed', (c) => c.lastPlayed],
  ['loved', (c) => c.loved],
  ['avoidautoplay', (c) => c.avoidAutoPlay],
  ['replaygain', (c) => c.replayGainTrack],
  ['replaygainalbum', (c) => c.replayGainAlbum],
]);

const DNA_FIELDS = new Map<string, (dna: TrackDna | null) => Value>([
  ['energy', (d) => d?.rms ?? null],
  ['rms', (d) => d?.rms ?? null],
  ['brightness', (d) => d?.brightness ?? null],
  ['flatness', (d) => d?.flatness ?? null],
  ['dynamicrange', (d) => d?.dynamicRange ?? null],
  ['rolloff', (d) => d?.rolloff ?? null],
  ['onsetdensity', (d) => d?.onsetDensity ?? null],
  ['low', (d) => d?.bands[0] ?? null],
  ['lowmid', (d) => d?.bands[1] ?? null],
  ['mid', (d) => d?.bands[2] ?? null],
  ['highmid', (d) => d?.bands[3] ?? null],
  ['high', (d) => d?.bands[4] ?? null],
]);

type FunctionImpl = (args: Value[], ctx: TrackContext, env: EvalEnvironment) => Value;

const FUNCTIONS: Record<string, FunctionImpl> = {
  weekday: (_a, _c, env) => env.weekday,
  hour: (_a, _c, env) => env.hour,
  month: (_a, _c, env) => env.month,
  season: (_a, _c, env) => env.season,
  now: (_a, _c, env) => env.now,
  abs: (args) => {
    const value = numberValue(args[0]);
    return value == null ? null : Math.abs(value);
  },
  min: (args) => {
    const nums = args.map(numberValue).filter((v): v is number => v != null);
    return nums.length ? Math.min(...nums) : null;
  },
  max: (args) => {
    const nums = args.map(numberValue).filter((v): v is number => v != null);
    return nums.length ? Math.max(...nums) : null;
  },
  dayssince: (args, _c, env) => {
    const ts = numberValue(args[0]);
    if (ts == null) return null;
    const ms = ts > 1e12 ? ts : ts * 1000;
    return (env.now - ms) / (1000 * 60 * 60 * 24);
  },
  matches: (args) => {
    const s = stringValue(args[0]);
    const pattern = stringValue(args[1]);
    if (s == null || pattern == null) return null;
    return safeRegexTest(pattern, s);
  },
  contains: (args) => {
    const s = stringValue(args[0]);
    const needle = stringValue(args[1]);
    if (s == null || needle == null) return null;
    return s.toLowerCase().includes(needle.toLowerCase());
  },
  lower: (args) => {
    const s = stringValue(args[0]);
    return s == null ? null : s.toLowerCase();
  },
  upper: (args) => {
    const s = stringValue(args[0]);
    return s == null ? null : s.toUpperCase();
  },
  length: (args) => {
    const s = stringValue(args[0]);
    return s == null ? null : s.length;
  },
};

function evalNode(node: AstNode, ctx: TrackContext, env: EvalEnvironment): Value {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'range':
      return { range: [node.lo, node.hi] };
    case 'identifier':
      return evalIdentifier(node.name, ctx);
    case 'field':
      return evalField(node.path, ctx);
    case 'tag':
      return ctx.tags.has(node.name);
    case 'call':
      return evalCall(node, ctx, env);
    case 'unary': {
      const arg = evalNode(node.argument, ctx, env);
      if (node.op === 'not') return arg == null ? null : !truthy(arg);
      if (node.op === 'neg') {
        const num = numberValue(arg);
        return num == null ? null : -num;
      }
      return null;
    }
    case 'binary':
      return evalBinary(node, ctx, env);
  }
}

function evalIdentifier(name: string, ctx: TrackContext): Value {
  const lower = name.toLowerCase();
  const accessor = TRACK_FIELDS.get(lower);
  if (accessor) return accessor(ctx);
  if (lower === 'track') {
    throw new Error('use track.<field> (e.g., track.year), not bare "track"');
  }
  if (lower === 'dna') {
    throw new Error('use dna.<field> (e.g., dna.energy), not bare "dna"');
  }
  throw new Error(`unknown identifier "${name}"`);
}

function evalField(path: string[], ctx: TrackContext): Value {
  if (path.length !== 2) throw new Error(`unsupported field path: ${path.join('.')}`);
  const root = path[0]!.toLowerCase();
  const member = path[1]!.toLowerCase();
  if (root === 'track') {
    const accessor = TRACK_FIELDS.get(member);
    if (!accessor) throw new Error(`unknown track field "${member}"`);
    return accessor(ctx);
  }
  if (root === 'dna') {
    const accessor = DNA_FIELDS.get(member);
    if (!accessor) throw new Error(`unknown dna field "${member}"`);
    return accessor(ctx.dna);
  }
  throw new Error(`unknown namespace "${root}"`);
}

function evalCall(node: { name: string; args: AstNode[] }, ctx: TrackContext, env: EvalEnvironment): Value {
  const key = node.name.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, key)) {
    throw new Error(`unknown function "${node.name}"`);
  }
  const impl = FUNCTIONS[key];
  const args = node.args.map((arg) => evalNode(arg, ctx, env));
  return impl!(args, ctx, env);
}

function evalBinary(node: Extract<AstNode, { kind: 'binary' }>, ctx: TrackContext, env: EvalEnvironment): Value {
  if (node.op === 'and') {
    const l = evalNode(node.left, ctx, env);
    if (l == null) return null;
    if (!truthy(l)) return false;
    const r = evalNode(node.right, ctx, env);
    if (r == null) return null;
    return truthy(r);
  }
  if (node.op === 'or') {
    const l = evalNode(node.left, ctx, env);
    if (truthy(l)) return true;
    const r = evalNode(node.right, ctx, env);
    if (l == null && r == null) return null;
    return truthy(r);
  }

  const left = evalNode(node.left, ctx, env);
  const right = evalNode(node.right, ctx, env);

  if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '/') {
    const l = numberValue(left);
    const r = numberValue(right);
    if (l == null || r == null) return null;
    if (node.op === '+') return l + r;
    if (node.op === '-') return l - r;
    if (node.op === '*') return l * r;
    if (node.op === '/') return r === 0 ? null : l / r;
  }

  if (node.op === '==' || node.op === '!=') {
    const result = compareEq(left, right);
    if (result == null) return null;
    return node.op === '==' ? result : !result;
  }

  if (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
    if (left == null || right == null) return null;
    const l = numberValue(left);
    const r = numberValue(right);
    if (l == null || r == null) {
      const ls = stringValue(left);
      const rs = stringValue(right);
      if (ls == null || rs == null) return null;
      if (node.op === '<') return ls < rs;
      if (node.op === '<=') return ls <= rs;
      if (node.op === '>') return ls > rs;
      return ls >= rs;
    }
    if (node.op === '<') return l < r;
    if (node.op === '<=') return l <= r;
    if (node.op === '>') return l > r;
    return l >= r;
  }

  if (node.op === 'matches') {
    const s = stringValue(left);
    const pattern = stringValue(right);
    if (s == null || pattern == null) return null;
    return safeRegexTest(pattern, s);
  }

  if (node.op === 'contains') {
    const haystack = stringValue(left);
    const needle = stringValue(right);
    if (haystack == null || needle == null) return null;
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }

  if (node.op === 'in') {
    if (left == null || right == null) return null;
    if (typeof right === 'object' && right !== null && 'range' in right) {
      const value = numberValue(left);
      if (value == null) return null;
      const [lo, hi] = right.range;
      return value >= lo && value <= hi;
    }
    if (typeof right === 'string' && typeof left === 'string') {
      return right.toLowerCase().includes(left.toLowerCase());
    }
    return null;
  }

  return null;
}

function compareEq(a: Value, b: Value): boolean | null {
  if (a == null || b == null) return null;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  const an = numberValue(a);
  const bn = numberValue(b);
  if (an != null && bn != null) return an === bn;
  const as = stringValue(a);
  const bs = stringValue(b);
  if (as != null && bs != null) return as.toLowerCase() === bs.toLowerCase();
  return null;
}

function numberValue(v: Value): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function stringValue(v: Value): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

function truthy(v: Value): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return true;
}
