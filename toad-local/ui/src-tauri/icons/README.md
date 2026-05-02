# Tauri icons

Tauri 2 needs platform-specific icons in this folder. The names referenced in
`../tauri.conf.json` are:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

Generate them all from a single 1024×1024 source PNG with:

```powershell
cd C:\Project-TOAD\toad-local\ui
npx tauri icon path\to\toad-source.png
```

That writes the full icon set into this directory. Run once before
`npm run tauri:build`. `npm run tauri:dev` works without icons, but the
production bundler will refuse to package without them.

If you want a no-frills placeholder for now, drop any 1024×1024 PNG into
`toad-source.png` next to this README and run the icon command — it'll
generate everything Tauri needs.
