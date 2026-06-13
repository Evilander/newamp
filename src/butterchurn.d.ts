declare module 'butterchurn' {
  interface ButterchurnVisualizer {
    connectAudio(audioNode: AudioNode): void;
    disconnectAudio(audioNode: AudioNode): void;
    loadPreset(preset: Record<string, unknown>, blendSeconds?: number): void;
    render(): void;
    setRendererSize(width: number, height: number): void;
  }

  const butterchurn: {
    createVisualizer(
      context: AudioContext,
      canvas: HTMLCanvasElement,
      opts: Record<string, unknown>,
    ): ButterchurnVisualizer;
  };

  export default butterchurn;
}

declare module 'butterchurn-presets' {
  const presetApi: {
    getPresets(): Record<string, Record<string, unknown>>;
  };

  export default presetApi;
}

// Extra preset packs (Extra/Extra2/MD1/...) share the base pack's API.
declare module 'butterchurn-presets/lib/*' {
  const presetApi: {
    getPresets(): Record<string, Record<string, unknown>>;
  };

  export default presetApi;
}
