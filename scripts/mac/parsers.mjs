// Pure parsers and formatters for scripts/mac-verify.mjs. Everything here takes
// text or bytes that a macOS tool printed and returns plain objects, so the
// logic can be checked on any machine with canned output
// (scripts/mac/mac-verify-selftest.mjs) before it ever meets a Mac.

/**
 * `codesign -dv --verbose=4 <path>` writes key=value lines to stderr. The
 * CodeDirectory line carries the flag word, where 0x10000 is the hardened
 * runtime and 0x2 means ad-hoc.
 */
export function parseCodesignDetails(text) {
  const map = {};
  const authorities = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9 ]*?)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].trim();
    if (key === 'Authority') authorities.push(match[2].trim());
    else map[key] = match[2].trim();
  }
  const cd = /CodeDirectory\b[^\n]*?flags=0x([0-9a-fA-F]+)\(([^)]*)\)/.exec(String(text));
  const flagBits = cd ? Number.parseInt(cd[1], 16) : 0;
  const flagNames = cd ? cd[2].split(',').map((name) => name.trim()).filter(Boolean) : [];
  const signature = map.Signature ?? null;
  const adhoc = signature === 'adhoc' || flagNames.includes('adhoc') || (flagBits & 0x2) !== 0;
  const hardenedRuntime = flagNames.includes('runtime') || (flagBits & 0x10000) !== 0;
  const developerId = authorities.some((name) => /^Developer ID Application:/.test(name));
  return {
    identifier: map.Identifier ?? null,
    format: map.Format ?? null,
    signature,
    adhoc,
    hardenedRuntime,
    developerId,
    teamId: map.TeamIdentifier && map.TeamIdentifier !== 'not set' ? map.TeamIdentifier : null,
    authorities,
    runtimeVersion: map['Runtime Version'] ?? null,
    flags: cd ? `0x${flagBits.toString(16)}(${flagNames.join(',')})` : null,
    sealedResources: map['Sealed Resources'] ?? null,
    timestamp: map.Timestamp ?? null,
  };
}

/**
 * `spctl --assess --verbose=4 <path>` prints "<path>: accepted" or
 * "<path>: rejected" plus "source=..." lines, and exits 0 only when accepted.
 * An ad-hoc signed build is rejected; that is expected without a Developer ID.
 */
export function parseSpctl(text, status) {
  const out = String(text);
  const verdict = /:\s*(accepted|rejected)\b/.exec(out);
  const source = /^\s*source=(.*)$/m.exec(out);
  const accepted = verdict ? verdict[1] === 'accepted' : status === 0;
  return {
    accepted,
    source: source ? source[1].trim() : null,
    notarized: /Notarized Developer ID/i.test(out),
    raw: out.trim(),
  };
}

/** Boolean entitlements from the plist `codesign -d --entitlements :-` prints. */
export function parseEntitlements(xml) {
  const entitlements = {};
  const re = /<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/g;
  let match;
  while ((match = re.exec(String(xml)))) entitlements[match[1]] = match[2] === 'true';
  return entitlements;
}

/** `lipo -archs <path>` prints architectures separated by spaces. */
export function parseLipoArchs(text) {
  return String(text).trim().split(/\s+/).filter(Boolean);
}

/**
 * `pmset -g assertions`. The per-process lines look like
 *   pid 4321(NewAmp): [0x0001a2b30001b2a3] 00:00:05 PreventUserIdleDisplaySleep named: "..."
 * and the system-wide summary lists each assertion type with a count.
 */
export function parsePmsetAssertions(text) {
  const system = {};
  const processes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const summary = /^\s{2,}([A-Za-z]+)\s+(\d+)\s*$/.exec(line);
    if (summary) {
      system[summary[1]] = Number(summary[2]);
      continue;
    }
    const entry = /^\s*pid (\d+)\(([^)]*)\):\s*\[[^\]]*\]\s*(\d+:\d+:\d+)\s+(\w+)\s+named:\s*"(.*)"/.exec(line);
    if (entry) {
      processes.push({ pid: Number(entry[1]), name: entry[2], age: entry[3], type: entry[4], named: entry[5] });
    }
  }
  return { system, processes };
}

// Chromium creates its display-sleep blocker with the legacy constant
// kIOPMAssertionTypeNoDisplaySleep, and macOS 27 lists it under that old name
// (seen on 27.0.1); the current name is kept for systems that print it. Both
// mean the same assertion.
const ASSERTION_ALIASES = {
  PreventUserIdleDisplaySleep: ['PreventUserIdleDisplaySleep', 'NoDisplaySleepAssertion'],
  PreventUserIdleSystemSleep: ['PreventUserIdleSystemSleep', 'NoIdleSleepAssertion'],
};

/** True when `pid` holds an assertion of `type` (for example PreventUserIdleDisplaySleep). */
export function holdsAssertion(parsed, pid, type) {
  const names = ASSERTION_ALIASES[type] ?? [type];
  return parsed.processes.some((entry) => entry.pid === pid && names.includes(entry.type));
}

/** `defaults read -g AppleInterfaceStyle` prints Dark in dark mode and fails in light mode. */
export function parseInterfaceStyle(stdout, status) {
  return status === 0 && /dark/i.test(String(stdout)) ? 'dark' : 'light';
}

/** Version as [major, minor, patch] from "26.0.1" or "v22.12.0". */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function versionAtLeast(have, want) {
  for (let i = 0; i < 3; i += 1) {
    if ((have[i] ?? 0) > (want[i] ?? 0)) return true;
    if ((have[i] ?? 0) < (want[i] ?? 0)) return false;
  }
  return true;
}

/**
 * Reads an uncompressed BMP (what `sips -s format bmp` writes) into a pixel
 * reader. Only 24 and 32 bit images are handled, both stored BGR(A). Rows may
 * be stored bottom-up (positive height) or top-down (negative height).
 */
export function readBmp(buffer) {
  if (buffer.length < 54 || buffer.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP');
  const dataOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const bits = buffer.readUInt16LE(28);
  if (bits !== 24 && bits !== 32) throw new Error(`unsupported BMP depth ${bits}`);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bits / 8;
  const stride = Math.floor((bits * width + 31) / 32) * 4;
  return {
    width,
    height,
    pixel(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) throw new RangeError('pixel outside image');
      const row = topDown ? y : height - 1 - y;
      const at = dataOffset + row * stride + x * bytesPerPixel;
      return [buffer[at + 2], buffer[at + 1], buffer[at]];
    },
  };
}

/** The three traffic-light colours as macOS draws them on an active window. */
export function classifyLight([r, g, b]) {
  if (r > 200 && g < 120 && b < 115) return 'close';
  if (r > 215 && g > 150 && g < 215 && b < 100) return 'minimize';
  if (r < 100 && g > 165 && b < 115) return 'zoom';
  return null;
}

/**
 * Counts traffic-light coloured pixels in the top-left corner of a window
 * capture. `scale` is the capture's pixels per point (2 on a Retina display).
 * Inactive windows draw grey lights, so a miss only means "hidden" when the
 * window was known to be active; the caller decides what to do with that.
 */
export function findTrafficLights(image, scale = 2) {
  const maxX = Math.min(image.width, Math.round(90 * scale));
  const maxY = Math.min(image.height, Math.round(40 * scale));
  const counts = { close: 0, minimize: 0, zoom: 0 };
  let distinct = new Set();
  for (let y = 0; y < maxY; y += 1) {
    for (let x = 0; x < maxX; x += 1) {
      const rgb = image.pixel(x, y);
      if (distinct.size < 64) distinct.add(rgb.join(','));
      const kind = classifyLight(rgb);
      if (kind) counts[kind] += 1;
    }
  }
  const floor = Math.round(18 * scale * scale);
  return {
    counts,
    visible: counts.close >= floor && counts.minimize >= floor && counts.zoom >= floor,
    // A capture the system refused to fill comes back flat.
    blank: distinct.size < 4,
  };
}

/** Aligned plain-text table for the PASS/FAIL summary. */
export function formatTable(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => String(row[column.key] ?? '').length)),
  );
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  return [
    line(columns.map((column) => column.title)),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => row[column.key] ?? ''))),
  ].join('\n');
}

export function summarize(results) {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0, MANUAL: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

/** One line for a table cell: first line only, bounded. */
export function clip(text, max = 110) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Key events for Input.dispatchKeyEvent. CDP modifiers are a bit set:
 * Alt 1, Control 2, Meta (Command) 4, Shift 8.
 */
export function keyEvents({ key, code, keyCode, meta = false, ctrl = false, shift = false, alt = false }) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  return [
    { ...base, type: 'rawKeyDown' },
    { ...base, type: 'keyUp' },
  ];
}

export const KEYS = {
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  M: { key: 'M', code: 'KeyM', keyCode: 77 },
  F: { key: 'f', code: 'KeyF', keyCode: 70 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};
