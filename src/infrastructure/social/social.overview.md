`src/infrastructure/social/`

# Social infrastructure

## Purpose

The one Instagram client (K10, IA4 of the Instagram automation launch). [`instagram.client.ts`](src/infrastructure/social/instagram.client.ts)
is the only code that calls `api.instagram.com` and `graph.instagram.com`: the authorization-code exchange, the long-lived
token exchange and its renewal, `/me`, the media and story lists, one post, the webhook subscription
(`subscribed_apps`), direct messages and private replies (`/messages`), public comment replies (`/replies`), and a
person's profile with the follow check (`is_user_follow_business`).
[`instagram-error.util.ts`](src/infrastructure/social/instagram-error.util.ts) reads Instagram's error answer once;
[`meta-signature.util.ts`](src/infrastructure/social/meta-signature.util.ts) checks Meta's two signatures.

The `app` domain ([src/domains/app/](src/domains/app/)) owns the accounts, tokens and automations; this module owns the
network primitive and nothing calls Instagram any other way.

## Design decisions

- **One version, pinned in code**: `INSTAGRAM_GRAPH_API_VERSION = 'v24.0'` (D20), as `STRIPE_API_VERSION` pins Stripe —
  an upgrade is a deliberate change checked against Meta's changelog. The token exchange and renewal use Instagram's
  unversioned `/access_token` and `/refresh_access_token`, as Meta documents them.
- **On the outbound pattern**: every call is `outboundFetchJson` on the `instagram` integration — a 10 s timeout per
  attempt and its own Redis-backed `instagramCircuit` (5 failures / 30 s) — so it shares timeouts, request-id propagation
  and the circuit with every other third party (see [outbound.overview.md](src/infrastructure/outbound/outbound.overview.md)).
- **The plain token lives only here (IA5, D21)**: every call takes the encrypted token (`encryptFieldSecret`), decrypts
  it right before the request and returns new tokens already encrypted, so services, repositories, jobs and logs hold
  ciphertext only. A token that does not decrypt is our failure — a plain error (500), never read as Instagram being down.
- **The token in the header**: Graph calls send `Authorization: Bearer`; only the two calls Instagram reads from the
  query (the long-lived exchange, the renewal) put `access_token` / `client_secret` in the URL, and those parameter
  names are redacted by `redactSensitiveUrl` wherever a URL is logged or reaches Sentry. The code exchange posts the
  code and the secret as a form body.
- **One error, four classes (IA4)**: every failure is an `InstagramApiError` (an `ExternalServiceError`, so an unmapped
  one answers 503) with `errorClass` — `auth` (code 190: subcode 463 → `expired`, else `error`; permission codes 10 and
  200–299 → `error`), `throttled` (codes 4, 17, 32, 613 or HTTP 429, with `retryAfterMs` from `Retry-After`, one minute
  when absent), `refused` (any other 4xx; code 10 with Meta's "outside the messaging window" subcodes 2534022 /
  2018278 — only that send fails, the account stays `connected`, D32; `isQuickReplyRefused` for code 100 / subcode
  2534015), `outage` (timeout,
  network, 5xx, an open circuit, an answer missing what the call needs). Callers branch on the class; the HTTP mapping
  (404 `instagram_reconnect_required`, 422 `instagram_code_invalid`, 503 `instagram_unavailable`) is the services'.
- **Refusals don't trip the circuit**: `auth`, `refused` and `throttled` carry `countsAsCircuitFailure: false` (as
  `ResendApiError` does) — Instagram answered, so a burst of bad codes, dead tokens or one account's throttle cannot open
  the circuit for every organization. Only an `outage` counts.
- **Flat or wrapped answers**: the code exchange and `/me` read `data[0]` when the body has `data` as a non-empty list,
  else the flat body (D33 — Meta documents both); anything else lacks what the call needs and is an `outage`.
- **One signature helper for both Meta checks**: `verifyMetaWebhookSignature` (`X-Hub-Signature-256` over the raw body,
  WH8) and `parseMetaSignedRequest` (the deauthorize / data-deletion `signed_request`, IA18) share one HMAC-SHA256 check
  with the app secret, compared with `timingSafeEqual`; the signature is verified before anything is parsed.

## Operational concerns

- **Never inside a database context** (1.10): read, close the unit of work, call Instagram, write in a new one.
  `rls-context-network-isolation.global.test.ts` reads this client's exported calls and fails on any of them inside a
  context callback under `src/domains/`.
- **Queues that call Instagram** pause while it is down: `instagram` is a managed circuit, so it is a `QueueProvider` for
  `createProviderPausableWorker`. A throttle does not open the circuit; a worker that must wait it out throws
  `ProviderOutageError` with the error's `retryAfterMs` itself.
- **Sends are not idempotent**: the run engine's claim keeps a message from going twice (D16); the 200–1000 ms pause
  before each send (K10) is the sender's.
- **Ops**: the circuit is listed and resettable at `/internal/ops/circuit-breakers` and reported in `/readyz`.

## External dependencies

- Instagram API with Instagram Login (`api.instagram.com`, `graph.instagram.com`), Graph API `v24.0`.
- Settings (full names, D20): `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (the one app secret — also the key of both Meta
  signatures), `INSTAGRAM_REDIRECT_URI`. `isInstagramConfigured()` is false while any is unset; both code exchanges
  then answer 503 (`errors:instagramNotConfigured`) without calling Instagram.
- `SECRETS_ENCRYPTION_KEY` (and its keyring) through `field-secret-encryption.util.ts`.

## Failure modes

- **Instagram down, slow or failing** → `outage`; five in a row open `instagramCircuit` and later calls fail fast with
  `category: 'circuit_open'` and `retryAfterMs` until the half-open probe.
- **A dead or under-permitted token** → `auth` with the `connectionStatus` the account moves to (IA9).
- **Throttled** → `throttled` with `retryAfterMs`; the circuit stays closed.
- **A bad, used or expired code, a refused send** (a message outside the 24-hour window included) → `refused`.
- **Settings unset** → 503 before any call.
- **Contract tests**: `src/tests/contract/instagram.contract.test.ts` pins the wire shapes with nock.
