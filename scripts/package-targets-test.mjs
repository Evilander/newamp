import assert from 'node:assert/strict';
import { electronBuilderTargetArgs, nativeBuildArgs } from './lib/package-targets.mjs';

assert.deepEqual(electronBuilderTargetArgs([], 'win32'), [['--win=nsis'], ['--win=portable']]);
assert.deepEqual(electronBuilderTargetArgs([], 'linux'), [['--linux=tar.gz']]);
assert.deepEqual(electronBuilderTargetArgs([], 'darwin'), [['--mac', '--arm64'], ['--mac', '--x64']]);
const mac = electronBuilderTargetArgs(['--mac'], 'win32');
assert.deepEqual(mac.map((target) => nativeBuildArgs(target, 'arm64')), [['--force', '--arch=arm64'], ['--force', '--arch=x64']]);
assert.deepEqual(electronBuilderTargetArgs(['--portable'], 'linux'), [['--win=portable']]);
assert.deepEqual(electronBuilderTargetArgs(['--linux'], 'win32'), [['--linux=tar.gz']]);
assert.throws(() => electronBuilderTargetArgs([], 'unsupported'), /Unsupported/);
console.log('PASS host package targets and per-architecture native build plan');
