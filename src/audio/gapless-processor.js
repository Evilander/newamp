// AudioWorklet half of the sample-accurate gapless transport. The producer is
// electron/gapless-transport.ts; the engine side is src/audio/sample-transport.ts.
//
// Interleaved stereo f32 arrives from the main process on a transferred
// MessagePort, with a segment marker in-band at the exact frame where each
// track starts. This processor is the transport's only clock: it plays frames
// in order, switches ReplayGain on a segment's first frame, and reports
// segment starts, position, underruns, duration corrections and the end of
// the stream back to the engine. Plain JS on purpose: audioWorklet.addModule
// loads it as-is.

const CREDIT_FRAMES = 4096;
const POSITION_FRAMES = 2048;
// Output starts once this much is queued (or the stream is known to be
// shorter), so a start or seek never plays one chunk and then underruns while
// ffmpeg is still spinning up.
const PREROLL_FRAMES = 4096;
// Same smoothing the engine's ReplayGain node uses for a mid-track change.
const GAIN_TIME_CONSTANT_SEC = 0.006;

class GaplessProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gen = 0;
    this.data = null;
    this.playing = false;
    this.disposed = false;
    this.gainCoef = 1 - Math.exp(-1 / (GAIN_TIME_CONSTANT_SEC * sampleRate));
    this.reset(0);
    this.underruns = 0;
    this.port.onmessage = (event) => this.control(event.data, event.ports);
  }

  reset(gen) {
    this.gen = gen;
    // Items: { pcm, offset } | { seg } | { fail } | { end: true }
    this.queue = [];
    // ReplayGain retargets and duration corrections for segments whose
    // marker hasn't arrived yet.
    this.gains = new Map();
    this.durations = new Map();
    this.queued = 0;
    this.primed = false;
    this.endQueued = false;
    this.drained = false;
    this.segment = null;
    this.segmentFrames = 0;
    this.gain = 1;
    this.gainTarget = 1;
    this.consumed = 0;
    this.creditedAt = 0;
    this.reportedAt = currentFrame;
    this.starving = false;
  }

  control(msg, ports) {
    switch (msg.t) {
      case 'data-port':
        if (this.data) this.data.close();
        this.data = ports[0];
        this.data.onmessage = (event) => this.receive(event.data);
        break;
      case 'flush':
        // The data port may already have moved to this generation.
        if (msg.gen > this.gen) this.reset(msg.gen);
        if (msg.gen >= this.gen) this.playing = !!msg.playing;
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        this.reportPosition(currentFrame);
        break;
      case 'gain':
        this.setGain(msg.token, msg.gain);
        break;
      case 'dispose':
        // The engine let go of this node; stop processing so it can be collected.
        this.disposed = true;
        if (this.data) this.data.close();
        this.data = null;
        break;
    }
  }

  receive(msg) {
    if (msg.gen < this.gen) return;
    if (msg.gen > this.gen) this.reset(msg.gen);
    switch (msg.t) {
      case 'pcm':
        this.queue.push({ pcm: msg.pcm, offset: 0 });
        this.queued += msg.pcm.length >> 1;
        break;
      case 'seg':
        if (this.gains.has(msg.token)) msg.gain = this.gains.get(msg.token);
        if (this.durations.has(msg.token)) msg.durationSec = this.durations.get(msg.token);
        this.queue.push({ seg: msg });
        break;
      case 'fail':
        this.queue.push({ fail: msg });
        break;
      case 'cut':
        this.cut(msg.token);
        break;
      case 'dur':
        this.setDuration(msg.token, msg.durationSec);
        break;
      case 'end':
        this.queue.push({ end: true });
        this.endQueued = true;
        break;
    }
  }

  // The producer revoked a chained segment. Everything of it already here is
  // queued ahead of this message, so drop from its marker to the tail; if it
  // is already audible, drop the rest of it.
  cut(token) {
    let from = this.queue.findIndex((item) => item.seg && item.seg.token === token);
    if (from < 0 && this.segment && this.segment.token === token) from = 0;
    if (from < 0) return;
    for (const item of this.queue.splice(from)) {
      if (!item.pcm) continue;
      const frames = (item.pcm.length >> 1) - item.offset;
      this.queued -= frames;
      this.consumed += frames;
    }
    this.credit(true);
  }

  // The segment may be audible, queued, or still on its way from the producer.
  setGain(token, gain) {
    this.gains.set(token, gain);
    if (this.segment && this.segment.token === token) this.gainTarget = gain;
    for (const item of this.queue) {
      if (item.seg && item.seg.token === token) item.seg.gain = gain;
    }
  }

  // Same reach as setGain, so a segment entered later reports the corrected
  // length; the engine side hears about it now either way.
  setDuration(token, durationSec) {
    this.durations.set(token, durationSec);
    if (this.segment && this.segment.token === token) this.segment.durationSec = durationSec;
    for (const item of this.queue) {
      if (item.seg && item.seg.token === token) item.seg.durationSec = durationSec;
    }
    this.port.postMessage({ t: 'dur', gen: this.gen, token, durationSec });
  }

  enter(seg, offset, failure) {
    const first = this.segment == null;
    this.segment = seg;
    this.segmentFrames = 0;
    this.gain = seg.gain;
    this.gainTarget = seg.gain;
    this.port.postMessage({
      t: 'segment',
      gen: this.gen,
      token: seg.token,
      durationSec: seg.durationSec,
      sourceRate: seg.sourceRate,
      resampler: seg.resampler,
      first,
      frame: currentFrame + offset,
      failed: failure,
    });
  }

  reportPosition(frame) {
    this.reportedAt = frame;
    this.port.postMessage({
      t: 'pos',
      gen: this.gen,
      token: this.segment ? this.segment.token : null,
      segmentFrames: this.segmentFrames,
      frame,
      playing: this.playing,
      starving: this.starving,
      underruns: this.underruns,
      queued: this.queued,
    });
  }

  credit(force) {
    if (!this.data || (!force && this.consumed - this.creditedAt < CREDIT_FRAMES)) return;
    this.creditedAt = this.consumed;
    this.data.postMessage({ t: 'credit', gen: this.gen, consumed: this.consumed });
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const left = channels[0];
    const right = channels[1] || left;
    const frames = left.length;
    if (this.disposed) return false;
    if (!this.playing) return true;
    if (!this.primed) {
      if (this.queued < PREROLL_FRAMES && !this.endQueued && !this.queue.some((item) => item.fail)) return true;
      this.primed = true;
    }
    let written = 0;
    while (written < frames) {
      const item = this.queue[0];
      if (!item) break;
      if (item.seg) {
        // A marker takes effect only once its first frame (or its failure, or
        // the end) is here, so a boundary is never reported for a track whose
        // audio has not arrived.
        const following = this.queue[1];
        if (!following) break;
        this.queue.shift();
        if (following.fail && following.fail.token === item.seg.token) {
          this.queue.shift();
          this.enter(item.seg, written, following.fail.message);
        } else {
          this.enter(item.seg, written, null);
        }
        continue;
      }
      if (item.fail) {
        // A failure after the segment's audio began (its resampler died).
        this.queue.shift();
        this.port.postMessage({
          t: 'fail',
          gen: this.gen,
          token: item.fail.token,
          message: item.fail.message,
          audible: !!this.segment && this.segment.token === item.fail.token,
        });
        continue;
      }
      if (item.end) {
        this.queue.shift();
        if (!this.drained) {
          this.drained = true;
          this.port.postMessage({
            t: 'drained',
            gen: this.gen,
            token: this.segment ? this.segment.token : null,
            segmentFrames: this.segmentFrames,
            frame: currentFrame + written,
          });
        }
        continue;
      }
      const pcm = item.pcm;
      const take = Math.min((pcm.length >> 1) - item.offset, frames - written);
      let src = item.offset * 2;
      const end = written + take;
      const target = this.gainTarget;
      if (this.gain === target) {
        const g = target;
        for (let i = written; i < end; i++, src += 2) {
          left[i] = pcm[src] * g;
          right[i] = pcm[src + 1] * g;
        }
      } else {
        let g = this.gain;
        const coef = this.gainCoef;
        for (let i = written; i < end; i++, src += 2) {
          g += (target - g) * coef;
          left[i] = pcm[src] * g;
          right[i] = pcm[src + 1] * g;
        }
        this.gain = Math.abs(target - g) < 1e-6 ? target : g;
      }
      item.offset += take;
      if (item.offset >= pcm.length >> 1) this.queue.shift();
      written += take;
      this.queued -= take;
      this.segmentFrames += take;
      this.consumed += take;
    }
    // Zero what was not written: silence on underrun, and after the end.
    for (let i = written; i < frames; i++) {
      left[i] = 0;
      right[i] = 0;
    }
    if (written < frames && !this.drained) {
      if (!this.starving) this.underruns++;
      this.starving = true;
    } else {
      this.starving = false;
    }
    this.credit(false);
    if (currentFrame + frames - this.reportedAt >= POSITION_FRAMES) this.reportPosition(currentFrame + frames);
    return true;
  }
}

registerProcessor('newamp-gapless', GaplessProcessor);
