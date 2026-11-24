`src/domains/app/`

# App

## Purpose

The Instagram automation product: a team organization connects its Instagram professional account, builds
automations that answer comments, direct messages and story replies, and keeps the contacts those
conversations create. Every table lives in the Postgres schema `app` and every route under `/api/v1/app`
(decision D1 of the launch iteration `launch-2026-11-20-ujai`).

What it owns today: the routes plugin (`app.routes.ts`, mounted by `src/routes.ts`), the container
(`app.container.ts`, decorated as `app.appDomain` by `domain-containers.plugin.ts`), the seed module
(`seed/index.ts`, registered in `SEED_MODULES`), the permission codes (`app.permissions.ts`), the schema
`app` (`appSchema` in `src/infrastructure/database/pg-schemas.ts`, created by
`migrations/20261121050908_app_schema.sql`), the channel connection (feat-instagram-dm-sending routes
1–5, 40 and 42 — start, callback, reconnect, pick, list, one, disconnect business — and Meta's PUBLIC
deauthorize and data-deletion callbacks, routes 16–17, since ROUTE row R9; the tables
`app.channel_connections`, `app.channel_connection_tokens` and `app.channel_connection_usages`), the channel
account (routes 6–11 — list, one, disconnect, pause, resume, choose active accounts — the capability list and the
one feature check; the table `app.channel_accounts`, ROUTE row R5) and the Instagram account (its settings, pickers
and the per-organization erase Meta's callbacks and the organization delete share; the
launch's connect route 1 retired with Instagram Login, RC-6; the tables `app.instagram_accounts` and
`app.instagram_account_settings` — the channel and Instagram tables created by
`migrations/20261121064529_app_instagram_account.sql` — and
`app.instagram_media`, created by `migrations/20261121094404_app_instagram_media.sql`), the contacts
(launch routes 9 and 10, now routes 18–23 of the DM-sending iteration; the tables `app.contacts`, `app.contact_activities` and `app.contact_tag_counts`, in `migrations/20261121094503_app_contacts.sql`), the
automations (routes 11–15 and the 15-minute "next post" expiry; the table `app.automations`, created by
`migrations/20261121150135_app_automations.sql`) and the Instagram webhook — Meta's subscription check
and delivery receiver (routes 60–61 since feat-instagram-dm-sending R17) and its stored events (route 62 and the 30-day clean-up; the table
`app.instagram_webhook_events`, created by `migrations/20261121094626_app_instagram_webhook_events.sql`).
The other sub-domains fill it in one ROUTE row at a time (`iterations/launch-2026-11-20-ujai/KICKOFF.md`).

What it does not own: organizations, members, roles and the permission catalog (tenancy — the app
codes and the locked Editor and Viewer roles are seeded there), in-app notifications and email (notify, mail
outbox) and the audit log (audit). The one Meta client lives in the channel connection's adapter folder
(`src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts` — the only code that
calls Meta, and the only code that decrypts a Meta token).

## Key invariants

- **One schema, granted like every other domain schema**: `app` is owned by `meepzo_be_owner` and gives
  `meepzo_be_app` and `meepzo_be_maintenance` USAGE plus the same default table privileges (and, for the
  maintenance role, default sequence privileges) as `auth`, `tenancy`, `billing`, `notify`, `audit` and
  `upload` — `migrations/20261121050908_app_schema.sql`. The schema `app` is not the `app.*` session
  settings (`app.current_organization_public_id`, …); those are GUCs, a separate namespace.
- **One mount point**: `src/routes.ts` registers `appRoutesPlugin` under `/api/v1/app`; each sub-domain's
  routes register under it (`__tests__/unit/app.domain-wiring.unit.test.ts`).
- **Seeded after tenancy**: the seed module depends on `tenancy`, so organizations exist before any app row
  (`src/tests/unit/scripts/seed/modules.unit.test.ts`); it has no reference data — the app codes and the
  Editor and Viewer roles are tenancy's. Bulk: each demo team organization gets a connected Instagram account, a fake
  `encryptFieldSecret` token, the default settings and three stored posts, then contacts of that
  account, then its automations (every trigger and scope), then that account's demo webhook events
  (every kind and status).
- **Team-only, organization from the token** (K1): every signed-in route takes the active organization
  from the token's `org` claim; on a personal organization a write answers `422` and a read
  `404 team_organization_required`, after the permission gate's `403`. Meta's two callbacks (routes
  7–8) are PUBLIC and carry no organization: Meta's form-encoded `signed_request` proves the caller,
  and the organizations come from a resolver, each changed in its own `VERIFIED` scope (IA6, IA18).
- **Forced RLS on every table** (K5): `organization_id` → organizations `ON DELETE CASCADE`, RLS enabled
  and forced, an organization policy with `USING` and `WITH CHECK` (listed in `EXPECTED_FORCE_RLS_TABLES`).
  The Instagram token table alone has no retention sweep arm (IA5).
- **Background work in the `instagram` worker family** (WH5): Instagram webhook event processing (one
  job per account, provider-pausable, `WORKER_CONCURRENCY_INSTAGRAM`) with its every-minute
  stuck-event pick-up on the same queue, and the daily 30-day clean-up of the webhook events (03:00,
  `runGlobalRetentionWorkerJob`). The automation timers run in the `retention` family (AU6): the
  "next post" expiry every 15 minutes, the 7-day wait cancel every hour, and the daily run (03:20
  UTC), comment-log (03:30) and deleted-automation (03:40) clean-ups.
- **A read-only plan stops the automation writes only** (AQ8, D27): `app-plan-access.ts` builds the
  preHandler (`SubscriptionService.assertOrganizationWritable`, `403 organization_read_only`) that
  `app.routes.ts` attaches to routes 12, 14 and 15; the domain's other writes stay open.
- **The channel connection's token stays ciphertext** outside the Meta client (IA5, MC9) — pinned by
  `sub-domains/channel-connection/__tests__/unit/channel-connection-token-isolation.policy.unit.test.ts`.
- **A deleted organization's Instagram account is erased at once** (D54): tenancy's organization
  delete calls `InstagramAccountErasureService.eraseForOrganizationOffboarding` through its
  offboarding port before the soft delete — unsubscribed (best effort), revoked, token, profile and
  stored posts erased; the rest of its rows wait for the purge.
- **A contact's erase reaches every copy in one transaction** (CT8): the container hands the contact
  service a list of `ContactErasureStep`s other sub-domains register (sub-domain 3's, with its build),
  so contacts never import the sub-domains built after them. An automation's delete cancels its open
  runs the same way (AU12): the container hands the automation service a list of
  `AutomationOpenRunCancelStep`s. The run engine (`automation/automation-run/`) registers one step
  in each list; the contacts list's automation filter reaches the automation service through a third
  hook (`ContactAutomationFilterResolver`, CT5).
- **The rules every sub-domain follows** are fixed by the route review (`plans/routes-final.md`, rules
  K1–K10) and become invariants of this file as each sub-domain is built.

## Sub-domains

In build order (`iterations/launch-2026-11-20-ujai/plans/routes-final.md`):

| Sub-domain | Purpose |
| --- | --- |
| [channel-connection](src/domains/app/sub-domains/channel-connection/channel-connection.overview.md) | One provider login of an organization for one business (Meta Unified Login): the Meta adapter (`channel-connection-meta/` — the one Meta client, the login calls, the usage headers, the signature checks), the one-use login state, and Meta's usage kept per connection with its Redis copy (DM-sending iteration, ROUTE row R2; the tables and routes land in R3); Meta's PUBLIC deauthorize and data-deletion callbacks (routes 16–17, matched by account then business — ROUTE row R9). |
| [channel-account](src/domains/app/sub-domains/channel-account/channel-account.overview.md) | One connected inbox of an organization, whatever its channel (`app.channel_accounts`, `cha_`): its status, pause, suspend, plan stop and automation switch; routes 6–11; the capability list and the one feature check (CA11); the channel connection's account port (DM-sending iteration, ROUTE row R5). |
| [instagram-account](src/domains/app/sub-domains/instagram-account/instagram-account.overview.md) | The organization's one connected Instagram account and its encrypted token (connect, read, disconnect), the daily account check and the reconnect notice (two workers); nested `instagram-account-settings` (the automation switch and public reply safety, changed by route 3) and `instagram-media` (the post and story pickers, read live — routes 5–6 — and the stored posts `app.instagram_media`); Meta's callbacks' per-organization erase. |
| [contact](src/domains/app/sub-domains/contact/contact.overview.md) | The people who interacted with each channel account (routes 18–23: list per account, open, the team's note / tags / pause, the bulk action, the tag list with counts, erase), written only through the contact service; activity times in `contact_activities` (S5), tag counts in `contact_tag_counts` (S7); the erase anonymises in place and the erase and pause run the registered steps. |
| [automation](src/domains/app/sub-domains/automation/automation.overview.md) | Comment, DM and story-reply automations of each Instagram account (list, create, read, edit, delete — routes 11–15), "next post" linking for event processing, the 15-minute expiry worker and the daily deleted-automation purge; nested `automation-run` (runs, run events, comment logs and the run engine whose entry points event processing calls — no routes; the hourly 7-day wait cancel and the daily run and comment-log retention workers). |
| [broadcast](src/domains/app/sub-domains/broadcast/broadcast.overview.md) | Broadcasts shared by every channel, built one ROUTE row at a time: nested `broadcast-segment` (saved audiences of one account, `app.segments`, `seg_`; routes 77–82 — list, save, open, change, delete, the audience count; PRO through the `segments` switch — ROUTE row R21); the broadcast (R22) and its recipients (R23) to come. |
| [instagram-webhook](src/domains/app/sub-domains/instagram-webhook/instagram-webhook.overview.md) | Meta's Instagram webhook: the receiver at the folder root — the subscription check (route 60, verify token) and the delivery (route 61, `X-Hub-Signature-256` with the Meta app secret, at Meta's per-object path `/social/channel-connections/meta/webhooks/instagram`, each event saved once before the answer, save-only — ROUTE row R17) — and nested `instagram-webhook-event` — the day-split events and their key table, their list (route 62, masked payload) and the clean-up — and event processing (one account's events at a time, in order, through contacts and the run engine; the every-minute stuck-event pick-up). |
| [instagram-sending](src/domains/app/sub-domains/instagram-sending/instagram-sending.overview.md) | The paced sender (DM-sending iteration § 6). ROUTE row R18 built its folder root: four lanes per account and their stops (`app.instagram_send_lanes`, `app.instagram_send_stops`), gate 2's minute counts, the organization's month count in 16 slots (`app.message_month_counts`, shared) and an account's day counts, the tenantless global sending row (`app.sending_states`, maintenance scope `SENDING_STATE` — the environment id, the settings versions, Meta's app-level usage), routes 63–64 (sending status, DM meter), the sending settings file, and the lane steps of the connection, the channel account and route 12. Messages, attempts, queues and workers come with later rows. |

## Patterns used

This domain implements the contracts documented in [src/PATTERNS.md](src/PATTERNS.md):

- [`tenant-isolation`](src/PATTERNS.md#tenant-isolation) / [`rls-context`](src/PATTERNS.md#rls-context) —
  every `app` table is organization-scoped with forced row-level security, reached only inside a
  database context; lookups before the organization is known go through narrow SECURITY DEFINER
  resolvers, then the organization's `VERIFIED` scope (IA6).
- [`idempotency`](src/PATTERNS.md#idempotency) — signed-in writes that create (route 1, connect; route
  12, create an automation) require `X-Idempotency-Key`.
- [`audit-emission`](src/PATTERNS.md#audit-emission) — `app.<resource>.<verb>` audit actions
  (`app.channel_connection.connect`, `.disconnect`, `app.channel_account.connect`, `.disconnect`,
  `.pause`, `.resume`, `.activate`,
  `app.channel_connection.deauthorize`, `app.channel_connection.data_deletion` — anonymous actor,
  `metadata.source = 'meta'` — `app.instagram_account_settings.update`, `app.contact.delete`,
  `app.automation.create`, `app.automation.update`, `app.automation.delete`).

## Cross-domain flows

- [`instagram-account-connect-flow`](src/FLOWS.md#instagram-account-connect-flow) — connect an Instagram
  account across `app` (the account, its token and settings), `tenancy` (the permission gate and the
  team check), `audit`, and the Instagram client.
- [`instagram-account-health-flow`](src/FLOWS.md#instagram-account-health-flow) — the daily account
  check and the reconnect notice across `app` (the account, its token, the two workers), `tenancy`
  (the recipients, the organization's language), `notify` (the in-app notification and its email,
  through the mail outbox) and the Instagram client. The worker process builds this domain's
  container too (`createDomainContainers` → `appDomain`).
- [`instagram-meta-callback-flow`](src/FLOWS.md#instagram-meta-callback-flow) — Meta's deauthorize
  and data-deletion callbacks across `app` (the accounts, their connection's token, their stored posts, in
  every organization the account or business resolver names) and `audit` (an anonymous entry per organization changed).
- [`instagram-comment-automation-flow`](src/FLOWS.md#instagram-comment-automation-flow) — a comment
  runs its automation across the sub-domains (webhook event → contact → run engine → Instagram
  client), proven end to end by `__tests__/e2e/instagram-comment-flow.e2e.test.ts`; on a dead token
  it leads into the account health flow (`notify`). What goes wrong or changes under a run — an event
  that ends failed, a step turned off, an automation deleted — is proven by
  `__tests__/e2e/instagram-engine-recovery.e2e.test.ts`.
- [`instagram-next-post-flow`](src/FLOWS.md#instagram-next-post-flow) — a waiting "next post"
  automation links to the first post commented on in its window and answers that same comment, or
  expires: the automation service, event processing, the stored posts, the run engine and the
  15-minute expiry worker, proven end to end by `__tests__/e2e/instagram-next-post-flow.e2e.test.ts`.
- [`instagram-retention-erasure-flow`](src/FLOWS.md#instagram-retention-erasure-flow) — how the data
  leaves: this domain's clean-up timers, a contact delete reaching every copy, Meta's data deletion,
  and the organization purge (`tenancy`) that cascades every `app` row; proved end to end by
  `__tests__/e2e/instagram-retention-erasure.e2e.test.ts`.
- [`instagram-message-flow`](src/FLOWS.md#instagram-message-flow) — a DM, a story reply or a button
  click, from Meta's delivery to the run's last message: event processing, the contact, the run
  engine and the Instagram client, proven end to end by
  `__tests__/e2e/instagram-message-flow.e2e.test.ts`.

Cross-domain reads and writes go through the other domain's service, passed into `createAppContainer`
as parameters — never its repository or schema.
