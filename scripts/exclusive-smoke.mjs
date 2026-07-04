#!/usr/bin/env node
// Exclusive-output addon smoke.
//
// Always (CI-safe, does not steal the device):
//   1. builds the addon if the prebuilt binary is missing (scripts/build-native.mjs)
//   2. loads it, enumerates playback devices, probes the default device's
//      native formats
//   3. opens SHARED mode, pushes 0.5s of s16 PCM, asserts exact frame
//      accounting, drain, zero pre-roll underruns, and clean close
//
// With NEWAMP_EXCLUSIVE_SMOKE_HW=1 (manual, grabs the device from the OS):
//   4. opens EXCLUSIVE at a device-native format, pushes 1s of PCM, asserts
//      requested==internal (honest bit-perfect negotiation), drain, close.
//
// Platforms: win32 (WASAPI) and linux (ALSA direct). Elsewhere: no-op pass.
// Headless environments (CI containers) legitimately enumerate zero devices —
// there the pass criteria is build+load+enumerate without crashing, and the
// playback sections are skipped.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const prebuilt = join(
  root,
  'native',
  'newamp-audio',
  'prebuilt',
  `${process.platform}-${process.arch}`,
  'newamp_audio.node',
)

if (process.platform !== 'win32' && process.platform !== 'linux') {
  console.log('[exclusive-smoke] unsupported platform — exclusive output is Windows/Linux, PASS (no-op).')
  process.exit(0)
}

const fail = (msg) => {
  console.error('[exclusive-smoke] FAIL:', msg)
  process.exit(1)
}

if (!existsSync(prebuilt)) {
  console.log('[exclusive-smoke] prebuilt binary missing — building...')
  execFileSync(process.execPath, [join(root, 'scripts', 'build-native.mjs')], { stdio: 'inherit' })
}
if (!existsSync(prebuilt)) fail('addon binary still missing after build')

const addon = createRequire(import.meta.url)(prebuilt)

// -- 1. enumerate + probe ----------------------------------------------------
const devices = addon.listDevices()
if (!Array.isArray(devices)) fail('listDevices did not return an array')
if (devices.length === 0) {
  // Headless CI: no audio hardware. Load + enumerate is the whole assertion.
  console.log('[exclusive-smoke] 0 playback devices (headless environment) — load+enumerate PASS, playback sections skipped.')
  console.log('[exclusive-smoke] PASS')
  process.exit(0)
}
const def = devices.find((d) => d.isDefault) ?? devices[0]
console.log(`[exclusive-smoke] ${devices.length} device(s); default: ${def.name}`)

const probe = addon.probeDevice()
if (!probe.formats) fail('probeDevice returned no formats')
console.log(
  '[exclusive-smoke] native formats:',
  probe.formats.map((f) => `${f.format}/${f.channels}ch@${f.sampleRate || 'any'}`).join(', ') || '(none reported)',
)

function makeS16Sine(rate, seconds, freq = 440, amp = 0.03) {
  const frames = Math.floor(rate * seconds)
  const buf = Buffer.alloc(frames * 2 * 2)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767)
    buf.writeInt16LE(v, i * 4)
    buf.writeInt16LE(v, i * 4 + 2)
  }
  return { buf, frames }
}

async function playThrough({ exclusive, rate, format, makeBuf }) {
  const opened = addon.open({ sampleRate: rate, channels: 2, format, exclusive, ringMs: 2000 })
  const { buf, frames } = makeBuf()
  let written = 0
  while (written < buf.length) {
    const n = addon.write(buf.subarray(written))
    if (n === 0) break
    written += n
  }
  if (written !== buf.length) fail(`ring accepted ${written}/${buf.length} bytes (ring too small?)`)
  addon.setEos(true)
  addon.start()
  const deadline = Date.now() + (frames / rate) * 1000 + 2000
  let stats = addon.stats()
  while (!stats.drained && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    stats = addon.stats()
  }
  addon.close()
  if (!stats.drained) fail(`${exclusive ? 'exclusive' : 'shared'} stream never drained (stats: ${JSON.stringify(stats)})`)
  if (stats.framesRendered !== frames) fail(`framesRendered ${stats.framesRendered} !== pushed ${frames}`)
  if (stats.underruns !== 0) fail(`expected 0 underruns, got ${stats.underruns}`)
  return opened
}

// -- 2. shared-mode end-to-end (CI-safe) --------------------------------------
const sharedRate = 48000
const sharedOpen = await playThrough({
  exclusive: false,
  rate: sharedRate,
  format: 's16',
  makeBuf: () => makeS16Sine(sharedRate, 0.5),
})
console.log(
  `[exclusive-smoke] shared-mode pass: ${sharedOpen.deviceName} — pushed/rendered exact, drained, closed`,
)

// -- 3. exclusive hardware pass (manual) --------------------------------------
if (process.env.NEWAMP_EXCLUSIVE_SMOKE_HW === '1') {
  const native = probe.formats.filter((f) => f.channels === 2 && ['s16', 's24', 's32', 'f32'].includes(f.format))
  if (native.length === 0) fail('device reports no usable native exclusive formats')
  // Prefer an integer format at its native rate; fall back to whatever is first.
  const pick = native.find((f) => f.format !== 'f32') ?? native[0]
  const rate = pick.sampleRate || 48000
  console.log(`[exclusive-smoke] HW pass: opening EXCLUSIVE ${pick.format}@${rate}...`)
  if (pick.format !== 's16') {
    // Only s16 sine generation is implemented here; for other formats assert
    // negotiation honesty with a silence buffer instead.
    const frames = Math.floor(rate * 1)
    const bps = pick.format === 's24' ? 3 : 4
    const opened = addon.open({ sampleRate: rate, channels: 2, format: pick.format, exclusive: true, ringMs: 2000 })
    if (opened.internalSampleRate !== rate || opened.internalFormat !== pick.format) {
      addon.close()
      fail(
        `exclusive negotiation dishonest: requested ${pick.format}@${rate}, internal ${opened.internalFormat}@${opened.internalSampleRate}`,
      )
    }
    const silence = Buffer.alloc(frames * 2 * bps)
    let w = 0
    while (w < silence.length) {
      const n = addon.write(silence.subarray(w))
      if (n === 0) break
      w += n
    }
    addon.setEos(true)
    addon.start()
    const deadline = Date.now() + 3500
    let stats = addon.stats()
    while (!stats.drained && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      stats = addon.stats()
    }
    addon.close()
    if (!stats.drained || stats.framesRendered !== frames) {
      fail(`exclusive HW pass failed: ${JSON.stringify(stats)} (expected ${frames} frames)`)
    }
    console.log(`[exclusive-smoke] EXCLUSIVE pass: ${opened.deviceName} ${pick.format}@${rate}, internal format matches request — bit-perfect path verified`)
  } else {
    const opened = await playThrough({
      exclusive: true,
      rate,
      format: 's16',
      makeBuf: () => makeS16Sine(rate, 1),
    })
    if (opened.internalSampleRate !== rate || opened.internalFormat !== 's16') {
      fail(`exclusive negotiation dishonest: internal ${opened.internalFormat}@${opened.internalSampleRate}`)
    }
    console.log(`[exclusive-smoke] EXCLUSIVE pass: ${opened.deviceName} s16@${rate} — bit-perfect path verified`)
  }
} else {
  console.log('[exclusive-smoke] exclusive HW pass skipped (set NEWAMP_EXCLUSIVE_SMOKE_HW=1 to run — it takes over the audio device)')
}

console.log('[exclusive-smoke] PASS')
