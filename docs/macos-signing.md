# macOS Code Signing & Notarization

NewAmp ships a hardened-runtime macOS app, so Apple's notary service requires it
to be signed with a **Developer ID Application** certificate. Without one,
`package:mac` ad-hoc signs the `.app` (`scripts/package.mjs` passes
`--config.mac.identity=-` whenever `CSC_LINK`/`CSC_NAME` are unset). An ad-hoc
seal is enough for Gatekeeper to offer System Settings → Privacy & Security →
Open Anyway, but not for notarization: the notarize preflight
(`scripts/verify-mac-signing.mjs`) blocks it. Builds up to 2.3.0 were left with
no seal at all, which is why quarantined downloads reported "NewAmp is damaged
and can't be opened"; `xattr -cr` on the app clears that.

## What you need

1. An Apple Developer account ($99/yr) and a **Developer ID Application** cert.
2. Export it as a `.p12` (Keychain Access → export) with a password.
3. An app-specific password for your Apple ID (appleid.apple.com → Sign-In & Security).

## Environment variables

For signing (consumed by electron-builder during `npm run package:mac`):

| Var | Value |
|-----|-------|
| `CSC_LINK` | path to (or base64 of) the Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` export password |

For notarization (consumed by `npm run release:notarize`):

| Var | Value |
|-----|-------|
| `NEWAMP_APPLE_ID` | your Apple ID email |
| `NEWAMP_APPLE_PASSWORD` | the app-specific password |
| `NEWAMP_TEAM_ID` | your 10-char Apple Team ID |

In CI these are GitHub Actions secrets already referenced by `.github/workflows/release.yml`.

## Verify a build

```bash
npm run package:mac
node scripts/verify-mac-signing.mjs            # must report "Developer ID signed"
npm run release:notarize                        # runs the preflight, then notarytool + staple
```

`codesign --verify --deep --strict` and `spctl -a -t install` are the source of
truth — the preflight runs both and fails if the app isn't Developer-ID-accepted.
