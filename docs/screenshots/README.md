# Screenshots

These PNGs are captured from the live local Symphony UI by `scripts/capture-screenshots.mjs` and embedded in the root README and docs gallery.

## Regenerate

```bash
npm run screenshots
```

The script creates an isolated demo workspace under `.toad/screenshot-workspace`, starts the API and Vite UI on temporary local ports, seeds a representative team, captures Chromium screenshots, and stops the servers on exit.

## Current Set

- `cockpit-for-me.png` - Cockpit FORme overview
- `cockpit-with-me.png` - Cockpit WITHme code editor
- `menu-file.png` - File menu
- `menu-view.png` - View menu
- `menu-run.png` - Run menu
- `menu-terminal.png` - Terminal menu
- `settings-general.png` - Settings general
- `settings-providers.png` - Settings providers
- `settings-github.png` - Settings GitHub

The PNGs are committed so GitHub renders the docs without requiring a local capture run.
