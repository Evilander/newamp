import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeAudioOutputDeviceId,
  uniqueAudioOutputDevices,
} from '../dist-electron/shared/audio-output.js';

assert.equal(normalizeAudioOutputDeviceId(null), null);
assert.equal(normalizeAudioOutputDeviceId(''), null);
assert.equal(normalizeAudioOutputDeviceId('   '), null);
assert.equal(normalizeAudioOutputDeviceId('default'), null);
assert.equal(normalizeAudioOutputDeviceId('abc123'), 'abc123');

assert.deepEqual(
  uniqueAudioOutputDevices([
    { deviceId: 'default', label: 'Default', kind: 'audiooutput' },
    { deviceId: 'speaker-1', label: 'Speakers', kind: 'audiooutput' },
    { deviceId: 'speaker-1', label: 'Speakers Copy', kind: 'audiooutput' },
    { deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' },
    { deviceId: '', label: '', kind: 'audiooutput' },
  ]),
  [
    { deviceId: 'speaker-1', label: 'Speakers' },
  ],
  'audio output device list should remove default/blank/non-output/duplicate entries',
);

const [typesSource, settingsSource, apiSource, engineSource, storeSource, settingsViewSource, packageSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /audioOutputDeviceId/, 'settings type should persist selected audio output device');
assert.match(settingsSource, /normalizeAudioOutputDeviceId/, 'settings store should normalize selected audio output device');
assert.match(apiSource, /audioOutputDeviceId/, 'renderer defaults should include selected audio output device');
assert.match(engineSource, /setOutputDevice/, 'AudioEngine should expose output-device switching');
assert.match(engineSource, /setSinkId/, 'AudioEngine should use Chromium output-device APIs when available');
assert.match(engineSource, /playOutputTestTone/, 'AudioEngine should expose a speaker output test tone');
assert.match(engineSource, /createStereoPanner/, 'speaker output test should pan left and right through the audio chain');
assert.match(storeSource, /setAudioOutputDevice/, 'player store should expose output-device setting action');
assert.match(storeSource, /playOutputTestTone/, 'player store should expose output test action');
assert.match(settingsViewSource, /Audio Output/, 'Settings should expose audio output controls');
assert.match(settingsViewSource, /enumerateDevices/, 'Settings should enumerate browser audio output devices');
assert.match(settingsViewSource, /Test L\/R/, 'Settings should expose the output test action');
assert.match(packageSource, /"smoke:audio-output"/, 'package.json should expose audio output smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
