// Runs the album grouping pass (shared/album-identity.ts) over the library in
// slices. The pass reads every track, groups them by folder, and writes back
// only the rows whose album changed, so the thread is handed back between
// chunks of rows instead of being held for the whole library.
//
// The same step generator drives both entry points: a synchronous run for
// callers with nothing to yield to (tests, a query that needs keys at once),
// and an asynchronous one that gives the event loop a turn whenever a slice
// has used up its time.

import {
  IdentityPass,
  artistKeyOf,
  artistSortKey,
  baseFold,
  keyForPair,
  type IdentitySummary,
  type IdentityTrack,
  type StoredIdentity,
  type TrackIdentity,
} from '../shared/album-identity.js';
import { albumKey as legacyAlbumKey } from '../shared/album-key.js';

export interface RegroupRow {
  id: number;
  path: string;
  album: string;
  artist: string;
  album_artist: string;
  album_artist_tag: string | null;
  scan_schema: number;
  compilation: number;
  disc_no: number | null;
  year: number | null;
  album_artist_sort: string | null;
  artist_sort: string | null;
  artist_key: string;
  album_key: string | null;
  album_display: string | null;
  album_artist_display: string | null;
  album_kind: string | null;
  album_reason: string | null;
  album_year: number | null;
  album_sort_key: string | null;
  disc_inferred: number | null;
}

export interface RegroupWrite {
  id: number;
  artistKey: string;
  /** The album columns to write; null leaves them alone. */
  identity: TrackIdentity | null;
  /** The track no longer has an album: its album columns go back to empty. */
  clear?: boolean;
}

/** A rating row still waiting for a key, or one whose key may have moved. */
export interface RatingTarget {
  rowid: number;
  albumArtist: string;
  album: string;
  albumKey: string | null;
}

export interface RatingRemap {
  rowid: number;
  albumKey: string;
}

/** One line of the Artists list: the artist with its spellings folded together. */
export interface ArtistGroup {
  artistKey: string;
  display: string;
  sortKey: string;
  trackCount: number;
  albumCount: number;
}

export interface RegroupHost {
  /** Changes whenever something that can alter the grouping changes; a pass that sees it move stops. */
  epoch(): number;
  loadSplits(): Set<string>;
  loadEditedAlbumArtists(): Set<number>;
  loadRatingTargets(): RatingTarget[];
  loadChunk(afterId: number, limit: number): RegroupRow[];
  /** Writes the rows and, with the first chunk, moves the rating rows, in one transaction. */
  writeChunk(rows: RegroupWrite[], remaps?: RatingRemap[]): void;
  finish(artists: ArtistGroup[]): void;
}

export interface RegroupResult extends IdentitySummary {
  aborted: boolean;
  written: number;
  ratingsRemapped: number;
  ms: number;
}

// Sized so that one step is a few milliseconds of work: the driver hands the
// thread back whenever a slice has used its budget, and a step is the least it
// can hand back between.
const LOAD_CHUNK = 800;
const RESOLVE_STEP = 40;
const FINALIZE_STEP = 80;
const WRITE_CHUNK = 400;
const VOTE_STEP = 2000;

function storedIdentity(row: RegroupRow): StoredIdentity | null {
  if (row.album_key == null) return null;
  return {
    albumKey: row.album_key,
    albumDisplay: row.album_display,
    albumArtistDisplay: row.album_artist_display,
    albumKind: row.album_kind,
    albumReason: row.album_reason,
    albumYear: row.album_year,
    albumSortKey: row.album_sort_key,
    discInferred: row.disc_inferred,
  };
}

export function* regroupSteps(host: RegroupHost): Generator<void, RegroupResult> {
  const started = performance.now();
  const epoch = host.epoch();
  const aborted = (written: number, summary: IdentitySummary): RegroupResult => ({
    ...summary,
    aborted: true,
    written,
    ratingsRemapped: 0,
    ms: performance.now() - started,
  });

  const pass = new IdentityPass(host.loadSplits());
  const edited = host.loadEditedAlbumArtists();
  const ratingTargets = host.loadRatingTargets();
  const watchedKeys = new Set<string>();
  for (const target of ratingTargets) {
    if (target.albumKey) watchedKeys.add(target.albumKey);
  }

  // The Artists list falls out of the same read: spellings, counts and sort
  // names per artist key, with the album count settled once albums have keys.
  const artistAcc = new Map<string, {
    names: Map<string, number>;
    trackCount: number;
    albumIds: number[];
    sortTag: string | null;
    albumSortTag: string | null;
  }>();

  // Rows whose artist key is stale (or whose album was cleared) need a write
  // even though the album pass has nothing to say about them.
  const sideWrites = new Map<number, RegroupWrite>();
  const moves = new Map<string, Map<string, number>>();
  const previousKey = new Map<number, string | null>();

  let after = 0;
  for (;;) {
    const rows = host.loadChunk(after, LOAD_CHUNK);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const artistKey = artistKeyOf(row.artist);
      if (artistKey) {
        let acc = artistAcc.get(artistKey);
        if (!acc) {
          acc = { names: new Map(), trackCount: 0, albumIds: [], sortTag: null, albumSortTag: null };
          artistAcc.set(artistKey, acc);
        }
        const name = row.artist.trim();
        acc.names.set(name, (acc.names.get(name) ?? 0) + 1);
        acc.trackCount++;
        if (row.album.trim()) acc.albumIds.push(row.id);
        if (row.artist_sort && (!acc.sortTag || row.artist_sort > acc.sortTag)) acc.sortTag = row.artist_sort;
        if (row.album_artist_sort && baseFold(row.album_artist) === artistKey
          && (!acc.albumSortTag || row.album_artist_sort > acc.albumSortTag)) {
          acc.albumSortTag = row.album_artist_sort;
        }
      }
      if (row.album.trim()) {
        const track: IdentityTrack = {
          id: row.id,
          path: row.path,
          album: row.album,
          artist: row.artist,
          albumArtist: row.album_artist,
          albumArtistTag: row.album_artist_tag,
          tagsKnown: row.scan_schema >= 1,
          albumArtistEdited: edited.has(row.id),
          compilation: row.compilation === 1,
          discNo: row.disc_no,
          year: row.year,
          albumArtistSort: row.album_artist_sort,
          artistSort: row.artist_sort,
          prev: storedIdentity(row),
        };
        pass.add(track);
        previousKey.set(row.id, row.album_key);
        if (row.artist_key !== artistKey) sideWrites.set(row.id, { id: row.id, artistKey, identity: null });
      } else if (row.album_key != null || row.artist_key !== artistKey) {
        sideWrites.set(row.id, { id: row.id, artistKey, identity: null, clear: row.album_key != null });
      }
    }
    yield;
  }

  while (!pass.resolve(RESOLVE_STEP)) yield;
  while (!pass.finalize(FINALIZE_STEP)) yield;
  yield;

  // Which album each track ended up in, and where the tracks of a rated album
  // went (by the key they were loaded under).
  const newKeys = new Set<string>();
  const albumOf = new Map<number, string>();
  let counted = 0;
  for (const { track, identity } of pass.all()) {
    newKeys.add(identity.albumKey);
    albumOf.set(track.id, identity.albumKey);
    const before = previousKey.get(track.id) ?? null;
    if (before && before !== identity.albumKey && watchedKeys.has(before)) {
      let votes = moves.get(before);
      if (!votes) moves.set(before, (votes = new Map()));
      votes.set(identity.albumKey, (votes.get(identity.albumKey) ?? 0) + 1);
    }
    if (++counted % VOTE_STEP === 0) yield;
  }
  yield;

  // A rating row with no key, or one whose key no track has any more and that
  // no track is seen leaving (a pass cut short after its writes landed has
  // already moved them), is matched through its (album artist, album) pair.
  const pairVotes = new Map<string, Map<string, number>>();
  for (const target of ratingTargets) {
    if (!target.albumKey || (!newKeys.has(target.albumKey) && !moves.has(target.albumKey))) {
      pairVotes.set(legacyAlbumKey(target.albumArtist, target.album), new Map());
    }
  }
  if (pairVotes.size) {
    let seen = 0;
    for (const { track, identity } of pass.all()) {
      const votes = pairVotes.get(legacyAlbumKey(track.albumArtist || track.artist, track.album));
      if (votes) votes.set(identity.albumKey, (votes.get(identity.albumKey) ?? 0) + 1);
      if (++seen % VOTE_STEP === 0) yield;
    }
    yield;
  }

  // Ratings follow their album: a row with no key yet is matched through the
  // old pair, and one whose key vanished moves to the key most of its tracks
  // went to. These are written with the first chunk of tracks, in the same
  // transaction, so a pass that stops after its first write never leaves a
  // rating behind on a key no track has.
  const remaps: RatingRemap[] = [];
  for (const target of ratingTargets) {
    const byPair = pairVotes.get(legacyAlbumKey(target.albumArtist, target.album));
    if (!target.albumKey) {
      remaps.push({ rowid: target.rowid, albumKey: bestVote(byPair) ?? keyForPair(target.albumArtist, target.album) });
    } else if (!newKeys.has(target.albumKey)) {
      const best = bestVote(moves.get(target.albumKey)) ?? bestVote(byPair);
      if (best) remaps.push({ rowid: target.rowid, albumKey: best });
    }
  }

  // Build the writes: changed album rows carry their new identity, and a
  // changed artist key rides along on the same statement.
  const writes: RegroupWrite[] = [];
  for (const { track, identity } of pass.changed()) {
    const side = sideWrites.get(track.id);
    sideWrites.delete(track.id);
    writes.push({ id: track.id, artistKey: side?.artistKey ?? artistKeyOf(track.artist), identity });
  }
  for (const side of sideWrites.values()) writes.push(side);
  yield;

  const summary = pass.summary();
  if (host.epoch() !== epoch) return aborted(0, summary);

  let written = 0;
  let pendingRemaps: RatingRemap[] | undefined = remaps.length ? remaps : undefined;
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    if (host.epoch() !== epoch) return aborted(written, summary);
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    host.writeChunk(chunk, pendingRemaps);
    pendingRemaps = undefined;
    written += chunk.length;
    yield;
  }
  if (pendingRemaps) {
    // No track changed album, but a rating still has to move.
    if (host.epoch() !== epoch) return aborted(written, summary);
    host.writeChunk([], pendingRemaps);
  }
  if (host.epoch() !== epoch) return aborted(written, summary);

  const artists: ArtistGroup[] = [];
  for (const [artistKey, acc] of artistAcc) {
    let display = '';
    let best = -1;
    for (const [name, n] of acc.names) {
      if (n > best || (n === best && name < display)) {
        display = name;
        best = n;
      }
    }
    const albums = new Set<string>();
    for (const id of acc.albumIds) {
      const key = albumOf.get(id);
      if (key) albums.add(key);
    }
    artists.push({
      artistKey,
      display,
      sortKey: artistSortKey(display, acc.sortTag || acc.albumSortTag),
      trackCount: acc.trackCount,
      albumCount: albums.size,
    });
  }
  yield;
  if (host.epoch() !== epoch) return aborted(written, summary);
  host.finish(artists);
  return {
    ...summary,
    aborted: false,
    written,
    ratingsRemapped: remaps.length,
    ms: performance.now() - started,
  };
}

function bestVote(votes: Map<string, number> | undefined): string | null {
  if (!votes || !votes.size) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of votes) {
    if (count > bestCount || (count === bestCount && best !== null && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

export function runRegroupSync(host: RegroupHost): RegroupResult {
  const steps = regroupSteps(host);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Runs the pass, giving the event loop a turn whenever a slice has used `budgetMs`. */
export async function runRegroupAsync(host: RegroupHost, budgetMs = 20): Promise<RegroupResult> {
  const steps = regroupSteps(host);
  let sliceStart = performance.now();
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() - sliceStart >= budgetMs) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  }
}
