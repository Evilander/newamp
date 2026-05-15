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
