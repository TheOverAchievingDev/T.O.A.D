# TOAD desktop (Tauri 2)

This folder ships a Tauri 2 wrapper that turns the React UI + Node
orchestrator API into a real desktop app — `.exe` on Windows, `.app` on
macOS, `.AppImage` / `.deb` on Linux. The wrapper is a Rust shell
(`src-tauri/`) that:

1. Spawns `node ../scripts/dev-api-server.mjs` as a child process when
   the window opens, so the orchestrator API is available without the
   user running `npm run api:dev` in a separate terminal.
2. Loads the production-built UI (`ui/dist/`) inside a system webview, or
   points at `http://localhost:5173` during `tauri dev`.
3. Kills the orchestrator child cleanly on window close / app exit.

## First-time setup

The Tauri scaffold is committed but the first build needs three things on
the build machine:

1. **Rust toolchain (1.70+)** — install via [rustup](https://rustup.rs/).
   Tauri's Rust deps compile during `tauri:build`; they download
   automatically on first run.
2. **Platform native deps** — see Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/)
   page. Mostly: WebView2 on Windows (already shipped with Win10+),
   Xcode CLI tools on macOS, libwebkit2gtk-4.1 on Linux.
3. **App icons** — Tauri's bundler refuses to package without them. From
   `toad-local/ui/`:
   ```
   npm run tauri:icon path\to\toad-source.png
   ```
   That generates every size Tauri needs into `src-tauri/icons/`. A
   1024×1024 PNG is the recommended source.

## Dev loop

From `toad-local/ui/`:

```
npm install        # picks up @tauri-apps/cli + @tauri-apps/api
npm run tauri:dev
```

This starts Vite on 5173, waits for it, then opens the Tauri webview
pointing at the dev server. HMR works the same way it does in a browser.
The orchestrator API is spawned automatically and visible at
`http://127.0.0.1:3001`.

## Production build

```
npm run tauri:build
```

Outputs land in `src-tauri/target/release/bundle/`:

- Windows: `bundle/msi/TOAD_0.1.0_x64_en-US.msi`,
  `bundle/nsis/TOAD_0.1.0_x64-setup.exe`
- macOS: `bundle/dmg/TOAD_0.1.0_x64.dmg`,
  `bundle/macos/TOAD.app`
- Linux: `bundle/appimage/toad_0.1.0_amd64.AppImage`,
  `bundle/deb/toad_0.1.0_amd64.deb`

## Architecture choice: Node on PATH vs sidecar

Right now the wrapper requires Node 20+ on the user's `PATH` and spawns
`node` directly. This keeps the bundle small and matches the
already-required dev environment.

If we ever want to ship to users who don't have Node installed, we can
flip to a Tauri sidecar. The mechanism: drop a Node binary into
`src-tauri/binaries/node-${TAURI_TARGET_TRIPLE}` and reference it from
`tauri.conf.json` `bundle.externalBin`. The bundle balloons by ~70MB but
the install cliff drops to zero. Deferred — not needed for the developer
audience this app currently serves.

## Caveats

- The CSP in `tauri.conf.json` allows `http://127.0.0.1:*` and
  `ws://127.0.0.1:*` so the UI can talk to the orchestrator and SSE.
  It also lets `https://api.github.com` and `https://github.com` through
  for the Phase 3c GitHub Device Flow auth. Anything else is blocked —
  tighten or relax via the `app.security.csp` field.
- The orchestrator's working directory in production is
  `parent of <app launch cwd>`. Practically: the app uses
  `<projectCwd>/.toad/toad.db` based on where you launched it from. To
  open a different project, swap working directories before launching
  (a project picker that re-launches with a different cwd is on the
  roadmap).
- Sourcemaps are generated in dev and stripped in production. Override
  with `TAURI_ENV_DEBUG=true npm run tauri:build` if you need to debug a
  bundled build.
