# Gemini CLI image generation

Foundry's local Gemini contact uses the installed Gemini CLI. Image generation
is provided by the [Nano Banana extension](https://github.com/gemini-cli-extensions/nanobanana),
not by the CLI's ordinary text model or its Google account login.

## Setup

Install Gemini CLI, then install and configure the extension locally:

```sh
gemini extensions install https://github.com/gemini-cli-extensions/nanobanana
gemini extensions config nanobanana
```

Enter a Google AI Studio API key in the extension's local configuration prompt.
Do not paste it into a conversation. An OpenRouter key cannot be used here.
An existing `NANOBANANA_API_KEY` environment variable is also supported, including
when Foundry is launched from Finder. The extension also recognizes
`NANOBANANA_GEMINI_API_KEY`, `NANOBANANA_GOOGLE_API_KEY`, `GEMINI_API_KEY`, and
`GOOGLE_API_KEY`. Prefer the Nano Banana-specific variable to keep the CLI's
chat authentication independent. `NANOBANANA_MODEL` selects the extension's image
model; otherwise its own default is used. Restart Foundry after changing shell
environment variables because the login-shell environment is cached.

## Runtime

- Consume Gemini CLI `stream-json` tool events for real progress and elapsed time.
- A per-run policy authorizes only Nano Banana's image tools. It does not allow
  arbitrary shell commands or other MCP servers. Preview launches are denied;
  images are shown in the conversation instead. Remove the policy after the turn.
- Disable this image authorization for controllers, health probes and read-only
  authorization checks.
- After a successful image tool result, attach new image files from the current
  workspace's `nanobanana-output`. Exclude pre-existing files; validate canonical
  containment, file signatures and the existing 4-image/8-MiB-per-image/20-MiB-total
  attachment limits. Never treat paths in assistant prose as attachments.
- Image tool errors override an overall CLI `result.status=success`. Missing
  credentials have a localized, actionable error. Stop, process errors and
  incomplete streams clear progress through the normal runtime cleanup.
- Preserve normal text conversations without requiring image credentials.

## Verification on 2026-09-23

Installed Nano Banana v1.0.12 alongside Gemini CLI 0.60.0. A real invocation through
`runLocalAgent` reached `mcp_nanobanana_generate_image`, emitted live image progress,
and correctly reported the missing Google API key even though the CLI returned
exit code zero and overall success. No suitable Google key was configured, so
real image generation is **not yet verified**.

Automated tests cover fragmented streams, parallel tool progress, hidden inputs,
failed image calls, ordinary text replies, missing terminal events, output
isolation, stale image exclusion, invalid image files, symlink escapes, actual
fixture subprocess delivery, Stop, heartbeat cleanup, temporary policy cleanup,
read-only policies, and runtime attachment persistence for Gemini.

```sh
npx vitest run src/main/geminiStream.test.ts src/main/geminiProcess.test.ts src/main/localAgentRuntime.test.ts src/main/localAgentIntegration.test.ts src/main/shellPath.test.ts
npm run typecheck
npm run build
```
