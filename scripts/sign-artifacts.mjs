import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve('.');
const defaultTimestampUrl = 'http://timestamp.digicert.com';

export function defaultSigningArtifacts(root = repoRoot) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').trim() || '0.0.0';
  return [
    { name: 'installer', path: resolve(root, 'release', `NewAmp Setup ${version}.exe`) },
    { name: 'portable', path: resolve(root, 'release', `NewAmp Portable ${version}.exe`) },
    { name: 'exe', path: resolve(root, 'release', 'win-unpacked', 'NewAmp.exe') },
  ];
}

export function buildSigningPlan({
  artifacts = defaultSigningArtifacts(),
  env = process.env,
  requireExistingTool = true,
} = {}) {
  const artifactProof = artifacts.map(fingerprintArtifact);
  const missingArtifacts = artifactProof.filter((artifact) => !artifact.exists);
  if (missingArtifacts.length) {
    return failedPlan({
      reason: `missing release artifacts: ${missingArtifacts.map((artifact) => artifact.name).join(', ')}`,
      artifacts: artifactProof,
      env,
    });
  }

  const signtoolPath = resolveSigntool(env, requireExistingTool);
  if (!signtoolPath.ok) {
    return failedPlan({ reason: signtoolPath.reason, artifacts: artifactProof, env });
  }

  const identity = resolveSigningIdentity(env, requireExistingTool);
  if (!identity.ok) {
    return failedPlan({ reason: identity.reason, artifacts: artifactProof, env, signtoolPath: signtoolPath.path });
  }

  const timestampUrl = text(env.NEWAMP_TIMESTAMP_URL) || text(env.SIGNTOOL_TIMESTAMP_URL) || defaultTimestampUrl;
  const commands = artifactProof.map((artifact) => ({
    name: `sign:${artifact.name}`,
    tool: signtoolPath.path,
    displayArgs: displayArgsFor(identity, timestampUrl, artifact.path),
    artifact,
  }));

  return {
    name: 'signing-workflow',
    ok: true,
    mode: identity.mode,
    signtool: signtoolPath.displayPath,
    timestampUrl,
    commands,
    artifacts: artifactProof,
    env: redactedEnvSummary(env, identity),
    reason: null,
  };
}

export function signArtifacts({
  dryRun = false,
  artifacts = defaultSigningArtifacts(),
  env = process.env,
  requireExistingTool = true,
} = {}) {
  const plan = buildSigningPlan({ artifacts, env, requireExistingTool });
  if (!plan.ok) return { ...plan, executed: false, results: [] };
  if (dryRun) return { ...plan, executed: false, results: [] };

  const identity = resolveSigningIdentity(env, requireExistingTool);
  const timestampUrl = text(env.NEWAMP_TIMESTAMP_URL) || text(env.SIGNTOOL_TIMESTAMP_URL) || defaultTimestampUrl;
  const results = [];
  for (const command of plan.commands) {
    const args = executableArgsFor(identity, timestampUrl, command.artifact.path);
    const result = spawnSync(command.tool, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    results.push({
      name: command.name,
      ok: result.status === 0 && !result.error,
      exitCode: result.status,
      error: result.error?.message ?? null,
      stdout: redactSecrets(tail(result.stdout), env),
      stderr: redactSecrets(tail(result.stderr), env),
    });
    if (result.status !== 0 || result.error) {
      return { ...plan, ok: false, executed: true, results, reason: `${command.name} failed` };
    }
  }

  return { ...plan, executed: true, results };
}

function failedPlan({ reason, artifacts, env, signtoolPath = null }) {
  return {
    name: 'signing-workflow',
    ok: false,
    mode: null,
    signtool: signtoolPath ? basename(signtoolPath) : null,
    timestampUrl: text(env.NEWAMP_TIMESTAMP_URL) || text(env.SIGNTOOL_TIMESTAMP_URL) || defaultTimestampUrl,
    commands: [],
    artifacts,
    env: redactedEnvSummary(env),
    reason,
  };
}

function resolveSigntool(env, requireExistingTool) {
  const configured = text(env.NEWAMP_SIGNTOOL_PATH);
  if (configured) {
    const resolved = resolve(configured);
    if (requireExistingTool && !existsSync(resolved)) {
      return { ok: false, path: resolved, displayPath: basename(resolved), reason: `NEWAMP_SIGNTOOL_PATH does not exist: ${resolved}` };
    }
    return { ok: true, path: resolved, displayPath: basename(resolved) };
  }

  if (process.platform !== 'win32') {
    return { ok: false, path: null, displayPath: null, reason: 'signtool.exe is only available on Windows' };
  }

  const result = spawnSync('where.exe', ['signtool.exe'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const found = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : null;
  if (found) return { ok: true, path: found, displayPath: basename(found) };

  const kitTool = findWindowsKitSigntool(env);
  if (kitTool) return { ok: true, path: kitTool, displayPath: basename(kitTool) };

  return { ok: false, path: null, displayPath: null, reason: 'signtool.exe was not found on PATH or in Windows Kits' };
}

function findWindowsKitSigntool(env) {
  const roots = [
    text(env.NEWAMP_WINDOWS_KITS_ROOT),
    text(env['ProgramFiles(x86)']) ? join(text(env['ProgramFiles(x86)']), 'Windows Kits') : '',
    text(env.ProgramFiles) ? join(text(env.ProgramFiles), 'Windows Kits') : '',
    'C:\\Program Files (x86)\\Windows Kits',
    'C:\\Program Files\\Windows Kits',
  ].filter(Boolean);

  for (const root of roots) {
    for (const candidate of windowsKitSigntoolCandidates(root)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function windowsKitSigntoolCandidates(root) {
  const candidates = [join(root, '10', 'App Certification Kit', 'signtool.exe')];
  const binRoot = join(root, '10', 'bin');
  let versionDirs = [];
  try {
    versionDirs = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    versionDirs = [];
  }

  const preferredArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64';
  const arches = [preferredArch, 'x64', 'arm64', 'x86'].filter((arch, index, all) => all.indexOf(arch) === index);
  for (const version of versionDirs) {
    for (const arch of arches) {
      candidates.push(join(binRoot, version, arch, 'signtool.exe'));
    }
  }
  return candidates;
}

function resolveSigningIdentity(env, requireExistingTool) {
  const pfxSource = text(env.NEWAMP_SIGN_CERT_PATH) || text(env.WIN_CSC_LINK) || text(env.CSC_LINK);
  if (pfxSource) {
    const certPath = certificateFilePath(pfxSource);
    if (!certPath) {
      return {
        ok: false,
        reason: 'release:sign supports a local PFX file path or file URL; use electron-builder for URL/base64 certificate sources',
      };
    }
    if (requireExistingTool && !existsSync(certPath)) {
      return { ok: false, reason: `certificate file does not exist: ${certPath}` };
    }
    const password = text(env.NEWAMP_SIGN_CERT_PASSWORD) || text(env.WIN_CSC_KEY_PASSWORD) || text(env.CSC_KEY_PASSWORD);
    if (!password) {
      return { ok: false, reason: 'certificate source is present but password env is missing' };
    }
    return { ok: true, mode: 'pfx', certPath, password };
  }

  const sha1 = text(env.NEWAMP_SIGN_SHA1) || text(env.WIN_CSC_SHA1_HASH) || text(env.CSC_SHA1_HASH);
  if (sha1) return { ok: true, mode: 'store', selector: '/sha1', value: sha1 };

  const subject = text(env.NEWAMP_SIGN_SUBJECT) || text(env.CSC_NAME);
  if (subject) return { ok: true, mode: 'store', selector: '/n', value: subject };

  return {
    ok: false,
    reason: 'no signing identity found: set NEWAMP_SIGN_CERT_PATH/CSC_LINK with a password, or NEWAMP_SIGN_SHA1/NEWAMP_SIGN_SUBJECT for an installed certificate',
  };
}

function displayArgsFor(identity, timestampUrl, artifactPath) {
  if (identity.mode === 'pfx') {
    return [
      'sign',
      '/fd',
      'SHA256',
      '/tr',
      timestampUrl,
      '/td',
      'SHA256',
      '/f',
      identity.certPath,
      '/p',
      '<redacted>',
      artifactPath,
    ];
  }
  return [
    'sign',
    '/fd',
    'SHA256',
    '/tr',
    timestampUrl,
    '/td',
    'SHA256',
    identity.selector,
    identity.value,
    artifactPath,
  ];
}

function executableArgsFor(identity, timestampUrl, artifactPath) {
  if (identity.mode === 'pfx') {
    return displayArgsFor(identity, timestampUrl, artifactPath).map((arg) => (arg === '<redacted>' ? identity.password : arg));
  }
  return displayArgsFor(identity, timestampUrl, artifactPath);
}

function certificateFilePath(value) {
  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return resolve(value);
  return null;
}

function fingerprintArtifact(artifact) {
  if (!existsSync(artifact.path)) {
    return { name: artifact.name, path: artifact.path, exists: false, bytes: 0, sha256: null };
  }
  const stat = statSync(artifact.path);
  return {
    name: artifact.name,
    path: artifact.path,
    exists: true,
    bytes: stat.size,
    sha256: createHash('sha256').update(readFileSync(artifact.path)).digest('hex').toUpperCase(),
  };
}

function redactedEnvSummary(env, identity = null) {
  return {
    hasSigntoolPath: Boolean(text(env.NEWAMP_SIGNTOOL_PATH)),
    hasPfxSource: Boolean(text(env.NEWAMP_SIGN_CERT_PATH) || text(env.WIN_CSC_LINK) || text(env.CSC_LINK)),
    hasPfxPassword: Boolean(text(env.NEWAMP_SIGN_CERT_PASSWORD) || text(env.WIN_CSC_KEY_PASSWORD) || text(env.CSC_KEY_PASSWORD)),
    hasStoreSha1: Boolean(text(env.NEWAMP_SIGN_SHA1) || text(env.WIN_CSC_SHA1_HASH) || text(env.CSC_SHA1_HASH)),
    hasStoreSubject: Boolean(text(env.NEWAMP_SIGN_SUBJECT) || text(env.CSC_NAME)),
    identityMode: identity?.mode ?? null,
  };
}

function redactSecrets(value, env) {
  let textValue = value ?? '';
  for (const secret of [
    env.NEWAMP_SIGN_CERT_PASSWORD,
    env.WIN_CSC_KEY_PASSWORD,
    env.CSC_KEY_PASSWORD,
  ]) {
    if (typeof secret === 'string' && secret) textValue = textValue.split(secret).join('<redacted>');
  }
  return textValue;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function tail(value) {
  return (value ?? '').trim().split(/\r?\n/).slice(-20).join('\n');
}

function parseCli(argv) {
  const flags = new Set(argv);
  return {
    dryRun: flags.has('--dry-run'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run release:sign -- --dry-run',
    '  npm run release:sign',
    '',
    'Supported signing identities:',
    '  PFX file: NEWAMP_SIGN_CERT_PATH or CSC_LINK/WIN_CSC_LINK + password env',
    '  Installed cert: NEWAMP_SIGN_SHA1 or NEWAMP_SIGN_SUBJECT',
    '',
    'The JSON report redacts certificate passwords.',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printUsage();
  } else {
    const report = signArtifacts({ dryRun: cli.dryRun });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}
