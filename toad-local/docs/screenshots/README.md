# Screenshots

PNGs in this directory are captured by `scripts/capture-screenshots.mjs` and embedded in the project's root `README.md`.

## Regenerate after a UI change

```bash
# from toad-local/
npm install --save-dev playwright   # one-time
npx playwright install chromium     # one-time
npm run screenshots
```

The script:

1. Boots the sidecar API server (port 3001) and the Vite UI dev server (port 5173) in the background — or detects them if you have them running already.
2. Drives a headless Chromium through every major screen.
3. Saves PNGs at 1440×900 to this directory.
4. Tears the dev servers back down on exit (or on Ctrl+C).

If a particular screen fails to capture, the script keeps going and warns. Re-run after fixing.

## Adding a new screen to the capture set

Edit `scripts/capture-screenshots.mjs`'s `SCREENS` array and add an entry with `{ name, description, navigate, waitFor }`. The next `npm run screenshots` run will pick it up.

## What ships in git

The PNGs themselves ARE committed to git so a fresh clone has visuals in the README without having to run the capture pipeline.
