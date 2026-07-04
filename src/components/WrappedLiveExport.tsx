// Wrapped Live export panel — records the 30s wrapped-live-scene canvas
// (visible as a live preview, which also keeps captureStream compositor-fed)
// while the user's top track plays, then finishes to a vertical MP4 via the
// video:save-clip IPC. Muted mode records silently without touching playback
// — for the copyright-bot-wary sharing crowd.

import { useEffect, useRef, useState } from 'react';
import type { WrappedStats } from '@shared/types';
import { usePlayerStore, engine } from '../store/usePlayerStore';
import { api } from '../lib/api';
import { createCanvasRecorder } from '../visualizer/eviland-recorder';
import { createWrappedLiveScene, type WrappedLiveScene } from '../visualizer/wrapped-live-scene';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}

export function WrappedLiveExport({ stats }: { stats: WrappedStats }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<WrappedLiveScene | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => () => {
    cancelRef.current = true;
    sceneRef.current?.stop();
  }, []);

  async function exportVideo(): Promise<void> {
    const canvas = canvasRef.current;
    if (!canvas || phase !== 'idle') return;
    cancelRef.current = false;
    setMessage(null);

    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#39ff14';
    const scene = createWrappedLiveScene(canvas, { stats, accent });
    if (!scene) {
      setMessage('Could not create the render canvas.');
      return;
    }
    sceneRef.current = scene;

    // Audio bed: play the top track from the start and tap the engine's
    // parallel visualizer node — the master graph is never touched.
    let audioDest: MediaStreamAudioDestinationNode | null = null;
    let audioStream: MediaStream | undefined;
    const exclusiveConfigured =
      usePlayerStore.getState().settings?.bitPerfectExclusive === true ||
      engine.getExclusiveInfo().active;
    if (!muted && exclusiveConfigured) {
      // The capture tap rides the Web Audio graph, which is silent while the
      // native exclusive path owns the DAC. Refuse to render a silent "audio
      // on" export — that's worse than telling the user why.
      setMessage(
        'Bit-Perfect Exclusive is on, so the audio bed can’t be captured. Toggle it off in Settings → Playback (or export muted).',
      );
      scene.stop();
      sceneRef.current = null;
      return;
    }
    if (!muted) {
      const topId = stats.topTracks[0]?.id;
      if (topId) {
        try {
          const track = await api.getTrack(topId);
          if (track) await usePlayerStore.getState().playTrack(track);
        } catch (err) {
          console.warn('[newamp] wrapped-live: top track playback failed, exporting silent', err);
        }
      }
      try {
        audioDest = engine.ctx.createMediaStreamDestination();
        engine.visualizerNode.connect(audioDest);
        audioStream = audioDest.stream;
      } catch {
        audioDest = null;
      }
    }

    const releaseAudio = (): void => {
      if (audioDest) {
        try {
          engine.visualizerNode.disconnect(audioDest);
        } catch {
          /* ignore */
        }
        audioDest = null;
      }
    };

    try {
      const recorder = createCanvasRecorder(canvas, { fps: 30, videoBitsPerSecond: 10_000_000 });
      scene.start();
      recorder.start(audioStream);
      setPhase('recording');
      const progressTimer = window.setInterval(() => setProgress(scene.progress()), 200);

      await new Promise((resolve) => setTimeout(resolve, scene.durationMs + 250));
      window.clearInterval(progressTimer);
      scene.stop();
      const blob = await recorder.stop();
      releaseAudio();
      if (cancelRef.current) return;
      if (!blob || !blob.size) {
        setMessage('Recording produced no data.');
        setPhase('idle');
        return;
      }
      setPhase('saving');
      const dataUrl = await blobToDataUrl(blob);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const path = await api.saveClipMp4({
        base64,
        defaultName: `NewAmp Wrapped - ${stats.label}`,
        maxHeight: 1920,
      });
      setMessage(path ? `Saved → ${path}` : 'Save cancelled.');
    } catch (err) {
      console.error('[newamp] wrapped-live export failed:', err);
      setMessage('Export failed — see the console for details.');
    } finally {
      releaseAudio();
      sceneRef.current = null;
      setPhase('idle');
      setProgress(0);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-newamp-wrapped-live>
      <div className="flex items-center gap-2">
        <button
          className={`pxbtn ${open ? 'is-active' : ''}`}
          onClick={() => setOpen((v) => !v)}
          title="Turn this Wrapped into a 30-second vertical video"
          data-newamp-wrapped-live-toggle
        >
          WRAPPED LIVE
        </button>
        {open && (
          <>
            <button
              className="pxbtn is-active"
              onClick={() => void exportVideo()}
              disabled={phase !== 'idle'}
              data-newamp-wrapped-live-export
            >
              {phase === 'recording'
                ? `Rendering… ${Math.round(progress * 100)}%`
                : phase === 'saving'
                  ? 'Encoding MP4…'
                  : '● Export 30s video'}
            </button>
            <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--ink-2)' }}>
              <input
                type="checkbox"
                checked={muted}
                onChange={(e) => setMuted(e.target.checked)}
                disabled={phase !== 'idle'}
              />
              Silent (no audio bed)
            </label>
          </>
        )}
      </div>
      {open && (
        <div className="flex items-start gap-3">
          {/* Live preview — the actual render surface, scaled down. Keeping it
              visible is what keeps captureStream fed. */}
          <canvas
            ref={canvasRef}
            width={1080}
            height={1920}
            style={{
              width: 202,
              height: 360,
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: '#0a0c0a',
            }}
            data-newamp-wrapped-live-canvas
          />
          <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)', maxWidth: 300 }}>
            <span>
              Six chapters · 30 seconds · 1080×1920 — scored to
              {stats.topTracks[0] ? ` “${stats.topTracks[0].title}”` : ' your top track'} unless silent.
            </span>
            <span>Starts playing your top track when export begins.</span>
            {message && <span style={{ color: 'var(--ink-2)' }}>{message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
