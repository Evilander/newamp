export interface AudioOutputCandidate {
  deviceId?: string | null;
  label?: string | null;
  kind?: string | null;
}

export interface AudioOutputDeviceOption {
  deviceId: string;
  label: string;
}

export function normalizeAudioOutputDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

export function uniqueAudioOutputDevices(devices: AudioOutputCandidate[]): AudioOutputDeviceOption[] {
  const seen = new Set<string>();
  const outputs: AudioOutputDeviceOption[] = [];

  for (const device of devices) {
    if (device.kind !== 'audiooutput') continue;
    const deviceId = normalizeAudioOutputDeviceId(device.deviceId);
    if (!deviceId || seen.has(deviceId)) continue;

    seen.add(deviceId);
    const label = typeof device.label === 'string' && device.label.trim()
      ? device.label.trim()
      : `Audio output ${outputs.length + 1}`;
    outputs.push({ deviceId, label });
  }

  return outputs;
}
