# Decisions — newamp-post-1.11-roadmap

One line per decision as the executor makes them. Format: `YYYY-MM-DD — decision — why`.

- 2026-06-10 — Identity = seed lineage, not stored configs; plans re-derive looks from seeds — keeps writes tiny under sql.js whole-DB export, survives algorithm upgrades via algoVersion.
- 2026-06-10 — Release-train order P1.1 → P4 → P3 → P1.2 → P2 → P5 — cheap+novel first, December deadline second, native scaffolding third (P2 reuses it), flash last.
- 2026-06-10 — Pillar 3 bypasses the HTMLAudioElement/transcode pipeline entirely (own WebCodecs decode) — that pipeline is the repo's most-revisited bug surface with 5 open todos.
- 2026-06-10 — Stems run native ORT in utilityProcess, never ORT-web in renderer — Electron-specific Intel iGPU conv-correctness bug (onnxruntime#24442).
- 2026-06-11 — Q3 answered with default: Settings purge-all + badge per-track reset; neighbor-borrowing ON with visible disclosure — all-local data, transparency over a buried toggle.
- 2026-06-11 — Q5 answered STRICT: algo-version-guard.mjs in CI — silent look-breaking is the one unforgivable failure for a memory feature.
- 2026-06-11 — v1.11.1 execution: engine+persistence and bridge+UI split into two serialized builders in the worktree; adversarial review of shipped 5452d77 runs in parallel, confirmed findings fold into 1.11.1.
- 2026-06-11 — Versioned as v1.12.0, not the roadmap's v1.11.1 — repo declares semver; persistent visual memory is a feature (minor), and every prior feature release minor-bumped.
