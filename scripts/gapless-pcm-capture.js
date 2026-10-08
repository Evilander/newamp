// Capture worklet for scripts/gapless-pcm-boundary-test.mjs. Records the left
// channel of whatever feeds it (the engine's master gain, i.e. the graph's
// final output with the limiter off) plus the context frame each block
// started on, and tracks the largest left/right difference seen. A 'mark'
// message is stamped with the capture index it arrived at, which places
// probe events in the capture's own timeline (the main thread's
// currentTime can trail the render thread by a callback or two).

const CHUNK_FRAMES = 16384;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunk = new Float32Array(CHUNK_FRAMES);
    this.filled = 0;
    this.recorded = 0;
    this.maxChannelDiff = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.t === 'mark') {
        this.port.postMessage({ t: 'marked', name: event.data.name, index: this.recorded });
      } else if (event.data === 'start') {
        this.recording = true;
        this.port.postMessage({ t: 'started', frame: currentFrame });
      } else if (event.data === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ t: 'stopped', frame: currentFrame, maxChannelDiff: this.maxChannelDiff });
      }
    };
  }

  flush() {
    if (!this.filled) return;
    this.port.postMessage({ t: 'pcm', pcm: this.chunk.slice(0, this.filled) });
    this.filled = 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    const left = input && input[0];
    const right = input && input[1];
    const frames = left ? left.length : 128;
    for (let i = 0; i < frames; i++) {
      const l = left ? left[i] : 0;
      if (right) this.maxChannelDiff = Math.max(this.maxChannelDiff, Math.abs(l - right[i]));
      this.chunk[this.filled++] = l;
      this.recorded++;
      if (this.filled === CHUNK_FRAMES) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
