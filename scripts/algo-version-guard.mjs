// Algo-version guard.
//
// Fails when the algorithm-defining structures (ARCHETYPES,
// TIER_ARCHETYPE_WEIGHTS, SAFE_RANGES) in eviland-randomizer.ts or
// eviland-director.ts change WITHOUT VISUAL_MEMORY_ALGO_VERSION moving in
// eviland-memory-types.ts. The constant lives in the mirrored memory-types
// file precisely so this guard has a stable, single source-of-truth to watch.
//
// Why this matters: a meaningful change to those structures means stored seeds
// in users' VisualMemoryPlans will no longer map to the looks they originally
// produced. The Director's algoVersion-mismatch path handles that gracefully
// (loads fingerprints only, re-derives looks) — but ONLY if the constant bumps
// so old plans are flagged stale. Forgetting the bump means tracks silently
// snap to different looks the moment users upgrade.
//
// How it works: we extract the LITERAL source range of each watched constant
// from both the base (HEAD by default) and the working tree, hash the ranges,
// and compare. Mere references to the symbols (e.g. `ARCHETYPES.map(...)`) are
// IGNORED — only changes to the DECLARATIONS' bodies count.
//
// Usage:
//   node scripts/algo-version-guard.mjs                  # HEAD..working tree
//   node scripts/algo-version-guard.mjs --base origin/main
//
// Skips cleanly when run outside a git checkout (e.g. tarball release flows).
// Exits 0 when no algorithm-defining structures changed OR the constant bumped
// alongside them.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WATCHED_FILES = [
  'src/visualizer/eviland-randomizer.ts',
  'src/visualizer/eviland-director.ts',
];
const VERSION_FILE = 'src/visualizer/eviland-memory-types.ts';
// The same constant is declared in three places. Two are kept byte-identical by
// packages/eviland-core/sync.mjs; shared/visual-memory.ts is a hand-maintained
// third copy that nothing watched, so a bump here could silently leave the
// renderer and the shared validator disagreeing about what a stale plan is.
const VERSION_MIRRORS = [
  'packages/eviland-core/src/eviland-memory-types.ts',
  'shared/visual-memory.ts',
];
const VERSION_CONST = 'VISUAL_MEMORY_ALGO_VERSION';
const WATCHED_SYMBOLS = ['ARCHETYPES', 'TIER_ARCHETYPE_WEIGHTS', 'SAFE_RANGES'];

const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';

function tryGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

const inGit = tryGit(['rev-parse', '--is-inside-work-tree']);
if (!inGit || inGit.trim() !== 'true') {
  console.log('[algo-version-guard] not a git checkout — skipping');
  process.exit(0);
}

for (const f of [...WATCHED_FILES, VERSION_FILE]) {
  if (!existsSync(resolve(f))) {
    console.error(`[algo-version-guard] expected file missing: ${f}`);
    process.exit(1);
  }
}

/**
 * Extract the source range for a `const NAME = ...;` (or `export const NAME = ...;`)
 * declaration. We balance brackets/parens/braces so multi-line object and
 * record literals are captured exactly. Returns null when the declaration is
 * not found in the supplied text.
 */
function extractDeclaration(source, name) {
  // Find the declaration start. Anchor at line start to avoid matching the
  // identifier as a property or comment occurrence.
  const re = new RegExp(`^(?:export\\s+)?const\\s+${name}\\b`, 'm');
  const m = source.match(re);
  if (!m || m.index == null) return null;
  const start = m.index;
  // Walk forward, counting open/close pairs across (), [], {}. End at the
  // top-level semicolon following the closing bracket (or at the first `;` if
  // the value is a primitive literal).
  let depth = 0;
  let i = start;
  let sawAny = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      sawAny = true;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ';' && depth === 0 && sawAny) {
      return source.slice(start, i + 1);
    } else if (ch === '=' && depth === 0 && !sawAny) {
      // The `=` sign appears before the first bracket. If the RHS is a
      // primitive literal (number, string), there will be no brackets at all —
      // close on the next semicolon.
      let j = i + 1;
      // Skip whitespace.
      while (j < source.length && /\s/.test(source[j])) j++;
      if (
        source[j] !== '(' &&
        source[j] !== '[' &&
        source[j] !== '{'
      ) {
        // Primitive RHS — scan to next top-level ;.
        while (j < source.length && source[j] !== ';') j++;
        return source.slice(start, j + 1);
      }
    }
    i++;
  }
  return null;
}

function fingerprint(text) {
  // Whitespace-normalised hash so cosmetic reformatting doesn't trigger the
  // guard. We collapse runs of whitespace and strip line-leading whitespace.
  const normalized = text.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function loadFromGit(ref, path) {
  // Returns the file contents at the given ref. `--` is required for paths
  // that may collide with ref names. Returns '' when the file doesn't exist
  // at that ref (intentional — file just added in working tree).
  const out = tryGit(['show', `${ref}:${path}`]);
  return out ?? '';
}

const changedDecls = [];
for (const file of WATCHED_FILES) {
  const baseSrc = loadFromGit(base, file);
  const headSrc = readFileSync(resolve(file), 'utf8');
  for (const sym of WATCHED_SYMBOLS) {
    const baseDecl = extractDeclaration(baseSrc, sym);
    const headDecl = extractDeclaration(headSrc, sym);
    // Only declarations that exist on at least one side count. A symbol that
    // was never defined in a given file is fine.
    if (baseDecl == null && headDecl == null) continue;
    const baseFp = baseDecl == null ? '∅' : fingerprint(baseDecl);
    const headFp = headDecl == null ? '∅' : fingerprint(headDecl);
    if (baseFp !== headFp) {
      changedDecls.push({ file, symbol: sym, baseFp, headFp });
    }
  }
}

checkVersionMirrors();

if (changedDecls.length === 0) {
  console.log(`[algo-version-guard] no algorithm-defining declarations changed since ${base} — OK`);
  process.exit(0);
}

// At least one watched declaration changed. Did VISUAL_MEMORY_ALGO_VERSION
// move?
const baseTypes = loadFromGit(base, VERSION_FILE);
const headTypes = readFileSync(resolve(VERSION_FILE), 'utf8');

function readVersionLiteral(source) {
  const re = new RegExp(`${VERSION_CONST}\\s*=\\s*(\\d+)`);
  const m = source.match(re);
  return m ? Number(m[1]) : null;
}

// Every copy of the constant must agree, whatever the value is, and this runs
// whether or not any declaration changed. A bump that lands in one file and not
// another is worse than no bump: the renderer would treat a plan as current
// while the shared validator called it stale.
function checkVersionMirrors() {
  const current = readVersionLiteral(readFileSync(resolve(VERSION_FILE), 'utf8'));
  for (const mirror of VERSION_MIRRORS) {
    const mirrorPath = resolve(mirror);
    if (!existsSync(mirrorPath)) {
      console.error(`[algo-version-guard] FAIL: expected ${VERSION_CONST} mirror ${mirror} to exist`);
      process.exit(1);
    }
    const mirrorVersion = readVersionLiteral(readFileSync(mirrorPath, 'utf8'));
    if (mirrorVersion !== current) {
      console.error(
        `[algo-version-guard] FAIL: ${VERSION_CONST} is ${current} in ${VERSION_FILE} ` +
        `but ${mirrorVersion} in ${mirror}. Every copy must carry the same version.`,
      );
      process.exit(1);
    }
  }
}
const baseVersion = readVersionLiteral(baseTypes);
const headVersion = readVersionLiteral(headTypes);

// Special-case: when the constant doesn't exist at base (this is the
// introducing change) and DOES exist at head — that counts as "moved". This is
// the "passes trivially on your own change" rule the scope calls out.
const constantChanged =
  baseVersion === null || headVersion === null
    ? baseVersion !== headVersion
    : headVersion !== baseVersion;

if (constantChanged) {
  console.log(
    `[algo-version-guard] ${changedDecls.length} declaration(s) changed and ${VERSION_CONST} ` +
      `moved from ${baseVersion ?? 'absent'} to ${headVersion ?? 'absent'} — OK`,
  );
  process.exit(0);
}

const sample = changedDecls.slice(0, 5);
console.error(
  `[algo-version-guard] FAIL: ${changedDecls.length} algorithm-defining declaration(s) changed in ` +
    `${WATCHED_FILES.join(' / ')} since ${base}, but ${VERSION_CONST} did NOT change ` +
    `in ${VERSION_FILE}.\n\n` +
    `Old VisualMemoryPlans persisted before this change will silently map their seeds ` +
    `to looks the new algorithm does not produce. Bump ${VERSION_CONST} in ` +
    `${VERSION_FILE} (it lives there precisely so this guard has a single source of truth)\n` +
    `so old plans are flagged stale and gracefully re-derived.\n\n` +
    `Changed:\n` +
    sample.map((c) => `  ${c.file}: ${c.symbol}  (${c.baseFp.slice(0, 8)} → ${c.headFp.slice(0, 8)})`).join('\n') +
    (changedDecls.length > sample.length ? `\n  ...and ${changedDecls.length - sample.length} more` : ''),
);
process.exit(1);
