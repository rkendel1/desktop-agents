# Contributing to Foundry

Thanks for your interest in improving Foundry! This guide covers local setup and
how to get a change merged.

## Prerequisites

- **Node.js 22.12+** and **npm 10+**
- macOS: Xcode Command Line Tools
- Optional: a Foundry account for Cloud Agents, or a supported local agent CLI
  (Claude Code, Codex, Gemini, …) for Local Agents

## Setup

```bash
git clone git@github.com:thinkany-ai/douchat.git
cd douchat
npm ci
cp .env.example .env
```

## Running

```bash
npm run dev        # Electron with hot reload (badged "DEV" icon)
npm run typecheck  # main, preload and renderer TypeScript
npm test           # Vitest suite
npm run build      # production bundles in out/
npm run package    # unpacked app for the current platform
```

See the [README](README.md#configuration) for environment variables.

## Project layout

| Path               | What it is                                               |
| ------------------ | -------------------------------------------------------- |
| `src/main`         | Electron main process: auth, storage and agent runtime   |
| `src/preload`      | Typed IPC bridge exposed to sandboxed renderer windows   |
| `src/renderer`     | React application and UI assets                          |
| `src/shared`       | Shared data types and collaboration protocol helpers     |
| `resources/icons`  | Release and development app icons (SVG sources + builds) |
| `scripts`          | Dev-host preparation and icon generation                 |
| `docs`             | Design notes for agents, groups, permissions and more    |

## Pull requests

- Branch off `dev`; keep PRs focused and reasonably small.
- Match the surrounding code style and naming.
- Run `npm run typecheck`, `npm test` and `npm run build` before opening a PR.
- For UI changes, include a screenshot or short recording.
- Never include real credentials, tokens or personal data in code, fixtures,
  screenshots or issue reports.
- Sign off your commits with `git commit -s` — see [License of contributions](#license-of-contributions).

## License of contributions

Foundry is released under [AGPL-3.0](LICENSE), and is also offered under a separate
commercial license to organizations that cannot accept AGPL terms. Keeping both
options open requires every contribution to carry the same two grants, so by
submitting a pull request you agree to the following.

**1. Certificate of origin.** You certify the [Developer Certificate of Origin
1.1](https://developercertificate.org/) — in short, that you wrote the contribution
yourself, or have the right to submit it under these terms, and that you understand
it will be public and kept indefinitely. Sign off each commit with `git commit -s`,
which appends a `Signed-off-by:` line.

**2. Licensing grant.** You retain copyright in your contribution. You grant
ThinkAny, LLC a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to
use, reproduce, modify, and distribute your contribution — including the right to
distribute it under AGPL-3.0 **and** under the project's commercial license terms.
You also grant every recipient of the software a patent license covering any of your
patent claims that your contribution necessarily infringes.

If you cannot make these grants — for example your employer owns the copyright in
your work — please say so in the pull request before we review it, so we can sort
out the paperwork rather than merge something we cannot relicense.

> These terms exist so a single dual-licensed codebase stays legally coherent; they
> do not give up your own rights to your code. They are not legal advice — if your
> situation is complicated, talk to a lawyer.
