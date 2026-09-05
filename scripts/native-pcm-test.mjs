// Compile the actual ring and callback in a device-free harness. Requires CXX
// (or c++) with C++17 support; no Electron, miniaudio backend or DAC required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(new URL('../native/newamp-audio/binding.cpp', import.meta.url), 'utf8');
const ring = source.match(/struct Ring \{[\s\S]*?\n\};/)?.[0];
const player = source.match(/struct Player \{[\s\S]*?\n\};/)?.[0];
const callback = source.match(/void DataCallback\([\s\S]*?\n\}/)?.[0];
assert.ok(ring && player && callback, 'production ring, player and callback must be present');
const root = resolve('tmp/native-pcm-test');
mkdirSync(root, { recursive: true });
const cpp = resolve(root, 'native-pcm.cpp');
const executable = resolve(root, process.platform === 'win32' ? 'native-pcm.exe' : 'native-pcm');
writeFileSync(cpp, `
#include <atomic>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#include <thread>
#include <iostream>
using ma_uint32 = uint32_t;
struct ma_device { void* pUserData = nullptr; };
${ring}
${player}
${callback}

int main() {
  // Ten available bytes for stereo s24: consume six, keep four, pad six.
  Player p;
  p.bytesPerFrame = 6;
  p.device.pUserData = &p;
  p.ring.allocate(16);
  unsigned char input[12];
  for (int i = 0; i < 12; i++) input[i] = i + 1;
  assert(p.ring.push(input, 10) == 10);
  unsigned char out[12];
  std::memset(out, 0xff, sizeof(out));
  DataCallback(&p.device, out, nullptr, 2);
  assert(p.framesRendered == 1 && p.ring.available() == 4);
  assert(std::memcmp(out, input, 6) == 0);
  for (int i = 6; i < 12; i++) assert(out[i] == 0);
  assert(p.ring.push(input + 10, 2) == 2);
  DataCallback(&p.device, out, nullptr, 1);
  assert(p.framesRendered == 2 && p.ring.available() == 0);
  assert(std::memcmp(out, input + 6, 6) == 0);

  // An incomplete first frame is pre-roll; a reset must discard its bytes.
  p.ring.push(input, 2);
  p.ring.reset();
  p.framesRendered = 0;
  p.underruns = 0;
  p.ring.push(input, 5);
  DataCallback(&p.device, out, nullptr, 1);
  assert(p.ring.available() == 5 && p.framesRendered == 0 && p.underruns == 0);
  for (int i = 0; i < 6; i++) assert(out[i] == 0);

  // Force wraparound and underruns with a live producer/consumer for formats
  // whose frame sizes both do and do not divide the power-of-two capacity.
  for (uint32_t frameBytes : {2u, 4u, 6u, 8u, 12u, 24u}) {
    Player stream;
    stream.bytesPerFrame = frameBytes;
    stream.device.pUserData = &stream;
    stream.ring.allocate(128);
    const uint64_t totalFrames = 20000;
    const uint64_t totalBytes = totalFrames * frameBytes;
    std::vector<unsigned char> input(totalBytes);
    for (uint64_t i = 0; i < totalBytes; i++) input[i] = 1 + i % 251;
    std::thread producer([&] {
      uint64_t offset = 0;
      while (offset < totalBytes) {
        uint64_t n = 1 + (offset % 83);
        if (n > totalBytes - offset) n = totalBytes - offset;
        offset += stream.ring.push(input.data() + offset, n);
        std::this_thread::yield();
      }
      stream.eos = true;
    });
    std::vector<unsigned char> buffer(frameBytes * 7);
    uint64_t verified = 0;
    while (verified < totalBytes) {
      const auto before = stream.framesRendered.load();
      DataCallback(&stream.device, buffer.data(), nullptr, 7);
      const auto consumed = (stream.framesRendered.load() - before) * frameBytes;
      assert(std::memcmp(buffer.data(), input.data() + verified, consumed) == 0);
      for (uint64_t i = consumed; i < buffer.size(); i++) assert(buffer[i] == 0);
      verified += consumed;
      std::this_thread::yield();
    }
    producer.join();
    DataCallback(&stream.device, buffer.data(), nullptr, 7);
    assert(stream.drained && stream.ring.available() == 0);
    assert(stream.framesRendered == totalFrames);
  }
  std::cout << "PASS native PCM: partial frames, silence padding, reset, wraparound, concurrent delivery\\n";
}
`);
const compiler = process.env.CXX || 'c++';
const compiled = spawnSync(compiler, ['-std=c++17', '-O2', '-pthread', cpp, '-o', executable], { encoding: 'utf8', timeout: 60000 });
assert.equal(compiled.status, 0, `${compiled.error?.message ?? ''}\n${compiled.stderr}`);
const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000 });
assert.equal(result.status, 0, result.error?.message || result.stderr);
console.log(result.stdout.trim());
