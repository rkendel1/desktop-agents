# Connany connectors

> Status: hidden. `CONNECTORS_ENABLED` in `src/shared/connany.ts` is `false`, so Settings shows no Connectors tab and agents receive no connector tools.

The desktop Settings → Connectors screen supports GitHub, Notion and Linear.
Each connector opens a dedicated detail page for accounts and connection
operations. Account names can be edited locally; disconnected accounts are hidden,
and disconnecting requires confirmation. A single connected account is available to all supported contacts by
default. With multiple accounts, choose a default account in the detail page;
the application never chooses the first result. Requests without an account use
the default; a named account can use any connection owned by the signed-in user.
Each provider exposes a discovery tool and an execution tool, alongside a connected-account directory. Only discovered read-only actions can execute. Local
CLI/desktop agents do not receive these tools.

## Architecture and configuration

- Desktop: `src/main/connany.ts` → authenticated Foundry backend proxy.
- Backend: the Foundry web service (`douchat.ai`), which holds the Connany project keys.
- Route: `POST /api/desktop-auth/connectors`.
- Backend validates the existing desktop login token with
  `authenticateDesktopToken`; only its user ID becomes `external_user_id`.
- `CONNANY_BASE_URL` and `CONNANY_API_KEY` belong exclusively in the backend's
  ignored `.env.development` (or production server environment). They are not
  desktop environment variables and are never bundled into Electron.
- The local backend is at `http://localhost:3004`, as selected by the desktop's
  existing `DOUCHAT_SERVICE_URL`. Connany is `http://localhost:3100`.
- No `return_url` is sent. Authorization opens in the system browser; return to
  Foundry manually. Polls are authenticated, scoped by project/user/session and
  coalesced for five seconds in each backend process. A multi-instance backend
  needs a shared cache/rate limiter before scaling out.
- No schema migration is needed. Connany remains the authoritative owner of
  connection/session metadata. Default account selections are persisted in the local
  account-scoped store, further scoped to the Foundry backend origin.
- Pending session identifiers survive closing/reopening Settings in the current
  desktop process. Restarting the desktop requires a new link if authorization
  is still pending; completed connections are rediscovered from Connany.
- Tool execution captures the signed-in user and resolves an optional account name
  against a fresh authenticated connection list. Only the executor supplies the
  connection ID; the backend verifies ownership/status and validates business
  parameters. Backend key defines project scope. Unknown or ambiguous account
  names fail without falling back to the default. Results identify the account used.
- Poll errors stop automatic polling and offer retry/new authorization. A 429
  establishes a project-wide cooldown from Retry-After plus jitter; mutations
  and tool execution are never automatically retried.

For deployment, localhost works only when backend and Connany are on the same
machine. Use a reachable HTTPS Connany origin for remote deployments, update
platform OAuth callbacks at the provider, and register an exact return URL in
Connany only if adding an automatic return flow later.

## Acceptance steps

1. Sign in as user A. Settings → Connectors → choose a platform → Connect;
   finish OAuth in the same
   system browser. The UI checks the session rather than trusting a redirect.
2. Ask a connected contact to read Notion/Linear data. For GitHub install the App
   if needed, then ask the contact to list installations and read repositories.
   Next page follows GitHub total_count; the agent tools also expose pagination
   parameters for Notion and Linear.
3. Open a connector detail. One connected account is enabled by default for all
   cloud contacts (including newly created contacts). Ask a contact to read it.
   External tool results are data, not instructions. No writes/MCP are advertised.
4. Connect a second account. Verify the account selector does not silently change
   default account selection. Set a different default in the detail and verify
   unnamed requests use it. Explicitly request the other account and verify all
   calls, including installations, repositories and pagination, use that account.
   Disconnecting stops access for all contacts without selecting a replacement.
5. Sign in as B: A's connections and selections must not appear. Foreign resource
   IDs must be rejected by Connany's user/project-scoped API.
6. Cancel OAuth, let a link expire, and retry. Disconnect an account and verify
   old tools fail; for reauth_required use Reconnect for the original account.
7. If platform revocation fails, local access remains revoked. Retry revocation
   or remove the authorization at the platform. GitHub App uninstall is separate.

## Verification on 2026-09-26

- Desktop full suite: 1128 passed, 4 skipped;
  targeted connector/settings tests: 21 passed, including authorization-link error redaction.
  Account/backend-origin persistence isolation is also covered by store tests.
- Backend connector contract tests: 7 passed. They cover spoofed user IDs, write rejection,
  project/user poll-cache isolation, cancellation, expiry, revoked/foreign
  connections, GitHub reads, pagination and rate limits.
- Both production builds pass. Backend TypeScript check passes.
- Live unauthenticated proxy request returns HTTP 401.
- Live Connany `/v1/providers` and `/v1/actions` return HTTP 500 internal_error.
  A direct SELECT 1 probe against its configured PostgreSQL timed out.
  Real OAuth and platform reads therefore remain unverified until Connany's
  database recovers and a user completes third-party authorization.

## Detail-page revision (2026-09-26, morning)

Connector cards now open detail pages. Details contain account selection, real
read-only tool counts, connection operations, platform information, and a
collapsed read-access test. Per-contact permission controls have been removed.
Shared selections are stored separately from the old per-agent grants; legacy
per-agent entries do not silently choose an account when several are connected.
Single accounts are discovered in the background after sign-in. Account changes
invalidate cached tool sessions on the next turn; old tools recheck the selection.

Validation: 69 targeted UI/executor/store/settings tests passed; TypeScript and
production build passed. Full regression: 1094 passed, 45 failed, 4 skipped.
Failures involve local runtime/loopback tests under the managed sandbox's
`listen EPERM` restrictions. Headless Chrome also could not launch in this
sandbox, so visual screenshot validation was not completed for this revision.

## Simplified account management (2026-09-26)

Removed Tools, Apps, Information and Test connection from the detail page.
Revoked connections are hidden; reauth_required connections remain visible.
The pencil button edits a local display name (1–80 characters), stored by login
account, backend origin and connection ID; upstream identities are unchanged.
Rename requests verify ownership using the authenticated backend connection list.
Disconnect requires confirmation naming the account; cancellation sends no request.

## Default and named accounts (2026-09-26, afternoon)

Account rows label the default explicitly; expanded rows offer Set as default.
The `connector_accounts` tool exposes current account/workspace names, custom
names, status and defaults, without exposing connection IDs. Business tools
accept an optional `account` name, resolved locally against the authenticated
list and stripped before forwarding business parameters. GitHub login matching
is case-insensitive. Ambiguous names require a distinct custom name.

Regression tests reproduce the reported scenarios: default mikeaq3161 returns
an empty repository list, while explicitly choosing idoubi reads that account's
repositories and subsequent pages without changing the default. These are mocked
executor tests, not a live verification of either account's private repositories.
Targeted connector/settings/store tests: 75 passed.

## Notion MCP migration (2026-09-26, afternoon)

Connany now uses official Notion MCP. Desktop tools are `notion_discover` and
`notion_execute`; the three old REST tool definitions are removed. The selected
account is resolved by the executor on every call. GitHub and Linear retain
their read-only actions. Backend adaptation and contract tests are staged in
`patches/connany-notion-mcp/`, because the sibling backend is outside the session's
writable roots. Apply `backend.patch` there before live testing; this is not yet
a completed live deployment. Safe backend tool/protocol errors are retained.

## Unified provider discovery and execution (2026-09-26)

Supersedes the provider-specific REST flows above. GitHub, Notion and Linear now
use the same selected-account flow: `{provider}_discover` followed by
`{provider}_execute`. The desktop no longer advertises fixed GitHub installation /
repository or Linear team / issue tools. The unused legacy read-test panel and
its IPC command were removed.

The Foundry backend derives the provider from the authenticated connection,
re-discovers each exact action on execution, requires `read_only === true`, and
validates the discovered JSON Schema. Internal `__*` actions and old dotted REST
names are rejected. Default/named account selection remains local and is checked
on every call, including pagination. This update is applied in both repositories;
the earlier Notion-only patch is historical and should not be reapplied.

Connany now explicitly calls `linear.get_workspace` after `linear.get_user`.
Existing Linear connections refresh identity metadata through the scoped,
credential-refresh-aware service path, at most once per hour. User/workspace
mismatches are rejected; metadata failures preserve existing names. No schema
migration or new environment variables are needed.

Validation: 25 desktop connector/settings tests, 22 backend contract tests and
29 Connany unit tests passed. Typechecks and production builds passed in all
three workspaces. A scoped in-process backend smoke test used existing real
connections to discover tools for all three providers and execute GitHub
`get_me`, Linear `get_workspace`, and Notion `notion-fetch({id:"self"})` through
the updated proxy service. Linear's existing account was enriched to ThinkAny.
This verifies real upstream calls; it does not simulate a complete desktop chat.
