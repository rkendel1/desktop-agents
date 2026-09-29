# Remaining "Douchat" identifiers

Foundry was named Douchat. The product a person sees is Foundry everywhere — window and About titles, the macOS
menu, dialogs, errors, onboarding and empty states, settings, notifications, accessibility labels, the zh translations,
prompts the agents receive, the AppPort manifest's application name and descriptions, the installers' names, the
README and the user documentation. What is left of the old name is one of the following, and each entry is a
deliberate decision, not an oversight. `src/shared/brand.test.ts` reads this table: every occurrence of the old name in
the repository must match a row here (and every row must still match something), so a stray one fails the build.

Classes: **compatibility** (changing it needs a data migration, breaks a contract, or has no user-facing benefit),
**historical** (records of what happened, or of an older on-disk format), **retained** (an external name that is not
ours to change in this PR).

## Renamed

The display name (`src/shared/brand.ts`), the app icon and every in-app mark (`resources/icons/foundry.*`), `package.json`
`productName` / dmg title / installer `artifactName` (installers are now `Foundry-<version>-…`, and the release workflow
checks for those names), the AppPort application name and capability descriptions, `createFoundryAppPort`, console log
prefixes (`[foundry]`), HTTP `User-Agent` headers, the TokenDance key name, the terminal helper script name, all user
documentation and every UI string in English and Chinese.

## Retained, by class

| Class | Pattern | Why it stays |
| --- | --- | --- |
| compatibility | `^(?:window\.)?douchat$` | The preload bridge (`window.douchat`), and bare names of the npm package (`douchat`), the Linux executable (electron-builder names it after the package), the repository directory, the user-data directory (`douchat`, `douchat-dev`: it is where the FeltDB flow lives) and the R2 bucket. |
| compatibility | `^window\.douchat\.\w+$` | Methods of the preload bridge; internal, renderer ↔ main only. |
| compatibility | `^douchat:[a-z-]+$` | IPC channel names; internal, and renaming them buys nothing a person can see. |
| compatibility | `^(?:[A-Za-z]+Douchat[A-Za-z]*\|[A-Za-z]*Douchat[A-Za-z]+\|douchat[A-Z]\w*)(?:\.\w+)*$` | Internal class, type and function names (`DouchatRuntime`, `DouchatApi`, `isDouchatRenderer`, …). No user-facing benefit; a rename is churn across ~100 files. |
| compatibility | `^douchat\.(?:projects\|coding\|approvals)\.[a-z.]+$` | The published AppPort capability and permission names. The contract is not changed for branding. |
| compatibility | `^ai\.douchat\.desktop$` | The AppPort application id and (`appId` `ai.thinkany.douchat`) the app's platform identity; changing either breaks updates and OS permissions. |
| compatibility | `^ai\.thinkany\.douchat(?:\.[a-z]+)?$` | The Electron `appId` (and the development host's bundle id): the identity auto-update, macOS permissions and Windows shortcuts are keyed on. |
| compatibility | `^douchat_[a-z_]*$` | Tool and marker names that agents' prompts and stored transcripts refer to (`douchat_create_routine`, `douchat_silent`, …). |
| compatibility | `^douchat-(?:file\|ref\|memory\|agent\|input\|dialog\|tanstack\|node-smoke)(?:[-:/\w]*)?$` | On-disk and in-page formats: the `douchat-file:` attachment scheme, `data-douchat-ref`, `<!-- douchat-memory: -->` markers in memory files, the `douchat-agent` archive format, `.douchat-input-*` folders, browser partitions. |
| compatibility | `^(?:github:)?douchat-github(?:-token)?$` | The persisted GitHub connection id and the vault reference of its token. |
| compatibility | `^(?:data-)?douchat-[a-z0-9-]+$` | Other hyphenated internal names: temporary-directory prefixes, skill-run and model-cache folders, log and vault file names, test fixtures, `douchat-local` / `douchat-host` (the stand-in owner authority's ids), `douchat-data` in `.gitignore`. Internal, and never shown. |
| compatibility | `^douchat-dev$` | The development user-data directory and dev icon key. |
| compatibility | `^(?:process\.env\.)?DOUCHAT_[A-Z_]+$` | Environment variables (`DOUCHAT_APPPORT`, `DOUCHAT_DEMO`, …) and the `DOUCHAT_OK` test sentinel. Renaming them needs a deliberate deprecation path. |
| compatibility | `^douchat\.(?:db\|general\|git\|platform\|desktop)$` | The legacy SQLite file name (`douchat.db`) imported by the migration, and property-path fragments of `window.douchat.*`. |
| compatibility | `^'?douchat'?$` | The `douchat` value of the activity `source` / event `origin` enums, part of the AppPort event contract. |
| compatibility | `^(?:[\w.:@/-]*[/:])?douchat(?:[-/.:][\w./:-]*)?$` | Paths, URL schemes and prefixed names of the same things: the `Application Support/douchat` and `%APPDATA%\\douchat` data folders, `douchat://` deep links in the design notes, the GitHub Actions signing-keychain temp files, `persist:douchat-agent-*` browser partitions, `github:douchat-…` vault keys. |
| compatibility | `^Douchat$` | The legacy application name — the Keychain service, `userData.ts`, the read-time author check, and this documentation of them (the only files allowed to say it are listed in `brand.test.ts`). |
| retained | `^(?:https?://)?(?:cdn\.)?douchat\.ai(?:[/?#][\w./?=&%-]*)?$` | The product website and update CDN: external hosts. |
| retained | `^(?:https://github\.com/\|git@github\.com:)?thinkany-ai/douchat(?:\.git\|/issues)?$` | The source repository, which this PR does not rename. |
| retained | `^douchat-file:///absolute/path$` | Example URL of the attachment scheme above. |

## Historical

- `docs/validation/*.json` — transcripts of validation runs made under the old name.
- Git history, and the migration of `douchat.db` / `local-agents.json` into FeltDB (`src/main/legacy/*`).
- Messages stored before the rename are signed `Douchat`; the read-time compatibility check in `src/shared/groupText.ts` accepts both names.
- The macOS Keychain service (`Douchat Safe Storage` / `Douchat Dev Safe Storage`) and `userData.ts`: Chromium derives the
  service from the application name, so keeping it is what keeps stored provider credentials readable. **Follow-up:** move
  credentials to a Foundry-named service, then flip `applicationName`. Until then the app menu, About panel and window titles
  are set explicitly to Foundry.
- The Codex app-server `clientInfo.name` (`douchat`) is a protocol identity reported to a third party.
