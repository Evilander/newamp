import { createHash } from 'node:crypto';
import type { MusicServerSong } from '../shared/music-servers.js';
import type { Track } from '../shared/types.js';

export function musicServerTrack(song: MusicServerSong): Track {
  const id = -Number.parseInt(createHash('sha256').update(`${song.connectionId}\0${song.itemId}`).digest('hex').slice(0, 13), 16) - 1;
  return {
    id, path: song.streamUrl,
    title: song.title, artist: song.artist, album: song.album, albumArtist: song.albumArtist,
    trackNo: song.trackNo, discNo: song.discNo, year: song.year, genre: song.genre,
    duration: song.duration, bitrate: song.bitrate, sampleRate: song.sampleRate, size: song.size,
    mtime: 0, hasArt: 0, loved: 0, rating: 0, ratingScore: null, avoidAutoPlay: 0,
    playCount: 0, lastPlayed: null, skipCount: 0, lastSkipped: null, bpm: null, key: null,
    replayGainTrackDb: null, replayGainAlbumDb: null,
  };
}
