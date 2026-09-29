# Foundry icons

The app icon is the Foundry logo, used exactly as supplied (`foundry-source.jpg`): an orange-to-red gradient
"F" on a dark rounded plate. Nothing is redrawn, recoloured or decorated.

The supplied file is a JPEG, so it has no transparency of its own: its plate sits on pure black. The generator cuts the
plate out of that black (the corners become transparent, with an anti-aliased edge) and places it on the 1024px
canvas with the transparent margin platform icons use (an ~824px plate). If a transparent original is supplied, drop it
in as `foundry-source.png` and change the one `Image.open` line in the script.

- `foundry.png` / `foundry.icns` / `foundry.ico`: release icon (PNG for the Dock, window and in-app marks; ICNS for macOS; ICO for Windows).
- `foundry-dev.png` / `foundry-dev.icns`: development icon — the same artwork with a small red `DEV` badge.

Electron selects the development PNG when the app is unpackaged and the release PNG otherwise. The Dock, BrowserWindow,
Settings → About and the empty-state mark all use these resources.

Regenerate every derived file with `python3 scripts/generate-icons.py` (needs Pillow and NumPy). Changing only the ICNS is
insufficient because Electron sets the running Dock icon from the PNG.
