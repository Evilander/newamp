# Contributing to NewAmp

Thanks for wanting to help. The short version:

- Bug reports and ideas: [open an issue](https://github.com/evilander/newamp/issues/new/choose). Screenshots and OS/version info help a lot.
- Open a PR for a fix or a feature. Say in the description which checks you ran.

What to run:

- Typo, copy or one-file fix: `npm run typecheck`.
- Feature or playback change: `npm run typecheck`, plus the `smoke:*` scripts closest to what you touched. `npm run` lists every script. The `smoke:*` scripts check a feature end to end, and `npm run test:all` runs every `test:*` script.
- Audio path, packaging or scanning: also `npm run smoke:rating`, `smoke:home`, `smoke:skin`, `smoke:audio-limiter` and `smoke:audio-output` (the last one needs an audio device). The maintainer runs these before tagging.

## Dev setup

Node 22.12 or newer (the `engines` field in `package.json`):

```bash
npm install
npm run dev
```

## Notes for code changes

- The Eviland engine lives in `src/visualizer/`. Edit it there, then run `node packages/eviland-core/sync.mjs` to update the copy in `packages/eviland-core/`. `npm run build` fails if the two have drifted.
- Eviland Live uses a private part of Butterchurn's renderer, so `butterchurn` is pinned to an exact version in `package.json`. Recheck that hook whenever you change the version.
- Global player shortcuts are in `shared/keyboard-shortcuts.ts`. Visualizer keys are in `src/components/visualizer-input.ts`, Library row keys in `LibraryView.tsx`, and macOS menu shortcuts in `electron/app-menu.ts`. A new shortcut needs its Cmd form for macOS and a row in the shortcut table in `docs/features.md`.
- The default Electron session denies every web permission except the few listed in `electron/permissions.ts`. A feature that needs another one (MIDI, notifications) has to add it there.
- A feature that makes a network request has to be added to both the Privacy section of the README and the Network features table in `docs/features.md`, with what it sends and when.
- Numbers in the README and docs (sizes, speeds, counts) come from a command you ran, and the command goes in the text.

Be kind in issues and reviews. That's the whole code of conduct.
