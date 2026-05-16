import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const coreExtensions = ['mp3', 'flac', 'wav', 'm4a', 'wma', 'm3u', 'm3u8', 'pls', 'cue'];

export function checkInstalledAssociations({
  root = repoRoot,
  configOnly = false,
  requiredOnly = false,
  expectedExePath = process.env.NEWAMP_INSTALLED_EXE || '',
} = {}) {
  const expected = loadExpectedAssociations(root, { requiredOnly });
  const packageCheck = checkPackageAssociations(expected);
  if (!packageCheck.ok || configOnly) {
    return {
      name: 'installed-file-associations',
      ok: packageCheck.ok,
      mode: { configOnly, requiredOnly, expectedExePath: expectedExePath || null },
      package: packageCheck,
      registry: configOnly ? { skipped: true } : null,
    };
  }

  if (process.platform !== 'win32') {
    return {
      name: 'installed-file-associations',
      ok: false,
      mode: { configOnly, requiredOnly, expectedExePath: expectedExePath || null },
      package: packageCheck,
      registry: {
        ok: false,
        skipped: true,
        reason: 'Windows registry proof is only available on Windows.',
      },
    };
  }

  const registry = readAssociationRegistry(expected.associations);
  if (!registry.ok) {
    return {
      name: 'installed-file-associations',
      ok: false,
      mode: { configOnly, requiredOnly, expectedExePath: expectedExePath || null },
      package: packageCheck,
      registry,
    };
  }

  const registryCheck = analyzeRegistryProof(expected.associations, registry.rows, expectedExePath);
  return {
    name: 'installed-file-associations',
    ok: registryCheck.ok,
    mode: { configOnly, requiredOnly, expectedExePath: expectedExePath || null },
    package: packageCheck,
    registry: registryCheck,
  };
}

export function summarizeInstalledAssociations(report) {
  const packageIssues = report.package?.issues ?? [];
  if (packageIssues.length > 0) return packageIssues.slice(0, 3).join('; ');
  const registry = report.registry;
  if (!registry) return 'registry proof did not run';
  if (registry.reason) return registry.reason;
  const missing = registry.missing ?? [];
  if (missing.length > 0) {
    const sample = missing.slice(0, 6).map((item) => `.${item.ext}`).join(', ');
    return `${missing.length} extension registrations missing or incomplete (${sample})`;
  }
  if (registry.commandFailures?.length > 0) return `${registry.commandFailures.length} command registrations are incomplete`;
  return 'installed association proof is not complete';
}

function loadExpectedAssociations(root, { requiredOnly }) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const configured = Array.isArray(pkg.build?.fileAssociations) ? pkg.build.fileAssociations : [];
  const expected = [];

  for (const association of configured) {
    const extensions = Array.isArray(association.ext) ? association.ext : [];
    for (const ext of extensions) {
      expected.push({
        ext: normalizeExt(ext),
        progId: String(association.name ?? ''),
        description: String(association.description ?? ''),
        commandText: 'Open with Newamp',
      });
    }
  }

  const requiredSet = new Set(coreExtensions);
  const associations = requiredOnly ? expected.filter((item) => requiredSet.has(item.ext)) : expected;
  return {
    associations,
    configured,
    requiredExtensions: coreExtensions,
    configuredExtensions: expected.map((item) => item.ext),
  };
}

function checkPackageAssociations(expected) {
  const issues = [];
  const configuredSet = new Set(expected.configuredExtensions);
  for (const ext of expected.requiredExtensions) {
    if (!configuredSet.has(ext)) issues.push(`package.json does not register .${ext}`);
  }

  const seen = new Set();
  for (const association of expected.configured) {
    const progId = String(association.name ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_.-]+$/.test(progId)) {
      issues.push(`file association ProgID "${progId}" should be a stable registry ID without spaces`);
    }
    if (!progId.startsWith('Newamp.')) {
      issues.push(`file association ProgID "${progId}" should start with Newamp.`);
    }
    for (const ext of association.ext ?? []) {
      const normalized = normalizeExt(ext);
      if (seen.has(normalized)) issues.push(`.${normalized} is registered by more than one association`);
      seen.add(normalized);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    requiredExtensions: expected.requiredExtensions,
    checkedExtensions: expected.associations.length,
    progIds: [...new Set(expected.associations.map((item) => item.progId))],
  };
}

function readAssociationRegistry(associations) {
  const rows = [];
  const roots = [
    { name: 'HKCU', path: 'HKCU\\Software\\Classes' },
    { name: 'HKLM', path: 'HKLM\\Software\\Classes' },
  ];

  for (const item of associations) {
    for (const root of roots) {
      const extKey = `${root.path}\\.${item.ext}`;
      const classKey = `${root.path}\\${item.progId}`;
      rows.push({
        root: root.name,
        ext: item.ext,
        progId: item.progId,
        description: item.description,
        extDefault: readRegistryDefault(extKey),
        openWithProgids: readRegistryValueNames(`${extKey}\\OpenWithProgids`),
        classDefault: readRegistryDefault(classKey),
        icon: readRegistryDefault(`${classKey}\\DefaultIcon`),
        shellDefault: readRegistryDefault(`${classKey}\\shell`),
        verbText: readRegistryDefault(`${classKey}\\shell\\open`),
        command: readRegistryDefault(`${classKey}\\shell\\open\\command`),
        userChoiceProgId: readRegistryNamedValue(
          `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${item.ext}\\UserChoice`,
          'ProgId',
        ),
      });
    }
  }

  return { ok: true, rows };
}

function analyzeRegistryProof(associations, rows, expectedExePath) {
  const missing = [];
  const proven = [];
  const defaultWarnings = [];

  for (const expected of associations) {
    const candidates = rows.filter((row) => row.ext === expected.ext && row.progId === expected.progId);
    const validated = candidates
      .map((row) => validateRegistryRow(row, expected, expectedExePath))
      .filter((item) => item.ok);

    if (validated.length === 0) {
      const best = candidates.map((row) => validateRegistryRow(row, expected, expectedExePath))[0] ?? null;
      missing.push({
        ext: expected.ext,
        progId: expected.progId,
        reason: best?.issues?.join('; ') || 'no HKCU/HKLM registry row found',
      });
    } else {
      const proof = validated[0];
      proven.push({
        ext: expected.ext,
        progId: expected.progId,
        root: proof.row.root,
        commandExe: proof.commandExe,
      });
      if (proof.row.userChoiceProgId && proof.row.userChoiceProgId !== expected.progId) {
        defaultWarnings.push({
          ext: expected.ext,
          userChoiceProgId: proof.row.userChoiceProgId,
          openWithProgId: expected.progId,
        });
      }
    }
  }

  return {
    ok: missing.length === 0,
    scope: 'HKCU/HKLM Software\\Classes plus HKCU Explorer UserChoice',
    checkedExtensions: associations.length,
    proven,
    missing,
    defaultWarnings,
  };
}

function validateRegistryRow(row, expected, expectedExePath) {
  const issues = [];
  const openWith = Array.isArray(row.openWithProgids) ? row.openWithProgids : [];
  if (!openWith.includes(expected.progId)) {
    issues.push(`OpenWithProgids does not include ${expected.progId}`);
  }
  if (row.classDefault !== expected.description) {
    issues.push(`class description is ${JSON.stringify(row.classDefault)}, expected ${JSON.stringify(expected.description)}`);
  }
  if (row.shellDefault !== 'open') issues.push('shell default verb is not open');
  if (row.verbText !== expected.commandText) issues.push(`open verb text is ${JSON.stringify(row.verbText)}`);

  const command = String(row.command ?? '');
  const commandExe = extractNewampExe(command);
  if (!/Newamp\.exe/i.test(command)) issues.push('command does not reference Newamp.exe');
  if (!/%1/.test(command)) issues.push('command does not pass "%1"');
  if (!commandExe) issues.push('command executable could not be parsed');
  if (commandExe && !existsSync(commandExe)) issues.push(`command executable is missing: ${commandExe}`);
  if (commandExe && expectedExePath && !samePath(commandExe, expectedExePath)) {
    issues.push(`command executable ${commandExe} does not match expected ${expectedExePath}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    commandExe,
    row,
  };
}

function extractNewampExe(command) {
  const quoted = command.match(/"([^"]*Newamp\.exe)"/i);
  if (quoted) return quoted[1];
  const unquoted = command.match(/([A-Za-z]:\\[^\r\n"]*?Newamp\.exe)/i);
  return unquoted?.[1] ?? null;
}

function readRegistryDefault(key) {
  const result = regQuery(key, ['/ve']);
  if (!result.ok) return null;
  const values = parseRegValues(result.stdout);
  return values.find((item) => item.name === '(Default)' || item.name === '<NO NAME>')?.data ?? null;
}

function readRegistryNamedValue(key, name) {
  const result = regQuery(key, ['/v', name]);
  if (!result.ok) return null;
  return parseRegValues(result.stdout).find((item) => item.name.toLowerCase() === name.toLowerCase())?.data ?? null;
}

function readRegistryValueNames(key) {
  const result = regQuery(key, []);
  if (!result.ok) return [];
  return parseRegValues(result.stdout).map((item) => item.name);
}

function regQuery(key, args) {
  const result = spawnSync('reg.exe', ['query', key, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2500,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}

function parseRegValues(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{4}(.+?)\s+REG_[A-Z0-9_]+(?:\s+(.*))?$/))
    .filter(Boolean)
    .map((match) => ({
      name: match[1].trim(),
      data: match[2]?.trim() ?? '',
    }));
}

function normalizeExt(ext) {
  return String(ext).trim().replace(/^\./, '').toLowerCase();
}

function samePath(a, b) {
  return stripLongPath(a).replace(/\//g, '\\').toLowerCase() === stripLongPath(b).replace(/\//g, '\\').toLowerCase();
}

function stripLongPath(path) {
  return String(path).replace(/^\\\\\?\\/, '');
}

if (process.argv[1] && samePath(process.argv[1], scriptPath)) {
  const args = new Set(process.argv.slice(2));
  const report = checkInstalledAssociations({
    root: repoRoot,
    configOnly: args.has('--config-only'),
    requiredOnly: args.has('--required-only'),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
