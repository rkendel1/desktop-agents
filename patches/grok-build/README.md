# Grok Build macOS socket compatibility

Foundry keeps `--sandbox strict` and `--permission-mode dontAsk`. Some Grok
versions reject the Docker/OrbStack socket symlink before starting. This optional
local build fixes that check without changing the official Grok installation.

Source: https://github.com/xai-org/grok-build
Pinned commit: `4247f661689354b831191f11eeeac8424993fe3d` (source package 1.0.38).
This is a locally patched build, not an official xAI release. The source is Apache-2.0.

The patch:
- On macOS, retains denies for both the socket link and its resolved target.
- Handles a missing endpoint when its parent exists (Docker is stopped).
- Refuses links to ordinary files and further endpoint symlinks.
- Adds explicit Seatbelt connection denies: filesystem denies alone do not
  prevent connecting to a Unix socket.
- Leaves Linux socket resolution unchanged.

Build in a separate checkout of the pinned commit, with the upstream Rust and
DotSlash prerequisites installed:

```sh
git apply /absolute/path/to/douchat/patches/grok-build/macos-socket-deny.patch
TMPDIR=/private/tmp cargo test -p xai-grok-sandbox --lib
cargo run -p xai-grok-sandbox --example socket_compat_check
cargo build -p xai-grok-pager-bin
```

The kernel check must report that both link and target connections and mutations
are denied, while a control workspace write succeeds. Never substitute a weaker
sandbox profile when a test or initialization fails.

After verifying a headless reply with Foundry's exact arguments, install the binary
as `~/.douchat/local-tools/grok/<Node process.arch>/grok` (executable).
Foundry uses this file only for the built-in Grok adapter on macOS. Other platforms,
other agents, and the terminal's official Grok executable are unchanged. Removing
this optional binary restores the normal executable selection. Official CLI
updates do not update this separate compatibility build.
