import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLastfmLiveProof, summarizeLastfmLiveProof } from './lastfm-live-proof.mjs';
import { checkManualListeningProof, summarizeManualListeningProof } from './manual-listening-proof.mjs';
import { checkReleaseBundle } from './release-bundle.mjs';
import { checkReleaseChecksums } from './release-checksums.mjs';
import { buildGithubPublishPlan } from './publish-github-release.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flags = new Set(args);
const allowIncomplete = flags.has('--allow-incomplete');
const includeRealLibrary = flags.has('--real-library');
const realLibraryRoot = optionValue('--library-root') || process.env.NEWAMP_REAL_LIBRARY_ROOT || 'K:/music';
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const objective =
  'make this project better than the original Winamp from the 2000s; be ambitious; create skins; create an installer/exe; create the full application';

const checksumReport = checkReleaseChecksums({ root: repoRoot, version: pkg.version });
const bundleReport = checkReleaseBundle({ root: repoRoot, version: pkg.version });
const manualProof = checkManualListeningProof();
const lastfmProof = checkLastfmLiveProof();
const publishPlan = buildGithubPublishPlan({ root: repoRoot, env: process.env });
const publicationReadiness = runNodeScript('publication-readiness.mjs', []);
const realLibraryProof = includeRealLibrary ? runRealLibraryProof(realLibraryRoot) : notRun(
  `Run ${displayCommand(process.execPath, [relativePath(scriptPath), '--real-library'])} for fresh K:/music scale proof.`,
);

const checklist = [
  item('full-application-shell', 'A real local desktop music player exists, not a demo surface.', [
    scriptCheck('build'),
    scriptCheck('start'),
    scriptCheck('package'),
    fileExists('electron/main.ts'),
    fileExists('src/App.tsx'),
    fileContains('README.md', /local-first Windows music player/i),
  ]),
  item('installer-and-exe', 'The project creates installable and portable Windows application artifacts.', [
    scriptCheck('package'),
    check('release checksums current', checksumReport.ok, checksumReport.reason, {
      path: relativePath(checksumReport.path),
      artifacts: checksumReport.artifacts,
    }),
    ...checksumReport.artifacts.map((artifact) =>
      check(`${artifact.name} artifact`, artifact.ok && artifact.sizeOk !== false, artifact.reason ?? 'artifact is missing or below size threshold', {
        path: artifact.path,
        bytes: artifact.bytes ?? null,
        sha256: artifact.sha256 ?? null,
      }),
    ),
  ]),
  item('skins', 'Skins are first-class, including Winamp classic import and custom skin export/import.', [
    scriptCheck('smoke:skin'),
    fileExists('electron/winamp-skin-import.ts'),
    fileExists('shared/custom-skin.ts'),
    fileContains('src/styles/index.css', /NewAmp skin system/i),
    fileContains('README.md', /\.newampskin\.json/i),
    fileContains('README.md', /\.wsz/i),
  ]),
  item('visualizer', 'Visualizer support goes beyond static playback UI.', [
    scriptCheck('smoke:visualizer'),
    scriptCheck('smoke:ui-visualizer'),
    dependencyCheck('butterchurn'),
    dependencyCheck('butterchurn-presets'),
    fileContains('README.md', /Milkdrop visualizer/i),
  ]),
  item('album-art-and-metadata', 'Album art and metadata rescue are implemented and covered.', [
    scriptCheck('smoke:album-art'),
    scriptCheck('smoke:metadata'),
    fileExists('scripts/album-art-smoke.mjs'),
    fileContains('README.md', /Album art rescue/i),
    fileContains('README.md', /Metadata rescue/i),
  ]),
  item('artist-facts-and-images', 'Artist facts and images are available from the playback surface.', [
    scriptCheck('smoke:artist'),
    fileExists('src/api/artistFacts.ts'),
    fileContains('README.md', /Artist facts and images/i),
    fileContains('src/api/artistFacts.ts', /image/i),
  ]),
  item('guitar-tab-play-along', 'Current-song guitar tab lookup and native tab windows are implemented with local fallbacks.', [
    scriptCheck('smoke:tabs'),
    fileExists('electron/guitar-tabs.ts'),
    fileContains('src/components/GuitarTabCompanion.tsx', /openGuitarTabWindow/),
    fileContains('scripts/tabs-smoke.mjs', /parseUltimateGuitar/),
    fileContains('scripts/tabs-smoke.mjs', /sidecar/i),
    fileContains('README.md', /pop out a native tab window/i),
  ]),
  item('custom-playlists', 'Users can create named custom playlists and attach playlist images/icons.', [
    scriptCheck('smoke:playlist'),
    fileContains('electron/library.ts', /savePlaylist\(input: SavePlaylistInput\)/),
    fileContains('electron/library.ts', /writePlaylistCover/),
    fileContains('src/components/views/PlaylistView.tsx', /data-playlist-icon-dropzone/),
    fileContains('scripts/playlist-smoke.mjs', /CREATE EMPTY PLAYLIST/),
    fileContains('README.md', /pick or drop playlist artwork/i),
  ]),
  item('large-local-library-proof', 'The player handles large local music libraries (tens of thousands of tracks).', [
    realLibraryProof,
  ]),
  item('audio-player-depth', 'The app has mature player behavior beyond basic play/pause.', [
    scriptCheck('smoke:playback-start'),
    scriptCheck('smoke:playback-controls'),
    scriptCheck('smoke:handoff'),
    scriptCheck('smoke:replaygain'),
    scriptCheck('smoke:eq'),
    scriptCheck('smoke:audio-limiter'),
    scriptCheck('smoke:cue'),
    scriptCheck('smoke:media-session'),
    fileContains('README.md', /ReplayGain/i),
    fileContains('README.md', /crossfade\/gapless/i),
  ]),
  item('release-gates-and-publication-plan', 'The release path is explicit, guarded, and ready to publish only when true blockers close.', [
    scriptCheck('release:gate'),
    scriptCheck('release:publication-readiness'),
    scriptCheck('release:publish-github'),
    scriptCheck('release:sign'),
    check('release bundle current', bundleReport.ok, bundleReport.reason, {
      paths: bundleReport.paths,
      bundle: bundleReport.bundle ?? null,
      sourceArchive: bundleReport.sourceArchive ?? null,
    }),
    check('public source archive hygiene', bundleReport.sourceArchive?.ok === true, bundleReport.sourceArchive?.reason ?? 'source archive hygiene was not checked', {
      entryCount: bundleReport.sourceArchive?.entryCount ?? null,
      forbiddenEntries: bundleReport.sourceArchive?.forbiddenEntries ?? null,
    }),
    check('GitHub publish dry-run plan', publishPlan.ok, publishPlan.reason, {
      repo: publishPlan.repo,
      tag: publishPlan.tag,
      artifacts: publishPlan.artifacts ?? null,
      commands: publishPlan.commands?.map((command) => command.label) ?? [],
      executed: false,
    }),
    check('publication readiness', publicationReadiness.ok, publicationReadiness.reason, {
      exitCode: publicationReadiness.exitCode,
      blockers: publicationReadiness.report?.blockers ?? null,
    }),
  ]),
  item('manual-and-live-release-proofs', 'Human listening, Last.fm live account, and signing proofs are current for the exact artifacts.', [
    check('manual listening proof', manualProof.ok, summarizeManualListeningProof(manualProof), {
      proofPath: relativePath(manualProof.proofPath),
    }),
    check('Last.fm live proof', lastfmProof.ok, summarizeLastfmLiveProof(lastfmProof), {
      proofPath: relativePath(lastfmProof.proofPath),
      username: lastfmProof.username ?? null,
    }),
    check('signed public artifacts', publicationReadiness.report?.checks?.find((entry) => entry.name === 'signed-artifacts')?.ok === true, 'release artifacts are not Authenticode-signed yet', {
      signatures: publicationReadiness.report?.checks?.find((entry) => entry.name === 'signed-artifacts')?.artifacts ?? null,
    }),
  ]),
];

const blockers = checklist.flatMap((entry) =>
  entry.ok
    ? []
    : entry.checks
      .filter((evidence) => evidence.ok !== true)
      .map((evidence) => `${entry.id}: ${evidence.label}: ${evidence.reason ?? evidence.status}`),
);

const report = {
  name: 'newamp-completion-audit',
  ok: blockers.length === 0,
  objective,
  version: pkg.version,
  verificationMode: {
    allowIncomplete,
    realLibrary: includeRealLibrary,
    realLibraryRoot,
  },
  checklist,
  blockers,
  conclusion: blockers.length === 0
    ? 'Objective achieved: all explicit deliverables and release requirements are backed by current evidence.'
    : 'Objective not complete: remaining blockers still require evidence or human/external action.',
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok || allowIncomplete ? 0 : 1;

function item(id, requirement, checks) {
  return {
    id,
    requirement,
    ok: checks.every((entry) => entry.ok === true),
    checks,
  };
}

function check(label, ok, reason = null, details = {}) {
  return {
    label,
    ok: !!ok,
    status: ok ? 'pass' : 'fail',
    reason: ok ? null : reason,
    ...details,
  };
}

function notRun(reason) {
  return {
    label: 'fresh real-library proof',
    ok: false,
    status: 'not-run',
    reason,
  };
}

function scriptCheck(name) {
  return check(`package script ${name}`, !!pkg.scripts?.[name], `package.json is missing script ${name}`, {
    script: pkg.scripts?.[name] ?? null,
  });
}

function dependencyCheck(name) {
  return check(`dependency ${name}`, !!pkg.dependencies?.[name] || !!pkg.devDependencies?.[name], `package.json is missing ${name}`, {
    version: pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null,
  });
}

function fileExists(path) {
  return check(`file ${path}`, existsSync(join(repoRoot, path)), `${path} is missing`, { path });
}

function fileContains(path, pattern) {
  const text = readText(path);
  return check(`source evidence ${path}`, text !== null && pattern.test(text), `${path} does not contain ${pattern}`, {
    path,
  });
}

function readText(path) {
  const fullPath = join(repoRoot, path);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : null;
}

function runRealLibraryProof(root) {
  if (!existsSync(root)) {
    return check('fresh real-library proof', false, `${root} does not exist`, { root });
  }
  const build = run('npm', ['run', 'build:electron']);
  if (!build.ok) {
    return check('fresh real-library proof', false, 'build:electron failed before real-library proof', {
      root,
      build,
    });
  }
  const first = run(process.execPath, [join(repoRoot, 'scripts', 'full-library-smoke.mjs'), root], {
    timeout: 360_000,
    env: {
      NEWAMP_FULL_SCAN_CLEAN: '1',
      NEWAMP_FULL_SCAN_SKIP_ART_STORAGE: '1',
    },
  });
  if (!first.ok) cleanFullLibrarySmokeRoot();
  const second = first.ok
    ? run(process.execPath, [join(repoRoot, 'scripts', 'full-library-smoke.mjs'), root], {
      timeout: 120_000,
      env: {
        NEWAMP_FULL_SCAN_CLEAN_AFTER: '1',
        NEWAMP_FULL_SCAN_SKIP_ART_STORAGE: '1',
        NEWAMP_FULL_SCAN_EXPECT_INCREMENTAL: '1',
        NEWAMP_FULL_SCAN_MAX_MS: process.env.NEWAMP_FULL_SCAN_INCREMENTAL_MAX_MS || '60000',
        NEWAMP_FULL_SCAN_MIN_SKIPPED: process.env.NEWAMP_FULL_SCAN_MIN_SKIPPED || '5000',
      },
    })
    : null;

  const firstReport = parseJson(first.stdout);
  const secondReport = second ? parseJson(second.stdout) : null;
  return check('fresh real-library proof', first.ok && second?.ok === true, first.ok ? 'incremental full-library proof failed' : 'full-library proof failed', {
    root,
    first: summarizeFullLibraryRun(first, firstReport),
    incremental: second ? summarizeFullLibraryRun(second, secondReport) : null,
  });
}

function cleanFullLibrarySmokeRoot() {
  const smokeRoot = join(repoRoot, 'tmp', 'full-library-smoke');
  const resolved = resolve(smokeRoot);
  const relativePath = relative(repoRoot, resolved);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`refusing to clean outside repo: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function summarizeFullLibraryRun(result, parsed) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    elapsedMs: parsed?.elapsedMs ?? null,
    stats: parsed?.stats ?? null,
    checks: parsed?.checks ?? null,
    finalProgress: parsed?.finalProgress ?? null,
    stderrTail: result.stderrTail,
  };
}

function runNodeScript(script, scriptArgs) {
  const result = run(process.execPath, [join(repoRoot, 'scripts', script), ...scriptArgs], { timeout: 45_000 });
  const report = parseJson(result.stdout);
  return {
    label: script,
    ok: result.ok && report?.ok === true,
    exitCode: result.exitCode,
    reason: result.ok && report?.ok === true
      ? null
      : report?.blockers?.join('; ') || report?.reason || result.stderrTail || 'script failed',
    report,
  };
}

function run(command, commandArgs, options = {}) {
  const isWindows = process.platform === 'win32';
  const env = { ...process.env, ...(options.env ?? {}) };
  const result = spawnSync(
    isWindows && basename(command) !== 'node.exe' && command !== process.execPath ? 'cmd.exe' : command,
    isWindows && basename(command) !== 'node.exe' && command !== process.execPath
      ? ['/d', '/s', '/c', [quoteForCmd(command), ...commandArgs.map(quoteForCmd)].join(' ')]
      : commandArgs,
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeout ?? 30_000,
      env,
    },
  );
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderrTail: tail(result.stderr),
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function relativePath(path) {
  if (!path) return null;
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith('..') ? rel.replaceAll('\\', '/') : path;
}

function displayCommand(command, commandArgs) {
  return [command, ...commandArgs].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

function basename(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

function quoteForCmd(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function tail(value) {
  return (value ?? '').trim().split(/\r?\n/).slice(-30).join('\n');
}
