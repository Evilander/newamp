#!/usr/bin/env node
// Builds native/newamp-audio (WASAPI exclusive output addon) and stages the
// binary at native/newamp-audio/prebuilt/win32-x64/newamp_audio.node.
//
// node-gyp's PowerShell-based Visual Studio discovery fails on this machine,
// so the compile runs inside a vcvars64.bat environment via a temp .cmd file.
// Usage: node scripts/build-native.mjs [--force]

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const addonDir = join(root, 'native', 'newamp-audio')
const builtNode = join(addonDir, 'build', 'Release', 'newamp_audio.node')
const prebuiltDir = join(addonDir, 'prebuilt', 'win32-x64')
const prebuiltNode = join(prebuiltDir, 'newamp_audio.node')
const force = process.argv.includes('--force')

if (process.platform !== 'win32') {
  console.log('[build-native] non-Windows platform — exclusive output is Windows-only in v1, skipping.')
  process.exit(0)
}

const sources = ['binding.cpp', 'binding.gyp', 'miniaudio.h'].map((f) => join(addonDir, f))
if (!force && existsSync(prebuiltNode)) {
  const binMtime = statSync(prebuiltNode).mtimeMs
  const stale = sources.some((f) => statSync(f).mtimeMs > binMtime)
  if (!stale) {
    console.log('[build-native] prebuilt binary is up to date:', prebuiltNode)
    process.exit(0)
  }
}

function findVcvars() {
  const editions = ['Community', 'Professional', 'Enterprise', 'BuildTools']
  for (const ed of editions) {
    const p = `C:\\Program Files\\Microsoft Visual Studio\\2022\\${ed}\\VC\\Auxiliary\\Build\\vcvars64.bat`
    if (existsSync(p)) return p
  }
  try {
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    const install = execFileSync(vswhere, ['-latest', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
    const p = join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    if (existsSync(p)) return p
  } catch {
    // fall through
  }
  return null
}

const vcvars = findVcvars()
if (!vcvars) {
  console.error('[build-native] FATAL: vcvars64.bat not found — install VS2022 with C++ workload.')
  process.exit(1)
}

if (!existsSync(join(addonDir, 'node_modules', 'node-addon-api'))) {
  console.log('[build-native] installing node-addon-api...')
  // --ignore-scripts: npm would otherwise auto-run node-gyp (binding.gyp in
  // package root) outside the vcvars environment and fail.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: addonDir, stdio: 'inherit', shell: true })
}

const cmdFile = join(os.tmpdir(), `newamp-build-native-${process.pid}.cmd`)
writeFileSync(
  cmdFile,
  [
    '@echo off',
    `call "${vcvars}"`,
    'if errorlevel 1 exit /b 1',
    `cd /d "${addonDir}"`,
    'call npx node-gyp rebuild',
  ].join('\r\n'),
)
console.log('[build-native] compiling with', vcvars)
try {
  execFileSync('cmd.exe', ['/d', '/s', '/c', cmdFile], { stdio: 'inherit' })
} finally {
  rmSync(cmdFile, { force: true })
}

if (!existsSync(builtNode)) {
  console.error('[build-native] FATAL: build completed but', builtNode, 'is missing.')
  process.exit(1)
}
mkdirSync(prebuiltDir, { recursive: true })
copyFileSync(builtNode, prebuiltNode)
console.log('[build-native] staged', prebuiltNode)

// Load-sanity: require the binary and enumerate devices in this process.
const { createRequire } = await import('node:module')
const nativeRequire = createRequire(import.meta.url)
const addon = nativeRequire(prebuiltNode)
const devices = addon.listDevices()
console.log(`[build-native] load OK — ${devices.length} playback device(s), default: ${devices.find((d) => d.isDefault)?.name ?? 'n/a'}`)
