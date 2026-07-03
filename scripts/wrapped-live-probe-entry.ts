// Wrapped Live probe — renders the real wrapped-live-scene against fixture
// stats at 6× speed and samples pixels at each chapter's midpoint. The smoke
// asserts every chapter paints (non-black) and that chapters actually differ
// (the film moves).

import { createWrappedLiveScene } from '../src/visualizer/wrapped-live-scene';
import type { WrappedStats } from '../shared/types';

declare global {
  interface Window {
    __wrappedLiveProbe: () => Promise<{
      created: boolean;
      chapters: Array<{ index: number; litFraction: number }>;
      interChapterDiff: number;
    }>;
  }
}

const FIXTURE: WrappedStats = {
  range: 'year' as WrappedStats['range'],
  label: '2026',
  generatedAt: 0,
  rangeStart: 0,
  rangeEnd: 0,
  totals: { plays: 4821, durationSec: 812_340, uniqueTracks: 1204, uniqueArtists: 341, discoveries: 187, loved: 96 },
  topTracks: [
    { id: 1, title: 'Biblical Violence', artist: 'Hella', plays: 88 },
    { id: 2, title: 'I Am Trying to Break Your Heart', artist: 'Wilco', plays: 71 },
    { id: 3, title: 'Dummy Discards A Heart', artist: 'Deerhoof', plays: 64 },
    { id: 4, title: 'Take Five', artist: 'The Dave Brubeck Quartet', plays: 52 },
    { id: 5, title: 'Oceania', artist: 'Björk', plays: 44 },
  ],
  topArtists: [
    { artist: 'Hella', plays: 240, durationSec: 51_000 },
    { artist: 'Wilco', plays: 198, durationSec: 61_000 },
    { artist: 'Deerhoof', plays: 154, durationSec: 39_000 },
    { artist: 'Björk', plays: 121, durationSec: 33_000 },
    { artist: 'Brubeck', plays: 98, durationSec: 29_000 },
  ],
  topAlbums: [],
  genres: [
    { genre: 'Math Rock', plays: 610 },
    { genre: 'Indie Rock', plays: 480 },
    { genre: 'Jazz', plays: 300 },
    { genre: 'Electronic', plays: 240 },
    { genre: 'Folk', plays: 150 },
    { genre: 'Ambient', plays: 90 },
  ],
  listeningClock: [2, 1, 0, 0, 0, 1, 4, 9, 14, 18, 20, 22, 25, 24, 22, 26, 30, 38, 45, 52, 44, 30, 16, 6],
  peakHour: 19,
  busiestDay: { date: '2026-03-14', plays: 61 },
  longestStreakDays: 23,
  taste: { energy: 0.72, brightness: 0.55, mood: 'Kinetic + Warm' },
};

window.__wrappedLiveProbe = async () => {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const SPEED = 6; // 30s film in 5s of wall time
  const scene = createWrappedLiveScene(canvas, { stats: FIXTURE, accent: '#39ff14', speed: SPEED });
  if (!scene) return { created: false, chapters: [], interChapterDiff: 0 };
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  scene.start();
  const chapters: Array<{ index: number; litFraction: number }> = [];
  const snapshots: Uint8ClampedArray[] = [];
  const chapterRealMs = 5_000 / SPEED;
  for (let i = 0; i < 6; i++) {
    // Sample at each chapter's midpoint.
    const target = (i + 0.5) * chapterRealMs;
    const wait = target - (i === 0 ? 0 : (i - 0.5) * chapterRealMs) - (i === 0 ? -0 : 0);
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? target : chapterRealMs));
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    const stride = 4 * 97; // sparse sample
    let sampled = 0;
    for (let p = 0; p < data.length; p += stride) {
      sampled += 1;
      if (data[p]! + data[p + 1]! + data[p + 2]! > 60) lit += 1;
    }
    chapters.push({ index: i, litFraction: lit / Math.max(1, sampled) });
    // Strided sample across the WHOLE frame (not the first rows, which are
    // mostly shared dark background) so the inter-chapter diff sees content.
    const sample = new Uint8ClampedArray(10_000);
    const step = Math.floor(data.length / 4 / 10_000) * 4;
    for (let k = 0; k < 10_000; k++) sample[k] = data[k * step] ?? 0;
    snapshots.push(sample);
    void wait;
  }
  scene.stop();

  // How different is chapter 1 from chapter 3 (both mid-film)?
  let diff = 0;
  const a = snapshots[1]!;
  const b = snapshots[3]!;
  for (let p = 0; p < Math.min(a.length, b.length); p++) {
    diff += Math.abs(a[p]! - b[p]!);
  }
  const interChapterDiff = diff / Math.min(a.length, b.length) / 255;

  return { created: true, chapters, interChapterDiff };
};
