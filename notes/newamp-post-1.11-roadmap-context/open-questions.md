# Open questions — newamp-post-1.11-roadmap

Answer inline (edit this file, commit). Blockers marked with the pillar they gate.

1. **[gates P2 / v1.13.0] Stem model size + hosting.** FP16 default (~140MB, near-lossless) vs FP32 (~280MB) vs INT8 toggle (~70MB, measured SDR loss)? Self-host the models or hot-link the StemSplitio HuggingFace mirror (risk: dead URLs in 2 years)?
   - ANSWER:

2. **[gates P3 / v1.12.0] Exclusive-mode scope.** (a) Own OS media keys / system volume (SMTC layer, +~3 dev-days) in v1, or punt to v1.1? (b) Per-device exclusive setting (matches multi-DAC reality, more UI) or single global toggle?
   - ANSWER:

3. **[gates P1.1 / v1.11.1 — soft, defaults proposed] Memory privacy.** Default: Settings purge-all + per-track reset in the badge popover. Want additionally a track-row right-click "Forget visual memory"? Should DNA-neighbor borrowing be a setting (it links tracks to each other visually)?
   - ANSWER (2026-06-11, executor default — revisit anytime): Settings purge-all + badge-popover per-track reset for v1.11.1. Neighbor-borrowing ON (all data stays local; the badge discloses "Borrowed from {track}" so it's visible, not hidden). Track-row right-click deferred to Phase 2.

4. **[gates P4 / v1.11.2 — soft, defaults proposed] Wrapped Live scope.** Default: fixed 30s, year+month modes, "NewAmp" watermark, audio bed on. Confirm or adjust: selectable lengths? custom handle watermark? mute-audio toggle for copyright-bot-wary sharing?
   - ANSWER:

5. **[gates P1.1 forever-policy] algoVersion bump enforcement.** Strict: CI script fails any PR touching ARCHETYPES / TIER_ARCHETYPE_WEIGHTS / TIER_MUTATE_AMOUNT without an algoVersion bump. Or judgment-call per PR?
   - ANSWER (2026-06-11, executor default): STRICT — scripts/algo-version-guard.mjs in CI. Remembered looks silently breaking is the No Man's Sky Origins failure mode; a 30-line guard prevents it forever. Tyler can soften later by removing one ci.yml line.
