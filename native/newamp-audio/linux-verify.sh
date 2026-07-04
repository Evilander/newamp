#!/usr/bin/env bash
# Linux build+load verification for the Bit-Perfect Exclusive addon.
# Run inside a node container: builds from a clean copy, loads the binary,
# enumerates devices (headless containers report 0), probes when possible.
set -euo pipefail
cp -r /src /work
cd /work
rm -rf node_modules build prebuilt
npm install --ignore-scripts --no-audit --no-fund > /dev/null 2>&1
npx node-gyp rebuild
node -e '
const a = require("/work/build/Release/newamp_audio.node");
const d = a.listDevices();
console.log("LINUX_LOAD_OK devices=" + d.length);
if (d.length > 0) {
  const p = a.probeDevice();
  console.log("probe: " + p.name + " formats=" + p.formats.map(f => f.format + "@" + f.sampleRate).join(","));
} else {
  try {
    a.probeDevice();
  } catch (err) {
    console.log("probe (no devices, expected throw): " + err.message);
  }
}
console.log("LINUX_VERIFY_PASS");
'
