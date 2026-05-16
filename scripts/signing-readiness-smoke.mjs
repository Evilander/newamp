import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const repoRoot = resolve('.');
const packagePath = resolve(repoRoot, 'package.json');

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const releaseVersion = String(pkg.version ?? '').trim() || '0.0.0';
const installerPath = resolve(repoRoot, 'release', `Newamp Setup ${releaseVersion}.exe`);
const portablePath = resolve(repoRoot, 'release', `Newamp Portable ${releaseVersion}.exe`);
const exePath = resolve(repoRoot, 'release', 'win-unpacked', 'Newamp.exe');
const artifacts = [
  { name: 'installer', path: installerPath },
  { name: 'portable', path: portablePath },
  { name: 'exe', path: exePath },
].map((item) => ({ ...item, exists: existsSync(item.path), signature: signatureStatus(item.path) }));
const env = signingEnvStatus();
const tools = toolStatus();
const store = certificateStoreStatus();
const blockers = [];

for (const artifact of artifacts) {
  if (!artifact.exists) blockers.push(`${artifact.name} artifact is missing: ${artifact.path}`);
  if (artifact.signature.status !== 'Valid') blockers.push(`${artifact.name} is ${artifact.signature.status}`);
}
if (!env.hasCertificateSource && store.codeSigningCertificates === 0) {
  blockers.push('no certificate source found: set CSC_LINK/WIN_CSC_LINK or install a CurrentUser/LocalMachine code-signing certificate');
}
if (env.hasCertificateSource && !env.hasPassword) {
  blockers.push('certificate source is present but CSC_KEY_PASSWORD/WIN_CSC_KEY_PASSWORD is missing');
}
if (!tools.signtoolAvailable && process.platform === 'win32') {
  blockers.push('signtool.exe was not found on PATH or in Windows Kits');
}

const signed = artifacts.every((artifact) => artifact.signature.status === 'Valid');
const readyToAttemptSigning =
  artifacts.every((artifact) => artifact.exists) &&
  (env.hasCertificateSource || store.codeSigningCertificates > 0) &&
  (!env.hasCertificateSource || env.hasPassword) &&
  (process.platform !== 'win32' || tools.signtoolAvailable);

const report = {
  ok: signed || readyToAttemptSigning,
  signed,
  readyToAttemptSigning,
  package: {
    productName: pkg.build?.productName ?? pkg.name,
    appId: pkg.build?.appId ?? null,
    winTarget: pkg.build?.win?.target ?? null,
  },
  artifacts,
  env,
  tools,
  certificateStore: store,
  blockers,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

function signingEnvStatus() {
  const linkVar = firstPresent(['WIN_CSC_LINK', 'CSC_LINK']);
  const passwordVar = firstPresent(['WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']);
  return {
    hasCertificateSource: Boolean(linkVar),
    certificateSourceVar: linkVar?.name ?? null,
    certificateSourceKind: linkVar ? classifyCertificateSource(linkVar.value) : null,
    certificateSourceFileExists: linkVar ? certificateSourceFileExists(linkVar.value) : null,
    hasPassword: Boolean(passwordVar),
    passwordVar: passwordVar?.name ?? null,
    identityAutoDiscovery: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? null,
  };
}

function firstPresent(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return null;
}

function classifyCertificateSource(value) {
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^file:\/\//i.test(value)) return 'file-url';
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return 'file';
  if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length > 200) return 'base64';
  return 'unknown';
}

function certificateSourceFileExists(value) {
  if (/^file:\/\//i.test(value)) {
    try {
      return existsSync(new URL(value));
    } catch {
      return false;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return existsSync(value);
  return null;
}

function toolStatus() {
  if (process.platform !== 'win32') {
    return { signtoolAvailable: false, signtoolPath: null, reason: 'signtool is Windows-only' };
  }
  const result = spawnSync('where.exe', ['signtool.exe'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : null;
  const discovered = first || findWindowsKitSigntool();
  return {
    signtoolAvailable: Boolean(discovered),
    signtoolPath: discovered ? `${basename(discovered)}` : null,
    source: first ? 'PATH' : discovered ? 'Windows Kits' : null,
  };
}

function findWindowsKitSigntool() {
  const roots = [
    process.env.NEWAMP_WINDOWS_KITS_ROOT,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Windows Kits') : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Windows Kits') : '',
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

function certificateStoreStatus() {
  if (process.platform !== 'win32') {
    return { checked: false, codeSigningCertificates: 0, reason: 'Windows certificate store is Windows-only' };
  }
  const command = [
    '$ErrorActionPreference = "SilentlyContinue";',
    '$certs = @();',
    '$certs += Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert;',
    '$certs += Get-ChildItem Cert:\\LocalMachine\\My -CodeSigningCert;',
    '[pscustomobject]@{ Count = @($certs).Count; Subjects = @($certs | Select-Object -First 5 -ExpandProperty Subject) } | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) {
    return {
      checked: false,
      codeSigningCertificates: 0,
      reason: result.error?.message || (result.stderr || result.stdout || 'certificate store query failed').trim(),
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      checked: true,
      codeSigningCertificates: Number(parsed.Count ?? 0),
      sampleSubjects: Array.isArray(parsed.Subjects) ? parsed.Subjects : parsed.Subjects ? [parsed.Subjects] : [],
    };
  } catch {
    return {
      checked: false,
      codeSigningCertificates: 0,
      reason: `certificate store query returned invalid JSON: ${result.stdout.trim().slice(0, 300)}`,
    };
  }
}

function signatureStatus(path) {
  if (!existsSync(path)) return { status: 'Missing', statusMessage: 'Artifact does not exist.' };
  if (process.platform !== 'win32') return { status: 'Skipped', statusMessage: 'Authenticode is Windows-only.' };
  const command = [
    '$sig = Get-AuthenticodeSignature -LiteralPath',
    quoteForPowerShell(path),
    '; [pscustomobject]@{ Status = [string]$sig.Status; StatusMessage = $sig.StatusMessage } | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) {
    return { status: 'Error', statusMessage: result.error?.message || (result.stderr || result.stdout || '').trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      status: parsed.Status,
      statusMessage: parsed.StatusMessage ?? '',
    };
  } catch {
    return { status: 'Error', statusMessage: result.stdout.trim() };
  }
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
