# Newamp Online And Social Roadmap

Newamp should stay local-first. The online layer should feel like Letterboxd for listening: optional identity, reviews, lists, conversations, and discovery around the user's real music library without turning the player into a streaming service.

## Product Shape

1. Public profiles: favorite albums, recent plays, top artists, custom lists, and "five bags" picks.
2. Reviews and diary entries: track, album, artist, playlist, and listening-session reviews with timestamped context.
3. Lists: ranked albums, themed mixes, "best local recordings", hidden gems, yearly recaps, and user-curated playlist pages.
4. Discussion: album threads, artist rooms, playlist comments, and friend activity.
5. Private by default: every scrobble/review/list can be local-only, friends-only, or public.

## Newamp-Specific Advantages

1. Local-file credibility: reviews can reference editions, bootlegs, live recordings, demos, and personal recordings that Last.fm will never recognize.
2. Rich listening receipts: bitrate, format, replay gain, queue context, repeat count, and lyrics/karaoke moments can power better diary entries.
3. AI-assisted writing: with the user's ChatGPT key, Newamp can draft liner notes, discussion prompts, album-context cards, and review seeds from local metadata.
4. Social playlists: custom playlists can have names, icons, descriptions, comments, collaborative edits, and public pages.
5. Visual identity: deck skins, visualizer presets, ratings, and listening-room screenshots make profiles feel more personal than plain scrobble feeds.

## Implementation Phases

1. Local social objects: add local `reviews`, `lists`, `comments`, and `profile` tables before any server exists.
2. Exportable profile bundle: generate a static profile page from local data so the concept is useful offline and easy to test.
3. Optional account service: add sign-in, profile sync, public pages, and friend graph after local objects are stable.
4. Moderated discussions: add report/block/moderation primitives before public comments launch.
5. Federation/imports: import Last.fm history, MusicBrainz IDs, ListenBrainz data, and Newamp profile bundles.

## Release Gate For The Online Layer

1. No account required for playback, library scanning, playlists, reviews, ratings, or visualizers.
2. No music files uploaded by default.
3. Clear per-item privacy controls.
4. Local export and delete account flows exist before public launch.
5. Offline behavior remains first-class.
