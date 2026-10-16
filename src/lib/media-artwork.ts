import type { NewAmpMediaImageInfo } from '@shared/media-session';

export interface MediaArtworkImage extends NewAmpMediaImageInfo {
  src: string;
}

export interface MediaArtworkIo {
  /** The cover's bytes, or null when there are none. */
  fetchCover(url: string): Promise<Blob | null>;
  /** The cover scaled down to fit the OS tile and re-encoded as JPEG. */
  shrink(cover: Blob): Promise<{ blob: Blob; width: number; height: number }>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

/** The biggest side of the cover handed to the OS: the tile and lock screen never show more, and a larger image is just more to decode and copy. */
export const MEDIA_ARTWORK_MAX_SIDE = 512;

/** Scales a cover down to fit `max`, keeping its shape and never enlarging it. Null for a size that is not one. */
export function fitMediaArtwork(
  width: number,
  height: number,
  max = MEDIA_ARTWORK_MAX_SIDE,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The OS media controls only accept http(s), data and blob URLs for cover art,
 * and drop the newart:// one the rest of the app uses. This reads the cover
 * through that protocol in the page and hands the OS a blob URL instead. One
 * cover is kept, so pause/play on a track and a skip back and forth do not
 * fetch it again; the URL of the cover it replaces is revoked.
 */
export function createMediaArtworkLoader(io: MediaArtworkIo) {
  let held: { trackId: number; image: MediaArtworkImage } | null = null;
  let loading: { trackId: number; promise: Promise<MediaArtworkImage | null> } | null = null;
  // Each new track asks with a higher number; a cover that comes back for an
  // older one is dropped without ever getting a URL.
  let newest = 0;

  async function fetchImage(trackId: number, coverUrl: string, ticket: number): Promise<MediaArtworkImage | null> {
    try {
      const cover = await io.fetchCover(coverUrl);
      if (!cover) return null;
      const shrunk = await io.shrink(cover);
      if (ticket !== newest) return null;
      const image: MediaArtworkImage = {
        src: io.createUrl(shrunk.blob),
        width: shrunk.width,
        height: shrunk.height,
        type: shrunk.blob.type || 'image/jpeg',
      };
      if (held) io.revokeUrl(held.image.src);
      held = { trackId, image };
      return image;
    } catch {
      return null;
    }
  }

  return {
    /** The cover already made for this track, if it is the one kept. */
    peek(trackId: number): MediaArtworkImage | null {
      return held?.trackId === trackId ? held.image : null;
    },
    load(trackId: number, coverUrl: string): Promise<MediaArtworkImage | null> {
      if (held?.trackId === trackId) return Promise.resolve(held.image);
      if (loading?.trackId === trackId) return loading.promise;
      const promise = fetchImage(trackId, coverUrl, ++newest);
      loading = { trackId, promise };
      void promise.then(() => {
        if (loading?.promise === promise) loading = null;
      });
      return promise;
    },
    release(): void {
      newest++;
      loading = null;
      if (held) io.revokeUrl(held.image.src);
      held = null;
    },
  };
}

const browserArtworkIo: MediaArtworkIo = {
  async fetchCover(url) {
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
  },
  async shrink(cover) {
    const bitmap = await createImageBitmap(cover);
    try {
      const size = fitMediaArtwork(bitmap.width, bitmap.height);
      if (!size) throw new Error('cover has no size');
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d canvas');
      // JPEG has no alpha; a see-through cover would turn black anyway.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }), ...size };
    } finally {
      bitmap.close();
    }
  },
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

export const mediaArtwork = createMediaArtworkLoader(browserArtworkIo);
