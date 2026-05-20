# Release Process

Symphony releases ship through GitHub tags and the Tauri release workflow.

## Before Tagging

1. Confirm the working tree only contains intended release changes.
2. Run backend verification from the repo root:

   ```powershell
   npm test
   ```

3. Run frontend verification:

   ```powershell
   cd ui
   npm run typecheck
   npm run build
   ```

4. Update release versions in:
   - `ui/package.json`
   - `ui/src-tauri/tauri.conf.json`

5. Move the relevant `CHANGELOG.md` notes from `Unreleased` to the release
   version section, including the release date.

## Tag And Publish

Create and push an annotated tag:

```powershell
git tag -a vX.Y.Z -m "Symphony AI vX.Y.Z"
git push origin vX.Y.Z
```

Pushing the tag starts `.github/workflows/release.yml`. The workflow builds the
Windows Tauri app, publishes the GitHub release, and uploads installer/updater
assets.

## After Publish

1. Confirm the GitHub release contains the installer and updater artifacts.
2. Confirm `latest.json` is available from the release assets.
3. Confirm `CHANGELOG.md` has a new empty `Unreleased` section for the next
   release cycle.
