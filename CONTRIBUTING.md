# Contributing to NewAmp

Thanks for wanting to help. The short version:

- **Bug reports and ideas**: [open an issue](https://github.com/evilander/newamp/issues/new/choose). Screenshots and OS/version info help a lot.
- **Small fixes** (typos, copy, one-file bugs): just open a PR. `npm run typecheck` passing is enough.
- **Feature or playback-affecting PRs**: please also run the smokes closest to what you touched (see `package.json` — there's a `smoke:*` script for nearly everything) and say which ones you ran in the PR description.

The heavyweight bar below is for **release-affecting changes** (audio path, packaging, scanning) — maintainers run this before tagging, you don't need it for a drive-by contribution:

```powershell
npm run smoke:rating && npm run smoke:home && npm run smoke:skin && npm run smoke:audio-limiter && npm run smoke:audio-output
npx tsc -p tsconfig.json --noEmit && npx tsc -p electron/tsconfig.json --noEmit
```

Dev setup is three commands (Node 20+):

```bash
npm install
npm run dev
```

Be kind in issues and reviews. That's the whole code of conduct.
