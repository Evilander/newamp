// Linear-time regular-expression matching for user-authored patterns.
//
// The Living Tags DSL lets a rule say `title matches "live|remix"`, and those
// rules run in the main process against every track in the library. Handing
// the pattern to the JavaScript RegExp engine means a backtracking matcher,
// and a pattern like `(a+)+$` or even the innocent-looking `.*.*.*=` can take
// seconds to minutes on a 4 KB tag string. The previous defence was a set of
// structural heuristics that rejected known-bad shapes; heuristics can only
// ever name the shapes someone has already thought of.
//
// This module removes the problem instead of screening for it. Patterns are
// compiled to a Thompson NFA and simulated one input character at a time, so
// matching costs O(pattern size × input length) no matter what the pattern
// looks like. The price is a smaller grammar: no backreferences, no
// lookarounds, no lazy quantifiers. Those features have no linear-time
// implementation and nothing in a tag rule needs them.
//
// Supported syntax
//   literals, `.`, escapes `\.` `\\` `\/` `\-` `\t` `\n`, `\d` `\D` `\w` `\W`
//   `\s` `\S`, classes `[abc]` `[^a-z]` (with the same escapes inside),
//   groups `( )`, `(?: )` and `(?<name> )`, alternation `|`, anchors `^` `$`, word boundary
//   `\b`, quantifiers `*` `+` `?` `{n}` `{n,}` `{n,m}` (n, m ≤ 64).
// Matching is always case-insensitive (the DSL's existing contract) and
// searches for the pattern anywhere in the input unless anchored.

export const MAX_SAFE_REGEX_PATTERN_LENGTH = 200;
export const MAX_SAFE_REGEX_REPEAT = 64;
// Counted repeats multiply the NFA size (`(a{64}){64}` is 4,096 states before
// the outer group is even considered). The cap keeps a pathological pattern
// from allocating its way around the linear-time guarantee.
export const MAX_SAFE_REGEX_STATES = 4000;

export type SafeRegexErrorCode =
  | 'empty'
  | 'too-long'
  | 'syntax'
  | 'unsupported'
  | 'repeat-too-large'
  | 'too-complex';

export class SafeRegexError extends Error {
  readonly code: SafeRegexErrorCode;
  constructor(code: SafeRegexErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// AST

type Node =
  | { kind: 'char'; code: number }
  | { kind: 'any' }
  | { kind: 'class'; negate: boolean; ranges: Array<[number, number]> }
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'boundary' }
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; branches: Node[] }
  | { kind: 'repeat'; item: Node; min: number; max: number | null };

const DIGIT: Array<[number, number]> = [[0x30, 0x39]];
const WORD: Array<[number, number]> = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const SPACE: Array<[number, number]> = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];

class Parser {
  private pos = 0;
  private readonly cps: number[];

  constructor(pattern: string) {
    this.cps = Array.from(pattern, (ch) => ch.codePointAt(0)!);
  }

  parse(): Node {
    const node = this.parseAlternation();
    if (this.pos < this.cps.length) {
      this.fail('syntax', `unexpected "${String.fromCodePoint(this.cps[this.pos]!)}"`);
    }
    return node;
  }

  private peek(): number | undefined {
    return this.cps[this.pos];
  }

  private next(): number {
    const cp = this.cps[this.pos];
    if (cp === undefined) this.fail('syntax', 'pattern ends unexpectedly');
    this.pos++;
    return cp;
  }

  private fail(code: SafeRegexErrorCode, detail: string): never {
    throw new SafeRegexError(code, `${detail} at position ${this.pos}`);
  }

  private parseAlternation(): Node {
    const branches: Node[] = [this.parseSequence()];
    while (this.peek() === 0x7c /* | */) {
      this.pos++;
      branches.push(this.parseSequence());
    }
    return branches.length === 1 ? branches[0]! : { kind: 'alt', branches };
  }

  private parseSequence(): Node {
    const items: Node[] = [];
    for (;;) {
      const cp = this.peek();
      if (cp === undefined || cp === 0x7c /* | */ || cp === 0x29 /* ) */) break;
      items.push(this.parseQuantified());
    }
    return items.length === 1 ? items[0]! : { kind: 'seq', items };
  }

  private parseQuantified(): Node {
    const atom = this.parseAtom();
    const cp = this.peek();
    let min: number;
    let max: number | null;
    if (cp === 0x2a /* * */) { this.pos++; min = 0; max = null; }
    else if (cp === 0x2b /* + */) { this.pos++; min = 1; max = null; }
    else if (cp === 0x3f /* ? */) { this.pos++; min = 0; max = 1; }
    else if (cp === 0x7b /* { */) {
      const bounds = this.parseBraces();
      if (!bounds) return atom; // a literal "{" that isn't a quantifier
      [min, max] = bounds;
    } else {
      return atom;
    }
    if (this.peek() === 0x3f /* ? */ || this.peek() === 0x2b /* + */) {
      this.fail('unsupported', 'lazy and possessive quantifiers are not supported');
    }
    if (atom.kind === 'start' || atom.kind === 'end' || atom.kind === 'boundary') {
      this.fail('syntax', 'an anchor cannot be repeated');
    }
    return { kind: 'repeat', item: atom, min, max };
  }

  // Returns null (and rewinds) when the brace does not form a valid
  // quantifier, so `{` can still appear literally, matching RegExp behaviour.
  private parseBraces(): [number, number | null] | null {
    const start = this.pos;
    this.pos++; // {
    const readInt = (): number | null => {
      let digits = '';
      while (this.peek() !== undefined && this.peek()! >= 0x30 && this.peek()! <= 0x39) {
        digits += String.fromCodePoint(this.next());
      }
      return digits.length ? Number(digits) : null;
    };
    const min = readInt();
    if (min === null) { this.pos = start; return null; }
    let max: number | null = min;
    if (this.peek() === 0x2c /* , */) {
      this.pos++;
      max = readInt(); // null means open-ended
    }
    if (this.peek() !== 0x7d /* } */) { this.pos = start; return null; }
    this.pos++;
    if (min > MAX_SAFE_REGEX_REPEAT || (max !== null && max > MAX_SAFE_REGEX_REPEAT)) {
      this.fail('repeat-too-large', `repeat counts are limited to ${MAX_SAFE_REGEX_REPEAT}`);
    }
    if (max !== null && max < min) this.fail('syntax', 'repeat maximum is smaller than its minimum');
    return [min, max];
  }

  private parseAtom(): Node {
    const cp = this.next();
    switch (cp) {
      case 0x28: /* ( */ {
        if (this.peek() === 0x3f /* ? */) {
          this.pos++;
          const marker = this.peek();
          if (marker === 0x3a /* : */) {
            this.pos++;
          } else if (marker === 0x3c /* < */ && this.cps[this.pos + 1] !== 0x3d && this.cps[this.pos + 1] !== 0x21) {
            // A named group `(?<name>...)` matches exactly like a plain group;
            // the name is accepted and ignored since nothing here captures.
            this.pos++;
            while (this.peek() !== undefined && this.peek() !== 0x3e /* > */) this.pos++;
            if (this.peek() !== 0x3e) this.fail('syntax', 'unterminated group name');
            this.pos++;
          } else if (marker === 0x3d || marker === 0x21 || marker === 0x3c) {
            this.fail('unsupported', 'lookahead and lookbehind are not supported');
          } else {
            this.fail('unsupported', 'inline modifiers like (?i:...) are not supported; matching is already case-insensitive');
          }
        }
        const inner = this.parseAlternation();
        if (this.peek() !== 0x29 /* ) */) this.fail('syntax', 'missing ")"');
        this.pos++;
        return inner;
      }
      case 0x29: /* ) */
        return this.fail('syntax', 'unmatched ")"');
      case 0x5b: /* [ */
        return this.parseClass();
      case 0x2e: /* . */
        return { kind: 'any' };
      case 0x5e: /* ^ */
        return { kind: 'start' };
      case 0x24: /* $ */
        return { kind: 'end' };
      case 0x5c: /* \ */ {
        const escaped = this.parseEscape(false);
        return escaped.kind === 'char' ? { kind: 'char', code: foldCase(escaped.code) } : escaped;
      }
      case 0x2a: case 0x2b: case 0x3f: /* * + ? */
        return this.fail('syntax', 'quantifier has nothing to repeat');
      default:
        return { kind: 'char', code: foldCase(cp) };
    }
  }

  private parseEscape(inClass: boolean): Node {
    const cp = this.next();
    switch (cp) {
      case 0x64: /* d */ return { kind: 'class', negate: false, ranges: DIGIT };
      case 0x44: /* D */ return { kind: 'class', negate: true, ranges: DIGIT };
      case 0x77: /* w */ return { kind: 'class', negate: false, ranges: WORD };
      case 0x57: /* W */ return { kind: 'class', negate: true, ranges: WORD };
      case 0x73: /* s */ return { kind: 'class', negate: false, ranges: SPACE };
      case 0x53: /* S */ return { kind: 'class', negate: true, ranges: SPACE };
      case 0x62: /* b */
        if (inClass) return { kind: 'char', code: 0x08 };
        return { kind: 'boundary' };
      case 0x42: /* B */
        return this.fail('unsupported', '\\B is not supported');
      case 0x74: /* t */ return { kind: 'char', code: 0x09 };
      case 0x6e: /* n */ return { kind: 'char', code: 0x0a };
      case 0x72: /* r */ return { kind: 'char', code: 0x0d };
      case 0x66: /* f */ return { kind: 'char', code: 0x0c };
      case 0x76: /* v */ return { kind: 'char', code: 0x0b };
      default:
        if (cp >= 0x30 && cp <= 0x39) this.fail('unsupported', 'backreferences are not supported');
        if (cp === 0x70 || cp === 0x50 || cp === 0x75 || cp === 0x78 || cp === 0x63 || cp === 0x6b) {
          this.fail('unsupported', `\\${String.fromCodePoint(cp)} escapes are not supported`);
        }
        // Any other escaped character is that character literally.
        return { kind: 'char', code: cp };
    }
  }

  private parseClass(): Node {
    let negate = false;
    if (this.peek() === 0x5e /* ^ */) { negate = true; this.pos++; }
    const ranges: Array<[number, number]> = [];
    let first = true;
    for (;;) {
      const cp = this.peek();
      if (cp === undefined) this.fail('syntax', 'missing "]"');
      if (cp === 0x5d /* ] */ && !first) { this.pos++; break; }
      first = false;
      const lo = this.parseClassAtom(ranges);
      if (lo === null) continue; // a \d-style shorthand already added its ranges
      if (this.peek() === 0x2d /* - */ && this.cps[this.pos + 1] !== undefined && this.cps[this.pos + 1] !== 0x5d) {
        this.pos++;
        const hi = this.parseClassAtom(ranges);
        if (hi === null) this.fail('syntax', 'a shorthand class cannot end a range');
        if (hi < lo) this.fail('syntax', 'character range is out of order');
        pushFoldedRange(ranges, lo, hi);
      } else {
        pushFoldedRange(ranges, lo, lo);
      }
    }
    return { kind: 'class', negate, ranges };
  }

  // Returns one class member's code point, or null after appending a
  // shorthand class's ranges (\d, \w, \s) to `into`.
  private parseClassAtom(into: Array<[number, number]>): number | null {
    const cp = this.next();
    if (cp !== 0x5c /* \ */) return cp;
    const node = this.parseEscape(true);
    if (node.kind === 'char') return node.code;
    if (node.kind === 'class') {
      if (node.negate) this.fail('unsupported', 'negated shorthand inside a class is not supported');
      into.push(...node.ranges);
      return null;
    }
    return this.fail('syntax', 'unexpected escape inside a class');
  }
}

// Case-insensitive matching: a class that names one case of an ASCII letter
// range also admits the other.
function pushFoldedRange(into: Array<[number, number]>, lo: number, hi: number): void {
  into.push([lo, hi]);
  const a = Math.max(lo, 0x41), b = Math.min(hi, 0x5a);
  if (a <= b) into.push([a + 0x20, b + 0x20]);
  const c = Math.max(lo, 0x61), d = Math.min(hi, 0x7a);
  if (c <= d) into.push([c - 0x20, d - 0x20]);
}

function foldCase(cp: number): number {
  // Simple case folding for the Basic Latin block; other scripts compare
  // exactly. Matches how the DSL's other string operators behave.
  return cp >= 0x41 && cp <= 0x5a ? cp + 0x20 : cp;
}

// ---------------------------------------------------------------------------
// NFA

type State =
  | { kind: 'char'; code: number; out: number }
  | { kind: 'any'; out: number }
  | { kind: 'class'; negate: boolean; ranges: Array<[number, number]>; out: number }
  | { kind: 'split'; out: number; out2: number }
  | { kind: 'start'; out: number }
  | { kind: 'end'; out: number }
  | { kind: 'boundary'; out: number }
  | { kind: 'match' };

interface Fragment { start: number; ends: number[] }

class Compiler {
  readonly states: State[] = [];

  private add(state: State): number {
    if (this.states.length >= MAX_SAFE_REGEX_STATES) {
      throw new SafeRegexError('too-complex', 'pattern expands to too many states');
    }
    this.states.push(state);
    return this.states.length - 1;
  }

  private patch(ends: number[], target: number): void {
    for (const idx of ends) {
      const s = this.states[idx]!;
      if (s.kind === 'match') continue;
      if (s.kind === 'split') {
        if (s.out === -1) s.out = target;
        else s.out2 = target;
      } else {
        s.out = target;
      }
    }
  }

  compile(node: Node): number {
    const frag = this.fragment(node);
    const match = this.add({ kind: 'match' });
    this.patch(frag.ends, match);
    return frag.start;
  }

  private fragment(node: Node): Fragment {
    switch (node.kind) {
      case 'char': { const i = this.add({ kind: 'char', code: node.code, out: -1 }); return { start: i, ends: [i] }; }
      case 'any': { const i = this.add({ kind: 'any', out: -1 }); return { start: i, ends: [i] }; }
      case 'class': { const i = this.add({ kind: 'class', negate: node.negate, ranges: node.ranges, out: -1 }); return { start: i, ends: [i] }; }
      case 'start': { const i = this.add({ kind: 'start', out: -1 }); return { start: i, ends: [i] }; }
      case 'end': { const i = this.add({ kind: 'end', out: -1 }); return { start: i, ends: [i] }; }
      case 'boundary': { const i = this.add({ kind: 'boundary', out: -1 }); return { start: i, ends: [i] }; }
      case 'seq': {
        if (!node.items.length) return this.empty();
        let frag = this.fragment(node.items[0]!);
        for (let k = 1; k < node.items.length; k++) {
          const next = this.fragment(node.items[k]!);
          this.patch(frag.ends, next.start);
          frag = { start: frag.start, ends: next.ends };
        }
        return frag;
      }
      case 'alt': {
        let frag = this.fragment(node.branches[0]!);
        for (let k = 1; k < node.branches.length; k++) {
          const other = this.fragment(node.branches[k]!);
          const split = this.add({ kind: 'split', out: frag.start, out2: other.start });
          frag = { start: split, ends: [...frag.ends, ...other.ends] };
        }
        return frag;
      }
      case 'repeat':
        return this.repeat(node);
    }
  }

  private empty(): Fragment {
    // An epsilon edge, expressed as a split whose second branch is patched
    // to the same target as the first.
    const i = this.add({ kind: 'split', out: -1, out2: -1 });
    return { start: i, ends: [i, i] };
  }

  private repeat(node: Extract<Node, { kind: 'repeat' }>): Fragment {
    const parts: Fragment[] = [];
    for (let k = 0; k < node.min; k++) parts.push(this.fragment(node.item));
    if (node.max === null) {
      // item* — a split that either enters the item or skips past it, with
      // the item's ends looping back to the split.
      const inner = this.fragment(node.item);
      const split = this.add({ kind: 'split', out: inner.start, out2: -1 });
      this.patch(inner.ends, split);
      parts.push({ start: split, ends: [split] });
    } else {
      for (let k = node.min; k < node.max; k++) {
        const inner = this.fragment(node.item);
        const split = this.add({ kind: 'split', out: inner.start, out2: -1 });
        parts.push({ start: split, ends: [split, ...inner.ends] });
      }
    }
    if (!parts.length) return this.empty();
    let frag = parts[0]!;
    for (let k = 1; k < parts.length; k++) {
      this.patch(frag.ends, parts[k]!.start);
      frag = { start: frag.start, ends: parts[k]!.ends };
    }
    return frag;
  }
}

// ---------------------------------------------------------------------------
// Public API

export class SafeRegex {
  private readonly states: State[];
  private readonly start: number;
  readonly source: string;

  private constructor(source: string, states: State[], start: number) {
    this.source = source;
    this.states = states;
    this.start = start;
  }

  /** Compiles `pattern`, throwing SafeRegexError on anything outside the supported grammar. */
  static compile(pattern: string): SafeRegex {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new SafeRegexError('empty', 'pattern is empty');
    }
    if (pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) {
      throw new SafeRegexError('too-long', `pattern is longer than ${MAX_SAFE_REGEX_PATTERN_LENGTH} characters`);
    }
    const ast = new Parser(pattern).parse();
    const compiler = new Compiler();
    const start = compiler.compile(ast);
    return new SafeRegex(pattern, compiler.states, start);
  }

  /** Like compile() but returns null instead of throwing. */
  static tryCompile(pattern: string): SafeRegex | null {
    try {
      return SafeRegex.compile(pattern);
    } catch (err) {
      if (err instanceof SafeRegexError) return null;
      throw err;
    }
  }

  /** True if the pattern matches anywhere in `input` (unless anchored). */
  test(input: string): boolean {
    const cps = Array.from(input, (ch) => foldCase(ch.codePointAt(0)!));
    const n = this.states.length;
    // Two generations of state sets, tracked with a visited stamp so adding
    // the same state twice in one step is free.
    let current: number[] = [];
    let following: number[] = [];
    const stamp = new Int32Array(n);
    let generation = 1;

    const addState = (list: number[], idx: number, pos: number): void => {
      if (stamp[idx] === generation) return;
      stamp[idx] = generation;
      const s = this.states[idx]!;
      switch (s.kind) {
        case 'split':
          addState(list, s.out, pos);
          addState(list, s.out2, pos);
          return;
        case 'start':
          if (pos === 0) addState(list, s.out, pos);
          return;
        case 'end':
          if (pos === cps.length) addState(list, s.out, pos);
          return;
        case 'boundary': {
          const before = pos > 0 && isWordChar(cps[pos - 1]!);
          const after = pos < cps.length && isWordChar(cps[pos]!);
          if (before !== after) addState(list, s.out, pos);
          return;
        }
        default:
          list.push(idx);
      }
    };

    for (let pos = 0; pos <= cps.length; pos++) {
      // Unanchored search: the start state is (re)entered at every position.
      generation++;
      // Carry over the states reached by consuming the previous character,
      // then add a fresh thread starting here.
      for (const idx of current) {
        stamp[idx] = generation;
        following.push(idx);
      }
      addState(following, this.start, pos);
      [current, following] = [following, current];
      following.length = 0;

      for (const idx of current) {
        if (this.states[idx]!.kind === 'match') return true;
      }
      if (pos === cps.length) break;
      const cp = cps[pos]!;
      generation++;
      for (const idx of current) {
        const s = this.states[idx]!;
        let consumes = false;
        if (s.kind === 'char') consumes = s.code === cp;
        else if (s.kind === 'any') consumes = cp !== 0x0a && cp !== 0x0d;
        else if (s.kind === 'class') consumes = inRanges(s.ranges, cp) !== s.negate;
        if (consumes) addState(following, (s as { out: number }).out, pos + 1);
      }
      [current, following] = [following, current];
      following.length = 0;
    }
    return false;
  }
}

function inRanges(ranges: Array<[number, number]>, cp: number): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function isWordChar(cp: number): boolean {
  return inRanges(WORD, cp);
}
