`src/domains/app/sub-domains/instagram-account/`

# Instagram account

Parent: [app](../../app.overview.md)

## Purpose

The Instagram part of the team organization's connected accounts. Since ROUTE row R5 of
`iterations/feat-instagram-dm-sending-2026-11-23-oxak/` every row extends one channel account
(`../channel-account/`, `app.channel_accounts`, 1:1 through `channel_account_id`): the account's routes
(read, disconnect — the launch's `GET` / `DELETE /api/v1/app/social/instagram/account`) moved there as
routes 7 and 8, and the connection the account came through is the channel account's (P111, P116); the
token is that connection's (`app.channel_connection_tokens`). ROUTE row R6 reshaped this table into the
1:1 extension (routes-final § 2.A, IA8): the Instagram user id, the profile, the account type, the private
flag, the webhook stamp and the starter-question time — no public id, status or connection columns of its
own (the account's one id is the channel account's `cha_…`, P47). Every read joins the channel account
for them; the status moves only on `app.channel_accounts`. The extension is written only through
`InstagramAccountExtensionService` (2.A.10). The later sub-domains read the
account through this sub-domain's services: its status and settings on every webhook event, the
guarded status change on a token error, and the two resolvers that find an organization before
one is known.

Built by ROUTE row R3 of the launch iteration (`iterations/launch-2026-11-20-ujai/`,
`plans/routes-final.md` § 1.A, decisions IA5–IA7, IA9–IA14). ROUTE row R7 added the background
work (§ 1 IA8, IA9): the daily account check — retired in feat-instagram-dm-sending (the token
renewal at R3, WC-35; the profile refresh to the channel connection's token check at R51; the
subscription retry to the 10-minute webhook subscription check at the R40 × R51 merge) — and the
reconnect notice that follows every break.
The nested folders carry the rest of § 1: `instagram-account-settings/` (route 12 of
feat-instagram-dm-sending, `PATCH /api/v1/app/social/instagram/accounts/{channel_account_id}/settings`,
ROUTE row R7 — keyed by the channel account), `instagram-media/` (the launch's routes 5–6 and the
stored posts, R5 — routes 13–14 under the named account since feat-instagram-dm-sending R8). Meta's
deauthorize and data-deletion callbacks (the launch's `instagram-account-meta-callback/`) moved to the
channel connection at feat-instagram-dm-sending R9 (routes 16–17, P46); their per-organization erase
stays here (`InstagramAccountErasureService`).

## Layout

- `instagram-account.schema.ts` — `app.instagram_accounts`: the 1:1 extension of a channel account,
  one row per organization and Instagram account, so a pick brings a revoked one back with its settings
- `instagram-account.repository.ts` — the live accounts (joined to the channel account), the pick's
  upsert, the webhook stamp and its clearing, the profile erase (once), the locked accounts of one
  provider account id or of named connections (Meta's callbacks, MC15) and of the whole organization
  (its delete), the subscription sweep's page and the profile refresh, the webhook's SECURITY DEFINER
  resolver; worker and retention factories
- `instagram-account-extension.service.ts` — the extension's one writer (2.A.10): create at the pick,
  the webhook stamp, the revoke's stamp clear, the profile erase, the messaging-webhook marks (P358)
- `instagram-messages-webhook-watch.util.ts` — the messaging-webhook watch's pure rules (P358): when the
  subscription check reads Meta's conversations (subscribed over 24 hours, no messaging item since, the hour's
  first window), when it flags, when the webhook store writes the seen mark (at most hourly)
- `instagram-account.serializer.ts` — the `instagram` object of the channel account (2.A.6)
- `instagram-account.constants.ts` — the status type (the channel account's) and the broken statuses a
  Meta error classifies, the audit resource type (shared with route 3), the frontend's Instagram page
- `queues/` — `instagram-reconnect-notice` (one notice per account and break), with its job
  schema (`organizationPublicId` in every payload, K8); `instagram-account-tasks.queue.ts` — the
  account jobs' producers on `instagram-tasks` (feat-instagram-dm-sending IA6, ROUTE row R40): job
  names, the retry ladder (1, 5, 15, 60 minutes, then hourly), the 10-minute check's spread and the
  subscription sweep's page bounds
- `workers/` — the reconnect notice, registered in `worker-registration.registry.ts`;
  `instagram-account-tasks.processor.ts` — the account jobs' task handlers (set-up, subscription
  check, starter-question sync), registered into `appDomain.instagramSendWork.taskHandlers`, and the
  10-minute subscription sweep (`runInstagramWebhookSubscriptionCheckSweep`), which rides the channel
  connection's token-check queue and worker (`scheduler.ts`)
- `instagram-account.service.ts` / `.validator.ts` / `.types.ts` — no route of its own since R5 (the
  channel account serves routes 7 and 8): the webhook subscribe / unsubscribe steps, the guarded
  `markConnectionBroken`, and for Meta's callbacks `disconnectForMeta` (an account match or a
  business match's connections) (revoke, token and — on a data deletion — profile erase, in the caller's
  verified scope), for the organization's delete the best-effort unsubscribe and
  `disconnectForOrganizationOffboarding` (D54), and for the run engine `findAutomationAccountAccess` (the event's account with
  its encrypted token and settings row, read in the job's scope — sub-domain 3.B)
- `instagram-account-erasure.service.ts` — the one erase of an account's data in an organization:
  Meta's callbacks (`eraseForMeta`) and the organization's delete (`eraseForOrganizationOffboarding`,
  called by tenancy through its offboarding port, D54) — the account service's disconnect, the
  media service's stored posts and, on the organization's delete, the revoked accounts' sending lanes
  stopped through the lane port (sub-domain 6, CA8 — ROUTE R61), in one transaction
- `instagram-account-settings/` — nested: the account's limits, stop words and behaviour switches,
  and route 12 that changes them (the automation switch with them, on the channel account — R7) ([overview](instagram-account-settings/instagram-account-settings.overview.md))
- `instagram-media/` — nested: the post and story pickers of one named account (routes 13–14, read
  live through the connection's token) and the stored posts with their missed-comment watch and a
  Live's end, which sub-domains 4–6 write through its service ([overview](instagram-media/instagram-media.overview.md))
- `instagram-account-error.util.ts` — the shared route errors (`instagram_not_connected`,
  `instagram_reconnect_required`, `instagram_unavailable` with `Retry-After`), built once for the account routes, route 3, the pickers and
  Meta's callbacks
- `seed/` — bulk: a connected account with a fake encrypted token per demo team organization; the
  nested settings and stored-posts contributions follow it
- `__tests__/unit/` — the repository and token-service database suites, the token-isolation
  policy, the account jobs, the reconnect notice and its queue with Instagram and the database
  stubbed
- `__tests__/integration/` — the routes, and the reconnect notice against
  Postgres and Redis (Instagram mocked with nock)

## Key invariants

- **Many accounts per organization, one organization per live account.** An organization holds
  as many not-revoked accounts as its plan's `channel_accounts_max` (counted at the pick under the
  organization lock, D26); one row that is not `revoked` per Instagram account across all
  organizations (`idx_instagram_accounts_instagram_user_live`) — a pick race answers
  `409 instagram_account_connected_elsewhere`.
- **No soft delete.** A disconnect sets `revoked` and `disconnected_at`
  (`chk_instagram_accounts_disconnected` keeps the two in step); the row stays until the
  organization is deleted, so a reconnect of the same Instagram account finds its row and its
  settings again (`idx_instagram_accounts_organization_instagram_user`).
- **The token is the connection's, ciphertext everywhere but the Meta client (IA5, MC9).** It is
  stored only as `app.channel_connection_tokens.encrypted_access_token` (`encryptFieldSecret`).
  Only the connection's token repository reads its table, only the token service, the connection's
  token check and the account jobs use that repository, and only
  `src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts` calls `decryptFieldSecret` on it —
  `channel-connection/__tests__/unit/channel-connection-token-isolation.policy.unit.test.ts` pins all three. One
  operator exception, allowlisted there: the secrets-key rotation script
  (`src/scripts/ops/secrets-key-rotate.ts`, `pnpm ops:secrets:rotate`) re-encrypts the column onto
  the current `SECRETS_ENCRYPTION` key version with the other encrypted fields (D37). The
  column is in the log-redaction paths (`PINO_REDACT_PATHS`) and the secret response fields
  (`IDEMPOTENCY_SECRET_RESPONSE_FIELD_NAMES`); route 2 never returns it.
- **The token table has no cross-organization arm.** Its RLS policy is the organization arm only,
  in `USING` and `WITH CHECK` — no retention sweep arm — so no maintenance process can read a token.
  The account and its settings carry the sweep arm in `USING` only.
- **No expiry to copy.** The connection's system-user token ends only if its login configuration says so — its end
  is the connection token's `expires_at` (P355), never the account's; `token_expires_at`,
  `scopes` and the app-scoped id left the extension at R6 (IA8).
- **The token goes with the connection's last account** (route 4, Meta's deauthorize and data
  deletion, routes 7–8, and the organization's delete, D54): a disconnect revokes the account and,
  when no other not-revoked account uses its connection, revokes the connection and deletes its
  token (CA8); `webhook_subscribed_at` is emptied with the account. Meta's data deletion also erases the profile (`profile_erased_at`, only on a
  revoked row) and the stored posts, revoked rows of the same person included — but never a
  connection made after Meta signed its request (D53).
- **A deleted organization holds no Instagram data.** Its delete, as the last step before the soft
  delete, unsubscribes every live account (best effort) and revokes and erases every account it ever
  held — token, profile, stored posts — and revokes every connection still live with its token (one
  left with no account too, IAC5), in its own scope, so the Instagram account connects
  elsewhere at once and Meta's later requests find nothing (D54). After the soft delete row-level
  security hides the rows from that scope, so the erase must come first; a failed one stops the
  delete, and the offboarding reconcile worker runs it again.
- **No Instagram call inside a database context**: the pick calls Meta, then writes in one
  transaction, then starts the set-up task after the commit; disconnect removes the starter questions
  and unsubscribes before its transaction (`rls-context-network-isolation.global.test.ts`).
- **Lookups before the organization is known go through SECURITY DEFINER resolvers** that return
  only organization public ids — `app.resolve_organization_public_id_for_instagram_user` (the
  not-revoked channel account of an Instagram user id; webhook routing) here, and Meta's callbacks'
  two (by provider account, else by business — the channel connection's, R9) — then work in that
  organization's `PRINCIPAL_SCOPE.VERIFIED` scope (IA6;
  `src/tests/security/rls/instagram-account-resolvers.security.test.ts`).
- **Team-only.** Disconnect answers `422` on a personal organization; the read answers
  `404 team_organization_required`. Before either, the permission gate answers `403`: a personal
  organization's Owner never holds `instagram-account:read` or `:manage` (IA3).

## Lifecycle

The status below is the channel account's (`app.channel_accounts.connection_status`, CA4 — no
`expired` since R6; Meta's subcode 463 lands as `error`); the extension follows it.

```mermaid
stateDiagram-v2
    [*] --> connected: a channel connection's pick — new row, empty settings
    connected --> error: markConnectionBroken (any token refusal)
    error --> connected: reconnect (the callback, MC6) or a pick (same row)
    connected --> revoked: disconnect (route 8) — the connection's token with its last account
    error --> revoked: disconnect (route 8) — the connection's token with its last account
    connected --> revoked: Meta deauthorize / data deletion — the connection's token with its last account
    error --> revoked: Meta deauthorize / data deletion — the connection's token with its last account
    connected --> revoked: organization deleted (D54, IAC5) — token, profile and stored posts erased
    error --> revoked: organization deleted (D54, IAC5) — token, profile and stored posts erased
    revoked --> revoked: Meta data deletion, organization deleted — profile erased (once), stored posts deleted
    revoked --> connected: pick the same account in the same organization (row and settings kept)
    revoked --> [*]: organization purged (cascade)
```

The guarded change (`markConnectionBroken`, IA9) is the only way out of `connected` other than a
disconnect: it moves only a channel account still `connected`, so of two racing callers exactly one
wins. The winner — and only the winner — enqueues the break's reconnect notice once its unit of work
commits (job id = the account and the channel account's `updated_at` at the break); a rolled-back
break enqueues nothing. A reconnect sets `connected` again, so a later break is a new one and is
told again.

### The account jobs (feat-instagram-dm-sending IA6, ROUTE row R40)

Three handlers on `instagram-tasks`, each one try per job (the queue has one attempt) and each asking
the sending gate first:

- **Set-up** (`instagram-account-setup`, WC-30) — after a pick's or a reconnect's commit, and when the
  subscription check finds a field off: the six webhook fields → `webhook_subscribed_at`; the live
  starter questions → `starter_questions_set_at`; one read-only message-access probe (`off` logged; its answer is stored in `message_access` + `message_access_checked_at` from connect-flow R5 — the columns land in R1).
  A failed try books the next after 1, 5, 15, 60 minutes, then hourly; after the 60-minute try the
  `instagram-account:manage` holders get one notification and email (type
  `instagram.reconnect_required`, its own text). Meta refusing the token breaks the account.
- **Webhook subscription check** (`instagram-webhook-subscription-check`, WC-25) — the 10-minute sweep
  adds one per connected account, spread by account id. A field off on a stamped account: the stamp
  emptied, a new set-up, the team alert (`app.instagram_account.webhook_subscription_lost`) and the
  missed-comment look (WC-26, a port ROUTE row R39 fills). All six on for a stamped account: the
  **messaging-webhook watch** (P358, Meta's Unified Login limit for an account shared without its linked
  Facebook Page) — subscribed over 24 hours, no messaging item since (`messages_webhook_seen_at`, written by
  the webhook store) and Meta's conversations (`GET /{id}/conversations?fields=updated_time`, once an hour)
  changed after the subscription → `messages_webhook_missing_at` set (once) and one notification and email
  to the `instagram-account:manage` holders ("Reconnect Instagram with its Facebook Page", once key = the
  account and its subscription time); the channel account shows `is_messages_webhook_missing`. The next
  messaging item clears it; so does the stamp's clearing.
- **Starter-question sync** (`instagram-starter-question-sync`, WC-31) — after a go-live, pause, delete
  or question change of a starter-question automation (the automation service's port): the account's
  whole ice-breaker list (oldest automation first, at most four, payload `starter:<aut_…>`), or its
  removal; `starter_questions_set_at` set or emptied. The set-up's ladder, without the email.

### The reconnect notice (IA9)

One job per account and break. It re-reads the account (a break that is over by then is skipped),
finds every active member holding `channel-account:manage` (Owner, Admin — CA4, WC-46) through tenancy's membership service,
and sends each an in-app notification with the email channel — type `instagram.reconnect_required`,
in the organization's language, linking to the frontend's Instagram page — through notify's
`NotificationService.createOrganizationNotifications`, keyed once-only by the break.

## Events

None emitted on the event bus. Connecting and disconnecting are the channel connection's and the
channel account's (`app.channel_connection.connect` / `.disconnect`, `app.channel_account.connect` /
`.disconnect`). Route 12 writes `app.instagram_account_settings.update` (INFO, resource type
`instagram_account`) through `recordScopedAuditEvent`, after the write commits and best-effort — an
audit failure never fails the request (audit-emission, D36). Meta's callbacks
(the channel connection's since R9) write `app.channel_connection.deauthorize` and
`.data_deletion`. The erase of
an organization's delete (D54) is named on tenancy's `tenancy.organization.delete` entry.

Background jobs (BullMQ, pull-based, K8): `instagram-reconnect-notice` — enqueued by the guarded
status change after its commit (API and worker processes alike); the 10-minute webhook
subscription sweep (on the channel connection's `channel-connection-token-check` queue,
`scheduler.ts`); the account jobs on `instagram-tasks` (set-up, subscription check,
starter-question sync — above). The notice creates
notify's notifications, whose own `notification` jobs send the email through the mail outbox.

## External integrations

Meta's Graph API on `graph.facebook.com`, only through `src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts`
([Meta adapter overview](../channel-connection/channel-connection-meta/channel-connection-meta.overview.md)) with the
account's connection token: `subscribed_apps` (the set-up's subscribe, the 10-minute check's read,
the disconnect's unsubscribe), `messenger_profile` (the starter questions: set, removed — also before a
disconnect), `conversations` (the set-up's message-access probe); the profile read is the
channel connection's token check's. No
Instagram Login call is left (RC-6, WC-35).
The Instagram app's settings and scopes:
[credentials-and-env.md § 10](docs/integrations/credentials-and-env.md).

## Failure modes

- **The connect's own failures** (the code refused, permissions missing, the plan's limit, Meta
  down) are the channel connection's (`../channel-connection/channel-connection.overview.md`).
- **The set-up fails after a pick** → never fails the pick: the task tries again after 1, 5, 15 and
  60 minutes, then hourly, and emails the owners once; the 10-minute subscription check stamps an
  account it finds fully subscribed, and route 7's `is_webhook_subscribed` lets the page warn that no
  events arrive. With `SENDING_ENABLED` off the task waits in the queue.
- **The subscription check meets Meta down or busy** → `unavailable`, logged; the next 10-minute
  window checks again. **Meta refuses the token** (any account job) → `error` (`expired` for subcode 463) at once; a code-10
  "outside the messaging window" answer is a refusal, never a break (D32).
- **A reconnect notice whose enqueue fails** (Redis refusing writes) → logged
  (`app.instagram_account.reconnect_notice_enqueue_failed`); no row holds it, so no sweep re-sends
  it — the Instagram page still shows the reconnect card.
- **The unsubscribe fails before a disconnect or an organization's delete** → logged, never blocks
  it; a revoked account's events are not stored (sub-domain 4).
- **No live account** → route 2 and route 4 answer `404 instagram_not_connected`.
- **Meta's callbacks** — the channel connection's since R9 (routes 16–17, see its overview).
