`src/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/`

# Meta callbacks (nested resource)

Parent: [Instagram account](../instagram-account.overview.md)

## Purpose

Meta's two callbacks about the person who connected an Instagram account (routes-final § 1.D, IA18–IA20, D22):

- **Deauthorize** — route 7, `POST /api/v1/app/social/instagram/deauthorize`: the owner removed the
  app. In every organization holding that Instagram account, the account is disconnected as route 4
  does — `revoked`, its token erased — without the unsubscribe call (the app is already removed).
- **Data deletion** — route 8, `POST /api/v1/app/social/instagram/data-deletion`: the owner asked
  for their data to be deleted. The same, plus the account's profile and its stored posts erased —
  revoked rows of the same person too. Contacts are not touched (a contact's own request is route
  10). Answers Meta's documented `{ url, confirmation_code }` outside the envelope; the link opens
  the frontend's `/instagram/data-deletion?code=…` page (IQ2 — no request table, no status route:
  the audit entry is the record).

Both are PUBLIC: Meta's form-encoded `signed_request` proves the caller. This folder owns no table;
it writes `app.instagram_accounts`, `app.instagram_account_tokens` and `app.instagram_media`
through their services. Built by ROUTE row R6 of the launch iteration
(`iterations/launch-2026-11-20-ujai/`).

## Layout

- `instagram-account-meta-callback.routes.ts` — routes 7 and 8: no `app.authenticate`,
  `WEBHOOK_RATE_LIMIT`, a 16 KB body limit (`META_CALLBACK_BODY_LIMIT_BYTES`, D53), no idempotency
  key (K3); route 8's `raw_response` config
- `instagram-account-meta-callback-ingress.plugin.ts` — registered first inside the routes plugin
  (the `stripeWebhookIngressPlugin` pattern): the routes' only body parser
  (`application/x-www-form-urlencoded`, which reads the one `signed_request` field and skips every
  other) and a `preValidation` hook that verifies `signed_request`
  with the shared `parseMetaSignedRequest` (`src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.ts`) and
  sets `request.metaSignedRequest`
- `instagram-account-meta-callback.controller.ts` — reads the verified request, calls the service,
  writes one audit entry per organization changed, answers Meta
- `instagram-account-meta-callback.service.ts` — the resolver, then one transaction per
  organization in its `PRINCIPAL_SCOPE.VERIFIED` scope (ledgered in
  `verified-scope-usage.policy.unit.test.ts`): `InstagramAccountErasureService.eraseForMeta`, the
  erase an organization's delete shares (D54)
- `instagram-account-meta-callback-confirmation-code.util.ts` — the data-deletion confirmation code,
  derived from the signed request (HMAC-SHA256 with the app secret over `user_id` and `issued_at`,
  21 characters `[a-z0-9]`)
- `instagram-account-meta-callback.serializer.ts` — Meta's data-deletion answer
  (`FRONTEND_URL` + `/instagram/data-deletion?code=…`, `confirmation_code`)
- `instagram-account-meta-callback.dto.ts` — the form body, `signed_request` (Meta's own shape, not
  strict)
- `instagram-account-meta-callback.constants.ts` / `.types.ts` — the frontend path, the audit
  actions and source, the form media type; the service's results and the answer object
- `__tests__/factories/` — Meta's signed request and form body, signed with a given secret; the
  route paths
- `__tests__/unit/` — the form parser and the ingress (a real Fastify instance, no database), the
  service with its unit of work run inline, the confirmation code and the answer builder
- `__tests__/integration/` — routes 7 and 8 over HTTP against Postgres

## Key invariants

- **The signature first, then everything else.** Nothing is read or written before the signed
  request verifies: HMAC-SHA256 of the payload part with `META_APP_SECRET`, compared in
  constant time, `algorithm` `HMAC-SHA256`, a digits-only `user_id` — the one helper the Instagram
  webhook's `X-Hub-Signature-256` check shares. A bad one is `400 instagram_signed_request_invalid`;
  no app secret is `503 instagram_not_configured`.
- **Only Meta's form body, and little of it.** The routes' plugin drops every inherited parser and
  adds one for `application/x-www-form-urlencoded`, encapsulated — no other route gains a form
  parser, and JSON or any other body here is `415`. The body has to be read before its signature can
  be checked, so anybody can make the server read one: it is at most 16 KB (`413` above) and one pass
  finds the single `signed_request` pair — no other field is decoded or collected, whatever the
  number of fields (D53).
- **No other organization's row is read.** The organization comes from
  `app.resolve_organization_public_ids_for_instagram_app_user` (IA6; Meta signs the app-scoped id,
  IQ3), which returns public ids only; each organization is then changed in its own verified scope,
  one transaction each.
- **Always 200 once verified** — a person never stored, a repeat, a deauthorize after a data
  deletion — so Meta does not retry (1.D.10). Route 8 answers the same code for the same signed
  request.
- **Only a connection older than the request (D53).** Meta signs when it made the request
  (`issued_at`, whole seconds) and retries one it got no answer for; an account connected — or
  connected again, which moves `connected_at` — after that second is left alone, whatever its
  status. A request without `issued_at` acts on every account. The accounts are locked as they are
  read, so a reconnect that races the request waits and connects on top of it.
- **Safe to repeat.** A revoked row stays as it is, an erased profile is not erased again
  (`eraseProfile` keys on `profile_erased_at IS NULL`), a deleted token or post is gone, a newer
  connection is left alone; a repeat changes nothing and writes no audit entry.
- **A deleted organization has nothing left.** Its delete erased the account before its soft delete
  (D54); after it, row-level security hides its rows, so the request finds none and answers as ever.
- **No run is cancelled** and automations stay `live` (IQ1, D24); settings, contacts and webhook
  events stay.

## Lifecycle

None of its own — it moves the parent account to `revoked` (any status) and, on a data deletion,
stamps `profile_erased_at`; see the [Instagram account lifecycle](../instagram-account.overview.md#lifecycle).

## Events

None on the event bus. Audit (IA7, K9): `app.instagram_account.deauthorize` and
`app.instagram_account.data_deletion` — WARNING, resource type `instagram_account`, anonymous actor
(Meta is not a user), `metadata.source = 'meta'`, the changed accounts' public ids, and on a data
deletion the confirmation code and the erased post count; one per organization changed, after its
commit, best-effort (audit-emission, D36).

## External integrations

Meta posts to these routes; nothing here calls Meta or Instagram. The two URLs are set on the
Instagram app ("Deauthorize callback URL", "Data deletion request URL"):
[credentials-and-env.md § 10](docs/integrations/credentials-and-env.md).

## Failure modes

- `400 instagram_signed_request_invalid` — missing, doubled, malformed or wrongly signed
  `signed_request`, another algorithm, or no `user_id`; nothing changes.
- `413` — a body over 16 KB; `415` — a body that is not form-encoded; `429` — over the webhook rate
  limit.
- `503 instagram_not_configured` — `META_APP_SECRET` unset.
- A database failure in one organization fails the request; Meta retries, and the organizations
  already changed find nothing left to do.

## Testing

- `__tests__/unit/instagram-account-meta-callback-ingress.plugin.unit.test.ts` — the form parser
  (one pair decoded at any field count, a doubled field refused), a good, a bad and a missing signed
  request, another algorithm, the 16 KB limit (`413`), a JSON body (`415`), no app secret (`503`),
  the parser kept inside its plugin.
- `__tests__/unit/instagram-account-meta-callback.service.unit.test.ts` — every resolved
  organization in its own verified scope, only changed organizations reported, the posts and the
  code on a data deletion, a repeat, no app secret.
- `__tests__/unit/instagram-account-meta-callback.serializer.unit.test.ts` — the confirmation code
  (stable, 21 `[a-z0-9]`, keyed by the app secret) and Meta's answer.
- `__tests__/integration/instagram-account-meta-callback.integration.test.ts` — routes 7 and 8: a
  valid and an invalid signature, a missing one, a body over the limit, a JSON body, no app secret,
  an unknown person still
  answered, every matching organization revoked and its token erased, the profile and posts erased
  (revoked rows too), another account untouched, contacts and settings untouched, a repeat harmless
  with the same code, a retried request after a reconnect leaving the new connection alone (D53), a
  request without `issued_at`, the audit entries. No automation run exists yet (sub-domain 3 is built
  later), so "no run is cancelled" holds by construction here — the service calls only the
  account, token and media services.
