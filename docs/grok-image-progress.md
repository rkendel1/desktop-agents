# Grok image generation and progress

The headless Grok adapter uses `streaming-json`, not the final-only `json`
format. Its protocol is documented in the [Grok Build headless guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md).

## Failure reproduced on 2026-09-23

With the previous Foundry arguments, Grok read the Imagine instructions and
announced that it would draw. Its `image_gen` call then failed with
`User cancelled the execution for tool image_gen`, followed by
`end.stopReason = cancelled`. `dontAsk` denied this tool because only read/search
tools had explicit permission. The final-only parser displayed the preparatory
text without checking the stop reason, so the conversation appeared successful.

## Adapter behavior

- Explicitly allow `image_gen` and `image_edit`; retain `dontAsk` and the strict
  sandbox. No general shell, write, or MCP permission is added.
- Parse tool events as they arrive. Show the image request, elapsed time, result
  preparation, and attachment transfer. No percentage is estimated. This Grok
  version leaves a running image call `pending` until completion, so the status
  says it is waiting for the image tool's result.
- Ignore reasoning, tool inputs, and file contents in progress messages.
- Treat failed image tools, cancelled turns, incomplete streams, and text-only
  tier restrictions as errors. Never publish a preamble as a successful result
  after these failures. Stop continues to kill the owned process group; timers
  are cleaned up on exit and failure.
- Attach only typed `ImageGen`/`ImageEdit` results from the completed session's
  own workspace. Validate session ID, workspace metadata, resolved file paths,
  MIME signatures and attachment limits. Reply text cannot nominate attachments.
- Localized error summaries explain that failed tasks are no longer running.

## Verification

Automated coverage: fragmented events, concurrent tools, hidden reasoning,
denied calls, tier restrictions, interrupted streams, truncated output, Stop,
heartbeat cleanup, real child-process attachment delivery, workspace isolation,
symlink escape rejection, invalid images, hashed workspace directories, runtime
loading cleanup, and renderer status/elapsed-time display.

Live smoke test through `runLocalAgent`, using the configured local Grok login:
one blue watercolor flower, no shell tools. Image call observed at approximately
19 seconds, result at 24 seconds, attachment delivery at 28 seconds. Returned
one valid 294,155-byte JPEG; visually inspected. This is a single successful run,
not a latency guarantee. No real chat was modified by the smoke test.

```sh
npx vitest run src/main/grokStream.test.ts src/main/grokProcess.test.ts src/main/localAgentRuntime.test.ts src/main/localAgentProcess.test.ts src/main/localAgentIntegration.test.ts src/renderer/src/components/ChatPane.test.tsx src/shared/bot/bot.test.ts
npm run typecheck
npm run build
```
