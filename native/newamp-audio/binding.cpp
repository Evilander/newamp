// NewAmp native audio output — WASAPI exclusive (and shared) playback via
// vendored miniaudio, exposed to the Electron main process over N-API.
//
// Contract (single device at a time, driven by electron/exclusive-output.ts):
//   listDevices()            -> [{ id, name, isDefault }]           (id = hex ma_device_id)
//   probeDevice(id?)         -> { name, formats: [{ format, channels, sampleRate }] }
//   open(opts)               -> negotiated format report (throws on failure)
//   start() / stopDevice()   -> run / halt the stream (stop = pause, keeps device)
//   write(Buffer)            -> bytes accepted into the ring (partial accept = backpressure)
//   clear()                  -> flush the ring (ONLY while stopped; used for seek)
//   setEos(bool)             -> mark end-of-stream so ring-empty means drained, not underrun
//   stats()                  -> { framesRendered, bufferedFrames, capacityFrames,
//                                 underruns, drained, running }
//   close()                  -> full uninit; relinquishes the exclusive device
//
// Threading: every exported function runs on the JS main thread. The WASAPI
// callback thread touches only the ring bytes and std::atomic counters — no
// locks, no allocation, no N-API. clear() is safe because the driver only
// calls it with the device stopped.

#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#include "miniaudio.h"

#include <napi.h>
#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {

std::string DeviceIdToHex(const ma_device_id& id) {
  static const char* hex = "0123456789abcdef";
  const auto* bytes = reinterpret_cast<const unsigned char*>(&id);
  std::string out;
  out.reserve(sizeof(ma_device_id) * 2);
  for (size_t i = 0; i < sizeof(ma_device_id); i++) {
    out.push_back(hex[bytes[i] >> 4]);
    out.push_back(hex[bytes[i] & 0xf]);
  }
  return out;
}

bool HexToDeviceId(const std::string& hexStr, ma_device_id* out) {
  if (hexStr.size() != sizeof(ma_device_id) * 2) return false;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  auto* bytes = reinterpret_cast<unsigned char*>(out);
  for (size_t i = 0; i < sizeof(ma_device_id); i++) {
    const int hi = nibble(hexStr[i * 2]);
    const int lo = nibble(hexStr[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    bytes[i] = static_cast<unsigned char>((hi << 4) | lo);
  }
  return true;
}

const char* FormatName(ma_format f) {
  switch (f) {
    case ma_format_u8: return "u8";
    case ma_format_s16: return "s16";
    case ma_format_s24: return "s24";
    case ma_format_s32: return "s32";
    case ma_format_f32: return "f32";
    default: return "unknown";
  }
}

ma_format FormatFromName(const std::string& name) {
  if (name == "s16") return ma_format_s16;
  if (name == "s24") return ma_format_s24;
  if (name == "s32") return ma_format_s32;
  if (name == "f32") return ma_format_f32;
  return ma_format_unknown;
}

// Single-producer (JS thread) / single-consumer (audio thread) byte ring.
// Monotonic 64-bit positions; capacity is a power of two.
struct Ring {
  std::unique_ptr<unsigned char[]> data;
  uint64_t capacity = 0;  // bytes, power of 2
  std::atomic<uint64_t> writePos{0};
  std::atomic<uint64_t> readPos{0};

  void allocate(uint64_t minBytes) {
    capacity = 1;
    while (capacity < minBytes) capacity <<= 1;
    data.reset(new unsigned char[capacity]);
    writePos.store(0, std::memory_order_relaxed);
    readPos.store(0, std::memory_order_relaxed);
  }
  uint64_t available() const {
    return writePos.load(std::memory_order_acquire) - readPos.load(std::memory_order_acquire);
  }
  uint64_t freeSpace() const { return capacity - available(); }

  // Producer side.
  uint64_t push(const unsigned char* src, uint64_t len) {
    const uint64_t w = writePos.load(std::memory_order_relaxed);
    const uint64_t space = capacity - (w - readPos.load(std::memory_order_acquire));
    const uint64_t n = len < space ? len : space;
    for (uint64_t i = 0; i < n;) {
      const uint64_t idx = (w + i) & (capacity - 1);
      const uint64_t run = (capacity - idx) < (n - i) ? (capacity - idx) : (n - i);
      std::memcpy(data.get() + idx, src + i, run);
      i += run;
    }
    writePos.store(w + n, std::memory_order_release);
    return n;
  }

  // Consumer side (audio callback).
  uint64_t pop(unsigned char* dst, uint64_t len) {
    const uint64_t r = readPos.load(std::memory_order_relaxed);
    const uint64_t avail = writePos.load(std::memory_order_acquire) - r;
    const uint64_t n = len < avail ? len : avail;
    for (uint64_t i = 0; i < n;) {
      const uint64_t idx = (r + i) & (capacity - 1);
      const uint64_t run = (capacity - idx) < (n - i) ? (capacity - idx) : (n - i);
      std::memcpy(dst + i, data.get() + idx, run);
      i += run;
    }
    readPos.store(r + n, std::memory_order_release);
    return n;
  }

  // ONLY safe while the consumer is not running.
  void reset() {
    readPos.store(writePos.load(std::memory_order_acquire), std::memory_order_release);
  }
};

struct Player {
  ma_device device{};
  bool deviceInitialized = false;
  Ring ring;
  uint32_t bytesPerFrame = 0;
  std::atomic<uint64_t> framesRendered{0};
  std::atomic<uint64_t> underruns{0};
  std::atomic<bool> eos{false};
  std::atomic<bool> drained{false};
};

Player g_player;

void DataCallback(ma_device* device, void* output, const void*, ma_uint32 frameCount) {
  auto* p = static_cast<Player*>(device->pUserData);
  auto* out = static_cast<unsigned char*>(output);
  const uint64_t wanted = static_cast<uint64_t>(frameCount) * p->bytesPerFrame;
  const uint64_t got = p->ring.pop(out, wanted);
  if (got < wanted) {
    std::memset(out + got, 0, wanted - got);
    // Silence before the first byte ever arrives is pre-roll, not an underrun.
    const bool preRoll = got == 0 && p->framesRendered.load(std::memory_order_relaxed) == 0;
    if (p->eos.load(std::memory_order_acquire)) {
      p->drained.store(true, std::memory_order_release);
    } else if (!preRoll) {
      p->underruns.fetch_add(1, std::memory_order_relaxed);
    }
  }
  p->framesRendered.fetch_add(got / p->bytesPerFrame, std::memory_order_relaxed);
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ma_context context;
  if (ma_context_init(nullptr, 0, nullptr, &context) != MA_SUCCESS) {
    Napi::Error::New(env, "ma_context_init failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  ma_device_info* playback = nullptr;
  ma_uint32 count = 0;
  Napi::Array result = Napi::Array::New(env);
  if (ma_context_get_devices(&context, &playback, &count, nullptr, nullptr) == MA_SUCCESS) {
    for (ma_uint32 i = 0; i < count; i++) {
      Napi::Object device = Napi::Object::New(env);
      device.Set("id", Napi::String::New(env, DeviceIdToHex(playback[i].id)));
      device.Set("name", Napi::String::New(env, playback[i].name));
      device.Set("isDefault", Napi::Boolean::New(env, playback[i].isDefault == MA_TRUE));
      result.Set(i, device);
    }
  }
  ma_context_uninit(&context);
  return result;
}

Napi::Value ProbeDevice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ma_device_id deviceId;
  ma_device_id* deviceIdPtr = nullptr;
  if (info.Length() > 0 && info[0].IsString()) {
    if (!HexToDeviceId(info[0].As<Napi::String>().Utf8Value(), &deviceId)) {
      Napi::Error::New(env, "invalid device id").ThrowAsJavaScriptException();
      return env.Null();
    }
    deviceIdPtr = &deviceId;
  }
  ma_context context;
  if (ma_context_init(nullptr, 0, nullptr, &context) != MA_SUCCESS) {
    Napi::Error::New(env, "ma_context_init failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  ma_device_info detail{};
  ma_result rc;
  if (deviceIdPtr == nullptr) {
    // Resolve the default playback device, then probe it.
    ma_device_info* playback = nullptr;
    ma_uint32 count = 0;
    rc = ma_context_get_devices(&context, &playback, &count, nullptr, nullptr);
    if (rc == MA_SUCCESS) {
      rc = MA_ERROR;
      for (ma_uint32 i = 0; i < count; i++) {
        if (playback[i].isDefault == MA_TRUE) {
          deviceId = playback[i].id;
          deviceIdPtr = &deviceId;
          rc = MA_SUCCESS;
          break;
        }
      }
      if (rc != MA_SUCCESS && count > 0) {
        deviceId = playback[0].id;
        deviceIdPtr = &deviceId;
        rc = MA_SUCCESS;
      }
    }
    if (rc != MA_SUCCESS) {
      ma_context_uninit(&context);
      Napi::Error::New(env, "no playback devices").ThrowAsJavaScriptException();
      return env.Null();
    }
  }
  rc = ma_context_get_device_info(&context, ma_device_type_playback, deviceIdPtr, &detail);
  if (rc != MA_SUCCESS) {
    ma_context_uninit(&context);
    Napi::Error::New(env, std::string("ma_context_get_device_info: ") + ma_result_description(rc))
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("name", Napi::String::New(env, detail.name));
  Napi::Array formats = Napi::Array::New(env);
  for (ma_uint32 i = 0; i < detail.nativeDataFormatCount; i++) {
    Napi::Object f = Napi::Object::New(env);
    f.Set("format", Napi::String::New(env, FormatName(detail.nativeDataFormats[i].format)));
    f.Set("channels", Napi::Number::New(env, detail.nativeDataFormats[i].channels));
    f.Set("sampleRate", Napi::Number::New(env, detail.nativeDataFormats[i].sampleRate));
    formats.Set(i, f);
  }
  result.Set("formats", formats);
  ma_context_uninit(&context);
  return result;
}

void CloseInternal() {
  if (g_player.deviceInitialized) {
    ma_device_uninit(&g_player.device);
    g_player.deviceInitialized = false;
  }
  g_player.framesRendered.store(0);
  g_player.underruns.store(0);
  g_player.eos.store(false);
  g_player.drained.store(false);
  g_player.ring.reset();
}

Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::Error::New(env, "open(opts) requires an options object").ThrowAsJavaScriptException();
    return env.Null();
  }
  CloseInternal();

  Napi::Object opts = info[0].As<Napi::Object>();
  const uint32_t sampleRate =
      opts.Has("sampleRate") ? opts.Get("sampleRate").As<Napi::Number>().Uint32Value() : 44100;
  const uint32_t channels =
      opts.Has("channels") ? opts.Get("channels").As<Napi::Number>().Uint32Value() : 2;
  const std::string formatName =
      opts.Has("format") ? opts.Get("format").As<Napi::String>().Utf8Value() : "s16";
  const bool exclusive =
      opts.Has("exclusive") ? opts.Get("exclusive").As<Napi::Boolean>().Value() : true;
  const uint32_t ringMs =
      opts.Has("ringMs") ? opts.Get("ringMs").As<Napi::Number>().Uint32Value() : 2000;

  const ma_format format = FormatFromName(formatName);
  if (format == ma_format_unknown) {
    Napi::Error::New(env, "unsupported format: " + formatName).ThrowAsJavaScriptException();
    return env.Null();
  }

  ma_device_id deviceId;
  ma_device_id* deviceIdPtr = nullptr;
  if (opts.Has("deviceId") && opts.Get("deviceId").IsString()) {
    if (!HexToDeviceId(opts.Get("deviceId").As<Napi::String>().Utf8Value(), &deviceId)) {
      Napi::Error::New(env, "invalid device id").ThrowAsJavaScriptException();
      return env.Null();
    }
    deviceIdPtr = &deviceId;
  }

  g_player.bytesPerFrame = static_cast<uint32_t>(ma_get_bytes_per_sample(format)) * channels;
  const uint64_t ringBytes =
      static_cast<uint64_t>(sampleRate) * g_player.bytesPerFrame * ringMs / 1000;
  g_player.ring.allocate(ringBytes < 65536 ? 65536 : ringBytes);

  ma_device_config config = ma_device_config_init(ma_device_type_playback);
  config.playback.pDeviceID = deviceIdPtr;
  config.playback.format = format;
  config.playback.channels = channels;
  config.sampleRate = sampleRate;
  config.dataCallback = DataCallback;
  config.pUserData = &g_player;
  config.playback.shareMode = exclusive ? ma_share_mode_exclusive : ma_share_mode_shared;
  // Never let WASAPI resample behind our back; we either match the device
  // native format or we report the mismatch honestly.
  config.wasapi.noAutoConvertSRC = MA_TRUE;

  ma_result rc = ma_device_init(nullptr, &config, &g_player.device);
  if (rc != MA_SUCCESS) {
    Napi::Error::New(env, std::string("ma_device_init: ") + ma_result_description(rc))
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  g_player.deviceInitialized = true;

  Napi::Object result = Napi::Object::New(env);
  result.Set("deviceName", Napi::String::New(env, g_player.device.playback.name));
  result.Set("exclusive", Napi::Boolean::New(env, exclusive));
  result.Set("requestedFormat", Napi::String::New(env, formatName));
  result.Set("requestedSampleRate", Napi::Number::New(env, sampleRate));
  result.Set("requestedChannels", Napi::Number::New(env, channels));
  // What the device is actually running — if these differ from the request,
  // miniaudio is converting and the path is NOT bit-perfect.
  result.Set("internalFormat",
             Napi::String::New(env, FormatName(g_player.device.playback.internalFormat)));
  result.Set("internalSampleRate",
             Napi::Number::New(env, g_player.device.playback.internalSampleRate));
  result.Set("internalChannels",
             Napi::Number::New(env, g_player.device.playback.internalChannels));
  result.Set("periodSizeInFrames",
             Napi::Number::New(env, g_player.device.playback.internalPeriodSizeInFrames));
  result.Set("capacityFrames",
             Napi::Number::New(env, static_cast<double>(g_player.ring.capacity /
                                                        g_player.bytesPerFrame)));
  return result;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_player.deviceInitialized) {
    Napi::Error::New(env, "no device open").ThrowAsJavaScriptException();
    return env.Null();
  }
  const ma_result rc = ma_device_start(&g_player.device);
  if (rc != MA_SUCCESS && rc != MA_INVALID_OPERATION) {  // INVALID_OPERATION = already started
    Napi::Error::New(env, std::string("ma_device_start: ") + ma_result_description(rc))
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value StopDevice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_player.deviceInitialized) return Napi::Boolean::New(env, false);
  ma_device_stop(&g_player.device);
  return Napi::Boolean::New(env, true);
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_player.deviceInitialized) {
    Napi::Error::New(env, "no device open").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::Error::New(env, "write(buffer) requires a Buffer").ThrowAsJavaScriptException();
    return env.Null();
  }
  auto buf = info[0].As<Napi::Buffer<unsigned char>>();
  const uint64_t accepted = g_player.ring.push(buf.Data(), buf.Length());
  if (accepted > 0) g_player.drained.store(false, std::memory_order_release);
  return Napi::Number::New(env, static_cast<double>(accepted));
}

Napi::Value Clear(const Napi::CallbackInfo& info) {
  g_player.ring.reset();
  g_player.drained.store(false, std::memory_order_release);
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value SetEos(const Napi::CallbackInfo& info) {
  const bool value = info.Length() > 0 && info[0].IsBoolean()
                         ? info[0].As<Napi::Boolean>().Value()
                         : true;
  g_player.eos.store(value, std::memory_order_release);
  if (!value) g_player.drained.store(false, std::memory_order_release);
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Stats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  const uint32_t bpf = g_player.bytesPerFrame ? g_player.bytesPerFrame : 1;
  result.Set("framesRendered",
             Napi::Number::New(env, static_cast<double>(g_player.framesRendered.load())));
  result.Set("bufferedFrames",
             Napi::Number::New(env, static_cast<double>(g_player.ring.available() / bpf)));
  result.Set("capacityFrames",
             Napi::Number::New(env, static_cast<double>(g_player.ring.capacity / bpf)));
  result.Set("underruns",
             Napi::Number::New(env, static_cast<double>(g_player.underruns.load())));
  result.Set("drained", Napi::Boolean::New(env, g_player.drained.load()));
  result.Set("running",
             Napi::Boolean::New(env, g_player.deviceInitialized &&
                                         ma_device_is_started(&g_player.device) == MA_TRUE));
  return result;
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  CloseInternal();
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("probeDevice", Napi::Function::New(env, ProbeDevice));
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stopDevice", Napi::Function::New(env, StopDevice));
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("clear", Napi::Function::New(env, Clear));
  exports.Set("setEos", Napi::Function::New(env, SetEos));
  exports.Set("stats", Napi::Function::New(env, Stats));
  exports.Set("close", Napi::Function::New(env, Close));
  return exports;
}

NODE_API_MODULE(newamp_audio, Init)

}  // namespace
