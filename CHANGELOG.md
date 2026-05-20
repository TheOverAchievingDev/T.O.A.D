# Changelog

All notable changes to Symphony AI will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and release tags follow semantic versioning where practical.

## [Unreleased]

### Changed

- Refreshed the root README, screenshot gallery, and engine screenshot docs
  for the promoted repository-root layout and the current FORme/WITHme UI.
- Replaced the README screenshot capture flow with an isolated current-app
  Playwright capture that seeds temporary demo data instead of relying on the
  older walkthrough script.
- Updated visible settings and menu copy that still referred to TOAD or older
  Foundry wording.

## [0.1.4] - 2026-05-20

### Changed

- Promoted the Symphony app from `toad-local/` to the repository root so the
  GitHub repo contains the product source directly.
- Updated the GitHub release workflow to build from the new root layout.
- Removed old root launcher wrappers and the separate tracked website project
  from the release repository.
- Added release process documentation so every GitHub release has a matching
  changelog entry.

### Fixed

- Made WITHme editor file diffs work in repositories with no initial commit by
  falling back to a file-vs-empty diff when `HEAD` does not exist.

## [0.1.3] - 2026-05-07

### Fixed

- Bundled the Windows `node-pty` platform package required by the installed
  desktop app.

## [0.1.2] - 2026-05-07

### Changed

- Added GitHub Actions release publishing for Tauri updater artifacts.

### Fixed

- Included the engine runtime dependency needed by packaged desktop builds.

## [0.1.1] - 2026-05-07

### Fixed

- Bundled the Symphony engine into the installed desktop app.

## [0.1.0] - 2026-05-06

### Changed

- Rotated the desktop updater public key for the first GitHub-distributed
  release line.

[Unreleased]: https://github.com/TheOverAchievingDev/T.O.A.D/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/TheOverAchievingDev/T.O.A.D/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/TheOverAchievingDev/T.O.A.D/releases/tag/v0.1.3
[0.1.2]: https://github.com/TheOverAchievingDev/T.O.A.D/releases/tag/v0.1.2
[0.1.1]: https://github.com/TheOverAchievingDev/T.O.A.D/releases/tag/v0.1.1
[0.1.0]: https://github.com/TheOverAchievingDev/T.O.A.D/releases/tag/v0.1.0
