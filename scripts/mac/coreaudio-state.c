// Reads and changes CoreAudio output-device state for scripts/mac/hog-probe.mjs
// and for watching the DAC while NewAmp plays in exclusive mode. Builds with
// the Xcode command line tools:
//
//   clang -O1 -Wall -o coreaudio-state coreaudio-state.c \
//     -framework CoreAudio -framework CoreFoundation
//
//   coreaudio-state list                      every output device, as JSON
//   coreaudio-state get [uid]                 the default output (or the uid)
//   coreaudio-state set-rate <hz> [uid]       set the nominal sample rate
//   coreaudio-state hog <ms> [uid]            own the device for <ms>, then let go
//   coreaudio-state watch <seconds> [uid]     one JSON line whenever rate, hog or
//                                             running state changes
//
// "get" and "list" only read. "set-rate" and "hog" change the system's audio
// setup and say so in their output.
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

#include <AvailabilityMacros.h>
#if MAC_OS_X_VERSION_MAX_ALLOWED < 120000
#define kAudioObjectPropertyElementMain kAudioObjectPropertyElementMaster
#endif

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector,
                                          AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress a = {selector, scope, kAudioObjectPropertyElementMain};
  return a;
}

static OSStatus get_value(AudioObjectID object, AudioObjectPropertySelector selector,
                          AudioObjectPropertyScope scope, void *out, UInt32 size) {
  AudioObjectPropertyAddress a = address(selector, scope);
  UInt32 io = size;
  return AudioObjectGetPropertyData(object, &a, 0, NULL, &io, out);
}

static long long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static void json_string(const char *s) {
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') {
      putchar('\\');
      putchar(c);
    } else if (c < 0x20) {
      printf("\\u%04x", c);
    } else {
      putchar(c);
    }
  }
  putchar('"');
}

static void fourcc(UInt32 value, char out[5]) {
  for (int i = 0; i < 4; i++) {
    unsigned char c = (unsigned char)((value >> (24 - 8 * i)) & 0xff);
    out[i] = (c >= 0x20 && c < 0x7f) ? (char)c : '?';
  }
  out[4] = 0;
}

static void string_property(AudioObjectID object, AudioObjectPropertySelector selector, char *buf,
                            size_t size) {
  CFStringRef value = NULL;
  buf[0] = 0;
  if (get_value(object, selector, kAudioObjectPropertyScopeGlobal, &value, sizeof(value)) == noErr &&
      value != NULL) {
    if (!CFStringGetCString(value, buf, (CFIndex)size, kCFStringEncodingUTF8)) buf[0] = 0;
    CFRelease(value);
  }
}

static int has_output(AudioObjectID device) {
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &a, 0, NULL, &size) != noErr) return 0;
  return size > 0;
}

static AudioObjectID default_output(void) {
  AudioObjectID device = kAudioObjectUnknown;
  get_value(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal, &device, sizeof(device));
  return device;
}

static AudioObjectID device_for_uid(const char *uid) {
  CFStringRef cf = CFStringCreateWithCString(kCFAllocatorDefault, uid, kCFStringEncodingUTF8);
  if (cf == NULL) return kAudioObjectUnknown;
  AudioObjectID device = kAudioObjectUnknown;
  AudioValueTranslation translation = {&cf, sizeof(cf), &device, sizeof(device)};
  AudioObjectPropertyAddress a =
      address(kAudioHardwarePropertyDeviceForUID, kAudioObjectPropertyScopeGlobal);
  UInt32 size = sizeof(translation);
  OSStatus rc = AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &translation);
  CFRelease(cf);
  return rc == noErr ? device : kAudioObjectUnknown;
}

static AudioObjectID pick_device(const char *uid) {
  return (uid != NULL && uid[0] != 0) ? device_for_uid(uid) : default_output();
}

static void print_format(AudioObjectID stream, AudioObjectPropertySelector selector) {
  AudioStreamBasicDescription f;
  memset(&f, 0, sizeof(f));
  if (get_value(stream, selector, kAudioObjectPropertyScopeGlobal, &f, sizeof(f)) != noErr) {
    printf("null");
    return;
  }
  char id[5];
  fourcc(f.mFormatID, id);
  printf("{\"rate\":%.0f,\"bits\":%u,\"channels\":%u,\"format\":\"%s\",\"flags\":%u}", f.mSampleRate,
         (unsigned)f.mBitsPerChannel, (unsigned)f.mChannelsPerFrame, id, (unsigned)f.mFormatFlags);
}

static void print_device(AudioObjectID device, int is_default) {
  char name[256], uid[256], transport_text[5];
  Float64 nominal = 0, actual = 0;
  pid_t hog = -1;
  UInt32 running = 0, transport = 0;
  string_property(device, kAudioObjectPropertyName, name, sizeof(name));
  string_property(device, kAudioDevicePropertyDeviceUID, uid, sizeof(uid));
  get_value(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, &nominal,
            sizeof(nominal));
  get_value(device, kAudioDevicePropertyActualSampleRate, kAudioObjectPropertyScopeGlobal, &actual,
            sizeof(actual));
  get_value(device, kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, &hog, sizeof(hog));
  get_value(device, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal,
            &running, sizeof(running));
  get_value(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, &transport,
            sizeof(transport));
  fourcc(transport, transport_text);

  printf("{\"id\":%u,\"name\":", (unsigned)device);
  json_string(name);
  printf(",\"uid\":");
  json_string(uid);
  printf(",\"isDefault\":%s,\"transport\":\"%s\",\"nominalRate\":%.0f,\"actualRate\":%.0f,"
         "\"hogPid\":%d,\"runningSomewhere\":%s",
         is_default ? "true" : "false", transport_text, nominal, actual, (int)hog,
         running ? "true" : "false");

  printf(",\"availableRates\":[");
  AudioObjectPropertyAddress rates =
      address(kAudioDevicePropertyAvailableNominalSampleRates, kAudioObjectPropertyScopeGlobal);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &rates, 0, NULL, &size) == noErr && size > 0) {
    AudioValueRange *ranges = malloc(size);
    if (ranges != NULL &&
        AudioObjectGetPropertyData(device, &rates, 0, NULL, &size, ranges) == noErr) {
      UInt32 count = size / sizeof(AudioValueRange);
      for (UInt32 i = 0; i < count; i++) {
        printf("%s[%.0f,%.0f]", i ? "," : "", ranges[i].mMinimum, ranges[i].mMaximum);
      }
    }
    free(ranges);
  }
  printf("]");

  printf(",\"physicalFormat\":");
  AudioObjectPropertyAddress streams =
      address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput);
  size = 0;
  AudioObjectID *ids = NULL;
  if (AudioObjectGetPropertyDataSize(device, &streams, 0, NULL, &size) == noErr && size > 0) {
    ids = malloc(size);
    if (ids != NULL &&
        AudioObjectGetPropertyData(device, &streams, 0, NULL, &size, ids) != noErr) {
      free(ids);
      ids = NULL;
    }
  }
  if (ids != NULL) {
    print_format(ids[0], kAudioStreamPropertyPhysicalFormat);
    printf(",\"virtualFormat\":");
    print_format(ids[0], kAudioStreamPropertyVirtualFormat);
    free(ids);
  } else {
    printf("null,\"virtualFormat\":null");
  }
  printf("}");
}

static int cmd_list(void) {
  AudioObjectPropertyAddress a = address(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size) != noErr) return 2;
  AudioObjectID *ids = malloc(size);
  if (ids == NULL) return 2;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, ids) != noErr) {
    free(ids);
    return 2;
  }
  AudioObjectID fallback = default_output();
  UInt32 count = size / sizeof(AudioObjectID);
  int first = 1;
  printf("[");
  for (UInt32 i = 0; i < count; i++) {
    if (!has_output(ids[i])) continue;
    printf("%s", first ? "" : ",");
    first = 0;
    print_device(ids[i], ids[i] == fallback);
  }
  printf("]\n");
  free(ids);
  return 0;
}

static int cmd_get(const char *uid) {
  AudioObjectID device = pick_device(uid);
  if (device == kAudioObjectUnknown) {
    printf("{\"error\":\"no such output device\"}\n");
    return 2;
  }
  print_device(device, device == default_output());
  printf("\n");
  return 0;
}

static int cmd_set_rate(double hz, const char *uid) {
  AudioObjectID device = pick_device(uid);
  if (device == kAudioObjectUnknown) {
    printf("{\"error\":\"no such output device\"}\n");
    return 2;
  }
  AudioObjectPropertyAddress a =
      address(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
  Float64 target = hz;
  OSStatus rc = AudioObjectSetPropertyData(device, &a, 0, NULL, sizeof(target), &target);
  printf("{\"changedSystemSetting\":true,\"requested\":%.0f,\"status\":%d}\n", hz, (int)rc);
  return rc == noErr ? 0 : 1;
}

// Setting kAudioDevicePropertyHogMode toggles: it takes the device when nobody
// owns it and releases it when the caller does. The value passed in is not
// used, so the owner is always read back instead of trusted.
static int cmd_hog(int hold_ms, const char *uid) {
  AudioObjectID device = pick_device(uid);
  if (device == kAudioObjectUnknown) {
    printf("{\"error\":\"no such output device\"}\n");
    return 2;
  }
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal);
  pid_t before = -1;
  get_value(device, kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, &before, sizeof(before));
  if (before != -1) {
    printf("{\"changedSystemSetting\":false,\"error\":\"already hogged\",\"owner\":%d}\n", (int)before);
    return 1;
  }
  pid_t self = getpid();
  OSStatus rc = AudioObjectSetPropertyData(device, &a, 0, NULL, sizeof(self), &self);
  pid_t during = -1;
  get_value(device, kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, &during, sizeof(during));
  printf("{\"changedSystemSetting\":true,\"takeStatus\":%d,\"ownerWhileHeld\":%d,\"pid\":%d}\n", (int)rc,
         (int)during, (int)self);
  fflush(stdout);
  for (long long until = now_ms() + hold_ms; now_ms() < until;) usleep(20 * 1000);
  pid_t release = -1;
  OSStatus rc2 = AudioObjectSetPropertyData(device, &a, 0, NULL, sizeof(release), &release);
  pid_t after = -1;
  get_value(device, kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, &after, sizeof(after));
  printf("{\"releaseStatus\":%d,\"ownerAfter\":%d}\n", (int)rc2, (int)after);
  return (rc == noErr && rc2 == noErr && during == self && after == -1) ? 0 : 1;
}

static int cmd_watch(int seconds, const char *uid) {
  AudioObjectID device = pick_device(uid);
  if (device == kAudioObjectUnknown) {
    printf("{\"error\":\"no such output device\"}\n");
    return 2;
  }
  long long start = now_ms();
  Float64 last_rate = -1;
  pid_t last_hog = -2;
  UInt32 last_running = 2;
  while (now_ms() - start < (long long)seconds * 1000) {
    Float64 rate = 0;
    pid_t hog = -1;
    UInt32 running = 0;
    get_value(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, &rate,
              sizeof(rate));
    get_value(device, kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, &hog, sizeof(hog));
    get_value(device, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal,
              &running, sizeof(running));
    if (rate != last_rate || hog != last_hog || running != last_running) {
      printf("{\"t\":%lld,\"nominalRate\":%.0f,\"hogPid\":%d,\"runningSomewhere\":%s}\n", now_ms() - start,
             rate, (int)hog, running ? "true" : "false");
      last_rate = rate;
      last_hog = hog;
      last_running = running;
    }
    usleep(50 * 1000);
  }
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (argc < 2) {
    fprintf(stderr, "usage: coreaudio-state list | get [uid] | set-rate <hz> [uid] | hog <ms> [uid] | watch <seconds> [uid]\n");
    return 64;
  }
  const char *command = argv[1];
  if (strcmp(command, "list") == 0) return cmd_list();
  if (strcmp(command, "get") == 0) return cmd_get(argc > 2 ? argv[2] : NULL);
  if (strcmp(command, "set-rate") == 0 && argc > 2) return cmd_set_rate(atof(argv[2]), argc > 3 ? argv[3] : NULL);
  if (strcmp(command, "hog") == 0 && argc > 2) return cmd_hog(atoi(argv[2]), argc > 3 ? argv[3] : NULL);
  if (strcmp(command, "watch") == 0 && argc > 2) return cmd_watch(atoi(argv[2]), argc > 3 ? argv[3] : NULL);
  fprintf(stderr, "unknown or incomplete command: %s\n", command);
  return 64;
}
