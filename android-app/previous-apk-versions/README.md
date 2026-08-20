# Previous APK versions

Archive of superseded builds of the KCMPS staff app. The **current** release always lives one
level up as `android-app/kcmps-app-vX.Y.Z.apk`; when a new version is built, the old APK gets
**moved here instead of deleted**. (Convention set by the owner 2026-08-20 — before that,
superseded APKs were deleted, so the earliest builds below no longer exist as files.)

Notes:

- **Not in git.** `android-app/.gitignore` excludes `*.apk` everywhere, deliberately — binaries
  bloat the repo, and any version can be rebuilt from its git commit with the same keystore.
  This folder is a local/owner-managed archive; back it up alongside `../signing/` if you care
  about keeping old binaries.
- **All versions are signed with the same keystore** (`../signing/kcmps-release.keystore`).
  Android only installs an update over an older version if the signature matches — which is
  also why that keystore must never be lost.
- **Naming:** `kcmps-app-vX.Y.Z.apk`, matching `versionName` in `app/build.gradle`
  (`versionCode` increments by 1 every release; Android refuses downgrades).

## Version log

| Version | versionCode | Date | Notes |
|---|---|---|---|
| 1.0.0 | 1 | 2026-08-20 | First build. **Known bug:** blank white screen if Android relaunched the activity right after a cold start (`restoreState()` with an empty history had no `loadUrl` fallback). Archived here — owner-restored copy, signature-verified. Do not install (superseded). |
| 1.0.1 | 2 | 2026-08-20 | Fixed the blank-screen restore bug. First version actually handed to staff. Archived here — owner-restored copy, signature-verified. |
| 1.1.0 | 3 | 2026-08-20 | Adds the ` KCMPSApp/1.1` User-Agent marker (lets kcmps.com detect the app for 30-day persistent sign-in) and sets `android:allowBackup="false"`. Persistent sign-in itself activates once the matching website changes reach production. |
