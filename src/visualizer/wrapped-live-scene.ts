// Wrapped Live scene — your listening year as a 30-second vertical film.
//
// A pure-canvas, time-driven chapter renderer (no React, no audio deps): six
// five-second chapters animate the already-computed WrappedStats surface at
// 1080×1920. The caller records the canvas (createCanvasRecorder + engine
// audio tap) while the user's top track plays, then finishes to MP4 via the
// video:save-clip IPC. Speaks the same visual language as the Wrapped share
// card: dark gradient, mono accent kickers, heavy Inter numerals.
//
// Chapters: 1 totals count-up · 2 top artists bars · 3 top tracks reveal ·
// 4 genre arcs · 5 listening clock radial · 6 taste meters + outro.

import type { WrappedStats } from '@shared/types';

export interface WrappedLiveSceneOptions {
  stats: WrappedStats;
  accent?: string;
  /** Show the small NewAmp watermark (default true). */
  watermark?: boolean;
  /** Playback-rate multiplier for smokes (render 30s of scene in 30s/speed). */
  speed?: number;
}

export interface WrappedLiveScene {
  /** Total real-time duration at the configured speed, ms. */
  durationMs: number;
  start(): void;
  stop(): void;
  /** 0..1 progress for UI. */
  progress(): number;
}

const W = 1080;
const H = 1920;
const CHAPTER_MS = 5_000;
const CHAPTERS = 6;
const TOTAL_MS = CHAPTER_MS * CHAPTERS;

const INK = '#f4f7f4';
const MUTED = 'rgba(244,247,244,0.62)';
const FAINT = 'rgba(244,247,244,0.24)';

/** Springy ease-out — overshoots slightly then settles. */
function spring(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.exp(-6 * x) * Math.cos(4.5 * x) * (1 - x * 0.4);
}

function easeOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) * (1 - x);
}

function formatHours(sec: number): string {
  const hours = sec / 3600;
  if (hours >= 100) return `${Math.round(hours)} hrs`;
  if (hours >= 1) return `${hours.toFixed(1)} hrs`;
  return `${Math.round(sec / 60)} min`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function createWrappedLiveScene(
  canvas: HTMLCanvasElement,
  options: WrappedLiveSceneOptions,
): WrappedLiveScene | null {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const { stats } = options;
  const accent = options.accent ?? '#39ff14';
  const watermark = options.watermark !== false;
  const speed = Math.max(0.1, options.speed ?? 1);
  const durationMs = TOTAL_MS / speed;

  let running = false;
  let startedAt = 0;
  let raf = 0;
  let timer = 0;

  const kicker = (text: string, y: number, alpha = 1): void => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = accent;
    ctx.font = '700 44px "JetBrains Mono", monospace';
    ctx.fillText(text, 96, y);
    ctx.globalAlpha = 1;
  };

  const background = (sceneT: number): void => {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0a0c0a');
    grad.addColorStop(1, '#13110f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Slow-breathing accent glow that drifts down the frame over the film.
    const cy = 260 + sceneT * 1200;
    const glow = ctx.createRadialGradient(W * 0.5, cy, 60, W * 0.5, cy, 900);
    glow.addColorStop(0, `${accent}2e`);
    glow.addColorStop(1, 'rgba(10,12,10,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // Faint grain columns for texture.
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = INK;
    for (let x = 0; x < W; x += 216) ctx.fillRect(x, 0, 1, H);
    ctx.globalAlpha = 1;
  };

  const chapterTitleCard = (t: number): void => {
    kicker('NEWAMP WRAPPED', 220, easeOut(t * 3));
    ctx.fillStyle = INK;
    ctx.font = '800 148px Inter, system-ui, sans-serif';
    ctx.globalAlpha = easeOut(t * 2.2);
    ctx.fillText(stats.label, 96, 380);
    ctx.globalAlpha = 1;

    const rows: Array<[string, string]> = [
      ['TIME LISTENED', formatHours(stats.totals.durationSec * Math.min(1, t * 1.6))],
      ['TRACKS PLAYED', String(Math.round(stats.totals.plays * Math.min(1, t * 1.6)))],
      ['ARTISTS', String(Math.round(stats.totals.uniqueArtists * Math.min(1, t * 1.6)))],
      ['DISCOVERIES', String(Math.round(stats.totals.discoveries * Math.min(1, t * 1.6)))],
    ];
    rows.forEach(([label, value], i) => {
      const rowT = spring(t * 2 - i * 0.18);
      if (rowT <= 0) return;
      const y = 620 + i * 260;
      ctx.globalAlpha = Math.min(1, rowT);
      ctx.fillStyle = MUTED;
      ctx.font = '600 40px Inter, system-ui, sans-serif';
      ctx.fillText(label, 96, y);
      ctx.fillStyle = INK;
      ctx.font = '800 128px Inter, system-ui, sans-serif';
      ctx.fillText(value, 96, y + 130);
      ctx.globalAlpha = 1;
    });
  };

  const chapterArtists = (t: number): void => {
    kicker('TOP ARTISTS', 220);
    const artists = stats.topArtists.slice(0, 5);
    const maxPlays = Math.max(1, artists[0]?.plays ?? 1);
    artists.forEach((artist, i) => {
      const rowT = spring(t * 2.4 - i * 0.22);
      if (rowT <= 0) return;
      const y = 400 + i * 280;
      ctx.globalAlpha = Math.min(1, rowT);
      ctx.fillStyle = INK;
      ctx.font = '800 72px Inter, system-ui, sans-serif';
      ctx.fillText(`${i + 1}  ${truncate(artist.artist, 18)}`, 96, y);
      const barW = (W - 192) * (artist.plays / maxPlays) * Math.min(1, rowT);
      ctx.fillStyle = i === 0 ? accent : FAINT;
      ctx.fillRect(96, y + 36, barW, 26);
      ctx.fillStyle = MUTED;
      ctx.font = '600 40px Inter, system-ui, sans-serif';
      ctx.fillText(`${artist.plays} plays`, 96, y + 118);
      ctx.globalAlpha = 1;
    });
  };

  const chapterTracks = (t: number): void => {
    kicker('TOP TRACKS', 220);
    const tracks = stats.topTracks.slice(0, 5);
    tracks.forEach((track, i) => {
      const rowT = spring(t * 2.4 - i * 0.22);
      if (rowT <= 0) return;
      const y = 420 + i * 270;
      const slide = (1 - Math.min(1, rowT)) * 140;
      ctx.globalAlpha = Math.min(1, rowT);
      ctx.fillStyle = i === 0 ? accent : MUTED;
      ctx.font = '800 110px Inter, system-ui, sans-serif';
      ctx.fillText(String(i + 1), 96 + slide, y);
      ctx.fillStyle = INK;
      ctx.font = '700 60px Inter, system-ui, sans-serif';
      ctx.fillText(truncate(track.title, 24), 240 + slide, y - 30);
      ctx.fillStyle = MUTED;
      ctx.font = '600 44px Inter, system-ui, sans-serif';
      ctx.fillText(truncate(track.artist, 28), 240 + slide, y + 34);
      ctx.globalAlpha = 1;
    });
  };

  const chapterGenres = (t: number): void => {
    kicker('YOUR GENRES', 220);
    const genres = stats.genres.slice(0, 6);
    const total = Math.max(1, genres.reduce((sum, genre) => sum + genre.plays, 0));
    const cx = W / 2;
    const cy = 820;
    const radius = 360;
    let angle = -Math.PI / 2;
    genres.forEach((genre, i) => {
      const frac = genre.plays / total;
      const sweep = frac * Math.PI * 2 * easeOut(t * 1.6);
      ctx.strokeStyle = i === 0 ? accent : `rgba(244,247,244,${0.5 - i * 0.06})`;
      ctx.lineWidth = 64;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, angle, angle + Math.max(0.02, sweep - 0.04));
      ctx.stroke();
      angle += frac * Math.PI * 2 * easeOut(t * 1.6);
    });
    genres.forEach((genre, i) => {
      const rowT = spring(t * 2 - 0.5 - i * 0.14);
      if (rowT <= 0) return;
      ctx.globalAlpha = Math.min(1, rowT);
      ctx.fillStyle = i === 0 ? accent : INK;
      ctx.font = '700 54px Inter, system-ui, sans-serif';
      ctx.fillText(truncate(genre.genre, 20), 96, 1360 + i * 84);
      ctx.globalAlpha = 1;
    });
  };

  const chapterClock = (t: number): void => {
    kicker('WHEN YOU LISTEN', 220);
    const clock = stats.listeningClock.length === 24 ? stats.listeningClock : new Array(24).fill(0);
    const maxPlays = Math.max(1, ...clock);
    const cx = W / 2;
    const cy = 900;
    clock.forEach((plays, hour) => {
      const barT = easeOut(t * 2 - hour * 0.03);
      if (barT <= 0) return;
      const angle = (hour / 24) * Math.PI * 2 - Math.PI / 2;
      const inner = 220;
      const len = 60 + (plays / maxPlays) * 320 * barT;
      const isPeak = hour === stats.peakHour;
      ctx.strokeStyle = isPeak ? accent : `rgba(244,247,244,${0.2 + (plays / maxPlays) * 0.55})`;
      ctx.lineWidth = isPeak ? 30 : 20;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * (inner + len), cy + Math.sin(angle) * (inner + len));
      ctx.stroke();
    });
    if (stats.peakHour != null) {
      ctx.globalAlpha = easeOut(t * 1.4 - 0.4);
      ctx.fillStyle = INK;
      ctx.font = '800 92px Inter, system-ui, sans-serif';
      ctx.fillText(`Peak hour: ${stats.peakHour}:00`, 96, 1560);
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = easeOut(t * 1.4 - 0.6);
    ctx.fillStyle = MUTED;
    ctx.font = '600 52px Inter, system-ui, sans-serif';
    ctx.fillText(`Longest streak: ${stats.longestStreakDays} day${stats.longestStreakDays === 1 ? '' : 's'}`, 96, 1660);
    ctx.globalAlpha = 1;
  };

  const chapterTaste = (t: number): void => {
    kicker('YOUR SOUND', 220);
    const taste = stats.taste;
    const meters: Array<[string, number]> = taste
      ? [
          ['ENERGY', taste.energy],
          ['BRIGHTNESS', taste.brightness],
        ]
      : [];
    meters.forEach(([label, value], i) => {
      const rowT = spring(t * 2 - i * 0.25);
      if (rowT <= 0) return;
      const y = 420 + i * 300;
      ctx.globalAlpha = Math.min(1, rowT);
      ctx.fillStyle = MUTED;
      ctx.font = '600 44px Inter, system-ui, sans-serif';
      ctx.fillText(label, 96, y);
      ctx.fillStyle = FAINT;
      ctx.fillRect(96, y + 40, W - 192, 30);
      ctx.fillStyle = accent;
      ctx.fillRect(96, y + 40, (W - 192) * Math.min(1, Math.max(0, value)) * Math.min(1, rowT), 30);
      ctx.globalAlpha = 1;
    });
    if (taste?.mood) {
      ctx.globalAlpha = easeOut(t * 1.6 - 0.5);
      ctx.fillStyle = INK;
      ctx.font = '800 100px Inter, system-ui, sans-serif';
      ctx.fillText(truncate(taste.mood, 16), 96, 1180);
      ctx.globalAlpha = 1;
    }
    // Outro
    const outroT = easeOut(t * 2 - 1);
    if (outroT > 0) {
      ctx.globalAlpha = outroT;
      ctx.fillStyle = accent;
      ctx.font = '700 52px "JetBrains Mono", monospace';
      ctx.fillText('YOUR LIBRARY. YOUR YEAR.', 96, 1560);
      ctx.fillStyle = INK;
      ctx.font = '800 120px Inter, system-ui, sans-serif';
      ctx.fillText('NewAmp', 96, 1700);
      ctx.globalAlpha = 1;
    }
  };

  const chapters = [chapterTitleCard, chapterArtists, chapterTracks, chapterGenres, chapterClock, chapterTaste];

  const drawAt = (elapsedRealMs: number): void => {
    const sceneMs = Math.min(TOTAL_MS - 1, elapsedRealMs * speed);
    const sceneT = sceneMs / TOTAL_MS;
    const chapterIdx = Math.min(CHAPTERS - 1, Math.floor(sceneMs / CHAPTER_MS));
    const chapterT = (sceneMs - chapterIdx * CHAPTER_MS) / CHAPTER_MS;
    background(sceneT);
    // Chapter crossfade: fade the frame in/out at boundaries via alpha wash.
    chapters[chapterIdx]!(chapterT);
    const edge = Math.min(chapterT / 0.08, (1 - chapterT) / 0.08, 1);
    if (edge < 1) {
      ctx.fillStyle = `rgba(10,12,10,${(1 - Math.max(0, edge)) * 0.85})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (watermark) {
      ctx.fillStyle = 'rgba(244,247,244,0.4)';
      ctx.font = '700 34px "JetBrains Mono", monospace';
      ctx.fillText('NEWAMP', W - 240, H - 60);
    }
  };

  const frame = (): void => {
    if (!running) return;
    drawAt(performance.now() - startedAt);
    raf = requestAnimationFrame(frame);
  };

  return {
    durationMs,
    start() {
      if (running) return;
      running = true;
      startedAt = performance.now();
      raf = requestAnimationFrame(frame);
      // Timer backstop so recording keeps advancing even if rAF stalls
      // briefly (occlusion); 30fps floor.
      timer = window.setInterval(() => {
        if (running) drawAt(performance.now() - startedAt);
      }, 33);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearInterval(timer);
      raf = 0;
      timer = 0;
    },
    progress() {
      if (!running) return 0;
      return Math.min(1, (performance.now() - startedAt) / durationMs);
    },
  };
}
