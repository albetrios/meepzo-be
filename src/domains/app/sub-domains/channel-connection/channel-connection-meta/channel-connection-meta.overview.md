`src/domains/app/sub-domains/channel-connection/channel-connection-meta/`

# Channel connection — Meta adapter

## Purpose

The Meta provider adapter of the channel connection (routes-final § 1 MC2 of
`iterations/feat-instagram-dm-sending-2026-11-23-oxak/`): the one Meta client, its error map, the Unified Login calls,
Meta's usage headers and the two signature checks. It has no table and no route of its own; the connection's routes and
every other sub-domain (Instagram account, webhook, sending) reach Meta only through this folder. A later provider adds a
sibling folder (`channel-connection-<provider>/`).

- [`meta-graph.client.ts`](meta-graph.client.ts) — every Graph call: the post and story lists, one post, the webhook
  subscription (`subscribed_apps`), direct messages and private replies (`/messages`), public comment replies
  (`/replies`), a person's profile with the follow check, and the Unified Login reads of a connection's token —
  `GET /me?fields=client_business_id`, `/me/assigned_instagram_accounts`, `/me/permissions`, `/me/adaccounts` and an
  ad account's ads. Moved here from the retired `infrastructure/social/` folder (reuse rule — moved, never copied).
- [`meta-login.ts`](meta-login.ts) — the Unified Login address (`https://www.facebook.com/dialog/oauth?client_id
  &config_id&redirect_uri&response_type=code&state&prompt=login`) and its code exchange (`/oauth/access_token`).
- [`meta-graph-usage.util.ts`](meta-graph-usage.util.ts) — reads `X-Business-Use-Case-Usage` and `X-App-Usage` and
  decides the pace (normal, slow at 80 %, wait at 95 %).
- [`meta-graph-error.util.ts`](meta-graph-error.util.ts) — `MetaGraphApiError`: Meta's error answer read once.
- [`meta-signature.ts`](meta-signature.ts) — the two Meta signature checks.

## Design decisions

- **One version, pinned in code**: `META_GRAPH_VERSION = 'v27.0'` on `graph.facebook.com`, a code constant like
  Stripe's API version — it does not vary by environment, so it is not an env var (P4).
- **No Instagram Login is left** (ROUTE row R3, RC-6, WC-35, AC-1.17): the launch's code exchange, token exchange,
  renewal and `/me` on `api.instagram.com` / `graph.instagram.com` are gone with their hosts and contract fixtures. An
  account's profile is read by its id on `graph.facebook.com` (`readInstagramAccountProfile`, the pick and the daily
  refresh).
- **On the outbound pattern**: every call is `outboundFetchJsonWithHeaders` on the `meta-graph` integration — a 10 s
  timeout per attempt and `metaGraphCircuit` (5 failures / 30 s), one circuit for the provider (MC2). The scale review's
  per-call-class backstop (S14) is ROUTE row R42's.
- **The plain token lives only here (MC9)**: every call takes the encrypted token, decrypts it right before the
  request, and returns new tokens already encrypted. A token that does not decrypt is our failure (a 500), never read
  as Meta being down.
- **The token only in `Authorization`, with `appsecret_proof`**: every call with a customer token sends
  `Authorization: Bearer` and adds `appsecret_proof` — the HMAC-SHA256 of the token keyed by `META_APP_SECRET`
  (plan:L7183–L7194). So a Graph call needs the app secret: unset, it answers 503 `instagram_not_configured` before
  any request. `appsecret_proof` and `client_secret` (the code exchange's query, as Meta documents it) are redacted
  wherever a URL is logged — their names hold `secret`.
- **Meta's usage on every answer (MC19, S13)**: each call takes an optional `recordUsage`; after the answer — a success
  or an error — the client reads the two usage headers and hands the reading to it, outside any transaction. The
  business usage is kept per (connection, asset, type) exactly as Meta reports it; the app-level usage once. A missing
  header changes nothing; a failing recorder is logged and never fails the call. The recorder comes from the
  connection's usage service (`../channel-connection-usage.service.ts`, `buildUsageRecorder`).
- **One error, four classes**: every failure is a `MetaGraphApiError` (an `ExternalServiceError`, so an unmapped one
  answers 503) with `errorClass` — `auth` (190; permission codes 10 and 200–299), `throttled` (4, 17, 32, 613, 80002
  or HTTP 429, with `retryAfterMs`), `refused` (any other 4xx; code 10 outside the messaging window; the quick reply
  refused), `outage` (timeout, network, 5xx, an open circuit, an answer missing what the call needs). Meta's text is
  never read (D52, D53).
- **Refusals don't trip the circuit**: `auth`, `refused` and `throttled` carry `countsAsCircuitFailure: false`.
- **One signature helper for both Meta checks**: `verifyMetaWebhookSignature` (`X-Hub-Signature-256`) and
  `parseMetaSignedRequest` (the deauthorize / data-deletion `signed_request`) share one constant-time HMAC-SHA256 check
  with `META_APP_SECRET`.

## Operational concerns

- **Never inside a database context** (1.10): read, close the unit of work, call Meta, write in a new one.
  `rls-context-network-isolation.global.test.ts` reads this client's exported calls and fails on any of them inside a
  context callback under `src/domains/`.
- **Queues that call Meta** pause while it is down: `meta` is a managed circuit, so it is a `QueueProvider` for
  `createProviderPausableWorker`.
- **Sends are not idempotent**: the run engine's claim keeps a message from going twice (D16).
- **Ops**: the circuit is listed and resettable at `/internal/ops/circuit-breakers` (`meta`) and reported in `/readyz`.

## External dependencies

- Meta Graph API `v27.0` (`graph.facebook.com`), Meta's login dialog (`www.facebook.com/dialog/oauth`); until R3 the
  Instagram Login hosts above.
- Settings (MC3): `META_APP_ID`, `META_APP_SECRET` (at least 32 characters when set), `META_CONFIG_ID`,
  `META_REDIRECT_URI`. `isInstagramConfigured()` is false while any is unset; `assertInstagramConfigured()` and
  `readMetaAppSettings()` answer 503 `instagram_not_configured`; `readMetaAppSecret()` needs the secret alone (Meta's
  callbacks, `appsecret_proof`). `META_WEBHOOK_VERIFY_TOKEN` is the webhook's (sub-domain 5).
- `SECRETS_ENCRYPTION_KEY` (and its keyring) through `field-secret-encryption.util.ts`.

## Failure modes

- **Meta down, slow or failing** → `outage`; five in a row open `metaGraphCircuit`.
- **A dead or under-permitted token** → `auth`.
- **Throttled** → `throttled` with `retryAfterMs`, and the usage reading of that answer reaches the recorder.
- **Settings unset** → 503 before any call.
- **Contract tests**: `src/tests/contract/meta-graph.contract.test.ts` pins the wire shapes with nock.
