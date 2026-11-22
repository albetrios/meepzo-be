# IG Automation API — final routes, sub-domain by sub-domain

**Route review final — 2026-11-21.** Every sub-domain is confirmed ([D24](decisions.md)–[D26](decisions.md), [D28](decisions.md)); the frontend may kick off on these routes.

Iteration `launch-2026-11-20-ujai` · started on branch `feat/instagram-automation` at `dfe8f0b` (2026-11-20) · built from
`intake-files/schema-routes.md`, `intake-files/PRD.md` and [decisions.md](decisions.md) D1–D23. Shape:
[routes-final-template.md](../../../docs/design-workflow/process/routes-final-template.md). This is a proposal: kickoff builds
it **ditto**, and where agent-os cannot, it stops and asks before anything differs.

How to read the tables: paths are under `/api/v1/app` (D1); `{x_id}` is a public id; **Gate** is the permission the caller
needs; **Idem** `req` = `X-Idempotency-Key` header required; `*` = required. Lists take `limit` and `after` (cursor).

## Sub-domains (in build order)

Each sub-domain builds on the ones above it.

| # | Sub-domain | Folder (`src/domains/app/sub-domains/…`) | Paths (`/app/…`) | Routes | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Instagram account | `instagram-account/` (+ `instagram-account-settings/`, `instagram-media/`, `instagram-account-meta-callback/`) | `social/instagram/connect`, `social/instagram/account` (+ `settings`), `social/instagram/media`, `social/instagram/stories`, `social/instagram/deauthorize`, `social/instagram/data-deletion` | 8 | organizations, users, tenancy roles | **final (rev 6, confirmed 2026-11-22)** |
| 2 | Contacts | `contact/` | `contacts` | 2 | 1 | **final (rev 3, confirmed 2026-11-22)** |
| 3 | Automations | `automation/` (+ `automation-run/`) | `automations` | 5 | 1, 2 | **final (rev 4, confirmed 2026-11-22)** |
| 4 | Instagram webhook | `instagram-webhook/` (+ `instagram-webhook-event/`) | `social/instagram/webhook`, `social/instagram/webhook-events` | 3 | 1, 2, 3 | **final (rev 6, confirmed 2026-11-22)** |

Domain total: **18 routes**, all new — the drop's 12 plus read account, change settings and disconnect (D5), Meta's
deauthorize and data-deletion callbacks (D22) and delete one contact (D22); none dropped. Folders carry the resource's name
instead of the drop's `social/instagram/` tree (IA1); the paths keep the drop's `social/instagram/` segments.

## Code layout and tables without routes

Every sub-domain is one folder, laid out like a domain; the domain's shared kernel stays at `src/domains/app/`
(`app.routes.ts`, `app.container.ts`, `app.permissions.ts` — IAC1). A table with no routes of its own is a persistence part of
its parent: schema and repository (and a service only when it holds logic) in the parent's folder, no controller, no routes
file; the parent's service writes it.

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `app.instagram_account_tokens` | `instagram-account/` (folder root) | the token service — connect, the daily renewal, disconnect, data deletion (IA5) |
| 1 | `app.instagram_media` | `instagram-account/instagram-media/` | the media service, called by event processing (4) and "next post" linking (3); routes 5–6 read Instagram live and never write it |
| 3 | `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs` | `automation/automation-run/` | the run engine, called by event processing (4) |

## Rules for every sub-domain

| # | Rule |
| --- | --- |
| K1 | **Base and organization scope.** Every signed-in route is under `/api/v1/app`, takes the active organization from the token (no organization segment) and is team-only: on a personal organization a write answers `422` (`assertTeamOrganization`) and a read answers `404 team_organization_required` — never 422 (`be-api-contract-guard`). Another organization's id → `404`, never `403`. Path ids `{<table singular>_id}` in `PARAM_NAME_TO_ENTITY`. |
| K2 | **Shape.** Success `200` (`DELETE` → `204`) with `{ data, meta }`; keyset lists through `finishKeysetPage`; snake_case body keys; unknown fields → `400`; errors `{ error: { type, code, reason?, detail, errors[] } }` with stable reasons and i18n keys. Exceptions, each named in its sub-domain: Meta's own answer shapes (route 8; routes 16–17 `text/plain`); a failed provider signature is `400` (`response-codes.md`). |
| K3 | **Idempotency.** Every signed-in `POST` requires `X-Idempotency-Key` (routes 1, 12). The PUBLIC Meta routes (7, 8, 16, 17) take none — Meta's own ids make them safe to repeat. |
| K4 | **Codes and roles.** Nine kebab-case codes, all landed by sub-domain 1 (IA2): `instagram-account:read` · `:manage`, `instagram-webhook-event:read`, `automation:read` · `:create` · `:update` · `:delete`, `contact:read` · `:delete`. Owner and Admin hold all nine; the new locked default **Member** role (D2, D3) holds `instagram-account:read`, `automation:read` · `:create` · `:update`, `contact:read` — and the existing `organization:read` (D31) — on every team organization, existing ones included. |
| K5 | **Row-level security.** Every table: `organization_id` → organizations `ON DELETE CASCADE`, RLS enabled and forced, an organization policy with `USING` and `WITH CHECK`. Lookups before the organization is known (webhook routing, "connected elsewhere", the Meta callbacks) go through narrow resolvers that return only an organization public id, then work in that organization's `VERIFIED` scope (IA6) — no other organization's row is read. |
| K6 | **Who did it.** `*_by_user_id` → users `ON DELETE SET NULL`; no membership pointers (table below). |
| K7 | **Personal data.** Contact email, phone, name, profile and message text are masked in logs and erased when the team deletes the contact (D22, sub-domain 2); the Instagram token is encrypted and read only on the Instagram client's path (IA5). |
| K8 | **Background work.** Pull-based, in the worker registry, one job per organization where it touches tenant data (`organizationPublicId` in the payload), safe to repeat, never sends a message twice (D16). |
| K9 | **Audit.** `<domain>.<resource>.<verb>` with the resource in snake_case, as the code writes it (`tenancy.organization_settings.update`): `app.instagram_account.connect`, `app.automation.create`, `app.contact.delete`, … |
| K10 | **Outside calls.** Instagram Graph API `v24.0` through one client, `src/infrastructure/social/instagram.client.ts`, on the existing outbound pattern (`src/infrastructure/outbound/`, its own circuit and timeout, nock contract tests) (IA4); never inside a database context; a 200–1000 ms random pause before each send. |

Who-did-it pointers:

| Sub-domain | Pointer | On delete | When the user is deleted |
| --- | --- | --- | --- |
| 1 | `instagram_accounts.connected_by_user_id`, `instagram_account_settings.updated_by_user_id` | `SET NULL` | the account and its settings stay; the pointer empties |
| 3 | `automations.created_by_user_id`, `automations.updated_by_user_id` | `SET NULL` | the automation stays; the pointer empties |
| 2, 4 | none | — | — |

## How the sub-domains call each other

Always through the owner's service, never its repository. Names as the owning sub-domain defines them.

| Caller | Owner | What it calls |
| --- | --- | --- |
| 4 | 1 | the live-account resolver (IA6); the account's status and settings for every event; `InstagramMediaService.upsertFromInstagram` (IA17); the guarded status change on a token error (IA9) |
| 3, 4 | 1 | the Instagram client for messages, replies and the follow check (IA4) |
| 3 | 1 | the media service for "next post" links; the organization's not-revoked account at create (AU27) |
| 4 | 2 | `recordContactInteraction` (per Instagram account, CT13; says whether it created the contact), `recordContactProfile` |
| 3 | 2 | `recordContactEmail`, `recordContactPhone`, `addContactTags`, `recordContactMessageSent`, `findLiveContact` |
| 2 | 3 | `ContactErasureStep` — 3 erases the comment-log copies in the contact delete's transaction (CT7, CT8); 4 registers none — the person's webhook events expire after 30 days (CQ1) |
| 4 | 3 | `linkNextPostAutomations`, `startCommentRun`, `handleDirectMessage`, `startStoryReplyRun`, `handleButtonClick` — each safe to run twice, called outside any database context with the scope, the event's Instagram account and the last-attempt flag |

## Connections

```text
1) WHO POINTS AT WHOM                         A ──► B = a column on A points at B

   tenancy.organizations ◄── every app table (K5)
   auth.users ◄───────────── connected_by, updated_by, created_by (K6)

   1 INSTAGRAM ACCOUNT ──< settings (1:1) · token (1:1) · stored posts
      ├──< 2 CONTACTS                    each contact's account (CT13)
      └──< 3 AUTOMATIONS                 each automation's account (AU27)
   3 AUTOMATIONS ──< automation runs ──< run events
                         ├──► 2 contacts
                         └──< comment logs ──► 2 contacts (AU24)
   4 INSTAGRAM WEBHOOK ──< webhook events        (no foreign key into 1–3; a post is named by its Instagram id)

2) THE GRAPH — each row points at the columns marked ●  (○ = writes there through its service)

                        Organizations  Users  1    2    3
   1  Instagram account ●              ●
   2  Contacts          ●                     ●
   3  Automations       ●              ●      ●○   ●○
   4  Instagram webhook ●                     ○    ○    ○

3) WHAT ONE ACTION SETS OFF (same transaction unless marked worker)

   17 event received ───► stored once, answered 200 → event processing                [worker]
                          → 2 contact first → 3 run engine → Instagram sends
   1 connect ───────────► webhook subscription (retried by the daily check) · audit
   4 / 7 disconnect ────► token erased · open runs left waiting (IQ1); the 7-day limit still ends them
   8 data deletion ─────► disconnect + token and profile erased (D22)
   10 contact delete ───► 3 comment-log copies erased · the person's webhook events expire in 30 days (CQ1)
   token error ─────────► reconnect notice, in-app + email                            [worker]
   daily ───────────────► renew tokens · refresh profiles · clean-ups                 [worker]
   every 15 minutes ────► "next post" windows that ended → expired                    [worker]
```

---

## 1. Instagram account — final (rev 6, confirmed 2026-11-22) — nested sub-domains 1.A–1.D

*rev 2 (2026-11-21, at R1's review, [D31](decisions.md)): the Member role also holds the existing `organization:read` (IA2, IAC2, K4).*
*rev 3 (2026-11-21, at R2's review, [D32](decisions.md), [D33](decisions.md)): a code-10 refusal for a message outside the 24-hour window fails only that send (IA4); `/me` is read flat or wrapped in `data` (IA12).*
*rev 4 (2026-11-21, at R3's review, [D35](decisions.md)–[D37](decisions.md)): the account object's `token_expires_at` is `access_expires_at` in the API (the column keeps its name); the connect audit is written after commit (IA12); the secrets-key rotation re-encrypts the Instagram token (IA5).*
*rev 5 (2026-11-22, at the acceptance-gap review, [D52](decisions.md)): a failed renewal keeps Instagram's class, code, subcode and HTTP status — never its text, which can quote the token (IA8, `last_refresh_error`).*

*rev 6 (2026-11-22, at the pre-merge review, [D53](decisions.md), [D54](decisions.md), [D56](decisions.md)): Meta's callbacks act only on a connection older than the request's `issued_at` (IA18–IA20) and parse a small form body in linear time; a team delete erases the account (token, profile, posts; `revoked`; unsubscribed) (IQ4, D5); connect answers `409 instagram_connect_restart_required` when the one-time code is spent (IA10–IA12); the app secret needs 32 characters when set (IA4); code 80002 is a throttle (IA4).*

Code: the **`instagram-account` sub-domain folder** — `app/sub-domains/instagram-account/` (the account and its token at
the folder root) with `instagram-account-settings/`, `instagram-media/` and `instagram-account-meta-callback/`.

1.1 Decisions (whole sub-domain) · 1.2 Open questions · 1.3 Tables and relations · 1.4 Permissions · 1.5 Common to every route ·
1.6 Objects returned · 1.7 Routes · 1.8 Request details · 1.9 Errors · 1.10 Rules worth knowing · 1.11 Code changes (whole sub-domain) ·
1.12 Nested sub-domains · then **1.A Instagram account · 1.B Instagram account settings · 1.C Instagram media · 1.D Meta callbacks**
— each with the same eleven sections.

The organization's one connected Instagram professional account: connect it, read it, change its automation switch and
public reply safety, disconnect it, pick posts and stories, and answer Meta's two callbacks. It also lands what the later
sub-domains need: the `app` domain, all nine new permission codes with the Member role, and the one Instagram client.
Design files: `schema-routes.md` §1–§4, §5.2–5.3, §6.1–6.3, §7, §8.1–8.6, §9; `decisions.md` D1–D5, D7–D10, D20–D23.
Route numbers run 1–8.

### 1.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation" — change any of them before you confirm. A decision that
belongs to one table is in its nested sub-domain.

| # | Decision |
| --- | --- |
| IA1 | **Folder and names**: the sub-domain folder `app/sub-domains/instagram-account/` holds the account at its root, with `app.instagram_account_tokens` as a persistence part of it (schema, repository, a token service — no controller, no routes). Three nested sub-domains: `instagram-account-settings/` (route 3, `app.instagram_account_settings`), `instagram-media/` (routes 5–6 read Instagram live; it owns `app.instagram_media`, which sub-domains 3 and 4 write through its service), `instagram-account-meta-callback/` (routes 7–8, PUBLIC, no table). Depth 3 under `domains/app/`. Public-id prefix `iga`; the account is one per organization, so its routes have no path id and nothing is added to `PARAM_NAME_TO_ENTITY`. Today: there is no `app` domain; the shape copies `tenancy/sub-domains/organization/` (singular `/tenancy/organization`, `organization-settings/` nested). `instagram-media/` is named after its table (fixed by D1). Other option: the drop's `social/instagram/` folder tree — not used, folders carry the resource's name (coverage › Findings 6); or `instagram-account-media/` by the strict prefix rule. |
| IA2 | **Nine codes, the Member role, and the teams that exist today (K4, D2–D4, D23)**: today `SYSTEM_PERMISSIONS` (`permission.reference.seed.ts`) holds 21 codes, a TEAM organization is provisioned with Owner and Admin, both locked (`organization-provisioning.ts`, `DEFAULT_TEAM_ROLES`), and no code path gives new codes to organizations that already exist. After: one new `APP_PERMISSIONS` (`src/domains/app/app.permissions.ts`) with every code of the iteration — `instagram-account:read` · `:manage`, `instagram-webhook-event:read`, `automation:read` · `:create` · `:update` · `:delete`, `contact:read` · `:delete` — in the catalog under three Roles-matrix rows (`instagram`, `automations`, `contacts`). Owner (TEAM only, like the notify codes) and Admin hold all nine; a new **Member** entry in `DEFAULT_TEAM_ROLES` (system, locked, tone sage) holds `instagram-account:read`, `automation:read`, `automation:create`, `automation:update`, `contact:read`, plus the existing `organization:read` so a member can load the organization (rev 2, D31). Existing team organizations get exactly the same through one idempotent reconcile that provisioning shares, so old and new never drift (IAC2, IQ5). Sub-domains 2–4 use these codes and add no catalog rows. Other option: each sub-domain adds its own codes — four catalog changes and four backfills instead of one. |
| IA3 | **Team-only: 422 on a write, 404 on a read (K1, F4)**: today every team-only route is a write and answers 422 through `assertTeamOrganization` (`organization-capability.ts`); the contract guard says a team-only read checks `isPersonalOrganization` and answers `404` with reason `team_organization_required` (`be-api-contract-guard` › Personal vs team; no route uses that reason yet); notify's webhook codes are granted to TEAM Owners only. After: all six signed-in routes read `team` in the catalog's O column. Writes 1, 3, 4 call `assertTeamOrganization({ capability: 'INSTAGRAM' })` → `422` (a new capability and key); reads 2, 5, 6 check `isPersonalOrganization` → `404 team_organization_required`. Both checks are the second line: a personal organization's Owner never holds the nine codes (IA2), so the permission gate answers `403 missing_permission` first — as `subscription:manage` is guarded twice today. Routes 7–8 carry no organization. Other option: grant the read codes to personal Owners too, so the 404 is what they see — they would hold codes for a surface they can never use. |
| IA4 | **One Instagram client (K10, D20)**: today every third-party call goes through `src/infrastructure/outbound/` (`outboundFetchJson`, one timeout and circuit per integration in `outbound-defaults.ts`, one `ExternalServiceError`), tested with nock in `src/tests/contract/` (the Google and GitHub OAuth providers, Stripe, Resend). After: `src/infrastructure/social/instagram.client.ts` is the only code that calls `api.instagram.com` / `graph.instagram.com`, Graph API version pinned in code (`v24.0`, like `STRIPE_API_VERSION`): the two code exchanges, renewal, `/me`, media, stories and `subscribed_apps` here; messages, replies and the follow check for sub-domains 3–4. A new integration `'instagram'` with its own `instagramCircuit` and a 10 s timeout; Instagram refusing one request (a bad code, a dead token) does not count against the circuit. Instagram's error body is read once (`instagram-error.util.ts`): **auth** (code 190 — subcode 463 → `expired`, any other → `error`; permission codes 10 and 200–299 → `error` — except code 10 with Meta's "outside the messaging window" subcodes (2534022, 2018278), which is **refused**: that send fails, the account stays `connected` (rev 3, D32)) · **throttled** (4, 17, 32, 613, HTTP 429 → 503 with `Retry-After`) · **refused** (other 4xx) · **outage** (timeout, network, 5xx). The token goes in the `Authorization` header wherever Instagram takes it; where Instagram needs it in the query (the two exchanges, renewal) the logged URL is redacted. Settings, full names: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (the one app secret, also for sub-domain 4's signature), `INSTAGRAM_REDIRECT_URI` (the frontend's `/auth/instagram/callback`); unset → `503 instagram_not_configured`, as the Stripe webhook does. The send pause (K10) lives with the sends (sub-domain 4). |
| IA5 | **Only the Instagram client reads the token (D21, K7)**: today secrets at rest are encrypted with `encryptFieldSecret` (`field-secret-encryption.util.ts`, the `SECRETS_ENCRYPTION_KEY` keyring) — notify's `encrypted_secret`, MFA seeds — and decrypted by whatever code uses them; nothing limits who may read one. After: (1) the token is stored only as `encrypted_access_token`; (2) the plain token exists only inside the Instagram client — its functions take the encrypted value, decrypt right before the call and return new tokens already encrypted, so services, repositories, jobs and logs only hold ciphertext; (3) only the token repository reads `app.instagram_account_tokens`, and only the token service and the daily check use it — pinned by a policy test, as `maintenance-context-confinement.policy.unit.test.ts` pins its files; (4) the table's policy has the organization arm only (no cross-organization arm), and the expiry the account object shows is copied onto `app.instagram_accounts.token_expires_at` in the same transaction, so the account read and the daily sweep never touch the token table (answers db-changes' "copy the expiry or let the session read one value"). Other option: a column grant that hides the column from the app role behind a SECURITY DEFINER reader — the database enforces it, but every send then needs a definer call; kickoff may add it on top. |
| IA6 | **Lookups before the organization is known (K5, D21)**: today the Stripe webhook finds its organization through narrow SECURITY DEFINER resolvers that return only an organization public id (`billing.resolve_organization_public_id_for_stripe_subscription`, `…_for_stripe_customer`), then works inside that organization's `PRINCIPAL_SCOPE.VERIFIED` scope. After: the same two steps. `app.resolve_organization_public_id_for_instagram_user(text)` — the organization whose **not-revoked** account has that `instagram_user_id` (connect's "connected elsewhere" check here; webhook routing in sub-domain 4). `app.resolve_organization_public_ids_for_instagram_app_user(text)` — every organization with a row of that app-scoped id, any status (the Meta callbacks, 1.D). Both pin `search_path`, `GRANT EXECUTE` to `meepzo_be_app`, `REVOKE … FROM PUBLIC`, and return public ids only; every write after them runs in that organization's own scope (`VERIFIED`, in the ledger). No other organization's row is read. A race between two organizations is still decided by the unique indexes (1.A.3). |
| IA7 | **Audit (K9)**: today controllers call `recordScopedAuditEvent` with `<domain>.<resource>.<verb>`, the resource in snake_case (`tenancy.membership_invitation.revoke`, `tenancy.organization_settings.update`, `organization.api_key.rotate`); pre-sign-in events pass `anonymousActor: true`. After: `app.instagram_account.connect` and `app.instagram_account.disconnect` (WARNING), `app.instagram_account_settings.update` (INFO, the changed field names), `app.instagram_account.deauthorize` and `app.instagram_account.data_deletion` (WARNING, `anonymousActor`, `metadata.source = 'meta'`, the confirmation code); resource type `instagram_account`. The brief's example `app.instagram-account.connect` becomes the code's snake_case. |
| IA8 | **The daily account check (D9)**: today crons are sweeps in `scheduler.ts`; a queue whose jobs call one provider pauses while it is down (`createProviderPausableWorker`). After: once a day (04:00 UTC, after the clean-ups) a sweep lists every `connected` account and hands one job per organization to a provider-pausable worker. The job, inside its organization: (1) renews the token when it ends within 7 days; (2) refreshes the profile (username, name, picture, counts, bio, website, `profile_synced_at`); (3) subscribes the account to the webhook fields again when `webhook_subscribed_at` is empty. **A failed renewal**: Instagram only down or busy and the token still valid → the account stays `connected`, `last_refresh_error` keeps the error, the next day tries again (seven tries before it ends); Instagram refuses the token → `error` (`expired` for subcode 463) at once; a token whose end has passed → `expired` without a call. Safe to repeat: one job per account per day, and a renewal never overwrites a newer token from a reconnect meanwhile. Other option: two crons, renewal and profile (the plan's WC-7, WC-10) — the same work, twice the calls; and for the subscription, retry only on the next connect (the drop) — an account that missed it gets no events at all, silently. |
| IA9 | **The reconnect notice (D10)**: today notifications are created in the API process only (`createAndDispatchNotification`, set up by `notify.container`; the invitation handlers find recipients with `findUserIdsWithPermission`); no worker creates one. After: an account leaves `connected` in one place only — the account service's guarded change `connected → expired \| error` (`WHERE connection_status = 'connected'`, stamps `connection_status_changed_at`), called by routes 5–6, the daily check, and sub-domains 3–4 on a token error. Only the call that wins enqueues, after commit, one reconnect-notice job (job id = the account and that time: one break, one notice). The job sends an in-app notification and an email, in the organization's language, to every active member holding `instagram-account:manage` (type `instagram.reconnect_required`, linking to the frontend's Instagram page). A reconnect sets `connected` again, so a later break is told again. Other option: an in-process event handled in notify — but most breaks happen in the worker process, which has no notification dispatch. |
| IA10 | **Error statuses under the repository's policy (§7, `response-codes.md`)**: today the policy keeps 409 and 422 for writes, files a bad provider signature as 400, and reads 409 as "may pass once the state changes", 422 as "the same request always fails". After: `instagram_code_invalid` and `instagram_account_not_professional` 409 → **422** (the same code never passes); a new `instagram_scopes_missing` **422** (a needed permission unticked on Instagram's consent screen); `instagram_reconnect_required` on the GET lists 409 → **404** with that reason (a GET is never a 409; the frontend branches on `reason`); `organization_already_has_instagram_account` and `instagram_account_connected_elsewhere` stay **409**; a bad Meta signed request → **400** `instagram_signed_request_invalid`, like the Stripe webhook. Every reason has an `errors:` key in `src/shared/locales/en/`. Other option: keep the drop's 409s as named exceptions — the policy and its OpenAPI builder change. |

### 1.2 Open questions

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| IQ1 | A disconnect (route 4, or Meta's routes 7–8): what happens to the account's open runs and live automations? | cancel open runs, automations stay `live` · leave runs waiting · also turn automations `inactive` | Cancel every `running` or `waiting` run, each with a status change in its history (as deleting an automation does); automations stay `live`, but nothing runs while no account is connected (events are skipped `account_disconnected`), so a reconnect resumes at once. The cancel lands with sub-domain 3 (built after this one): its service is called inside the disconnect's transaction. **Your call (2026-11-21): leave runs waiting** — a disconnect cancels nothing; automations stay `live`; nothing runs while no account is connected (a revoked account's events are not stored — WH4, D28); a waiting run continues when the same account reconnects, and the 7-day limit (D8) still cancels one that waits longer |
| IQ2 | Meta's data-deletion answer needs a status link and a confirmation code (F16). Keep a record table and a status route? | no table, no route — a frontend page shows the code · a small `app.instagram_data_deletion_requests` table + a PUBLIC status route (a 19th route) | No table, no route. The erase is a few writes inside route 8 (IA20), so it is done when Meta gets the code; the audit entry (IA7) is the record; the link opens a meepzo-fe page (`/instagram/data-deletion?code=…`) that says the data is deleted and shows the code. Take the table and route only if the erase ever moves to background work |
| IQ3 | Which id does Meta's signed request carry — the app-scoped `/me` `id` (`instagram_app_user_id`) or `user_id` (`instagram_user_id`)? | app-scoped id · Instagram user id | The app-scoped id — Meta documents the callbacks' `user_id` as the person's app-scoped id. Confirm with a test account before routes 7–8 ship and pin the contract fixture to it; the resolver (IA6) searches that column only |
| IQ4 | Does Meta's data deletion also erase the account's stored posts (`app.instagram_media`)? D22 names only the token and profile | erase them · keep them | Erase them: they are the owner's content from Meta and nothing needs them once the account is gone (automations keep only the post's id). Needs `instagram_account_id` on the table (IA17) |
| IQ5 | Backfill (D3): an existing team organization may already have a live custom role named "Member" (role names are unique per organization) | rename it "Member (custom)" · make it the locked Member (its codes reset) · skip that organization | Rename it "Member (custom)", keeping its people and codes, and add the locked Member beside it; the reconcile logs each rename |
| IQ6 | Connect takes only `code` — no OAuth `state` — so a crafted callback link could attach someone else's Instagram account to your organization | the frontend checks `state` · a backend route mints and checks it (reuse `oauth-state.ts`) · none | The frontend makes a random `state`, keeps it in session storage, sends it to Instagram and drops a callback whose `state` differs before it posts the code — no backend change, no new route. Other option keeps the check on the server but adds a route |

**Answered 2026-11-21** ([D24](decisions.md)): IQ1 your call — leave runs waiting; IQ2–IQ6 the recommendation (no deletion table or status route; the app-scoped id, checked with a test account before routes 7–8 ship; erase the stored posts; rename a clashing custom "Member"; the frontend checks `state`).

### 1.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.instagram_accounts` | the organization's connected Instagram professional account | one not-revoked per organization (D5) and one organization at a time per Instagram account; status by actions only (IA9, IA14); no soft delete — `revoked` stands in |
| `app.instagram_account_tokens` | its encrypted long-lived token | one per account; read only on the client path (IA5); erased on every disconnect (IA14) |
| `app.instagram_account_settings` | its automation switch and public reply safety | one per account; created with the defaults at the first connect, kept on a reconnect |
| `app.instagram_media` | a post or reel an automation ran on | one per organization and Instagram media id; written by sub-domains 3–4 through the media service (IA17) |

```text
tenancy.organizations
   │
   └──< app.instagram_accounts ──┬──< app.instagram_account_tokens   (1:1)   the token, ciphertext only (IA5)
                                 ├──< app.instagram_account_settings (1:1) ──> auth.users (updated by)
                                 ├──< app.instagram_media                    stored posts (IA17)
                                 └──> auth.users (connected by)

A ──< B   one A has many B     A ──> B   a column on A points at one B
```

Pointing at these from other sub-domains: `contacts.instagram_account_id` (2, CT13) and `automations.instagram_account_id`
(3, AU27) — composite, `ON DELETE RESTRICT` (an account is never deleted, only `revoked`); automations, runs and comment
logs name a post by its Instagram media id, without a foreign key (drop §8.8–8.12); sub-domain 4 finds the account through
the resolver (IA6). *(Cross-reference updated 2026-11-21 when sub-domains 2–3 were confirmed; no design change here.)*

**PostgreSQL design**

Standard columns on every table here (not repeated below): `id bigserial` primary key, `organization_id bigint NOT NULL` →
`tenancy.organizations` `ON DELETE CASCADE` (K5), `created_at` / `updated_at timestamptz NOT NULL DEFAULT now()` (the app
sets `updated_at`; the repository has no trigger) with `chk_<table>_updated`; `public_id varchar(28)` on the account only.
Schema `app`: a new `appSchema` in `pg-schemas.ts` and `CREATE SCHEMA app` with the same grants as the six schemas today.
Children link with a composite key `(organization_id, instagram_account_id)` → `instagram_accounts (organization_id, id)`
(B2-5, as `tenant-composite-foreign-keys`), named `<table>_<parent>_fk` as the code names them (`memberships_role_fk`; the
skill's `fk_<table>_<column>` differs — kickoff picks one). Value lists: `varchar(n)` + a lowercase `CHECK`, no enums;
Instagram ids `varchar(64)` with `CHECK (… ~ '^[0-9]{1,64}$')`. RLS on all four: enabled and forced, listed in
`EXPECTED_FORCE_RLS_TABLES`, one policy `<table>_tenant_isolation` `FOR ALL` — `USING` the organization arm (plus the
cross-organization sweep arm `maintenanceBypassArm('app.global_retention_cleanup')` on accounts, settings and media;
**not** on tokens, IA5), `WITH CHECK` the organization arm only. Branch rule: none (no branches in this product).
Membership pointers: none — only `*_by_user_id` → users `ON DELETE SET NULL` (K6). No partitioning: one live account per
organization, and media grows only by posts that got comments. Each table's design is in its nested sub-domain.

### 1.4 Permissions

All nine codes land here (IA2); this sub-domain's own routes use the first two.

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `instagram-account:read` | Instagram · View | see the connected account, its posts, reels and stories | 2, 5, 6 | Owner, Admin, Member |
| `instagram-account:manage` | Instagram · Manage | connect, change the settings, disconnect; receives the reconnect notice (D10) | 1, 3, 4 | Owner, Admin |
| `instagram-webhook-event:read` | Instagram · Webhook events | the received-events list (sub-domain 4) | 18 | Owner, Admin |
| `automation:read` | Automations · View | automations (sub-domain 3) | 11, 13 | Owner, Admin, Member |
| `automation:create` | Automations · Create | add an automation (3) | 12 | Owner, Admin, Member |
| `automation:update` | Automations · Edit | edit, turn on, turn off (3) | 14 | Owner, Admin, Member |
| `automation:delete` | Automations · Delete | delete an automation (3) | 15 | Owner, Admin |
| `contact:read` | Contacts · View | contacts (sub-domain 2) | 9 | Owner, Admin, Member |
| `contact:delete` | Contacts · Delete | delete one contact (2, D23) | 10 | Owner, Admin |

"Owner" is a TEAM organization's Owner (IA3). Routes 7–8 are PUBLIC (Meta's signed request, 1.D).

### 1.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (K1) |
| Auth | routes 1–6: `Authorization: Bearer <access token>`, the active organization from the token, no organization segment; routes 7–8: PUBLIC, Meta's `signed_request` proves the caller (IA18) |
| Organization | team-only (K1): on a personal organization writes 1, 3, 4 → `422`, reads 2, 5, 6 → `404 team_organization_required`; before either, `403 missing_permission`, since the codes are never held there (IA3) |
| Writes | route 1 needs `X-Idempotency-Key` (K3); route 3 takes an optional `expected_updated_at` (a stale save → `409 record_changed`); routes 7–8 take no key (K3) |
| Success | `200` with `{ data, meta }`; route 4 → `204`; route 8 answers Meta's own shape `{ url, confirmation_code }` (IA20) |
| Lists | routes 5–6 only, Instagram's cursor: `limit` 1–50 (default 25), `after`; `meta.pagination` = `{ per_page, next, has_more }`, no `estimated_total` (IA16) |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400 invalid_field` (unknown fields too), `401`, `403 missing_permission`, `404`, `409`, `422`, `429`, `503 instagram_unavailable` / `instagram_not_configured` (K2, IA10) |

### 1.6 Objects returned

| Object | Where |
| --- | --- |
| Instagram account · Instagram connect result | 1.A.6 — Instagram account |
| Instagram account settings | 1.B.6 — Instagram account settings |
| Instagram media item · Instagram story | 1.C.6 — Instagram media |
| Meta data-deletion answer | 1.D.6 — Meta callbacks |

### 1.7 Routes

Every route of the sub-domain in one table; each nested sub-domain repeats its own with the details.

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/social/instagram/connect` | Finish "Connect Instagram" | `instagram-account:manage` | req |
| 2 | GET | `/social/instagram/account` | The connected account **(new, D5)** | `instagram-account:read` | |
| 3 | PATCH | `/social/instagram/account/settings` | Change the switch and reply safety **(new, D5)** | `instagram-account:manage` | |
| 4 | DELETE | `/social/instagram/account` | Disconnect **(new, D5)** | `instagram-account:manage` | |
| 5 | GET | `/social/instagram/media` | Posts and reels, live from Instagram | `instagram-account:read` | |
| 6 | GET | `/social/instagram/stories` | Live stories, from Instagram | `instagram-account:read` | |
| 7 | POST | `/social/instagram/deauthorize` | Meta: the owner removed the app **(new, D22)** | PUBLIC (Meta signed request) | none (K3) |
| 8 | POST | `/social/instagram/data-deletion` | Meta: delete the owner's data **(new, D22)** | PUBLIC (Meta signed request) | none (K3) |

### 1.8 Request details

In each nested sub-domain (1.A to 1.D, section .8).

### 1.9 Errors

Every route can answer the errors in 1.5; each route's own errors are in its nested sub-domain (1.A to 1.D, section .9).

### 1.10 Rules worth knowing

- **What the later sub-domains take from here, never a copy**: the codes and the Member role (IA2), the Instagram client (IA4)
  and the token path (IA5). Sub-domain 4: the live-account resolver (IA6), the account's status and settings for every
  event, `InstagramMediaService.upsertFromInstagram` (IA17), and the guarded status change on a token error (IA9).
  Sub-domain 3: the media service for "next post" links. A disconnect cancels no runs (IQ1, your call).
- **No Instagram call inside a database context** (`rls-context-network-isolation.global.test.ts`): every route and job here
  reads, closes the unit of work, calls Instagram, then writes in a new one.
- **The status moves only these ways**: `connected` → `expired` | `error` (IA9, the one guarded change); `expired` | `error`
  → `connected` (connect); any → `revoked` (routes 4, 7, 8); `revoked` → `connected` only by connecting the same Instagram
  account in the same organization again (IA11).
- **Frontend pieces (meepzo-fe, sibling work)**: `/auth/instagram/callback` posts the code and checks `state` (IQ6); the
  Instagram page reads route 2 and shows a reconnect card for `expired` / `error`; the data-deletion status page (IQ2).
- **Logs**: the token, the app secret and the code are never logged; URLs that carry them are redacted (IA4). The account's
  profile is the organization's business data; K7's masking covers contacts (sub-domains 2–4).

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| IAC1 | IA1: the `app` domain — `src/domains/app/` (`app.routes.ts` under `/api/v1/app`, `app.container.ts`, `app.permissions.ts`, `app.overview.md`, `seed/index.ts` as a `DomainSeedModule` depending on tenancy), registered in `src/routes.ts`, `domain-containers.plugin.ts` and `SEED_MODULES`; `appSchema` in `pg-schemas.ts`; one migration `migrations/<timestamp>_app_instagram_account.sql` (`CREATE SCHEMA app` and its grants, the four tables, keys, indexes, checks, RLS enable + force + policies, the two resolvers); `EXPECTED_FORCE_RLS_TABLES` + 4; `PUBLIC_ID_PREFIXES.instagramAccount = 'iga'`; the `app` row in `src/domains/CLAUDE.md`'s domain map; OpenAPI tag `Instagram account` |
| IAC2 | IA2, IQ5: `APP_PERMISSIONS` (nine codes) and nine `SYSTEM_PERMISSIONS` rows (categories `instagram`, `automations`, `contacts`); `ownerPermissionCodesForOrganizationType('TEAM')` and `ADMIN_PERMISSION_CODES` take all nine; `MEMBER_ROLE_NAME` in `member-role.constants.ts` and the Member entry in `DEFAULT_TEAM_ROLES` (locked, the five app codes + `organization:read`, D31); `reconcileDefaultTeamRoles` beside `provisionOrganization` — for each TEAM organization, inside its own scope: add a missing default role (renaming a clashing custom "Member", IQ5), grant missing codes to Owner and the default roles (`ON CONFLICT DO NOTHING`), invalidate its permission cache — run by `prepareDatabase` right after `seedPermissions`, so every deploy and test database gets it (how it lists the organizations — a narrow lister or the seed's operator login — is kickoff's); `owner-permission-codes.unit.test.ts`, `team-organization-provisioning.db.unit.test.ts` and a reconcile test (twice = once); the tenancy bulk seed's role grants |
| IAC3 | IA3: `OrganizationCapability` `'INSTAGRAM'` with `errors:personalOrganizationNoInstagram` (writes); the reads' `isPersonalOrganization` check with reason `team_organization_required` (its first use — the slug and its key registered in `response-codes.md`); routes 1–6 read `team` in `docs/routes.txt` and `route-organization-scope.json` (`pnpm validate:route-organization-scope`) |
| IAC4 | IA4: `src/infrastructure/social/` (`instagram.client.ts`, `instagram-error.util.ts`, `meta-signature.util.ts` shared with sub-domain 4, `social.overview.md`); `'instagram'` in `OutboundIntegrationName` and `OUTBOUND_DEFAULT_FACTORIES`, `instagramCircuit` in `circuit-breaker.ts`, the `'instagram'` provider for `createProviderPausableWorker`; settings `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` (env schema, `.env.example`, fake values in `harness-provider-env.ts`, the external-credentials fill, GitHub Environments — be-env-schema-add); `src/tests/contract/instagram.contract.test.ts` + `fixtures/instagram/` (both exchanges, renewal, `/me`, media, stories, `subscribed_apps`, a 190/463 body, a throttled body); query-string redaction covers `access_token` and `client_secret` |
| IAC5 | IA5: `instagram-account-token.schema.ts` / `.repository.ts` / `.service.ts` at the folder root (no controller, no routes); `instagram-account-token-isolation.policy.unit.test.ts` (only the listed files import the token schema or repository; only the client calls `decryptFieldSecret` on it); `encrypted_access_token` in the response-secret and log-redaction field lists |
| IAC6 | IA6: the two resolvers in the migration (`SET search_path`, grant, `REVOKE … FROM PUBLIC`); the `PRINCIPAL_SCOPE.VERIFIED` ledger entries (`verified-scope-usage.policy.unit.test.ts`); `src/tests/security/rls/instagram-account-resolvers.security.test.ts` run as `meepzo_be_app` (a plain read sees no other organization; each resolver returns only a public id) |
| IAC7 | IA7, IA10: the five audit actions (`recordScopedAuditEvent`; `anonymousActor` on routes 7–8); every reason's key in `src/shared/locales/en/errors.json` and the other locales; the new reasons in `docs/reference/api/response-codes.md`'s reason list |
| IAC8 | IA8: `instagram-account/queues/instagram-account-daily-check.queue.ts` + `.job.schema.ts` (`organizationPublicId`, `instagramAccountPublicId`), `workers/instagram-account-daily-check.worker.ts` + `.processor.ts` (provider-pausable; the sweep as a second job name on the same queue, under `runGlobalRetentionWorkerJob`); `worker-registration.registry.ts`, `WORKER_QUEUE_NAMES`, a `scheduler.ts` entry (daily, 04:00 UTC); tests: due / not due, a failed renewal stays `connected`, a refused token → `error`, an ended token → `expired`, a reconnect's newer token is kept, twice = once |
| IAC9 | IA9: the guarded `markConnectionBroken` in the account service; an `instagram-reconnect-notice` queue + worker (job id per account and break); `instagram.reconnect_required` in `NOTIFICATION_TYPES`; a membership-service read over `findUserIdsWithPermission` (cross-domain through the service); a notification path the worker process can use (today only `notify.container` sets up `createAndDispatchNotification` — kickoff picks the seam); title, message and email copy keys; tests: one notice per break, a new break after a reconnect is told again |
| IAC10 | Seeds and docs: reference — the nine codes and the Member role (IAC2); bulk — each demo team organization gets a connected account with a fake encrypted token, default settings and a few stored posts (`instagram-account/seed/`); `pnpm routes:catalog`, `route-success-statuses.json`, `pnpm docs:generate`; `instagram-account.overview.md` and one per nested folder; `src/FLOWS.md` (connect, reconnect notice); the Instagram app settings in `docs/integrations/` |

### 1.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/instagram-account/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 1.A Instagram account | folder root | `app.instagram_accounts`, `app.instagram_account_tokens` | 1, 2, 4 | final |
| 1.B Instagram account settings | `instagram-account-settings/` | `app.instagram_account_settings` | 3 | final |
| 1.C Instagram media | `instagram-media/` | `app.instagram_media` | 5, 6 | final |
| 1.D Meta callbacks | `instagram-account-meta-callback/` | — | 7, 8 | final |

---

### 1.A Instagram account — `instagram-account/` (folder root) — final

#### 1.A.1 Decisions

| # | Decision |
| --- | --- |
| IA11 | **Fields and status**: today nothing; the drop keeps one account per organization for every status, so an organization can never switch accounts (coverage › Inside schema-routes 7). After: one row per organization and Instagram account — connecting the same account again reuses its row, revoked included, so its settings come back; at most one **not-revoked** row per organization (D5) and one per Instagram account across all organizations. `connection_status` `connected` · `expired` · `error` · `revoked`. New columns against the drop: `token_expires_at` (IA5), `connection_status_changed_at` (IA9), `webhook_subscribed_at` (IA8, IA12), `disconnected_at` (set exactly while `revoked`), `profile_erased_at` (IA20); `username` may be empty only on a revoked, erased row. Revoked rows stay until the organization is deleted (D8). Other option: delete the row on disconnect — a reconnect then loses its settings. |
| IA12 | **Connect (route 1, §6.1)**: today the OAuth sign-in (`auth-method/oauth/`) exchanges a code through `outboundFetchJson` and maps a refusal with `toOAuthProviderFailure`; it signs a user in, so only its outbound pattern is reused. After — Instagram first, then one transaction, then the subscription: (1) strip a trailing `#_`; exchange the code (`api.instagram.com/oauth/access_token`, redirect address `INSTAGRAM_REDIRECT_URI`) for a short-lived token and its granted permissions, then for a long-lived one (`ig_exchange_token`, about 60 days → `expires_at`); read `/me` (`user_id`, `id`, `username`, `name`, `account_type`, `profile_picture_url`, the three counts, `biography`, `website`; the answer read flat or wrapped in `data[0]` — D33). (2) Refuse a personal account (`account_type` not `BUSINESS` / `MEDIA_CREATOR`) and missing permissions (`instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`). (3) Ask the resolver (IA6) who holds this `instagram_user_id` — another organization → `409 instagram_account_connected_elsewhere`; this organization has another live account → `409 organization_already_has_instagram_account`. (4) One transaction in the caller's scope: insert or update the account (profile, scopes, `connected`, `connected_at`, `connected_by_user_id`, `token_expires_at`; clears `disconnected_at`, `profile_erased_at`), insert the default settings when the account has none, write the encrypted token, write the audit entry after commit, as every other route does (rev 4, D36); `is_new_connection` is `false` when the organization had this account before (any status); a unique-index race → the matching 409. (5) After commit, when `webhook_subscribed_at` is empty: `POST /{instagram_app_user_id}/subscribed_apps` (`comments,messages,messaging_postbacks`); success sets `webhook_subscribed_at`; a failure is logged (`app.instagram_account.webhook_subscription_failed`) and never fails the connect — the next connect or the daily check (IA8) retries it. Nothing is stored when steps 1–3 fail; a repeated key replays the first answer. |
| IA13 | **Read the account (route 2, D5)**: today nothing reads it (F6). After: the organization's not-revoked account with its settings — `expired` and `error` included, so a reload shows the reconnect card; none, or only revoked rows → `404 instagram_not_connected`. Database only, never Instagram; the token is never returned; a new `is_webhook_subscribed` lets the page warn that no events arrive. |
| IA14 | **Disconnect (route 4, D5)**: today nothing sets `revoked` (F7). After: first a best-effort `DELETE /{instagram_app_user_id}/subscribed_apps` (logged on failure, never blocks), then one transaction: `revoked`, `disconnected_at`, the token row deleted, `token_expires_at` and `webhook_subscribed_at` emptied; settings and profile kept; the organization is free for another account; later events of the revoked account are not stored (sub-domain 4, WH4, D28). Open runs and live automations (IQ1, your call): nothing is cancelled; automations stay `live`; a waiting run continues if the same account reconnects, else the 7-day limit (D8) cancels it. The token is erased on **every** disconnect, not only on Meta's data deletion (answers db-changes' open: a revoked account has no use for it, a reconnect brings a new one). Other option: keep the token until the organization goes — a live secret nobody uses. |

#### 1.A.2 Open questions

None — IQ1 (leave runs waiting) and IQ6 (the frontend checks `state`) are answered (1.2).

#### 1.A.3 Tables and relations

`app.instagram_accounts`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `instagram_user_id` | `varchar(64)` | no | | `/me` `user_id` — equals the webhook `entry.id`; digits |
| `instagram_app_user_id` | `varchar(64)` | no | | `/me` `id` — app-scoped; send URLs and the Meta callbacks (IQ3); digits |
| `username` | `varchar(64)` | yes | | required unless `revoked` (erased by IA20) |
| `name` | `varchar(255)` | yes | | |
| `biography` | `text` | yes | | |
| `website` | `text` | yes | | the drop's `varchar(500)` → `text`: Instagram's link, not ours to bound |
| `profile_picture_url` | `text` | yes | | signed CDN address, refreshed daily (IA8) |
| `followers_count`, `follows_count`, `media_count` | `integer` | no | `0` | `≥ 0` |
| `scopes` | `text[]` | no | `'{}'` | the granted permissions; `cardinality(scopes) <= 20` |
| `connection_status` | `varchar(20)` | no | `'connected'` | `connected` · `expired` · `error` · `revoked` |
| `connection_status_changed_at` | `timestamptz` | no | `now()` | set at every status change (IA9) |
| `token_expires_at` | `timestamptz` | yes | | copy of the token's `expires_at`, same transaction (IA5); empty once revoked |
| `webhook_subscribed_at` | `timestamptz` | yes | | set when `subscribed_apps` succeeded (IA12); empty once revoked |
| `connected_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL` (K6); the latest connect |
| `connected_at` | `timestamptz` | no | `now()` | the latest connect |
| `disconnected_at` | `timestamptz` | yes | | `(connection_status = 'revoked') = (disconnected_at IS NOT NULL)` |
| `profile_synced_at` | `timestamptz` | yes | | connect and the daily check |
| `profile_erased_at` | `timestamptz` | yes | | Meta's data deletion (IA20); only on a revoked row |

Indexes: unique `idx_instagram_accounts_public_id`; unique `idx_instagram_accounts_organization_id_id` `(organization_id, id)` —
the children's composite key; unique `idx_instagram_accounts_organization_instagram_user` `(organization_id, instagram_user_id)` —
one row per account per organization (IA11); unique `idx_instagram_accounts_organization_live` `(organization_id) WHERE
connection_status <> 'revoked'` (D5); unique `idx_instagram_accounts_instagram_user_live` `(instagram_user_id) WHERE
connection_status <> 'revoked'`; `idx_instagram_accounts_instagram_app_user_id` `(instagram_app_user_id)` — the Meta resolver,
any status; `idx_instagram_accounts_connected_by_user_id` `WHERE connected_by_user_id IS NOT NULL`. The daily sweep pages the
`connected` rows by `id` (one live row per organization — no extra index). Checks: `chk_instagram_accounts_connection_status`,
`chk_instagram_accounts_instagram_user_id`, `chk_instagram_accounts_instagram_app_user_id`, `chk_instagram_accounts_counts`,
`chk_instagram_accounts_scopes`, `chk_instagram_accounts_username_unless_revoked`, `chk_instagram_accounts_disconnected`,
`chk_instagram_accounts_profile_erased` (`profile_erased_at IS NULL OR connection_status = 'revoked'`),
`chk_instagram_accounts_updated`. RLS: organization policy (+ the sweep arm in `USING`), enabled and forced; the two resolvers
(IA6). Branch: none.

`app.instagram_account_tokens` (no public id; a persistence part of the account — no routes)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `instagram_account_id` | `bigint` | no | | composite → accounts `ON DELETE CASCADE`; one per account |
| `encrypted_access_token` | `text` | no | | `encryptFieldSecret` output, `length > 0`; the drop's `access_token_ciphertext` renamed to the repository's `encrypted_*` |
| `token_type` | `varchar(20)` | no | `'long_lived'` | `long_lived` |
| `expires_at` | `timestamptz` | yes | | about 60 days after issue or renewal |
| `last_refreshed_at` | `timestamptz` | yes | | |
| `last_refresh_error` | `varchar(500)` | yes | | Instagram's class, code, subcode and HTTP status — never its text (rev 5, D52: the text can quote the token) |

Indexes: unique `idx_instagram_account_tokens_organization_account` `(organization_id, instagram_account_id)` — one per account,
and the composite key's index; the drop's `expires_at` index is dropped (the sweep reads the account's copy, IA5). Checks:
`chk_instagram_account_tokens_token_type`, `chk_instagram_account_tokens_encrypted_access_token_not_empty`,
`chk_instagram_account_tokens_updated`. RLS: the organization arm in `USING` and `WITH CHECK`, **no** bypass arm (IA5); enabled
and forced. Branch: none.

#### 1.A.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-account:manage` | 1, 4 |
| `instagram-account:read` | 2 |

#### 1.A.5 Common to every route

As 1.5.

#### 1.A.6 Objects returned

**Instagram account**: `id` (`iga_…`), `instagram_user_id`, `username`, `name`, `biography`, `website`, `profile_picture_url`,
`profile_url` (`https://instagram.com/{username}`), `followers_count`, `follows_count`, `media_count`, `scopes`,
`connection_status` (`connected` · `expired` · `error` — a revoked account is never returned), `access_expires_at` (the column `token_expires_at`; renamed in the API, rev 4, D35),
`is_webhook_subscribed` **(new)**, `settings` (Instagram account settings, 1.B.6), `connected_by_user_id` (`usr_…` or null),
`connected_at`, `profile_synced_at`, `updated_at`. Never the token.

**Instagram connect result** (route 1): `is_new_connection` (`false` = this organization had the account before),
`instagram_account`.

#### 1.A.7 Routes (1, 2, 4)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/social/instagram/connect` | Finish "Connect Instagram" | `instagram-account:manage` | req |
| 2 | GET | `/social/instagram/account` | The connected account **(new, D5)** | `instagram-account:read` | |
| 4 | DELETE | `/social/instagram/account` | Disconnect **(new, D5)** | `instagram-account:manage` | |

#### 1.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 1 | — | `code*` (1–2000 characters; a trailing `#_` is stripped) | Instagram connect result |
| 2 | — | — | Instagram account |
| 4 | — | — | 204 |

#### 1.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 1 | `400` · `code` | missing, empty, over 2000 characters, or an unknown field |
| 1, 4 | `403` · `missing_permission` | no `instagram-account:manage` |
| 2 | `403` · `missing_permission` | no `instagram-account:read` (a personal organization never holds it) |
| 1, 4 | `422` | a personal organization (IA3) |
| 2 | `404` · `team_organization_required` | a personal organization (IA3) |
| 1 | `422` · `instagram_code_invalid` | Instagram refuses the code: expired, used, or another redirect address |
| 1 | `422` · `instagram_account_not_professional` | a personal Instagram account |
| 1 | `422` · `instagram_scopes_missing` | a needed permission was not granted on Instagram's consent screen |
| 1 | `409` · `organization_already_has_instagram_account` | the organization has another account that is not revoked |
| 1 | `409` · `instagram_account_connected_elsewhere` | this Instagram account is live in another organization |
| 1 | `422` / `409` | the idempotency key is missing, malformed or reused / the same key is still running (K3) |
| 2, 4 | `404` · `instagram_not_connected` | no account that is not revoked |
| 1 | `503` · `instagram_unavailable` / `instagram_not_configured` | Instagram down, failing or throttling (`Retry-After`) / the Instagram app settings are not set |

#### 1.A.10 Rules worth knowing

None beyond 1.10.

#### 1.A.11 Code changes

| # | Change |
| --- | --- |
| IAC11 | IA11: `instagram-account.schema.ts` and the token schema (columns, keys, the unique indexes, checks, policies as 1.A.3); repository methods — the live account by organization, upsert by `(organization_id, instagram_user_id)`, the guarded status change (IA9), revoke, erase the profile (IA20) |
| IAC12 | IA12–IA14: routes 1, 2, 4 (`instagram-account.routes.ts` with route schemas; `config: { idempotencyRequired: true }` on 1), controller, service (the connect steps, disconnect), DTO (`code` 1–2000, strict), validator, serializer (`profile_url`, `is_webhook_subscribed`, `usr_` for `connected_by_user_id`); integration tests for each success and each error in 1.A.9, the four connect outcomes, two organizations racing for one account, the `test:rls-role` lane |

---

### 1.B Instagram account settings — `instagram-account/instagram-account-settings/` — final

#### 1.B.1 Decisions

| # | Decision |
| --- | --- |
| IA15 | **Settings (route 3, §5.2, §8.4)**: today only connect would write them, with the defaults (F5). After: `PATCH` any of the six fields, at least one — `is_automation_enabled` (the master switch, on by default), `is_public_reply_safety_enabled` (off), `public_reply_chance_percent` 0–100 (80), `public_reply_hour_limit` 1–1000 (60), `public_reply_gap_min_seconds` 5–3600 (20), `public_reply_gap_max_seconds` 5–3600 (60); whole numbers only; min ≤ max is checked on the merged result (`400` on `public_reply_gap_max_seconds`) and again by a `CHECK`. Optional `expected_updated_at` — the roles and memberships pattern (`expectedUpdatedAtSchema`, `assertRecordNotChangedSince` → `409 record_changed`). Sets `updated_by_user_id` (K6). Works on an `expired` or `error` account, so the switch can be turned off while reconnecting; no live account → `404 instagram_not_connected`. Answers the settings object. Event processing (sub-domain 4) reads them on every event through this service; no cache at launch. |

#### 1.B.2 Open questions

None.

#### 1.B.3 Tables and relations

`app.instagram_account_settings` (no public id)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `instagram_account_id` | `bigint` | no | | composite → accounts `ON DELETE CASCADE`; one per account |
| `is_automation_enabled` | `boolean` | no | `true` | the master switch |
| `is_public_reply_safety_enabled` | `boolean` | no | `false` | |
| `public_reply_chance_percent` | `smallint` | no | `80` | 0–100 |
| `public_reply_hour_limit` | `smallint` | no | `60` | 1–1000 |
| `public_reply_gap_min_seconds` | `smallint` | no | `20` | 5–3600 |
| `public_reply_gap_max_seconds` | `smallint` | no | `60` | 5–3600, `≥ public_reply_gap_min_seconds` |
| `updated_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL` (K6) |

Indexes: unique `idx_instagram_account_settings_organization_account` `(organization_id, instagram_account_id)` — one per account,
and the composite key's index; `idx_instagram_account_settings_updated_by_user_id` `WHERE updated_by_user_id IS NOT NULL`.
Checks (the drop's names): `chk_instagram_account_settings_chance`, `chk_instagram_account_settings_hour_limit`,
`chk_instagram_account_settings_gap_min`, `chk_instagram_account_settings_gap_max`, `chk_instagram_account_settings_gap_order`,
`chk_instagram_account_settings_updated`. RLS: organization policy, enabled and forced. Branch: none.

#### 1.B.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-account:manage` | 3 |

#### 1.B.5 Common to every route

As 1.5.

#### 1.B.6 Objects returned

**Instagram account settings**: `is_automation_enabled`, `is_public_reply_safety_enabled`, `public_reply_chance_percent`,
`public_reply_hour_limit`, `public_reply_gap_min_seconds`, `public_reply_gap_max_seconds`, `updated_by_user_id` (`usr_…` or
null, **new**), `updated_at`.

#### 1.B.7 Routes (3)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 3 | PATCH | `/social/instagram/account/settings` | Change the switch and reply safety **(new, D5)** | `instagram-account:manage` | |

#### 1.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 3 | — | at least one of `is_automation_enabled`, `is_public_reply_safety_enabled`, `public_reply_chance_percent`, `public_reply_hour_limit`, `public_reply_gap_min_seconds`, `public_reply_gap_max_seconds`; optional `expected_updated_at` | Instagram account settings |

#### 1.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 3 | `400` · the field's name | out of range, not a whole number, an empty body, an unknown field, or max below min on the merged result |
| 3 | `403` · `missing_permission` | no `instagram-account:manage` |
| 3 | `404` · `instagram_not_connected` | no account that is not revoked |
| 3 | `409` · `record_changed` | `expected_updated_at` is older than the saved settings |
| 3 | `422` | a personal organization (IA3) |

#### 1.B.10 Rules worth knowing

- The settings row is created by the connect transaction (IA12) through this sub-domain's service, never by the account's
  repository.

#### 1.B.11 Code changes

| # | Change |
| --- | --- |
| IAC13 | IA15: `instagram-account-settings/` — schema, repository, service (create the defaults, read for sub-domain 4, update), controller, routes with schema, DTO (six optional fields + `expected_updated_at`, at least one, strict), validator (the merged min ≤ max), serializer; integration tests for each error in 1.B.9 and the audit entry |

---

### 1.C Instagram media — `instagram-account/instagram-media/` — final

#### 1.C.1 Decisions

| # | Decision |
| --- | --- |
| IA16 | **The post and story pickers (routes 5–6, §6.2–6.3)**: today nothing; the drop reads Instagram live and stores nothing. After: the service reads the live account and its token ciphertext in one short unit of work, closes it, calls Instagram (`/{instagram_app_user_id}/media` with the drop's fields; `/{instagram_app_user_id}/stories`) and maps the answer — upper-case types to lowercase (`IMAGE` → `image`, `REELS` → `reels`), `timestamp` → `published_at`, `children.data` → `children`, a story's `expires_at` = `published_at` + 24 h. Paging is Instagram's own cursor: `limit` 1–50 (default 25) is passed on; `after` is passed back as Instagram's `after`; `next` = Instagram's `paging.cursors.after` only when Instagram has a next page; `has_more` follows it; no `estimated_total` (Instagram gives none). An account that is not `connected` → `404 instagram_reconnect_required` without a call; Instagram refusing the token → the guarded status change (IA9) in a new unit of work, then the same 404; Instagram down or throttling → `503 instagram_unavailable` with `Retry-After`. No cache at launch. Other option: a 60-second read cache per organization and cursor (be-read-cache-guard), if paging meets Instagram's hourly call limit. |
| IA17 | **Stored posts (`app.instagram_media`, §8.6)**: today nothing; the drop stores a post when a comment arrives on one not stored yet and when a "next post" automation links one, keyed by organization only. After: the table belongs to the account — a new `instagram_account_id` (composite key, `ON DELETE CASCADE`), so Meta's data deletion can erase that account's posts (IQ4) and a second account's posts never mix with the first's; `owner_username` is dropped (it is the account's own username — one less copy to erase). Written only through `InstagramMediaService.upsertFromInstagram` (sub-domain 4's event processing, sub-domain 3's "next post" link), never by their repositories. Kept until the organization is deleted (D8) or Meta's data deletion (IA20). Automations, runs and comment logs keep naming a post by its Instagram media id, without a key (db-changes' open: keep — they outlive an erased post). Other option: the drop's organization-only table. |

#### 1.C.2 Open questions

IQ4 (1.2) — erase stored posts on Meta's data deletion.

#### 1.C.3 Tables and relations

`app.instagram_media` (no public id — addressed by its Instagram media id; a persistence part with no routes of its own:
routes 5–6 read Instagram, not this table)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `instagram_account_id` | `bigint` | no | | composite → accounts `ON DELETE CASCADE` **(new, IA17)** |
| `instagram_media_id` | `varchar(64)` | no | | digits |
| `shortcode` | `varchar(64)` | yes | | |
| `media_type` | `varchar(20)` | yes | | `image` · `video` · `carousel_album` |
| `media_product_type` | `varchar(20)` | yes | | `feed` · `reels` · `story` · `ad` |
| `caption` | `text` | yes | | |
| `media_url`, `thumbnail_url`, `permalink` | `text` | yes | | |
| `published_at` | `timestamptz` | no | | |
| `comments_count`, `like_count` | `integer` | no | `0` | `≥ 0` |
| `is_comment_enabled` | `boolean` | no | `true` | |
| `graph_data` | `jsonb` | no | `'{}'` | an object (`jsonb_typeof(graph_data) = 'object'`) — the Instagram object as read |
| `synced_at` | `timestamptz` | no | `now()` | |

`owner_username` dropped (IA17). Indexes: unique `idx_instagram_media_organization_media` `(organization_id, instagram_media_id)`
(the drop's); `idx_instagram_media_organization_account_published` `(organization_id, instagram_account_id, published_at DESC)` —
the composite key's index and the account's posts by date; the drop's `(organization_id, published_at DESC)` is dropped (no list
reads it — sub-domain 3 adds one back if "next post" needs a by-date read). Checks: `chk_instagram_media_instagram_media_id`,
`chk_instagram_media_media_type`, `chk_instagram_media_media_product_type`, `chk_instagram_media_counts`,
`chk_instagram_media_graph_data_object`, `chk_instagram_media_updated`. RLS: organization policy, enabled and forced. Branch: none.

#### 1.C.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-account:read` | 5, 6 |

#### 1.C.5 Common to every route

As 1.5.

#### 1.C.6 Objects returned

**Instagram media item** (route 5): `instagram_media_id`, `caption`, `media_type` (`image` · `video` · `carousel_album`),
`media_product_type` (`feed` · `reels` · `story` · `ad` or null), `media_url`, `thumbnail_url`, `permalink`, `published_at`,
`comments_count`, `like_count`, `children` (`[{ instagram_media_id, media_type, media_url }]` or null).

**Instagram story** (route 6): `instagram_story_id`, `media_type` (`image` · `video`), `media_url`, `thumbnail_url`, `permalink`,
`published_at`, `expires_at`.

#### 1.C.7 Routes (5–6)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 5 | GET | `/social/instagram/media` | Posts and reels, live from Instagram | `instagram-account:read` | |
| 6 | GET | `/social/instagram/stories` | Live stories, from Instagram | `instagram-account:read` | |

#### 1.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 5 | `limit` (1–50, default 25), `after` (Instagram's cursor, 1–1000 characters) | — | Instagram media item[] |
| 6 | as 5 | — | Instagram story[] |

#### 1.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 5, 6 | `400` · `limit` / `after` | `limit` outside 1–50; `after` empty or over 1000 characters; an unknown query field |
| 5, 6 | `403` · `missing_permission` | no `instagram-account:read` (a personal organization never holds it) |
| 5, 6 | `404` · `team_organization_required` | a personal organization (IA3) |
| 5, 6 | `404` · `instagram_not_connected` | no account, or only revoked ones |
| 5, 6 | `404` · `instagram_reconnect_required` | the account is `expired` or `error`, or Instagram just refused its token (the status is set, IA9) |
| 5, 6 | `503` · `instagram_unavailable` | Instagram down, failing or throttling (`Retry-After`) |

#### 1.C.10 Rules worth knowing

- Routes 5–6 never write `app.instagram_media`; only the media service does, for sub-domains 3–4.

#### 1.C.11 Code changes

| # | Change |
| --- | --- |
| IAC14 | IA16: `instagram-media/` controller, routes 5–6 with schemas, service (the live reads), DTO (`limit`, `after`, strict), serializers for both objects; integration tests with nock — paging passed through, both 404s, the status change on a refused token, `503` with `Retry-After` |
| IAC15 | IA17: `instagram-media.schema.ts` (as 1.C.3), repository, `InstagramMediaService.upsertFromInstagram` (insert or refresh by `(organization_id, instagram_media_id)`) and `deleteForAccount` (IA20); unit tests |

---

### 1.D Meta callbacks — `instagram-account/instagram-account-meta-callback/` — final

#### 1.D.1 Decisions

| # | Decision |
| --- | --- |
| IA18 | **Meta's signed request (routes 7–8)**: today the Stripe webhook checks its signature in a route-scoped plugin before the handler (`stripeWebhookIngressPlugin`), answers a bad one with 400 and runs under `WEBHOOK_RATE_LIMIT`; the app's body parser reads JSON only. After: Meta posts `application/x-www-form-urlencoded` with one field, `signed_request` = `<signature>.<payload>` (base64url). A route-scoped form parser and a plugin like Stripe's: HMAC-SHA256 of the payload part with `INSTAGRAM_APP_SECRET`, compared in constant time (one helper shared with sub-domain 4's `X-Hub-Signature-256` check, `meta-signature.util.ts`); `algorithm` must be `HMAC-SHA256` and `user_id` digits; anything else → `400 instagram_signed_request_invalid`; no app secret → `503 instagram_not_configured`. `WEBHOOK_RATE_LIMIT`; no auth, no idempotency key (K3), no CSRF check. Once verified the answer is always `200`, even when no account matches, so Meta does not retry. |
| IA19 | **Deauthorize (route 7, D22)**: today nothing. After: the resolver (IA6, IQ3) gives every organization with that app-scoped id; in each, inside its own verified scope, the disconnect of IA14 without the unsubscribe call (the app is already removed): `revoked`, the token erased. A revoked row changes nothing. One audit entry per organization changed (IA7). Open runs as IQ1. Answers `200` `{ data: null, meta }`. |
| IA20 | **Data deletion (route 8, D22)**: today nothing. After: as route 7, plus in each organization, in the same transaction: the profile erased (`username`, `name`, `biography`, `website`, `profile_picture_url` emptied; counts 0; `scopes` empty; `profile_erased_at`) and the account's stored posts deleted (IQ4) — revoked rows of that id too, since it is the same person's data. Contacts are not touched (D22; a contact's own request is route 10). The confirmation code is derived from the signed request (`user_id` and `issued_at`, HMAC with the app secret, 21 characters `[a-z0-9]`), so Meta repeating one request gets the same code. The answer is Meta's documented shape, outside the envelope: `{ "url": "<FRONTEND_URL>/instagram/data-deletion?code=<code>", "confirmation_code": "<code>" }`. No table, no status route (IQ2). The erase is done before the answer, so nothing waits in the background — the plan's WC-14 (written for D6) goes. |

#### 1.D.2 Open questions

IQ2 (1.2) — the deletion record and status link; IQ3 (1.2) — which id Meta sends; IQ4 (1.2) — the stored posts.

#### 1.D.3 Tables and relations

None of its own (IQ2: no request table). Writes `app.instagram_accounts`, `app.instagram_account_tokens` and `app.instagram_media`
through their services, one transaction per organization the resolver (IA6) names.

#### 1.D.4 Permissions

None — PUBLIC; Meta's signed request proves the caller (IA18).

#### 1.D.5 Common to every route

As 1.5, except: PUBLIC, a form-encoded body, no idempotency key (K3), `WEBHOOK_RATE_LIMIT`; route 8 answers outside the envelope.

#### 1.D.6 Objects returned

**Meta data-deletion answer** (route 8): `url` (the frontend's status page with the code), `confirmation_code` — Meta's
documented shape, outside `{ data, meta }`.

#### 1.D.7 Routes (7–8)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 7 | POST | `/social/instagram/deauthorize` | Meta: the owner removed the app **(new, D22)** | PUBLIC (Meta signed request) | none (K3) |
| 8 | POST | `/social/instagram/data-deletion` | Meta: delete the owner's data **(new, D22)** | PUBLIC (Meta signed request) | none (K3) |

#### 1.D.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 7 | — | form `signed_request*` (`application/x-www-form-urlencoded`) | `{ data: null, meta }` |
| 8 | — | form `signed_request*` | Meta data-deletion answer |

#### 1.D.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 7, 8 | `400` · `instagram_signed_request_invalid` | missing, a bad signature, another algorithm, or no `user_id` |
| 7, 8 | `415` | the body is not form-encoded |
| 7, 8 | `429` | over the webhook rate limit |
| 7, 8 | `503` · `instagram_not_configured` | no app secret set |

#### 1.D.10 Rules worth knowing

- An unknown `user_id` is still `200` (route 8 with a code), so a request for someone we never stored ends cleanly.

#### 1.D.11 Code changes

| # | Change |
| --- | --- |
| IAC16 | IA18: `instagram-account-meta-callback/` routes with a route-scoped `application/x-www-form-urlencoded` parser, the verification plugin (the `stripeWebhookIngressPlugin` pattern) setting `request.metaSignedRequest`, `WEBHOOK_RATE_LIMIT`; unit tests of the verifier (good, bad signature, other algorithm, malformed); both routes in the never-5xx fuzz |
| IAC17 | IA19, IA20: controller and service — resolver, then per organization the disconnect / erase through the account, token and media services in one transaction; the derived confirmation code; Meta's answer shape documented in the route schema and `response-codes.md` as the one envelope exception beside the webhook's plain text; audit; integration tests — an unknown user is still `200`, a repeat returns the same code, another organization's live account is untouched, a revoked row's profile is erased too; the meepzo-fe status page (sibling PR) |

---

### Hand-over checks — sub-domain 1 (for the reviewer)

- Sections 1.1–1.12 and 1.A–1.D each .1–.11 are present; every table row has its header's column count.
- Ids are unique: IA1–IA20, IAC1–IAC17, IQ1–IQ6; every cited id exists (K1–K10 are the brief's).
- Routes run 1–8 with no gap; 8 routes = route-changes' "Instagram account 6 + Meta callbacks 2".
- Every route has a gate and an Idem cell; route 1 (the one authenticated `POST`) is `req`; routes 7–8 are `POST` without a key
  by K3 (the template's "every POST is req" does not fit PUBLIC callbacks).
- Every table states its RLS, its branch rule (none) and its pointers (users only, `SET NULL`; no membership pointers).
- The change files say otherwise in these places and must take this sub-domain's answer when it is confirmed:
  `db-changes.md` — the new account columns (`token_expires_at`, `connection_status_changed_at`, `webhook_subscribed_at`,
  `disconnected_at`, `profile_erased_at`; `username` empty only once erased), the token column `encrypted_access_token`, media's
  `instagram_account_id` and no `owner_username`, its opens answered by IA5, IA14, IA17, IQ2–IQ4; `route-changes.md` — F4 (IA3:
all six `team`, reads `404 team_organization_required`),
  F16 (IQ2), the status changes of IA10, route 8's answer shape, `is_webhook_subscribed` on RC-13; `worker-changes.md` — WC-7
  and WC-10 become one daily check that also retries the webhook subscription (IA8, answers Q8 and Q10), WC-11's mechanism (IA9),
  WC-14 removed (still D6; under D22 the erase runs inside route 8), Q16–Q18 superseded by D22 / IQ1.

---

## 2. Contacts — final (rev 3, confirmed 2026-11-22) — no nested sub-domains

*rev 2 (2026-11-21, at R8's build, [D38](decisions.md)): contact personal data is hidden in logs through its own log-redaction list, split from the idempotency engine's secret list (CT12).*

*rev 3 (2026-11-22, at R18's review, [D46](decisions.md)): `lockLiveContact` — every run-engine unit locks the contact first, so a contact erase and an event of the same contact never deadlock and an event that meets an erase writes nothing (CT9).*

Code: the **`contact` sub-domain folder** — `app/sub-domains/contact/` (the contact at the folder root); it has no
nested sub-domains.

2.1 Decisions (whole sub-domain) · 2.2 Open questions · 2.3 Tables and relations · 2.4 Permissions · 2.5 Common to every route ·
2.6 Objects returned · 2.7 Routes · 2.8 Request details · 2.9 Errors · 2.10 Rules worth knowing · 2.11 Code changes (whole sub-domain) ·
2.12 Nested sub-domains (none).

The people who interacted with the connected Instagram account — commented, sent a DM, replied to a story or clicked a
button — with the email and phone they shared, their tags and their message times. Event processing (sub-domain 4)
creates and updates them; the team lists them and may erase one (D22). Design read: `schema-routes.md` §1–§4, §5.5,
§6.5, §6.12, §8.1, §8.9, §8.10, §8.12, §9; decisions D1, D8, D11, D12, D20–D23. Builds on sub-domain 1 (the `app`
schema, the app domain's capability and permission catalog). Route numbers run 9–10.

### 2.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation" — change any of them before you confirm.

| # | Decision |
| --- | --- |
| CT1 | **Folder and names.** Today: no `app` domain, no contact entity (`PUBLIC_ID_PREFIXES` has no `contact`). → the sub-domain folder `contact/` with the contact at its root (`contact.routes.ts`, `.controller`, `.service`, `.repository`, `.schema`, `.dto`, `.validator`, `.serializer`, `.types`, `seed/`, `__tests__/`), laid out like `notify/sub-domains/webhook/`; table `app.contacts` (D1) on the `app` pgSchema sub-domain 1 adds; public-id entity `contact`, prefix `con` (free — coverage Findings 12); path param `{contact_id}` registered in `PARAM_NAME_TO_ENTITY` (K1); OpenAPI tag `Contact`. No nested sub-domain: one table, two routes, nothing it owns (2.12). |
| CT2 | **Only event processing writes contacts, through this sub-domain's service.** Today: nothing; the repository's worker-callable pattern is a repository with a worker factory (`createWorkerNotificationRepository(databaseHandle)`). → no route adds or edits a contact (schema-routes §6.12); sub-domains 3–4 call the operations in 2.10 inside their organization-scoped job (`runOrganizationScopedWorkerJob`, K8) and never import the contact repository or schema. Every write changes a **live** contact only and answers `null` for an erased one, so the caller stops (CT9). |
| CT3 | **Team-only, and what a personal organization gets.** Today: every `team` route is a write and answers `422` through `assertTeamOrganization`; `be-api-contract-guard` says a team-only **read** answers `404` with reason `team_organization_required` instead ("a GET is never a 422") — no route does that yet. → route 10: `422` through `assertTeamOrganization` with the app domain's capability (added by sub-domain 1, shared); route 9: `404 team_organization_required` (a new reason, shared with sub-domain 1's reads). Both are `team` in the catalog's O column (K1). Other option: route 9 `both`, answering an empty list — a personal organization can never connect Instagram, so it never has contacts. |
| CT4 | **The list's search and filters** (schema-routes §5.5). Today: lists take `q` (`listSearchSortSchema`, 1–200 characters), several values comma-separated (`valueListSchema`, `recordIdListSchema`), yes/no as `true` / `false` (`include_ended`); `UserRepository.findMany` searches the exact expression its trigram index holds. → **`q`** (the drop's `search`), any case, over username, full name and email, every word anywhere (`buildSearchCondition({ everyWord: true })` over the one concatenated expression of `idx_contacts_search_trgm`); **`tags`** — up to 10, comma-separated, exact text, the contact holds all of them (`tags @> …`); **`has_email`**, **`has_phone`**; **`is_following_account`** (`true` = following, `false` = checked and not following; never checked matches neither); **`first_seen_from`** / **`first_seen_to`** (`to` exclusive); **`automation_id`** (CT5). Unknown params → `400` (K2). Other option: keep the drop's `search` name and repeated `tag=` params (the OpenAPI query tooling would first have to learn array params). |
| CT5 | **`automation_id` = had a run of that automation — lands with sub-domain 3.** Today: memberships' `role_id` filter is an `EXISTS` helper exported by the owning schema (`membershipHoldsRole`), and an unknown id gives an empty page (`MembershipService.resolveListFilters`). → route 9 ships without it; sub-domain 3's build adds the optional param (non-breaking): the automation service resolves the `aut_…` id inside the organization (deleted automations too — their runs stay; unknown → empty page; malformed → `400`), and the contact repository filters with `contactHadRunOfAutomation(automationId)`, an `EXISTS` on `app.automation_runs` exported by the run schema (a join-only schema import inside the same domain). Other option: the contact service asks the automation service for the matching contact ids — a capped id list and two round-trips. |
| CT6 | **Sorts and paging.** Today: `resolveKeysetSort` keysets a text column or a timestamp column (its `created_at` kind — any timestamp the repository selects as `cursor_created_at`); both assume NOT NULL: a NULL sort value drops rows after page 1, and a row without `sort_value` mints a cursor that restarts the list. → `sort` = `last_message_received_at` (default) · `first_seen_at` · `username`, with `order` = `asc` · `desc` (the repository's style, not the drop's `-field`); no `order` = newest first for the two times, A→Z for `username` (applied in the service; `order` stays optional — contract skill). `last_message_received_at` becomes NOT NULL (CT10), so both time sorts are plain keysets; `username` waits on CQ2. `limit` 1–100, default 25 (K2); `estimated_total` on the first page, capped (`countWithCap`, as memberships). |
| CT7 | **Deleting a contact erases it (D22): anonymise and keep the row.** Today: the repository's one person-erasure is the user's — tombstone, details nulled, copies in stored `membership.*` webhook payloads nulled (`docs/reference/data/data-lifecycle-deletion.md`); runs point at contacts with `RESTRICT` (schema-routes §8.10). → route 10 sets `deleted_at` and clears every personal column — `instagram_user_id`, `username`, `full_name`, `profile_picture_url`, `followers_count`, the follow status, `email`, `phone` (with their times) and `tags`; `chk_contacts_erased` makes the database hold it (2.3). The row stays so its runs stay, without personal data (CT8). No restore (the data is gone), no reason asked, no body, no `X-Idempotency-Key` (K3); a repeat answers `404 contact_not_found`. Audit `app.contact.delete` (CT12). Other option: **hard delete** — the contact, its runs (run events cascade) and its comment logs go in one transaction; the simplest erase, but the run history (D13's later run views, automation statistics) and the comment-log rows that reply safety counts (hour limit, gap) go with it. |
| CT8 | **The erase reaches every copy, in one transaction.** Today: the event bus runs after commit and must not fail the request, so it cannot make an erase all-or-nothing. → the contact service takes a list of **erasure steps** the app container hands it (sub-domains 3 and 4 are built later and call contacts, so contacts never imports them); route 10 locks the live contact, runs each step, then anonymises the row — all in one `withTransaction` inside the request's `withAppDatabaseContext`. Sub-domain 3's step cancels the contact's `running` / `waiting` runs (one `status_changed` run event each, `queued_automations` emptied — it holds trigger text), clears `trigger_text` on all its runs, and clears the comment-log copies `comment_text`, `commenter_instagram_user_id`, `commenter_username`, `email_received`, `phone_received`, matched by `contact_id` alone — every comment log carries it (AU24), so no second match is needed. Instagram ids of posts, stories and comments stay — the duplicate-reply rule needs them (D17) and they name the account's own content. Sub-domain 4 registers no step (CQ1, your call): a deleted contact's webhook events stay until the 30-day clean-up (D8), their payload masked in the list (WQ2). |
| CT9 | **After an erase.** The contact is never listed and every route on it is `404`; a new comment or message from the same Instagram user starts a **fresh** contact (the old row no longer carries the id), so automations may run for them again and the 24-hour opening-DM rule starts over. Meta's data-deletion request (route 8) never touches contacts (D22). |
| CT10 | **Field rules.** Today: `trimmedEmail()` trims, lowercases and checks the shape (and refuses Gmail plus addresses); `PHONE_NUMBER_PATTERN` is India-only (`^\+91\d{10}$`, for team members). → **email**: `trimmedEmail()` reused as is; **phone**: spaces, dashes, dots and brackets dropped, a leading `+` kept, then `^\+?[0-9]{10,15}$` — a new `INTERNATIONAL_PHONE_NUMBER_PATTERN` beside the India one (a contact may be from anywhere; the PR says why — reuse rule); **tags**: 1–255 characters (an automation's name becomes the tag when it has none), a comma turned into a space, at most 50 — past 50 a new tag is dropped and logged and the run still completes; **`last_message_received_at` NOT NULL**: the event's own time on every comment, DM, story reply and button click (a contact is only ever born from one), never moved back (`greatest`); **`first_seen_at`**: the first event's time; **follow status** gains `follow_checked_at` (added) so a null status means "never checked" (be-sql-design-guard: no unexplained three-state boolean); **`last_direct_message_received_at`** (added, nullable) — the time of the contact's last DM, story reply or button click, the only events that open Instagram's 24-hour messaging window (a comment does not); sub-domain 3's opening-DM rule reads it (AUC13, 3.B.10). Other option: keep `last_message_received_at` nullable and DM-only, and give the keyset helper a nulls-last timestamp sort too. |
| CT11 | **Retention (D8), no limits (D12).** No clean-up timer: a contact stays until its organization is purged (`organization-tombstone-retention`, `ON DELETE CASCADE`) or the team erases it; an erased row (no personal data) stays while runs point at it. No plan limit counts contacts. Other option: remove erased rows once no run points at them, inside the run clean-up (WC-12). |
| CT13 | **Contacts belong to the Instagram account they came from (CQ5, your call).** Today: the drop keys a contact by organization and Instagram user id; Instagram gives one person a different id per professional account. → `instagram_account_id` → `app.instagram_accounts` (composite `(organization_id, instagram_account_id)` → `(organization_id, id)`, `ON DELETE RESTRICT` — accounts are never deleted, only `revoked`); the upsert key becomes `(organization_id, instagram_account_id, instagram_user_id)`; every contact shows its `instagram_account_id`; the list takes an optional `instagram_account_id` filter (`iga_…`, default every account). Reconnecting the same account keeps its contacts (the same account row, IA12); another account starts its own. Other option: organization-wide, as the drop. |
| CT12 | **Personal data in logs and the audit (K7, K9, K6).** Today: `SENSITIVE_KEY_FRAGMENTS` masks `email` but no phone or name; audit actions are `<domain>.<resource>.<verb>`, written by the controller after the service (`notify.webhook.delete` through `recordScopedAuditEvent`). → hide `phone`, `full_name`, `username`, `profile_picture` in logs through a log-redaction list of their own — split from the idempotency engine's secret-response list, which keeps refusing only real secrets, so a `username` in a response stays replayable (rev 2, D38; shared with sub-domain 4's message-text keys); route 10 writes `app.contact.delete`, resource `contact`, metadata `{ contact_public_id }` only — never the erased values. Contacts carry no `*_by_user_id` (K6): the system writes them, and the audit entry says who erased one. |

### 2.2 Open questions

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| CQ1 | When a contact is erased, the raw webhook events kept 30 days (sub-domain 4's list, the debugging view) still hold that person's comments, messages, username and any email they typed. Erase those too? | erase at once · let them expire after 30 days (D8) | **erase at once** — sub-domain 4 keeps the sender's Instagram user id on each event (indexed) and its erasure step deletes that person's events in the same transaction (WH18); otherwise the team still sees the "deleted" person in the events list for up to a month. **Your call (2026-11-21): let them expire** after 30 days (D8) |
| CQ2 | Sort by username: a contact with no username (a DM-only contact whose profile was never read) breaks keyset paging today (CT6). | keep the sort, contacts without a username last (teach the shared keyset helper a nulls-last text sort) · drop the username sort at launch | **keep** — one improvement in `list-query.util.ts` / `pagination.util.ts`, reusable by any later nullable sort |
| CQ3 | Where do the name, profile picture, follower count (and a DM sender's username) come from? The webhook carries only a commenter's username (schema-routes §5.6). | event processing reads the Instagram profile when it creates the contact and at each follow check (one Graph call returns name, username, picture, followers and follow status) · webhook data only (those fields stay empty) | **read the profile** — through the one Instagram client (K10), failing open (a failed read saves the contact without it); sub-domain 4 confirms the call |
| CQ4 | A person may ask the team for a copy of their data (not asked at Step 4; `db-changes.md` › contact, open). | not at launch — the list row shows everything stored about them · an export route | **not at launch** |
| CQ5 | Instagram gives one person a different id per professional account, so after the organization switches to another account (D5) the same person appears as a second contact, and the old contacts can no longer be messaged. Tie each contact to the account it came from? | organization-wide, as the drop · add `instagram_account_id` (and a filter) | **organization-wide, as the drop** — reconnecting the same account keeps the same ids; the old contacts stay as the team's leads. **Your call (2026-11-21): per account** (CT13) |

**Answered 2026-11-21** ([D25](decisions.md)): CQ1 your call — let the events expire; CQ5 your call — per account (CT13); CQ2, CQ3, CQ4 the recommendation (keep the username sort, contacts without a username last; read the profile when a contact is new; no export at launch).

### 2.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.contacts` | one Instagram user who interacted with one of the organization's Instagram accounts | one live contact per organization, Instagram account and Instagram user (the upsert target, CT13); written only through the contact service by event processing (CT2); erased in place, never restored (CT7); RLS organization policy |

```text
tenancy.organizations
   │
   └──< app.instagram_accounts (1) ──< app.contacts         the account it came from (CT13) — composite, RESTRICT
                                          └──< app.automation_runs (3)   who a run is for — composite (organization_id, contact_id), RESTRICT
                                          ┄┄< app.automation_comment_logs (3)   contact_id (AU24)

A ──< B   one A has many B     ┄┄<  a column on B names A without a foreign key
```

Pointing at it from other sub-domains: `automation_runs.contact_id` (3 — composite `(organization_id, contact_id)` →
`(organization_id, id)`, `ON DELETE RESTRICT`), `automation_comment_logs.contact_id` (3 — AU24).
It points at `app.instagram_accounts` (1 — composite `(organization_id, instagram_account_id)`, `ON DELETE RESTRICT`, CT13).
Branch rule: none — the organization is the only scope. Membership or user pointers: none (K6).

**PostgreSQL design**

`app.contacts` — no `created_by_user_id` / `updated_by_user_id` (written by the system, K6); `deleted_at` only, no
`delete_reason` / `delete_note` (CT7).

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id` | `bigint` (bigserial) | no | identity | primary key, internal only |
| `public_id` | `varchar(28)` | no | | `con_…` from `generatePublicId('contact')` |
| `organization_id` | `bigint` | no | | → `tenancy.organizations` `ON DELETE CASCADE` (K5) |
| `instagram_account_id` | `bigint` | no | | **added** (CT13); composite `(organization_id, instagram_account_id)` → `app.instagram_accounts (organization_id, id)` `ON DELETE RESTRICT` |
| `instagram_user_id` | `varchar(64)` | yes | | `^[0-9]{1,64}$`; the webhook's `sender.id` / `from.id`; set while live, cleared on erase |
| `username` | `varchar(64)` | yes | | refreshed from every event or profile read that carries it; never blanked by an event without it |
| `full_name` | `varchar(255)` | yes | | from the profile read (CQ3) |
| `profile_picture_url` | `text` | yes | | `^https://`; an Instagram CDN link that expires — refreshed at each profile read |
| `followers_count` | `integer` | yes | | `≥ 0`; null = unknown |
| `is_following_account` | `boolean` | yes | | the last follow check; null = never checked |
| `follow_checked_at` | `timestamptz` | yes | | **added** (CT10); set exactly when `is_following_account` is |
| `email` | `varchar(255)` | yes | | lowercase, email shape (`trimmedEmail()` in the service) |
| `email_collected_at` | `timestamptz` | yes | | set exactly when `email` is |
| `phone` | `varchar(20)` | yes | | `^\+?[0-9]{10,15}$`, stored normalised (CT10) |
| `phone_collected_at` | `timestamptz` | yes | | set exactly when `phone` is |
| `tags` | `text[]` | no | `'{}'` | at most 50, no null element; each 1–255 without a comma (service, CT10) |
| `first_seen_at` | `timestamptz` | no | | the first event's own time |
| `last_message_received_at` | `timestamptz` | no | | **not null** (CT10); the latest comment, DM, story reply or button click |
| `last_direct_message_received_at` | `timestamptz` | yes | | **added** (CT10); the latest DM, story reply or button click — a comment never sets it; read by sub-domain 3's opening-DM rule |
| `last_message_sent_at` | `timestamptz` | yes | | null = never; drives the 24-hour opening-DM rule (schema-routes §6.5 step 3) |
| `deleted_at` | `timestamptz` | yes | | **added** — the erase time (CT7) |
| `created_at`, `updated_at` | `timestamptz` | no | `now()` | the app sets `updated_at` on every change (schema-routes §8.1) |

Indexes (every one declared in `contact.schema.ts` too — index-hygiene gate):

- `idx_contacts_public_id` — unique `(public_id)`.
- `idx_contacts_organization_id_id` — unique `(organization_id, id)`: the parent key of the runs' composite reference (sub-domain 3).
- `idx_contacts_organization_id_instagram_account_id_instagram_user_id` — unique `(organization_id, instagram_account_id, instagram_user_id)`: the upsert target (CT13), and the index behind the account reference. Not partial: erased rows hold `NULL`, which never collides, so a fresh contact can follow an erased one (CT9); it leads with `organization_id`, so it also serves the organization cascade (be-sql-design-guard D.1).
- `WHERE deleted_at IS NULL`, one per sort, each serving both directions: `idx_contacts_organization_id_last_message_received_at_id` `(organization_id, last_message_received_at, id)`, `idx_contacts_organization_id_first_seen_at_id` `(organization_id, first_seen_at, id)`, `idx_contacts_organization_id_username_id` `(organization_id, username, id)` (only if CQ2 keeps the sort; Z→A takes an incremental sort on the rare equal usernames).
- `idx_contacts_search_trgm` — `USING gin ((coalesce(username, '') || ' ' || coalesce(full_name, '') || ' ' || coalesce(email, '')) gin_trgm_ops) WHERE deleted_at IS NULL`; the repository's search must use this expression verbatim (as `idx_users_display_name_trgm`). `pg_trgm` is already installed.
- `idx_contacts_tags_gin` — `USING gin (tags) WHERE deleted_at IS NULL`, for `tags @> $1`.
- No index for `has_email`, `has_phone` or `is_following_account`: they narrow an organization's own rows, already reached by the sort index.

Checks (`chk_contacts_<rule>`):

- `chk_contacts_instagram_user_id` — `instagram_user_id ~ '^[0-9]{1,64}$'`.
- `chk_contacts_email` — `email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'` (a shape guard; the full rule is `trimmedEmail()`).
- `chk_contacts_phone` — `phone ~ '^\+?[0-9]{10,15}$'`.
- `chk_contacts_email_collected`, `chk_contacts_phone_collected`, `chk_contacts_follow_checked` — `(value IS NULL) = (time IS NULL)` for each pair.
- `chk_contacts_followers_count` — `followers_count >= 0`.
- `chk_contacts_profile_picture_url` — `profile_picture_url ~ '^https://'`.
- `chk_contacts_tags` — `cardinality(tags) <= 50 AND array_position(tags, NULL) IS NULL`.
- `chk_contacts_erased` — `(deleted_at IS NULL) = (instagram_user_id IS NOT NULL)` and, when `deleted_at` is set, `num_nonnulls(username, full_name, profile_picture_url, followers_count, is_following_account, follow_checked_at, email, email_collected_at, phone, phone_collected_at) = 0 AND cardinality(tags) = 0`.
- `chk_contacts_updated` — `updated_at >= created_at`.

Foreign keys: `contacts_organization_id_organizations_id_fk` (the repository's generated name) and `contacts_instagram_account_fk` (CT13; the name follows sub-domain 1's convention). RLS (K5): enabled and
forced; policy `contacts_tenant_isolation` `FOR ALL` — `USING` the organization GUC OR
`maintenanceBypassArm('app.global_retention_cleanup')`, `WITH CHECK` the organization GUC only (the
`member-role.schema.ts` pattern); `{ schemaName: 'app', tableName: 'contacts' }` in `EXPECTED_FORCE_RLS_TABLES`. No
contact lookup ever runs before the organization is known — event processing routes the event to its organization
first (sub-domain 4) — so no cross-organization resolver is needed. Partitioning: none (well under 10M rows, update-heavy).
Migration: a new dated file (`pnpm db:migrate:new app_contacts`) — production holds data, so the init file stays as is.

### 2.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `contact:read` | Contacts · View | the contact list, with emails and phones | 9 | Owner, Admin, Member (D2) |
| `contact:delete` | Contacts · Delete | erase one contact (D22) | 10 | Owner, Admin (D23) |

The catalog rows (category `contacts`), the Owner / Admin / Member presets and the backfill for existing team
organizations land with sub-domain 1 (K4); this sub-domain adds the two constants to the app domain's permissions file.

### 2.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (D1, D20) |
| Auth | `Authorization: Bearer <access token>`; the active organization comes from the token (K1) |
| Organization | team only (CT3): route 9 `404 team_organization_required`, route 10 `422` on a personal organization; another organization's contact is `404`, never `403` (K1) |
| Writes | no `POST` or `PATCH`, so no `X-Idempotency-Key` (K3); route 10 takes no body and no query |
| Success | `200` with `{ data, meta }`; the list `{ data: [...], meta: { request_id, pagination: { per_page, next, has_more, estimated_total } } }` (`estimated_total` on the first page); `DELETE` → `204` (K2) |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400 invalid_field`, `401`, `403 missing_permission`, `404`, `422`, `429` (K2) |

### 2.6 Objects returned

**Contact**: `id` (`con_…`), `instagram_account_id` (`iga_…`, **added**, CT13), `instagram_user_id`, `username`, `full_name`, `profile_picture_url`, `followers_count`,
`is_following_account`, `follow_checked_at` (**added**, CT10), `email`, `email_collected_at`, `phone`,
`phone_collected_at`, `tags`, `first_seen_at`, `last_message_received_at` (never null, CT10), `last_direct_message_received_at` (**added**, CT10), `last_message_sent_at`,
`created_at`, `updated_at`. Internal ids and `deleted_at` are never returned (an erased contact is never returned at all).

### 2.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 9 | GET | `/contacts` | List contacts — the Contacts page | `contact:read` | |
| 10 | DELETE | `/contacts/{contact_id}` | Erase one contact **(new — D22)** | `contact:delete` | |

### 2.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 9 | `q` (1–200; username, full name, email — any case, every word anywhere), `tags` (comma-separated, up to 10, each 1–255; holds all), `has_email`, `has_phone`, `is_following_account` (`true` \| `false`), `first_seen_from` / `first_seen_to` (ISO 8601 with offset; `to` exclusive, `from` before `to`), `automation_id` (`aut_…`; with sub-domain 3, CT5), `instagram_account_id` (`iga_…`, one account; default every account — CT13), `sort` = `last_message_received_at` (default) \| `first_seen_at` \| `username` (CQ2), `order` = `asc` \| `desc` (default newest first for the times, A→Z for `username`), `limit` (1–100, default 25), `after` | — | Contact[] |
| 10 | — | — | 204 |

### 2.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 9 | `400` · `q` / `tags` / `has_email` / `has_phone` / `is_following_account` / `first_seen_from` / `first_seen_to` / `sort` / `order` / `limit` | a bad value, more than 10 tags, `first_seen_from` not before `first_seen_to`, or an unknown parameter |
| 9 | `400` · `automation_id` | not a well-formed id (from sub-domain 3's build, CT5); an unknown one is an empty page |
| 9 | `400` · `instagram_account_id` | not a well-formed id; an unknown one is an empty page (CT13) |
| 9 | `404` · `team_organization_required` | a personal organization (CT3) |
| 10 | `400` · `contact_id` | not a well-formed public id |
| 10 | `404` · `contact_not_found` | not in the organization, another organization's, or already erased (K1, CT9) |
| 10 | `422` | a personal organization (CT3) |
| 9, 10 | `403` · `missing_permission` | the caller lacks `contact:read` / `contact:delete` (a Member on route 10) |

### 2.10 Rules worth knowing

**What sub-domains 3 and 4 call** (CT2). Each runs inside the caller's organization-scoped job and uses
`createWorkerContactRepository(databaseHandle)`; each writes a live contact only and returns `null` for an erased one.

| Operation | Called by | What it does |
| --- | --- | --- |
| `recordContactInteraction({ organizationId, instagramAccountId, instagramUserId, username, occurredAt, interactionKind })` | 4 — every processed comment, DM, story reply, button click | upsert on `(organization_id, instagram_account_id, instagram_user_id)` (CT13): a new contact gets `first_seen_at` = `last_message_received_at` = `occurredAt`; an existing one gets `username` when given and `last_message_received_at = greatest(…)`; `interactionKind` other than `comment` also moves `last_direct_message_received_at = greatest(…)`. Returns the contact (id, email, phone, follow status, `last_message_sent_at`, `last_direct_message_received_at`, tags) and `isNewContact` (sub-domain 4 reads the profile only for a new one, CQ3) |
| `recordContactProfile({ contactId, profile, checkedAt })` | 4 — the profile read (CQ3) and each follow check | sets the fields given: `username`, `full_name`, `profile_picture_url`, `followers_count`; a follow result sets `is_following_account` and `follow_checked_at` |
| `recordContactEmail({ contactId, email, collectedAt })` | the email step (3, run inside 4) | `trimmedEmail()`; answers `invalid` (the run asks again) or saves the email and its time |
| `recordContactPhone({ contactId, phone, collectedAt })` | the phone step (3, run inside 4) | normalises (CT10); answers `invalid` (the run keeps waiting) or saves the phone and its time |
| `addContactTags({ contactId, tags })` | the run's completion (3) | appends the tags not held yet, in order, up to 50; never fails the run (CT10) |
| `recordContactMessageSent({ contactId, sentAt })` | 4 — after every DM | `last_message_sent_at = greatest(…)` |
| `findLiveContact({ contactId })` | 3, 4 — before each step and each send | the contact, or `null` once erased — so a run that raced an erase stops before it messages anyone |
| `lockLiveContact({ databaseHandle, organizationId, contactId })` (rev 3, D46) | 3 — first in every run-engine unit | the contact locked `FOR KEY SHARE` until the unit ends (or `null` once erased): the erase's lock waits for it and then clears what the unit wrote; a unit that meets an erase writes nothing. Two units of one contact never block each other |
| `ContactErasureStep` (a function the container registers) | 3 (CT8; 4 registers none — CQ1) | called by route 10 inside its transaction with `{ organizationId, contactId, instagramUserId }` |

- Event processing handles one Instagram account's events in order (D15), so two processing writes for one contact
  never race; only route 10 can, and it locks the contact row first.
- A skipped event (echo, read receipt, reaction, edit, switched-off automations) creates or touches no contact
  (schema-routes §6.5 step 4).
- The list is not live (D11): a contact who messages again moves up between pages; a refresh shows it.
- Members see emails and phones — `contact:read` shows the whole row (D2); there is no field-level code.

### 2.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| CTC1 | CT1, CT7, CT10: new table `app.contacts` in a new dated migration (`pnpm db:migrate:new app_contacts`) — columns (with `instagram_account_id`, CT13), checks, indexes and RLS as 2.3; `contact.schema.ts` on `appSchema` (from sub-domain 1) declaring every index, check and the `pgPolicy`; `{ schemaName: 'app', tableName: 'contacts' }` in `EXPECTED_FORCE_RLS_TABLES`; `PUBLIC_ID_PREFIXES.contact = 'con'` and `PARAM_NAME_TO_ENTITY.contact_id`; `INTERNATIONAL_PHONE_NUMBER_PATTERN` beside `PHONE_NUMBER_PATTERN` |
| CTC2 | CT2: `ContactService` with the operations of 2.10 and `ContactRepository` with `createWorkerContactRepository(databaseHandle)` (organization context only, like `createWorkerNotificationRepository`); the upsert `ON CONFLICT (organization_id, instagram_account_id, instagram_user_id)`; wired in `app.container.ts` |
| CTC3 | CT4, CT6: `listContactsQueryDto` — `listSearchSortSchema(['last_message_received_at', 'first_seen_at', 'username'] as const)` plus the filters (with `instagram_account_id`, CT13) — registered in `tooling/openapi/query-schema-map.ts`; the repository list with `resolveKeysetSort` (the cursor timestamp selected from the sort column), `buildSearchCondition`, `finishKeysetPage` and `countWithCap`; serializer; controller; route 9 behind `contact:read` |
| CTC4 | CQ2: a nulls-last text sort in `resolveKeysetSort` and the text keyset builders (`list-query.util.ts`, `pagination.util.ts`) — a row with a null value pages after every value, and a cursor from such a row continues instead of restarting; unit tests. Dropped, with the username index, if CQ2 goes the other way |
| CTC5 | CT3: the team-only read guard answering `404 team_organization_required` (reason slug and i18n key in `src/shared/locales/en/errors.json`, registered in `docs/reference/api/response-codes.md`; shared with sub-domain 1's reads); routes 9–10 `team` in `route-organization-scope.json`; the route catalog legend says a team-only read answers `404` |
| CTC6 | CT7, CT8, CT9: route 10 behind `contact:delete`; `deleteContact` (lock the live contact, run the erasure steps, anonymise — one transaction); the `ContactErasureStep` type the app container fills; `NotFoundError('Contact').withReason('contact_not_found')` registered in `response-codes.md`; the audit entry `app.contact.delete` |
| CTC7 | CT5, CT8 — **built with sub-domain 3**: the `automation_id` filter, `contactHadRunOfAutomation` exported by the run schema and the automation service's id lookup; sub-domain 3's erasure step, with a comment-log index on `(contact_id)`. Sub-domain 4 adds no erasure step (CQ1) |
| CTC8 | CT12: `phone`, `full_name`, `username`, `profile_picture` in `SENSITIVE_KEY_FRAGMENTS` with its unit test; `CONTACT_READ` / `CONTACT_DELETE` in the app domain's permissions file (catalog, presets and backfill with sub-domain 1, K4) |
| CTC9 | Seeds, tests, docs: bulk seed in `contact/seed/` (contacts per team organization — usernames, some emails and phones, tags; no reference seed); unit (validators, phone normalising, tag merge and cap, serializer); integration (each filter, each sort in both directions across pages, search, another organization's contact `404`, Member `403` on route 10, personal organization `404` / `422`, an erase clears every column and its copies, a repeat `404`, a fresh contact after an erase); an RLS security test as `meepzo_be_app` and the `test:rls-role` lane; `contact.overview.md`; TSDoc on every export; `pnpm routes:catalog`, success statuses (`200`, `204`), the OpenAPI tag `Contact`; a `contacts` row in `docs/reference/data/data-lifecycle-deletion.md` |

### 2.12 Nested sub-domains

None — the contact is the folder root's only record; it owns no table and no route of its own.

---

Hand-over notes (for the plan owner; not part of the section):

- Checks run: sections 2.1–2.12 present; every table row matches its header; ids CT1–CT12, CQ1–CQ5, CTC1–CTC9 are unique and
  every cited one exists; routes 9–10 run without a gap, each with a gate and an Idem cell (no `POST` here); the table
  states its RLS, its branch rule (none) and its pointers (no membership or user pointer).
- The change files to bring in line: `db-changes.md` › contact — `deleted_at` and `follow_checked_at` added,
  `instagram_user_id` cleared on erase, `last_message_received_at` always set, the Step 5 open item answered by CT7/CT8,
  the export item is CQ4; › automation_run and automation_comment_log — their Step 5 items answered by CT8.
  `route-changes.md` RC-12 — `q`, `tags`, `sort` + `order`, `automation_id` arriving with sub-domain 3; F4 — reads answer
  `404` (CT3); RC-18 / F18 — answered by CT7/CT8; F10 does not reach route 10 (no body). `worker-changes.md` — no new
  background work; the "No clean-up timer" note should cite D22, not D6 (CT11).

---

## 3. Automations — final (rev 4, confirmed 2026-11-22) — nested sub-domains 3.A–3.B

*rev 2 (2026-11-22, at the R15–R18 review, [D47](decisions.md), [D48](decisions.md), [D49](decisions.md)): an event that ends `failed` also fails the runs it left `running`; the delete and the engine take their locks in one order and a starting run proves its automation is live under a lock (AU12, AU19); a click on a finished run while another run waits for the email asks for the email (AU17 — acceptance AC-9.9 read with that exception); AU14 is built in full — a run waiting for a step now off goes on at the contact's next event.*

*rev 3 (2026-11-22, at the engine-fix review, [D50](decisions.md), [D51](decisions.md)): a comment outside the 24-hour messaging window moves no waiting run on (AU14); a skipped event fails the runs it left `running` too (AU19).*

*rev 4 (2026-11-22, at the pre-merge review, [D53](decisions.md), [D55](decisions.md), [D56](decisions.md)): the comment logs keep no text of Instagram's error (8.12's `error_response` holds codes and the trace id only); a 502 or 504 on a message send is `unknown` and never sent again (3.B.9, AQ5); the opening message's button title is proven by the database (3.A.3).*

Code: the **`automation` sub-domain folder** — `app/sub-domains/automation/` (the automation at the folder root) with
`automation-run/` (no routes).

3.1 Decisions (whole sub-domain) · 3.2 Open questions · 3.3 Tables and relations · 3.4 Permissions · 3.5 Common to every route ·
3.6 Objects returned · 3.7 Routes · 3.8 Request details · 3.9 Errors · 3.10 Rules worth knowing · 3.11 Code changes (whole sub-domain) ·
3.12 Nested sub-domains · then **3.A Automations · 3.B Automation runs** — each with the same eleven sections.

What an organization builds to answer comments, DMs and story replies on its Instagram account — the automation itself
(routes 11–15), each belonging to the Instagram account connected when it was created (AU27) — and what happens when
one runs for a contact: the run, its history, the per-comment log and the run engine that sub-domain 4's event
processing calls. Design read: `schema-routes.md` §1–§4, §5.4, §6.5 (Run steps, Comment arriving while a run exists,
Default texts, Sends), §6.7–§6.11, §7, §8.1, §8.8, §8.10–§8.12, §9, §10; `PRD.md` §7–§11 for the legacy flow only
(D14: the new design wins); decisions D1, D8, D9, D11–D21, D24–D26. Builds on sub-domain 1 (the `app` schema and its
grants, the app capability and permission catalog, the Instagram client, the account and its settings) and
sub-domain 2 (contacts and their service). Route numbers run 11–15.

### 3.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation" — change any of them before you confirm. A decision that
belongs to one table is in its nested sub-domain.

| # | Decision |
| --- | --- |
| AU1 | **Folder and names.** Today: no `app` domain, no automation entity; a nested folder with no routes exists twice — `notify/sub-domains/webhook/webhook-delivery/` (repository, events, queues, workers) and `auth-method/verification-token/` (schema, repository, service). → the sub-domain folder `automation/` with the automation at its root (`automation.routes.ts`, `.controller`, `.service`, `.repository`, `.schema`, `.dto`, `.validator`, `.serializer`, `.types`, `workers/`, `seed/`, `__tests__/`) — routes 11–15, `app.automations`; one nested `automation/automation-run/` with **no controller and no routes file** (D13): `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, the run engine and the run workers. Comment logs sit with runs because the engine writes both in the same unit of work and nothing reads them yet (`src/domains/CLAUDE.md`: flatten a nested folder with no distinct routes or tests). Depth `app/sub-domains/automation/automation-run/` ≤ 4. Public-id entities `automation` (`aut`), `automationRun` (`run`, used in DM button payloads), `automationCommentLog` (`acl`) — all free (coverage Findings 12); `automation_id` → `automation` in `PARAM_NAME_TO_ENTITY` (K1); OpenAPI tag `Automation`. Other option: a third nested folder `automation-comment-log/` — worth it only when D13's later read routes come. |
| AU2 | **One code set, in the Automations row.** Today: codes are kebab-case `<resource>:<action>` in each domain's permissions file, catalog rows in `permission.reference.seed.ts`. → `automation:read` · `create` · `update` · `delete` (D20); Owner and Admin hold all; the locked Member role holds read, create, update (D2, D3, K4). No code for runs or comment logs (D13): the engine runs as sub-domain 4's job, not as a person. Catalog category `automations`; rows, presets and backfill land with sub-domain 1 (K4). |
| AU3 | **Team only, and what a personal organization gets.** Today: every `team` route is a write answering `422` through `assertTeamOrganization`; `be-api-contract-guard` says a team-only **read** answers `404` `team_organization_required`, never `422` (no route does it yet). → writes 12, 14, 15: `422` through `assertTeamOrganization` with the app capability sub-domain 1 adds; reads 11, 13: `404 team_organization_required` (the guard sub-domain 2 lands, CTC5). All five `team` in the O column (K1). Another organization's automation is `404 automation_not_found`, never `403`. |
| AU4 | **Audit.** Today: the controller writes `recordScopedAuditEvent` after the service, action `<domain>.<resource>.<verb>` present tense (`notify.webhook.create`, `tenancy.role.delete`), an update carrying `changed_fields` from `listBodyFieldNames(request.body)` (`webhook.controller.ts`). → `app.automation.create` (metadata `automation_public_id`), `app.automation.update` (`automation_public_id`, `changed_fields`), `app.automation.delete` (`automation_public_id`, `delete_reason`, `cancelled_run_count`); resource type `automation`. The drop's `automation.created` / `.updated` / `.deleted` (schema-routes §6.8–§6.11) follow the repository's style (D20). The engine writes no audit entries — runs are their own history. |
| AU5 | **The run engine is a service other sub-domains call, never a route.** Today: cross-sub-domain work goes service → service inside the same domain (root `CLAUDE.md` › Dependency rules). → `AutomationRunService` (in `automation-run/`) offers the entry points in 3.B.8; sub-domain 4's event processing calls them per event with its job's organization scope (`PRINCIPAL_SCOPE.JOB`, minted by sub-domain 4's worker and relayed — never minted here) and **outside** any database context, because the engine opens its own short contexts around each Instagram call (AU19, `rls-context-network-isolation.global.test.ts`). It calls out only through services: sub-domain 1 (the Instagram client's sends and follow read, the account's reply-safety settings, marking the account `error` on a token error) and sub-domain 2 (`findLiveContact`, `recordContactEmail`, `recordContactPhone`, `recordContactProfile`, `addContactTags`, `recordContactMessageSent`). It registers one `ContactErasureStep` with sub-domain 2 (CT8, AU26). |
| AU6 | **Background work owned here** (K8): pull-based crons in the `retention` family (`retentionDefinition`, concurrency 1), each registered in `worker-registration.registry.ts`, `scheduler.ts` and `queue-catalog.ts`, safe to repeat. A cross-organization **scan** reads under `MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP` and each **change** runs in its organization's `PRINCIPAL_SCOPE.JOB` context (the `membership-invitation-expiry` pattern — the retention bypass is in `USING` only, so it can delete but never update across organizations); a **delete** runs under `runGlobalRetentionWorkerJob` with `deleteInBatchesByCondition`. The five pieces: next-post expiry every 15 minutes (D9, WC-6, 3.A); waiting-run cancel every hour (D8, WC-13), run retention and comment-log retention daily (D8, WC-12, WC-9), and the deleted-automation purge daily (AQ7) — 3.B. All in UTC. Other option: one `automation-maintenance` queue routing five job names on `job.name` (one connection in the budget instead of five; `queue-and-worker-rules.md` §7.2 allows it only for a sweep backing up its queue, so it bends the rule). |

### 3.2 Open questions

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| AQ1 | Several live comment automations match one comment ("run **every**", schema-routes §6.5), but Instagram takes **one** private reply per comment, and nothing more until the person answers (Meta's private-reply rules — confirm at kickoff). | every one runs — the oldest sends the private reply, the later ones fail at their first DM unless the person's DM window is already open · only the oldest matching automation runs; the others get a comment log `ignored` · `comment_already_answered` · queue the others behind the first run | **only the oldest runs** — predictable, no failed runs; the frontend can warn when two automations share a keyword on the same post. **Your rule (2026-11-21):** match by Instagram account + post + keyword — only the commented post's account's live `comment` automations are eligible (AU27); the automations linked to that post (`specific` on it, or a "next post" linked to it) are checked first and the oldest match runs; only when none of them matches are the "any post" automations checked, and the oldest match runs; every other match gets a comment log `ignored` · `comment_already_answered`, never `failed`; automations of other posts are not touched (AU16, AU24) |
| AQ2 | On a comment trigger the opening message is the private reply; without a button the person has nothing to answer, so the next message (the final DM is always on, D19) is refused by Instagram unless their DM window is open. | require `opening_message.button_title` on comment automations while the opening message is on (`400`) · allow it and let such runs fail at runtime | **require the button** — every comment flow then works. **Answered 2026-11-21: the recommendation** (AU8, 3.A.9) |
| AQ3 | Is the opening message sent on `dm` and `story_reply` triggers? The drop calls it "a private reply to the comment" (§6.5 step 3) but keeps the field on every trigger; the legacy flow sends it only on comments (PRD §9). | send it as a normal DM on every trigger · comments only (skip it for DMs and story replies) | **send it on every trigger** — the field and its button wait exist for every trigger, and the person just messaged, so their DM window is open. **Answered 2026-11-21: the recommendation** (AU18) |
| AQ4 | Two waiting "next post" automations with **different** keywords and overlapping windows: may both link to the same new post? The overlap `409` keeps keyword clashes apart, which only matters if both can link. | both link — every live waiting automation whose window holds the post links in one statement · only the oldest links; the other waits for a later post | **both link** — the rule then mirrors the overlap check; a post another automation targeted **before** this comment (a `specific` one, or one linked earlier) is still never taken. **Answered 2026-11-21: the recommendation** (AU15; both then answer by AQ1's rule — the older one runs) |
| AQ5 | A send whose outcome is unknown (a timeout after the request went out, a crash before the result was saved): what does the retry do? (D16: never send twice.) | fail the step (`error_type = network`, the run `failed`, comment log `failed`) · assume it was delivered and continue | **fail the step** — never a second send, and the failure is visible; a person who did get the message and clicks its button meets a failed run, which ignores the click (D18). **Answered 2026-11-21: the recommendation** (AU19) |
| AQ6 | The delete reason: the repository's record deletes require `reason` (query string, `recordDeleteQuerySchema`, roles and memberships); the drop makes it optional with default `not_needed` and sends it in a body (route-changes F10). | required, in the query (the repository) · optional, default `not_needed` (the drop) | **required, in the query** — the same confirm drawer as roles and members; a `DELETE` body is dropped by some clients. **Answered 2026-11-21: the recommendation** (AU12) |
| AQ7 | A deleted automation stays because runs and comment logs point at it (`db-changes.md` › automation, open). With D8 they go 180 days after they end. | keep deleted automations for good · remove one once it was deleted 180 days ago and nothing points at it | **remove it** — a daily purge; rows still referenced are skipped and tried again the next day (`deleteInBatchesByCondition`); the audit log keeps the delete. **Answered 2026-11-21: the recommendation** (AU25) |
| AQ8 | Read-only plan access: `SubscriptionService.assertOrganizationWritable` says "every write under `/api/v1/app/`" answers `403 organization_read_only` while `BILLING_READ_ONLY_ENFORCED` is on, through an `app-plan-access.ts` preHandler that no longer exists. Do routes 12, 14, 15 take it? (D12 is about counts, not this.) | yes — the app domain's preHandler again (sub-domain 1) · no | **yes, writes only** — reads stay open and running automations keep running; sub-domain 1 restores the preHandler for the whole domain. **Answered 2026-11-21: the recommendation**, scoped to this sub-domain's writes 12, 14, 15 — this sub-domain lands the read-only preHandler on them (AUC3); the app domain's other writes stay open (D27) |
| AQ9 | The list's sorts `last_triggered_at` (empty until the first run) and `completed_run_count` (a number): the shared keyset helper sorts only NOT NULL text and timestamps today (CT6). | keep both — the helper learns a nulls-last timestamp and an integer sort, one change with sub-domain 2's CTC4 · drop both at launch | **keep both** — the list page shows them; one improvement in `list-query.util.ts` / `pagination.util.ts` serves contacts and automations. **Answered 2026-11-21: the recommendation** (AU13) |

**Answered 2026-11-21** ([D26](decisions.md)): AQ1 your rule — a comment is matched by Instagram account + post +
keyword, the post-linked automations first, the oldest match runs, every other match is logged `ignored` ·
`comment_already_answered` (AU16, AU24); and **each automation belongs to one Instagram account** — the one connected
when it is created (AU27). AQ2–AQ9 the recommendation (a comment automation with the opening message on needs its
button; the opening message on every trigger; two waiting "next post" automations may link the same post; an unknown
send outcome fails the step; the delete reason required, in the query; a deleted automation purged 180 days after its
delete once nothing points at it; writes blocked while the plan is read-only; keep the last-triggered and run-count
sorts).

### 3.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.automations` | one automation of one Instagram account: trigger, target, keywords, tags, the message of each step, its counters | belongs to the account connected when it was created, never changed (AU27); always complete (AU8); next-post window rules and the overlap `409`, per account (AU9); soft delete with a reason, no restore, purged 180 days later (AU12, AQ7); RLS organization policy |
| `app.automation_runs` | one automation flow for one contact | one open run per automation and contact (AU17); every send claimed before and recorded after (AU19); cancelled after 7 days of waiting (AU25); removed 180 days after it ends (D8) |
| `app.automation_run_events` | each status change of a run, and each email or phone it collected | append-only, written with the run change (AU23); goes with its run |
| `app.automation_comment_logs` | the step results of one comment × automation, ignored comments included | one per comment × automation (AU24); one automation answers a comment, the other matches are logged `ignored` (AU16); written with the run in the same short transactions, so it references the run and the contact; removed 180 days after it was written (D8) |

```text
tenancy.organizations
   │
   └──< app.instagram_accounts (1) ──< app.automations       the account it runs on (AU27) — composite, RESTRICT
                                          ├──< app.automation_runs ──┬──< app.automation_run_events     its history (AU23)
                                          │                          └──> app.contacts (2)             who it runs for — RESTRICT
                                          ├──< app.automation_comment_logs ──┬──> app.automation_runs   SET NULL (AU24)
                                          │                                  └──> app.contacts (2)      RESTRICT (AU24)
                                          └──> auth.users (created_by, updated_by)                     SET NULL (K6)

A ──< B   one A has many B     A ──> B   a column on A points at one B
```

Pointing at these from other sub-domains: none by foreign key. Sub-domain 2's contacts list filters on runs
(`contactHadRunOfAutomation`, CT5, AUC13); sub-domain 4 calls the engine (3.B.8). They point at
`app.instagram_accounts` (1 — `automations.instagram_account_id`, composite `(organization_id, instagram_account_id)`,
`ON DELETE RESTRICT`, AU27, as contacts CT13) and `app.contacts` (2). `target_instagram_media_id` and the run's trigger
ids are Instagram ids, not references to `app.instagram_media` — a `specific` post is picked from the live list and
never stored (schema-routes §6.2).

**PostgreSQL design**

Standard columns on every table (not repeated below): `id bigserial` primary key (internal only), `organization_id
bigint NOT NULL` → `tenancy.organizations` `ON DELETE CASCADE`, `created_at timestamptz NOT NULL DEFAULT now()`, and —
except the append-only run events — `updated_at timestamptz NOT NULL DEFAULT now()` with `chk_<table>_updated`
(`updated_at >= created_at`; the app sets it on every change, schema-routes §8.1). A parent of a composite reference has
unique `(organization_id, id)`; a child points at it with `(organization_id, <parent>_id)` → `(organization_id, id)`
named `<table>_<parent>_fk` (the B2-5 pattern and names of `20261101101100_tenant_composite_foreign_keys.sql`;
`be-sql-design-guard` writes `fk_<table>_<column>` — kickoff picks one, agent-os wins). Value lists are `varchar(n)` +
`CHECK` (no enums). RLS on all four (K5): enabled and forced; policy `<table>_tenant_isolation` `FOR ALL` — `USING`
the organization GUC OR `maintenanceBypassArm('app.global_retention_cleanup')`, `WITH CHECK` the organization GUC only
(`member-role.schema.ts`); each in `EXPECTED_FORCE_RLS_TABLES`. No lookup here runs before the organization is known:
sub-domain 4 routes the event to its organization first. Branch rule: none — the organization is the only scope; the
Instagram account (AU27) narrows which automations an event matches, never who may read them.
Membership pointers: none; user pointers `created_by_user_id` / `updated_by_user_id` → `auth.users` `ON DELETE SET
NULL` (K6, as `tenancy.roles`). Migration: one new dated file after sub-domain 1's (which creates the `app` schema and
its grants) — production holds data, so the init file stays as is. Each table's columns are in its nested sub-domain.

### 3.4 Permissions

All of the sub-domain's codes in one place; the nested sub-domain repeats its routes' gates.

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `automation:read` | Automations · View | list and read automations | 11, 13 | Owner, Admin, Member |
| `automation:create` | Automations · Create | create one — the frontend's Duplicate too | 12 | Owner, Admin, Member |
| `automation:update` | Automations · Edit | edit, turn on and off | 14 | Owner, Admin, Member |
| `automation:delete` | Automations · Delete | delete — cancels its open runs | 15 | Owner, Admin |

### 3.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (D1, D20) |
| Auth | `Authorization: Bearer <access token>`; the active organization comes from the token (K1) |
| Organization | team only (AU3): reads 11, 13 `404 team_organization_required`, writes 12, 14, 15 `422` on a personal organization; another organization's automation `404 automation_not_found` |
| Writes | `POST` needs `X-Idempotency-Key` (K3); `PATCH` takes an optional `expected_updated_at` (a stale save → `409 record_changed`, AU11); `DELETE` takes `reason` and `note` in the query (AU12, AQ6); writes 12, 14, 15 answer `403 organization_read_only` while the organization's plan is read-only — reads stay open and running automations keep running (AQ8) |
| Success | `200` with `{ data, meta }`; the list `{ data: [...], meta: { request_id, pagination: { per_page, next, has_more, estimated_total } } }` (`estimated_total` on the first page); `DELETE` → `204` (K2) |
| Lists | `limit` (1–100, default 25), `after`, `q` (1–200), `sort`, `order` (K2) |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400 invalid_field` (unknown fields too), `401`, `403 missing_permission` / `organization_read_only`, `404`, `409`, `422` (personal organization; idempotency key missing or reused), `429` |

### 3.6 Objects returned

| Object | Where |
| --- | --- |
| Automation | 3.A.6 — Automations |
| — runs, run events, comment logs are never returned (D13) | 3.B.6 — Automation runs |

### 3.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 11 | GET | `/automations` | List automations | `automation:read` | |
| 12 | POST | `/automations` | Create one (also the Duplicate button) | `automation:create` | req |
| 13 | GET | `/automations/{automation_id}` | Get one | `automation:read` | |
| 14 | PATCH | `/automations/{automation_id}` | Edit it, turn it on or off | `automation:update` | |
| 15 | DELETE | `/automations/{automation_id}` | Delete it with a reason; cancels its open runs | `automation:delete` | |

### 3.8 Request details

In each nested sub-domain (3.A to 3.B, section .8; 3.B has no routes and lists the engine's operations instead).

### 3.9 Errors

Every route can answer the errors in 3.5; each route's own errors are in 3.A.9; the engine's outcomes are in 3.B.9.

### 3.10 Rules worth knowing

- **Deleting an automation cancels its open runs in the same transaction** (AU12): the automation service calls the
  run service; nothing waits for a worker.
- **The engine runs inside sub-domain 4's job, in order per Instagram account** (D15). It assumes that order: the
  reply-safety counts are exact (AU20) and two events never move one run at once; the run row lock (`FOR UPDATE`) and
  the one-open-run index are the backstop.
- **Writes into other sub-domains go through their services**, never their repositories: contact email, phone,
  profile, tags and last message sent (sub-domain 2); sends, the follow read and the account's `error` status
  (sub-domain 1).
- **The engine reads the automation as it is now at every step** (AU14): an edit applies to open runs from their next
  step, and a step turned off meanwhile is skipped.
- **An automation answers only its own Instagram account's events** (AU27): the engine matches the event's account
  only, so another account's automations never run — after a switch to another account (D5) the old account's
  automations stay listed but never run, and their open runs wait for a reconnect of that account or the 7-day limit
  (IQ1, D24).
- **One automation answers a comment** (AQ1, your rule, D26): account + post + keyword, the post-linked automations
  first, the oldest match runs, every other match is logged `ignored` · `comment_already_answered` (AU16).
- **A read-only plan stops writes only** (AQ8): routes 12, 14, 15 answer `403 organization_read_only`; reads and the
  engine go on.
- No plan limits (D12) and no live updates (D11): the list shows new counters on refresh.

### 3.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| AUC1 | AU1: folders `automation/` and `automation/automation-run/` (no controller, no routes file); `PUBLIC_ID_PREFIXES` `automation: 'aut'`, `automationRun: 'run'`, `automationCommentLog: 'acl'`; `PARAM_NAME_TO_ENTITY.automation_id = 'automation'`; the routes registered under the app domain's routes; OpenAPI tag `Automation`; `automation.overview.md` and `automation-run.overview.md` (with the run's status machine as a Mermaid `## Lifecycle`) |
| AUC2 | AU2: `AUTOMATION_READ` / `CREATE` / `UPDATE` / `DELETE` in the app domain's permissions file; their catalog rows (category `automations`), the Owner / Admin / Member presets and the backfill ride on sub-domain 1's change (K4); the Roles matrix row |
| AUC3 | AU3, AU4, AQ8: `assertTeamOrganization` with the app capability on routes 12, 14, 15 and the team-only read guard (`404 team_organization_required`, sub-domain 2's CTC5) on 11, 13; all five `team` in `route-organization-scope.json`; the three audit actions in the controller; routes 12, 14, 15 behind the read-only preHandler (`403 organization_read_only`, AQ8) — **landed here**: `app-plan-access.ts` (the file `SubscriptionService.assertOrganizationWritable` names) restored in the app domain and attached to routes 12, 14, 15 only — the app domain's other writes stay open (D27) — with `assertOrganizationWritable`'s comment corrected to say so; integration tests for 12, 14, 15 (a read stays open) |
| AUC4 | AU6: five workers through `retentionDefinition` in `worker-registration.registry.ts`, their `upsertJobScheduler` entries in `scheduler.ts`, `WORKER_QUEUE_NAMES` in `queue-catalog.ts`, the two scan paths in the `maintenance-context-confinement` allowlist; the worker count and family breakdown in `docs/deployment/runbooks/resource-limits.md` |

### 3.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/automation/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 3.A Automations | folder root | `app.automations` | 11–15 | final |
| 3.B Automation runs | `automation-run/` | `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs` | none (D13) | final |

---

### 3.A Automations — `automation/` (folder root) — final

#### 3.A.1 Decisions

| # | Decision |
| --- | --- |
| AU7 | **Fields** (schema-routes §5.4, §8.8, §10). Today: the drop's object, whose response allows `final_message: null` (§5.4) though create requires it. → `name` 1–255 trimmed (need not be unique — Duplicate makes copies); `keywords` trimmed, lowercased, deduplicated, each 1–100, at most 50; `tags` trimmed, deduplicated, each 1–50, at most 20; `public_reply_texts` each 1–300, at most 20; Instagram ids `^[0-9]{1,64}$`; the message objects exactly as §10, `.strict()` (unknown keys → `400`); **`final_message` always present, never null** (D19). The server sets `instagram_account_id` (at create, AU27), `next_post_status`, `next_post_linked_at`, `completed_run_count`, `last_triggered_at`, `created_by_user_id` and `updated_by_user_id` (from the token). Read-only fields are not in the DTOs, so sending one is the strict schema's unknown-key `400`. The messages and texts of a step that is off are kept, so turning it on again restores them. |
| AU8 | **One flow rule set, run on the merged automation.** Today: per-body cross-field rules sit in the DTO (`membership.dto.ts` `superRefine`), and `parseWithSchema` throws `ValidationError` with one `errors[]` item per field. → the DTO checks shape; one pure function in `automation.validator.ts` (`validateAutomationFlow`) checks the merged automation — create = the defaults + the body, edit = the stored row + the body (§6.10: "all create rules run on the merged automation") — and throws `ValidationError` with one `errors[]` item per broken rule (3.A.9). **Every save is complete, whatever the status**, so "`status = live` needs a complete flow" (§6.10) is the same check, no second rule: opening and follow need their objects when on; the email and phone questions may be null (the default question, §10). `dm`: `target_scope = any`, at least one keyword, and `is_dm_keyword_trigger_enabled = true` (off, a `dm` automation could never run — coverage Inside 9). Public reply only on `comment`, with 1–20 texts. **On `comment` with the opening message on, `opening_message.button_title` is required** (`400`, AQ2, D26) — the opening message is then the private reply, and without a button the person has nothing to answer, so the next DM would be refused. Other option: allow incomplete drafts while `inactive` — `final_message` nullable again, against D19. |
| AU9 | **The "next post" window** (§6.8). Today: the drop's rules, messages in English inline. → `next` only on `comment`; the media id is never sent (the server sets it when it links); both dates required, valid, end after start; the start not before 24 hours ago and the end not in the past — each checked only when that date is new or changed; a window that has started may move later, never earlier; every message through an i18n key (AUC5). **Overlap:** when the saved automation is `live` and `waiting`, another `live`, `waiting` automation of the **same Instagram account** (AU27, D26) whose window overlaps (`start < other end AND other start < end`) and shares a keyword — or either has none — is `409 next_post_window_overlap`, the detail naming it, the first shared keyword (A→Z) and its dates (ISO 8601, UTC) through `errors:nextPostWindowOverlap`, or `errors:nextPostWindowOverlapAnyComment` when a side has no keywords. A draft (`inactive`) is checked when it turns live. The check and the write run under one per-organization advisory lock (`acquireResourceQuotaLock`, a new namespace `AUTOMATION_NEXT_POST`), so two saves never both pass; linking (AU15) takes the same lock. A changed window on an `expired` automation puts it back to `waiting`; on a `linked` one the window, `target_scope` and target ids are fixed — `409 next_post_already_linked`. Leaving `next` clears every next-post field. |
| AU10 | **The counters are the engine's.** Today: the drop says `completed_run_count` is "incremented in SQL" (§8.8) and is read-only on edit (§6.10). → the run engine writes both through the automation repository: `last_triggered_at = now()` when a run starts, `completed_run_count = completed_run_count + 1` in the completion's transaction (never read-modify-write); neither is in any DTO. An ignored comment moves neither. |
| AU11 | **`PATCH` takes `expected_updated_at`.** Today: memberships and roles refuse a stale save with `409 record_changed`, naming who changed it and when (`assertRecordNotChangedSince`, D43). → the same optional field and check on route 14 (additive; the drop does not have it). Other option: last save wins. |
| AU12 | **Delete** (§6.11). Today: roles and memberships soft-delete with `reason` + `note` in the query string (`recordDeleteQuerySchema`; "a `DELETE` has no body"); the drop sends an optional body (F10). → soft delete (`deleted_at`, `delete_reason`, `delete_note`), `reason` required in the query (AQ6), `note` 1–280 required for `other`; in the same unit of work the run service cancels its `running` and `waiting` runs (`cancel_reason = automation_deleted`, one `status_changed` run event each, their comment logs `cancelled`); runs and comment logs stay; a queued entry naming it is skipped when it comes up (AU21). `404 automation_not_found` when missing, deleted or another organization's. No restore route at launch (the five routes are fixed); the purge is AQ7. Other option: `POST /automations/{automation_id}/restore` later. (rev 2, D47) The delete and the engine take their locks in one order, and an engine unit that starts a run proves its automation is still live under a lock, so no open run is ever left on a deleted automation; the delete also cancels whatever open run it finds after it has the lock. |
| AU13 | **The list** (§5.4 `AutomationListQuery`). Today: lists take `q`, `sort` + `order` (`listSearchSortSchema`), `ILIKE` through `buildSearchCondition`, keysets through `resolveKeysetSort` + `finishKeysetPage`. → `q` (the drop's `search`) over `name`, any case, through `buildSearchCondition` on the trigram index; filters `status`, `trigger_type`, `target_scope`, `next_post_status` (one value each, as the drop) and `instagram_account_id` (`iga_…`, one account, default every account — unknown → an empty page, malformed → `400`, as contacts CT13; AU27); `sort` = `created_at` (default) · `name` · `last_triggered_at` · `completed_run_count` with `order` (the drop's `-created_at` style becomes `sort` + `order`); no `order` = newest / most first, `name` A→Z (applied in the service; `order` stays optional). `last_triggered_at` sorts never-triggered automations last in both directions (AQ9). Deleted automations never listed. `estimated_total` on the first page, capped (`countWithCap`, as memberships). |
| AU14 | **Editing and turning off while runs are open.** Today: the drop is silent; legacy reads the automation per step. → the engine reads the automation as it is at every step, so an edit reaches open runs from their next step and a step turned off meanwhile is skipped (a run waiting for a step now off moves on at the next event). Turning an automation `inactive` stops new runs; its open runs finish. Other option: turning off cancels open runs, as delete does. (rev 2, D48) Built in full: on the contact's next event a run waiting for a step that is now off goes on as if it had no such step, and the automations queued behind its email start as when the email arrives (AU21). (rev 3, D50) A comment outside the 24-hour messaging window moves nothing on: its next message would be a second private reply, which Instagram refuses. |
| AU15 | **Linking a "next post" (WC-4) and expiring it (WC-6, D9).** Today: the drop says "one conditional update, so only one wins" — read here as one **automation** links to one post even when comments on two posts race. → `linkNextPostAutomations` (called by sub-domain 4 for each comment, in a savepoint — a failure never stops the comment, D18): under the AU9 lock, one `UPDATE` sets `linked`, `target_instagram_media_id`, `next_post_linked_at` on every **live** `waiting` automation **of the post's Instagram account** (AU27) whose window holds the post's `published_at`, `WHERE next_post_status = 'waiting'`, unless an automation of that account already targeted the post before this statement (AQ4, D26 — so two may link one post, and AQ1's rule then lets the older one answer). Only live ones link, matching the overlap check (AU9) — an inactive draft never takes a post from a live one. **Expiry:** a worker every 15 minutes scans `waiting` automations whose `next_post_ends_at` has passed (all organizations, oldest first, a batch of 500), then per organization sets them `expired` with the same conditional `WHERE`; repeating changes nothing. The edge "posted just before the end, first comment after the expiry run" is accepted (worker-changes Q5). Other option: let linking also take `expired` automations whose window holds the post. |
| AU27 | **Each automation belongs to one Instagram account** (D26, your call). Today: the drop keys an automation by organization only (§8.8); an organization has at most one not-revoked account (D5) but may switch to another, and contacts are already kept per account (CT13). → `instagram_account_id` NOT NULL → `app.instagram_accounts` (composite `(organization_id, instagram_account_id)` → `(organization_id, id)`, `ON DELETE RESTRICT`, `automations_instagram_account_fk` — accounts are never deleted, only `revoked`; as contacts CT13). **Set by the server at create** (route 12) from the organization's not-revoked account, read through sub-domain 1's account service in the create's unit of work (the read route 2 does, IA13 — an `expired` or `error` account counts, it is still the organization's); none → `409 instagram_not_connected` (sub-domain 1's reason and i18n key, reused — a state that passes once an account connects), checked after the body's own `400`s. **Never changed**: no DTO carries it, so sending it is the strict schema's unknown-key `400`; reconnecting the same account reuses its row (IA11), so its automations run again. The Automation object shows `instagram_account_id` (`iga_…`); the list filters by it (AU13). **Per account**: the "next post" overlap (AU9), linking (AU15) and the engine's matching (AU16) look only at the event's or the saved automation's account — another account's automations never run; an automation of a revoked account never runs, and its open runs stay waiting (IQ1, D24) until that account reconnects or the 7-day limit cancels them (AU25). A disconnect racing a create can leave an automation of a just-revoked account — harmless, it never runs. Duplicate gives the copy the account connected now (3.A.10). Other option: organization-wide automations, as the drop — after a switch the old account's automations would answer the new account's comments. |

#### 3.A.2 Open questions

None open — AQ2 (the opening button), AQ4 (several next-post automations, one post), AQ6 (delete reason), AQ8
(read-only plan access), AQ9 (the two sorts) are answered (3.2, D26).

#### 3.A.3 Tables and relations

`app.automations` — standard columns as 3.3, plus `public_id varchar(28)` (`aut_…`), `created_by_user_id` /
`updated_by_user_id`, and soft delete (`deleted_at`, `delete_reason varchar(20)`, `delete_note varchar(280)` with
`chk_automations_delete_reason`, `_delete_reason_when_deleted`, `_delete_note_when_other`, from
`RECORD_DELETE_REASON_VALUES`, as `tenancy.roles`).

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `instagram_account_id` | `bigint` | no | | **added** (AU27); composite `(organization_id, instagram_account_id)` → `app.instagram_accounts (organization_id, id)` `ON DELETE RESTRICT` (`automations_instagram_account_fk`); set by the server at create, never changed |
| `name` | `varchar(255)` | no | | trimmed, 1–255 |
| `status` | `varchar(10)` | no | `'inactive'` | `live` · `inactive` |
| `trigger_type` | `varchar(15)` | no | | `comment` · `story_reply` · `dm` |
| `target_scope` | `varchar(10)` | no | `'any'` | `any` · `specific` · `next`; `next` only on `comment`, `dm` only `any` |
| `target_instagram_media_id` | `varchar(64)` | yes | | the `specific` post, or the post a `next` automation linked to; digits |
| `target_instagram_story_id` | `varchar(64)` | yes | | the `specific` story; digits |
| `next_post_starts_at` | `timestamptz` | yes | | set exactly when `next` |
| `next_post_ends_at` | `timestamptz` | yes | | set exactly when `next`; after the start |
| `next_post_status` | `varchar(10)` | yes | | `waiting` · `linked` · `expired`; set exactly when `next` |
| `next_post_linked_at` | `timestamptz` | yes | | set exactly when `linked` |
| `is_dm_keyword_trigger_enabled` | `boolean` | no | `true` | always `true` on `dm` (AU8) |
| `keywords` | `text[]` | no | `'{}'` | at most 50, lowercase, no null element; at least 1 on `dm` |
| `tags` | `text[]` | no | `'{}'` | at most 20, no null element |
| `is_public_reply_enabled` | `boolean` | no | `false` | only on `comment`, then 1–20 texts |
| `public_reply_texts` | `text[]` | no | `'{}'` | at most 20 |
| `is_opening_message_enabled` | `boolean` | no | `true` | on ⇒ `opening_message` set |
| `opening_message` | `jsonb` | yes | | §10 object; on `comment` with the opening message on, `button_title` set (AQ2) |
| `is_follow_required` | `boolean` | no | `false` | on ⇒ `follow_request_message` set |
| `follow_request_message` | `jsonb` | yes | | §10 object |
| `is_email_collection_enabled` | `boolean` | no | `false` | |
| `email_request_message` | `jsonb` | yes | | §10 object; null = the default question |
| `is_phone_collection_enabled` | `boolean` | no | `false` | |
| `phone_request_message` | `jsonb` | yes | | §10 object; null = the default question |
| `final_message` | `jsonb` | no | | §10 object, always (D19) |
| `completed_run_count` | `integer` | no | `0` | `≥ 0`; `+ 1` in SQL at each completion |
| `last_triggered_at` | `timestamptz` | yes | | the last run start |

Checks (`chk_automations_<rule>`): `status`, `trigger_type`, `target_scope`, `next_post_status` (value lists);
`name` (`char_length(btrim(name)) BETWEEN 1 AND 255`); `next_only_comment`; `dm_scope`; `dm_keyword_trigger`
(`trigger_type <> 'dm' OR is_dm_keyword_trigger_enabled`, **added**); `dm_needs_keywords`; `specific_target`
(`specific` + `comment` ⇒ media id, no story id; `specific` + `story_reply` ⇒ story id, no media id; `any` ⇒ neither;
`next` ⇒ no story id); `next_post_fields` (`(target_scope = 'next') = (next_post_status IS NOT NULL)`, the two window
ends set exactly then); `next_post_window` (end > start); `next_post_linked` (`(next_post_status = 'linked') =
(next_post_linked_at IS NOT NULL)`, and on `next` the media id is set exactly when linked); `keywords`, `tags`,
`public_reply_texts` (`cardinality` caps, `array_position(…, NULL) IS NULL`); `public_reply` (on ⇒ `comment` and at least
one text); `message_objects` (each message column null or `jsonb_typeof = 'object'`; `final_message` an object);
`enabled_steps_have_messages` (**added** — opening on ⇒ its object, follow on ⇒ its object); `comment_opening_button`
(**added**, AQ2 — `trigger_type <> 'comment' OR NOT is_opening_message_enabled OR jsonb_typeof(opening_message ->
'button_title') = 'string'`); `instagram_ids`
(`^[0-9]{1,64}$`); `completed_run_count` (`≥ 0`); the three soft-delete checks; `updated`.

Indexes (every one declared in `automation.schema.ts` too — the index-hygiene gate):

- `idx_automations_public_id` — unique `(public_id)`.
- `idx_automations_organization_id_id` — unique `(organization_id, id)`: the parent key of the runs' and comment logs' composite references; it also serves the organization cascade.
- `idx_automations_organization_id_instagram_account_id` — `(organization_id, instagram_account_id)` (**added**, AU27): the account reference (`be-sql-design-guard` — every foreign key indexed; not partial, so it covers soft-deleted automations too) and the list's `instagram_account_id` filter.
- `WHERE deleted_at IS NULL`, one per sort, each serving both directions: `idx_automations_organization_id_created_at_id` `(organization_id, created_at, id)`, `idx_automations_organization_id_name_id` `(organization_id, name, id)`, `idx_automations_organization_id_last_triggered_at_id` `(organization_id, last_triggered_at, id)` and `idx_automations_organization_id_completed_run_count_id` `(organization_id, completed_run_count, id)` (the last two: AQ9). With the `instagram_account_id` filter they read the organization's few automations and drop the other account's — no per-account sort index.
- `idx_automations_name_trgm` — `USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL` (`pg_trgm` is installed).
- `idx_automations_live_triggers` — `(organization_id, instagram_account_id, trigger_type) WHERE status = 'live' AND deleted_at IS NULL`: the candidates of each event, of the event's account only (AU16, AU27).
- `idx_automations_target_media` — `(organization_id, instagram_account_id, target_instagram_media_id) WHERE target_instagram_media_id IS NOT NULL AND deleted_at IS NULL`: a comment's post-linked automations (AU16), and "already targeted" (AU15).
- `idx_automations_next_post_waiting` — `(organization_id, instagram_account_id, next_post_ends_at) WHERE next_post_status = 'waiting' AND deleted_at IS NULL`: linking and the overlap check, per account (AU9, AU15).
- `idx_automations_next_post_expiry` — `(next_post_ends_at) WHERE next_post_status = 'waiting' AND deleted_at IS NULL` (**added**): the 15-minute scan across organizations.
- `idx_automations_tombstoned` — `(deleted_at) WHERE deleted_at IS NOT NULL` (the `tenancy.roles` shape): the purge (AQ7).
- `idx_automations_created_by_user_id`, `idx_automations_updated_by_user_id` — `WHERE … IS NOT NULL`.
- **Dropped from the drop:** `idx_automations_next_post_keywords` (GIN on `keywords`) — the overlap check reads one organization's few waiting automations through `idx_automations_next_post_waiting`, and its "either has no keywords" arm is an `OR` a GIN index cannot serve; the index would only cost writes.

Foreign keys: `automations_organization_id_organizations_id_fk` (the repository's generated name),
`automations_instagram_account_fk` (AU27; the name follows sub-domain 1's convention), and the two user pointers (K6).
RLS: as 3.3 (`automations_tenant_isolation`). Branch: none. Partitioning: none (small, update-heavy).

#### 3.A.4 Permissions

| Code | Routes |
| --- | --- |
| `automation:read` | 11, 13 |
| `automation:create` | 12 |
| `automation:update` | 14 |
| `automation:delete` | 15 |

#### 3.A.5 Common to every route

As 3.5.

#### 3.A.6 Objects returned

**Automation**: `id` (`aut_…`), `instagram_account_id` (`iga_…`, **added**, AU27), `name`, `status`, `trigger_type`, `target_scope`, `target_instagram_media_id`,
`target_instagram_story_id`, `next_post_starts_at`, `next_post_ends_at`, `next_post_status`, `next_post_linked_at`,
`is_dm_keyword_trigger_enabled`, `keywords`, `tags`, `is_public_reply_enabled`, `public_reply_texts`,
`is_opening_message_enabled`, `opening_message`, `is_follow_required`, `follow_request_message`,
`is_email_collection_enabled`, `email_request_message`, `is_phone_collection_enabled`, `phone_request_message`,
`final_message` (never null, D19), `completed_run_count`, `last_triggered_at`, `created_by_user_id` /
`updated_by_user_id` (`usr_…` or null, resolved in one batch per page through `auth.resolve_user_public_ids_by_ids`,
as notifications do — `auth.users` is FORCE RLS), `created_at`, `updated_at`. Every value list typed as its list
(D19). Internal ids and the soft-delete columns are never returned.

#### 3.A.7 Routes (11–15)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 11 | GET | `/automations` | List automations | `automation:read` | |
| 12 | POST | `/automations` | Create one (also the Duplicate button) | `automation:create` | req |
| 13 | GET | `/automations/{automation_id}` | Get one | `automation:read` | |
| 14 | PATCH | `/automations/{automation_id}` | Edit it, turn it on or off | `automation:update` | |
| 15 | DELETE | `/automations/{automation_id}` | Delete it with a reason; cancels its open runs | `automation:delete` | |

#### 3.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 11 | `q` (1–200; the name, any case), `status` (`live` \| `inactive`), `trigger_type` (`comment` \| `story_reply` \| `dm`), `target_scope` (`any` \| `specific` \| `next`), `next_post_status` (`waiting` \| `linked` \| `expired`), `instagram_account_id` (`iga_…`, one account; default every account — AU27), `sort` = `created_at` (default) \| `name` \| `last_triggered_at` \| `completed_run_count` (AQ9), `order` = `asc` \| `desc` (default newest / most first; `name` A→Z), `limit` (1–100, default 25), `after` | — | Automation[] |
| 12 | — | `name*`, `trigger_type*`, `final_message*` (`{ text* 1–1000, links 0–3 of { title* 1–20, url* https:// } }`); optional: `status` (default `inactive`), `target_scope` (default `any`), `target_instagram_media_id`, `target_instagram_story_id`, `next_post_starts_at`, `next_post_ends_at` (ISO 8601 with offset), `is_dm_keyword_trigger_enabled` (default `true`), `keywords`, `tags`, `is_public_reply_enabled` (default `false`), `public_reply_texts`, `is_opening_message_enabled` (default `true` — so a body that leaves it on sends `opening_message`), `opening_message` (`{ text* 1–1000, button_title 1–20 \| null }`; `button_title` required on a `comment` automation while the opening message is on — AQ2), `is_follow_required`, `follow_request_message` (`{ text* 1–1000, following_button_title* 1–20, profile_button_title* 1–20 }`), `is_email_collection_enabled`, `email_request_message` (`{ text* 1–1000 }` \| null), `is_phone_collection_enabled`, `phone_request_message` (`{ text* 1–1000 }` \| null). No `instagram_account_id` — the server sets it from the connected account (AU27) | Automation |
| 13 | — | — | Automation |
| 14 | — | any field of 12 (at least one besides `expected_updated_at` — `errors:validation.sendAtLeastOneField`); `null` clears a nullable message or id; `expected_updated_at`; never `instagram_account_id` (AU27) | Automation |
| 15 | `reason*` = `mistake` \| `duplicate` \| `not_needed` \| `other` (AQ6), `note` (1–280; required for `other`) | — | 204 |

#### 3.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 11 | `400` · `q` / `status` / `trigger_type` / `target_scope` / `next_post_status` / `sort` / `order` / `limit` / `after` | a bad value or an unknown parameter |
| 11 | `400` · `instagram_account_id` | not a well-formed id; an unknown one is an empty page (AU27) |
| 12, 14 | `400` · `target_scope` | `next` on a non-comment trigger; not `any` on `dm` |
| 12, 14 | `400` · `target_instagram_media_id` / `target_instagram_story_id` | `specific` without its id, the other id given, an id on `any`, a media id sent on `next`, not digits |
| 12, 14 | `400` · `keywords` | `dm` without a keyword; more than 50; an item outside 1–100 |
| 12, 14 | `400` · `is_dm_keyword_trigger_enabled` | `false` on `dm` (AU8) |
| 12, 14 | `400` · `is_public_reply_enabled` / `public_reply_texts` | on for a non-comment trigger; on without 1–20 texts; a text outside 1–300 |
| 12, 14 | `400` · `opening_message` / `follow_request_message` | the step is on and its object is missing — one `errors[]` item per missing object |
| 12, 14 | `400` · `opening_message.button_title` | a `comment` automation with the opening message on and no button title (AQ2, D26) |
| 12, 14 | `400` · `final_message` | missing or null (D19); more than 3 links |
| 12, 14 | `400` · a message field (`opening_message.text`, `final_message.links`, …) | an unknown key inside a message object, a text outside 1–1000, a title outside 1–20, a link not `https://` |
| 12, 14 | `400` · `next_post_starts_at` / `next_post_ends_at` | a date missing, not valid, the end not after the start, the start before 24 hours ago or the end in the past (when new or changed), a started window moved earlier (AU9) |
| 12 | `409` · `instagram_not_connected` | the organization has no connected (not revoked) Instagram account — passes once one connects (AU27) |
| 12, 14 | `409` · `next_post_window_overlap` | another live waiting automation of the same Instagram account overlaps and shares a keyword, or either has none (AU9, AU27) |
| 14 | `409` · `next_post_already_linked` | the window, `target_scope` or a target id changes on a linked automation |
| 14 | `409` · `record_changed` | `expected_updated_at` is older than the stored row (AU11) |
| 12, 14 | `400` | a read-only field (unknown key — `instagram_account_id` included, AU27); route 14: an empty body |
| 15 | `400` · `reason` / `note` | missing or unknown reason; `other` without a note; a note over 280 |
| 13–15 | `400` · `automation_id` | not a well-formed id |
| 13–15 | `404` · `automation_not_found` | missing, deleted or another organization's |
| 11, 13 | `404` · `team_organization_required` | a personal organization (AU3) |
| 12, 14, 15 | `422` | a personal organization (AU3); route 12: `X-Idempotency-Key` missing or reused (K3) |
| 12, 14, 15 | `403` · `organization_read_only` | the organization's plan is read-only (AQ8, D26; the read-only preHandler on routes 12, 14, 15 — AUC3) |
| 11–15 | `403` · `missing_permission` | the caller lacks the gate (a Member on route 15) |

#### 3.A.10 Rules worth knowing

- The frontend's **Duplicate** reads one automation and posts it to route 12 (§6.8); a copied `next` window must
  still pass AU9, a copied linked automation arrives `waiting` (the server sets the status), and the copy belongs to
  the account connected now, which may not be the original's (AU27).
- After a switch to another Instagram account the old account's automations stay in the list (filter by
  `instagram_account_id`), editable and deletable, but they never run (AU27).
- The overlap `409` is a conflict, so it carries no `errors[]` — the drop's error example mixes a `400` body with this
  reason (§2); the frontend branches on `reason`.
- An automation's internal id is what runs and comment logs point at; its public id is in button payloads
  (`<aut_…>::<run_…>`, §5.6), so a deleted automation's buttons resolve to `automation_not_found` inside the engine and
  the click is ignored.

#### 3.A.11 Code changes

| # | Change |
| --- | --- |
| AUC5 | AU7, AU8, AU9, AU11, AU27: `app.automations` in the new migration — columns (with `instagram_account_id` and `automations_instagram_account_fk`, AU27), checks (with `comment_opening_button`, AQ2), indexes and RLS as 3.A.3 — and `automation.schema.ts` on `appSchema` declaring every index, check and the `pgPolicy`; the create reads the organization's not-revoked account through sub-domain 1's account service and answers `409 instagram_not_connected` without one (the reason and its key are sub-domain 1's, reused); the serializer's `instagram_account_id` (`iga_…`); `{ schemaName: 'app', tableName: 'automations' }` in `EXPECTED_FORCE_RLS_TABLES`; the DTOs (`.strict()` message schemas shared by create and edit, `trimmedStringMinMax`, `httpsLinkSchema`, `expectedUpdatedAtSchema`), `validateAutomationFlow` on the merged automation, the serializer; i18n keys in `src/shared/locales/en/errors.json` (and `es`): `automationNotFound`, `nextPostWindowOverlap`, `nextPostWindowOverlapAnyComment`, `nextPostAlreadyLinked`, `validation.nextPostDatesRequired`, `.nextPostDatesInvalid`, `.nextPostEndBeforeStart`, `.nextPostStartInPast`, `.nextPostEndInPast`, `.nextPostStartMovedEarlier`, `.messageObjectRequired`, `.nextScopeOnlyForComments`, `.dmScopeOnlyAny`, `.specificNeedsTarget`, `.dmNeedsKeyword`, `.dmKeywordTriggerRequired`, `.publicReplyOnlyForComments`, `.openingButtonRequired` (AQ2); the reasons `automation_not_found`, `next_post_window_overlap`, `next_post_already_linked` registered in `docs/reference/api/response-codes.md`; the `AUTOMATION_NEXT_POST` advisory-lock namespace in `resource-quota-lock.util.ts` |
| AUC6 | AU13, AQ9, AU27: `listAutomationsQueryDto` (`listSearchSortSchema(['created_at', 'name', 'last_triggered_at', 'completed_run_count'] as const)` + the five filters, `instagram_account_id` resolved inside the organization — unknown → an empty page) registered in `tooling/openapi/query-schema-map.ts`; the repository list with `resolveKeysetSort`, `buildSearchCondition` and `finishKeysetPage`; a nulls-last timestamp kind and an integer kind in `resolveKeysetSort` and the keyset builders (one change with sub-domain 2's CTC4 — whichever builds first lands it, the other reuses it); routes 11 and 13 |
| AUC7 | AU12, AQ6: route 15 with `recordDeleteQuerySchema`; the soft delete and the run service's `cancelAutomationOpenRuns` in one unit of work; `cancelled_run_count` in the audit metadata |
| AUC8 | AU15, AQ4, AU27: `linkNextPostAutomations` in the automation service (the lock, one conditional `UPDATE` limited to the post's Instagram account, run by sub-domain 4 in a savepoint); the next-post expiry worker in `automation/workers/` (`automation-next-post-expiry` queue, cron every 15 minutes, a batch of 500, scan then per-organization update) |
| AUC9 | Seeds and tests for the root: bulk seed in `automation/seed/` (automations per team organization across every trigger and scope); unit (DTOs, `validateAutomationFlow` rule by rule, the window rules with a fixed clock, the serializer); integration (each route's success and each error in 3.A.9, the overlap `409` under two concurrent saves, no overlap across two accounts, create without a connected account `409`, the account set at create and kept by an edit, the `instagram_account_id` filter, Member `403` on 15, read-only `403` on 12, 14, 15 with 11, 13 still open, another organization's id `404`, personal organization `404` / `422`, each sort in both directions across pages, `q`); an RLS security test as `meepzo_be_app` and the `test:rls-role` lane; `pnpm routes:catalog`, the success statuses (`200`, `204`), OpenAPI examples |

---

### 3.B Automation runs — `automation/automation-run/` — final

#### 3.B.1 Decisions

| # | Decision |
| --- | --- |
| AU16 | **What starts a run, and which automation** (AQ1 — your rule, D26). Today: the drop's §6.5 table runs **every** matching comment automation; legacy PRD §7–§8. Every event matches only the automations of **its own Instagram account** (AU27); "oldest" is `created_at`, then `id`. → **comment** — matched by account + post + keyword: the eligible automations are the account's live `comment` automations whose keywords the lowercased text contains (none = every comment) and whose target is this post. (1) **Post-linked first**: `specific` on this post, or a `next` linked to it (both: `target_instagram_media_id` = the post; a `next` still `waiting` or `expired` matches nothing) — the oldest match is chosen. (2) **Only when none of them matches**, the `any` automations — the oldest match is chosen. The chosen automation goes through AU17 (it starts or resumes a run, or is logged with its own AU17 reason — the next match is not tried); **every other matching automation**, of either kind, gets a comment log `ignored` · `comment_already_answered` (AU24) — never `failed`, never a run. Automations of other posts and non-matching ones get nothing. The choice and every log of the comment are written in one short transaction at `keyword_match`, so a retried comment finds its logs and resumes the chosen run instead of choosing again. "Next post" linking runs first (AU15), so a just-linked automation counts as post-linked. **DM** (`message.text`, no story; a `messages` change too, D18): first a run of this contact (the contact is per account, CT13) waiting for an email or a phone takes it as the answer (email waits first, then the oldest wait); otherwise the **first** live automation of the account, any trigger, with `is_dm_keyword_trigger_enabled` and a keyword the text contains, oldest first (no keywords never matches a DM, §6.5). **Story reply**: the account's first live `story_reply` automation, `any` or `specific` on that story, whose keywords match, oldest first; an expired story simply stops matching (D18). **Button click** (`<aut_…>::<run_…>`): continues that run when it waits for `opening_message_button` or `follow` and its automation belongs to the event's account; a `completed`, `failed` or `cancelled` run, a running one, one of a deleted automation, or another account's ignores it (D18). Other option: when the chosen automation is held back by AU17, try the next match — the rule says the oldest match runs, so it is not taken. |
| AU17 | **One open run per automation × contact, and a trigger that meets a run** (§6.5 "Comment arriving while a run exists", D14). Today: the drop's unique open-run index. → checked for the automation AU16 chose (on a comment, only that one — the other matches are `comment_already_answered`), in this order: (1) **another run of the contact waits for an email** → the new trigger (comment or story reply) is saved on that run (AU21), the email question is asked again (D18 — as a private reply to the new comment, or a DM), comment log `ignored` · `waiting_for_other_email`; a click is not continued and the question is asked again (§6.5); (2) **this automation's run waits** → `already_waiting`; (3) **it is running** → `run_in_progress`; (4) **its last run is `completed` or `failed`** → `previous_run_final` — no second run for that contact (D14); a `cancelled` last run (deleted, 7-day wait) allows a new one. For DMs and story replies the same order applies, with no comment log. Once a final run is removed (180 days after it ended, D8) the contact may trigger that automation again. |
| AU18 | **The steps** (§6.5 "Run steps"; run `current_step` → comment-log step). Today: the drop's eight steps; legacy PRD §9. → 1 `keyword_match`: the run starts `running`, `last_triggered_at` set, comment log `started`. 2 `comment_reply`: on a comment, the **public reply** when reply safety allows (AU20) — a failure is logged and the flow goes on; then, on **every** trigger (AQ3, D26), the **opening message** — the private reply to the comment, a normal DM on DM and story triggers — skipped when the contact's `last_message_sent_at` is within 24 hours (D14); with a button the run waits for `opening_message_button`. 3 `follow_check`: when on, the follow read through the Instagram client; following → saved (`recordContactProfile`) and skipped; else the follow request (its "I'm following" button and the profile link built from the account's username) and a wait for `follow`; a click reads again — following continues, not following sends the request again. 4 `email_collect`: skipped when the contact has an email; else the question with the `user_email` quick reply, wait for `email`; the answer from the quick reply, an attachment's email or the typed text (D18) goes to `recordContactEmail` — `invalid` sends the wrong-email text and the question again. 5 `phone_collect`: the same with `user_phone_number`; `invalid` sends nothing and keeps waiting (legacy). 6 `final_dm`: the final message with up to 3 link buttons → `completed`, `completed_run_count + 1`, the automation's tags — or its name when it has none — through `addContactTags` (up to 255 characters, the contact's cap of 50 is sub-domain 2's, CT10). `findLiveContact` before each step stops a run whose contact was erased meanwhile (CT2). |
| AU19 | **A message is sent at most once — claimed before, recorded after** (D16; `queue-and-worker-rules.md` §5.4 "claim the row atomically, finish an already-done row as a skip"; §5.6 "no external call inside a database context"). Today: legacy logs "DUPLICATE RISK" and sends again (PRD §5). → every send is three steps: (a) a short `withAppDatabaseContext` locks the run (`FOR UPDATE`), sets `sending_message_kind` and `sending_started_at` (only when empty) and commits; (b) outside any context, the Instagram client sends (its 200–1000 ms pause, K10); (c) a short context records the result — **delivered**: the claim cleared, the step advanced, the comment log step `sent` with its time, a `status_changed` event when the status moves, `recordContactMessageSent` after a DM; **refused** (Instagram answered with an error): the claim cleared, then a temporary error is rethrown for sub-domain 4's capped retry and a permanent one fails the step; **unknown** (a timeout after the request left, a crash): the claim stays. Each run also keeps `last_instagram_event_key`, the event that last moved it. A retry of that event resumes from the saved step, never re-sending: a run whose claim is still set fails the step (AQ5). On the event's **last** attempt (`isLastAttempt`, passed by sub-domain 4) a temporary error fails the run instead of rethrowing, so no run stays `running`. Because every failure is written in its own short transaction, a DM or story-reply run keeps its error after any rollback (D16). (rev 2, D47) An event that ends `failed` (a fifth failed try, `processing_attempts_exhausted`, a permanent or token failure) also fails the runs it left `running` — matched by `last_instagram_event_key` — in one short unit with a `status_changed` event and the comment log's failure, so no run stays `running`. (rev 3, D51) The same when the event ends `skipped` on a later try. |
| AU20 | **Public reply safety** (D17, §6.5 step 2). Today: legacy counts in Redis with one Lua step because five workers of one account ran at once (PRD §11); the repository's `incrementWithExpiryOnFirst` is a fixed window only. → checked only when the account's `is_public_reply_safety_enabled` is on (sub-domain 1's settings), in the order **duplicate** (the comment already got a public reply from this account — any comment log of it `sent`) → **random** (reply when a draw under 100 < `public_reply_chance_percent`) → **hour limit** (the organization's public replies `sent` in the last 60 minutes ≥ `public_reply_hour_limit`) → **gap** (the last one is closer than a gap drawn between `public_reply_gap_min_seconds` and `_max_seconds`); the first that applies is saved as `public_reply_skip_reason`. The counts come from **comment logs in Postgres**: events of one account run in order (D15), so no two replies race and the count is exact; Postgres is the only source of truth, no new Redis script, and the "counts unreadable → reply anyway" rule (D17) has nothing to guard. Always (safety on or off): never the automation's last reply text (picked at random among the others). The DM is never held back. Other option: the brief's Redis counts — a sliding-window Lua beside `redis-counter.util.ts`, failing open. |
| AU21 | **Automations queued behind an email** (§10, WC-5). Today: the drop's `queued_automations` shape; legacy starts them at the final DM (PRD §9). → `[{ automation_id: "aut_…", queued_at, trigger: { type, instagram_media_id?, instagram_comment_id?, instagram_story_id?, text } }]` validated by a `.strict()` Zod schema before every save; public ids only (queue rule §3.1); **one entry per automation** (a second trigger for a queued automation is logged but not added), so the list is bounded by the organization's automations (a backstop check ≤ 100). When the email arrives (the drop, WC-5): each entry starts as its own run, in order — skipped when the automation is no longer live, was deleted, or already has a run for the contact (AU17) — and its comment log moves from `ignored` to `started` with the new run (same comment × automation row). The email step of those runs is then skipped (the contact has it). A run cancelled after 7 days, or by a delete, an erase or a disconnect, starts none of its entries (WC-13). |
| AU22 | **Default texts in English through i18n** (D20, §6.5 "Default texts"). Today: user-facing copy is in `src/shared/locales/en/` namespaces `common`, `errors`, `success`, `mail`; in-app notification copy is `common:notifications.*`. → `common:automationMessages.emailQuestion`, `.phoneQuestion`, `.invalidEmail`, `.buttonTemplateText`, `.linkButtonTitle` with the drop's English (the same keys in `es` for parity), read by the worker with `i18next.getFixedT('en')` — every DM in English. Used when a saved message has none: the email and phone questions (nullable objects, §10) and the wrong-email text; the button-template text and link title are fallbacks only, since §10 requires a text and a title. When Instagram refuses the quick reply (code 100, subcode 2534015) the question goes again as plain text, under the same claim (a refusal means not delivered). Other option: a new `messages` namespace (`REQUIRED_NAMESPACES` grows). |
| AU23 | **Run events** (§8.11). Today: the drop's append-only ledger, `occurred_at`. → one row per status change (`status_changed` + the new status) and per email or phone collected (`email_received` / `phone_received` — the value lives on the contact, never here: the `db-changes.md` open item, confirmed), in the same short transaction as the run change; never updated (the repository writes inserts only); goes with its run (`ON DELETE CASCADE`). The time column is `created_at` (the repository's name; the drop's `occurred_at`), and it has no `updated_at` — append-only, as `audit.logs`. |
| AU24 | **Comment logs and their references** (D21, §8.12). Today: the drop leaves `automation_run_id` and `contact_id` without a foreign key because "the run or contact may not be committed when the log is written". → with AU19's short transactions the contact (written by sub-domain 4 before the engine runs, `recordContactInteraction`) and the run are committed before or with the log, so both get composite references: `contact_id` **NOT NULL** → contacts `RESTRICT` (a contact is erased in place, never removed — CT7), `automation_run_id` nullable (an ignored comment has no run) → runs `ON DELETE SET NULL (automation_run_id)` (a run removed after 180 days leaves the log). A failed step still leaves its log — the failure is its own transaction. `waiting_for` names the button wait `opening_message_button` (D19, so `varchar(25)`); `overall_status` gains **`cancelled`** (a run cancelled by a delete, a wait or an erase); `ignored_reason` gains **`comment_already_answered`** (AQ1, D26 — another automation answers this comment, AU16). One log per comment × automation that matched — the chosen one and every other match; an automation that does not match, and a comment that matches none, has none. Other option: the drop's unreferenced columns. |
| AU25 | **Background work on runs and logs** (D8). Today: `membership-invitation-expiry` (scan, then per-organization change) and `notification-retention` (`deleteInBatchesByCondition` under the retention context). → **waiting-run cancel**, hourly (WC-13 proposal): `waiting` runs whose `waiting_since_at` is more than 7 days old, scanned across organizations (a batch of 500), each cancelled in its organization's context after re-checking it still waits — `cancel_reason = wait_expired`, a `status_changed` event, its comment log `cancelled`, its queued entries dropped. **Run retention**, daily at 03:20 UTC: runs whose `ended_at` is more than 180 days old (their events cascade; comment logs keep their row with no run). **Comment-log retention**, daily at 03:30 UTC: logs written more than 180 days ago. **Deleted-automation purge** (AQ7), daily at 03:40 UTC: automations deleted more than 180 days ago — still referenced ones are skipped by the batch delete's foreign-key fallback and tried again the next day. Open runs are never removed. |
| AU26 | **Personal data, erase and disconnect** (K7, D22, CT8, worker-changes Q18). Today: sub-domain 2 erases a contact in place and runs each registered `ContactErasureStep` in the same transaction (CT7, CT8). → copies of personal data here: `trigger_text`, the `text` of queued triggers, and the comment log's `comment_text`, `commenter_instagram_user_id`, `commenter_username`, `email_received`, `phone_received` — masked in logs (their keys join sub-domain 2's `SENSITIVE_KEY_FRAGMENTS` change, CT12). **This sub-domain's erasure step** (`{ organizationId, contactId, instagramUserId }`): cancels the contact's `running` and `waiting` runs (`cancel_reason = contact_deleted`, one `status_changed` event each, `queued_automations` emptied), clears `trigger_text` on all its runs and the five comment-log copies on its logs — matched by `contact_id` alone, since every log now carries it (AU24), so CT8's `OR commenter_instagram_user_id` and its index are not needed. Instagram ids of posts, stories and comments stay (the duplicate rule needs them). **Disconnect** (route 4, Meta's deauthorize and data deletion — sub-domain 1): cancels nothing (IQ1, your call) — waiting runs continue on a reconnect of the same account, else the 7-day limit cancels them (`wait_expired`). |

#### 3.B.2 Open questions

None open — AQ1 (your rule: account + post + keyword, post-linked first, the oldest match runs), AQ3 (the opening
message on every trigger), AQ5 (an unknown send outcome fails the step), AQ7 (the deleted-automation purge) are
answered (3.2, D26).

#### 3.B.3 Tables and relations

`app.automation_runs` — standard columns as 3.3, plus `public_id varchar(28)` (`run_…`, in button payloads). No
`*_by_user_id` (the system writes it), no soft delete.

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `automation_id` | `bigint` | no | | `(organization_id, automation_id)` → automations `RESTRICT` (`automation_runs_automation_fk`) |
| `contact_id` | `bigint` | no | | `(organization_id, contact_id)` → contacts `RESTRICT` (`automation_runs_contact_fk`; contacts are erased in place, CT7) |
| `trigger_type` | `varchar(15)` | no | | `comment` · `story_reply` · `dm` |
| `trigger_instagram_media_id` | `varchar(64)` | yes | | digits; set on `comment` |
| `trigger_instagram_comment_id` | `varchar(64)` | yes | | digits; set on `comment` |
| `trigger_instagram_story_id` | `varchar(64)` | yes | | digits; set on `story_reply` |
| `trigger_text` | `text` | yes | | personal data; cleared by the erase (AU26) |
| `status` | `varchar(10)` | no | `'running'` | `running` · `waiting` · `completed` · `failed` · `cancelled` |
| `current_step` | `varchar(20)` | no | `'keyword_match'` | `keyword_match` · `comment_reply` · `follow_check` · `email_collect` · `phone_collect` · `final_dm` |
| `waiting_for` | `varchar(25)` | yes | | `opening_message_button` · `follow` · `email` · `phone` |
| `queued_automations` | `jsonb` | no | `'[]'` | AU21 shape; an array of at most 100 |
| `last_instagram_event_key` | `varchar(512)` | no | | **added** (AU19); as long as the webhook event key (4.B.3); the key of the event that last moved the run |
| `sending_message_kind` | `varchar(20)` | yes | | **added** (AU19); `public_reply` · `opening_message` · `follow_request` · `email_question` · `invalid_email` · `phone_question` · `final_message` |
| `sending_started_at` | `timestamptz` | yes | | **added**; set exactly when `sending_message_kind` is |
| `error_message` | `text` | yes | | why it failed |
| `cancel_reason` | `varchar(20)` | yes | | **added**; `automation_deleted` · `wait_expired` · `contact_deleted` (no `account_disconnected` — IQ1) |
| `started_at` | `timestamptz` | no | `now()` | |
| `last_step_at` | `timestamptz` | no | `now()` | |
| `waiting_since_at` | `timestamptz` | yes | | set exactly when `waiting` |
| `completed_at` | `timestamptz` | yes | | set exactly when `completed` |
| `failed_at` | `timestamptz` | yes | | set exactly when `failed` |
| `cancelled_at` | `timestamptz` | yes | | set exactly when `cancelled` |
| `ended_at` | `timestamptz` | | generated | **added**; `coalesce(completed_at, failed_at, cancelled_at)`, stored — the retention clock (D8) |

Checks (`chk_automation_runs_<rule>`): `trigger_type`, `status`, `current_step`, `waiting_for`, `sending_message_kind`,
`cancel_reason` (value lists); `waiting` (`(status = 'waiting') = (waiting_for IS NOT NULL AND waiting_since_at IS NOT
NULL)`); `completed`, `failed`, `cancelled` (each status ⇔ its time; `cancelled` ⇔ `cancel_reason` too); `sending`
(the two claim columns set together); `trigger_targets` (`comment` ⇒ media and comment ids, `story_reply` ⇒ story id);
`instagram_ids` (digits); `queued_automations` (`jsonb_typeof = 'array' AND jsonb_array_length <= 100`); `updated`.

Indexes:

- `idx_automation_runs_public_id` — unique `(public_id)`.
- `idx_automation_runs_organization_id_id` — unique `(organization_id, id)`: the parent key of run events and comment logs.
- `idx_automation_runs_one_open` — unique `(organization_id, automation_id, contact_id) WHERE status IN ('running', 'waiting')`: one open run (AU17); also the organization's open runs for a disconnect.
- `idx_automation_runs_automation_contact` — `(organization_id, automation_id, contact_id, started_at)`: the automation reference, "this automation's last run for this contact" (AU17) and the contacts filter (CT5).
- `idx_automation_runs_contact` — `(organization_id, contact_id, started_at)`: the contact reference and the erase step.
- `idx_automation_runs_contact_waiting` — `(organization_id, contact_id, waiting_for) WHERE status = 'waiting'`: a DM finding the run that waits for its answer.
- `idx_automation_runs_waiting_since` — `(waiting_since_at) WHERE status = 'waiting'`: the hourly 7-day scan across organizations.
- `idx_automation_runs_ended` — `(ended_at) WHERE ended_at IS NOT NULL`: run retention.
- **Dropped from the drop:** `idx_automation_runs_organization_started` — no route lists runs (D13); the organization cascade is served by the composite indexes.

`app.automation_run_events` — append-only: no public id (§4), no `updated_at`.

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `automation_run_id` | `bigint` | no | | `(organization_id, automation_run_id)` → runs `ON DELETE CASCADE` (`automation_run_events_automation_run_fk`) |
| `event_type` | `varchar(20)` | no | | `status_changed` · `email_received` · `phone_received` |
| `status` | `varchar(10)` | yes | | the new run status; set exactly for `status_changed` |
| `created_at` | `timestamptz` | no | `now()` | when it happened (the drop's `occurred_at`, AU23) |

Checks: `chk_automation_run_events_event_type`, `chk_automation_run_events_status` (the run status list, and
`(event_type = 'status_changed') = (status IS NOT NULL)`). Index: `idx_automation_run_events_automation_run`
`(organization_id, automation_run_id, created_at)` — the reference and a run's history. Dropped: the drop's
`(organization_id, occurred_at)` (no reads, D13; retention goes through the run's cascade).

`app.automation_comment_logs` — standard columns as 3.3, plus `public_id varchar(28)` (`acl_…`, unused until a read
route, D13). The drop's columns as §8.12, with these changes:

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `automation_id` | `bigint` | no | | `(organization_id, automation_id)` → automations `RESTRICT` (`automation_comment_logs_automation_fk`) |
| `automation_name` | `varchar(255)` | no | | the name at the time |
| `automation_run_id` | `bigint` | yes | | **referenced** (AU24): `(organization_id, automation_run_id)` → runs `ON DELETE SET NULL (automation_run_id)`; null when ignored |
| `contact_id` | `bigint` | no | | **referenced, not null** (AU24): `(organization_id, contact_id)` → contacts `RESTRICT` |
| `instagram_media_id`, `instagram_comment_id` | `varchar(64)` | no | | digits |
| `comment_text`, `commenter_username`, `commenter_instagram_user_id` | `text`, `varchar(64)`, `varchar(64)` | yes | | personal data; cleared by the erase (AU26) |
| `public_reply_status`, `opening_dm_status`, `follow_status`, `email_status`, `phone_status`, `final_dm_status` | `varchar(10)` | no | `'off'` | `off` · `sent` · `waiting` · `done` · `skipped` · `failed` |
| `public_reply_text` | `text` | yes | | the text sent |
| `public_reply_skip_reason` | `varchar(20)` | yes | | `duplicate` · `random` · `hour_limit` · `gap`; set exactly when the public reply is `skipped` (**added** check) |
| `public_reply_at`, `opening_dm_at`, `button_clicked_at`, `follow_at`, `follow_confirmed_at`, `email_at`, `phone_at`, `final_dm_at` | `timestamptz` | yes | | each step's time |
| `email_received`, `phone_received` | `varchar(255)`, `varchar(50)` | yes | | personal data; cleared by the erase (AU26) |
| `overall_status` | `varchar(10)` | no | `'started'` | `started` · `waiting` · `completed` · `failed` · `cancelled` (**added**, AU24) · `ignored` |
| `current_step`, `failed_step` | `varchar(15)` | yes | | `public_reply` · `opening_dm` · `follow_check` · `email_collect` · `phone_collect` · `final_dm` (kept apart from the run's list, D19) |
| `waiting_for` | `varchar(25)` | yes | | `opening_message_button` · `follow` · `email` · `phone` (D19; the drop's `button` and `varchar(10)` replaced) |
| `ignored_reason` | `varchar(30)` | yes | | `waiting_for_other_email` · `already_waiting` · `run_in_progress` · `previous_run_final` · `comment_already_answered` (**added**, AQ1, D26 — another automation answers this comment, AU16) |
| `error_type` | `varchar(15)` | yes | | `instagram_api` · `token` · `network` · `code` |
| `http_status`, `error_code`, `error_subcode` | `integer` | yes | | Instagram's answer |
| `error_message`, `error_reason`, `error_stack` | `text` | yes | | `error_stack` never returned |
| `fbtrace_id` | `varchar(100)` | yes | | |
| `error_response` | `jsonb` | yes | | Instagram's error body |
| `error_at` | `timestamptz` | yes | | set when a step failed |

Checks (`chk_automation_comment_logs_<rule>`): each status list, `overall_status`, `current_step`, `failed_step`,
`waiting_for`, `ignored_reason` (with `comment_already_answered`), `error_type`, `public_reply_skip_reason` (value lists); `ignored`
(`(overall_status = 'ignored') = (ignored_reason IS NOT NULL)`); `failed_has_error` (`overall_status = 'failed' ⇒
error_at IS NOT NULL`); `public_reply_skipped` (**added**); `instagram_ids` (digits); `updated`.

Indexes:

- `idx_automation_comment_logs_public_id` — unique `(public_id)`.
- `idx_automation_comment_logs_automation_comment` — unique `(organization_id, automation_id, instagram_comment_id)`: one log per comment × automation, and the automation reference.
- `idx_automation_comment_logs_comment` — `(organization_id, instagram_comment_id)`: the `duplicate` check (AU20).
- `idx_automation_comment_logs_automation_run` — `(organization_id, automation_run_id) WHERE automation_run_id IS NOT NULL`: the run reference (`SET NULL`).
- `idx_automation_comment_logs_contact` — `(organization_id, contact_id)`: the contact reference and the erase step.
- `idx_automation_comment_logs_public_replies` — `(organization_id, public_reply_at) WHERE public_reply_status = 'sent'`: the hour limit and the gap (AU20).
- `idx_automation_comment_logs_automation_public_replies` — `(organization_id, automation_id, public_reply_at) WHERE public_reply_status = 'sent'`: the automation's last reply text.
- `idx_automation_comment_logs_created` — `(created_at)`: comment-log retention across organizations.
- **Dropped from the drop:** `(organization_id, created_at)`, `(automation_id, created_at)`, `(organization_id, instagram_media_id)` — no reads (D13); the references now have the composite indexes above.

RLS on all three: as 3.3. Branch: none. Partitioning: none at launch — run events and comment logs are append-heavy
and time-pruned, but well under 10M rows (`be-sql-design-guard` E.3); revisit with `PARTITION BY RANGE (created_at)`
if they grow.

#### 3.B.4 Permissions

None — no routes (D13). The engine and the workers run under the job's organization scope, never as a person.

#### 3.B.5 Common to every route

No routes. Every operation in 3.B.8 takes the caller's organization scope and opens its own short contexts (AU5, AU19);
the workers follow AU6.

#### 3.B.6 Objects returned

None (D13). Internal shape only: the queued automation entry (AU21).

#### 3.B.7 Routes

None — runs and comment logs get read routes later (D13); the webhook-events list (sub-domain 4) is the debugging view.

#### 3.B.8 Request details

No routes; the operations other sub-domains call instead. `scope` is the caller's organization scope;
`instagramAccountPublicId` is the event's Instagram account (`iga_…`, from sub-domain 4's job) — every match is limited
to its automations (AU27); `event` carries `eventKey`, `occurredAt` and `isLastAttempt`; `contact` is the row
`recordContactInteraction` returned (sub-domain 2).

| Operation | Called by | Input | Result |
| --- | --- | --- | --- |
| `startCommentRun` | 4 — a comment, after the contact and the post are saved and `linkNextPostAutomations` ran | `scope`, `instagramAccountPublicId`, `contact`, `event` + `instagramCommentId`, `instagramMediaId`, `text`, `commenterUsername` | one automation chosen — post-linked first, the oldest match (AQ1, D26) — its run started or resumed, or its AU17 reason logged; every other match logged `ignored` · `comment_already_answered` (AU16–AU18, AU24) |
| `handleDirectMessage` | 4 — a DM or a `messages` change | `scope`, `instagramAccountPublicId`, `contact`, `event` + `text`, `quickReplyPayload`, `attachmentEmail` | the waiting run answered, or a run started, or nothing matched |
| `startStoryReplyRun` | 4 — a story reply | `scope`, `instagramAccountPublicId`, `contact`, `event` + `instagramStoryId`, `text` | a run started, or nothing matched |
| `handleButtonClick` | 4 — a postback | `scope`, `instagramAccountPublicId`, `contact`, `event` + `automationPublicId`, `runPublicId` | the run continued, or the click ignored (AU16) |
| `linkNextPostAutomations` (automation service, 3.A) | 4 — every comment, in a savepoint | `scope`, `instagramAccountPublicId`, `instagramMediaId`, `publishedAt` | the account's automations linked (AU15) |
| `cancelAutomationOpenRuns` | 3.A — route 15, same transaction | the automation's id | the count cancelled |
| the erasure step | 2 — route 10, same transaction (`ContactErasureStep`, CT8) | `organizationId`, `contactId`, `instagramUserId` | — (AU26) |
| `contactHadRunOfAutomation` (exported by `automation-run.schema.ts`) and `findAutomationIdForFilter` (automation service, deleted ones included) | 2 — the contacts list's `automation_id` filter (CT5) | the automation's internal id / its `aut_…` id | an `EXISTS` condition / the internal id or `null` (an empty page) |

#### 3.B.9 Errors

No routes; what each failure does inside the engine (sub-domain 4 marks the event).

| Failure | Classified by | What happens |
| --- | --- | --- |
| Temporary Instagram error (5xx, rate limit, a connection refused before sending) | the Instagram client (sub-domain 1) | claim cleared, error rethrown — sub-domain 4 retries the event (capped, D16); on the last attempt the run `failed` |
| Permanent Instagram error on a needed message (the person blocked messages, outside the messaging window, the comment gone) | the client | the step and run `failed`, error on the run and the comment log |
| Any error on the public reply | the client | `public_reply_status = failed`, the flow goes on (legacy, WC-3) |
| Token error (code 190) | the client | sub-domain 1 sets the account `error` and the reconnect notice (WC-11); the run `failed` with `error_type = token` |
| Unknown outcome (timeout after sending, a crash) | the claim left set (AU19) | the step `failed`, never re-sent (AQ5) |
| Contact erased meanwhile | `findLiveContact` returns `null` | the run stops without sending; the erase already cancelled it |
| Automation deleted or turned off meanwhile | the engine's read | a deleted one's run was cancelled with the delete; a turned-off one finishes (AU14) |
| A malformed `queued_automations` entry | its Zod schema | the entry is skipped and logged; the others start |

#### 3.B.10 Rules worth knowing

- **Which channel a DM uses** (Instagram's rules — confirm at kickoff): a normal DM when the person sent us a DM, a
  story reply, a quick reply or a button click in the last 24 hours; otherwise, on a comment run, a private reply to
  the comment (one per comment, within 7 days); otherwise it cannot be sent and the step fails. A comment does **not**
  open that window, but sub-domain 2's `last_message_received_at` counts comments too (CT10) — so this needs a contact
  time that counts only messages and clicks (AUC13 asks sub-domain 2 for `last_direct_message_received_at`).
- **The run's steps and the comment log's steps** keep two lists (D19): `keyword_match` → the log's start;
  `comment_reply` → `public_reply` then `opening_dm`; `follow_check`, `email_collect`, `phone_collect`, `final_dm` the
  same on both.
- **A retry never repeats a sent message, and never applies an event twice**: an event whose key is the run's
  `last_instagram_event_key` resumes the run from its saved step; a comment whose logs exist resumes the chosen
  automation's run, and the others stay logged as ignored — the choice is never made twice (AU16).
- **Status changes and their history**: every `running` ↔ `waiting` → `completed` / `failed` / `cancelled` writes one
  run event in the same transaction; an email or phone collected writes `email_received` / `phone_received`.
- **Reply-safety counts are per organization** (one connected account per organization, D5), the last-text rule per
  automation.
- **One comment, one automation** (AQ1, your rule, D26): two automations that match the same comment never both
  answer — a post-linked one beats an "any post" one, and between two of a kind the older one runs; the frontend may
  warn when two of an account's automations can match the same comment.
- **Nothing here holds a database context across an Instagram call** — each send is claim (short context) → call →
  record (short context).

#### 3.B.11 Code changes

| # | Change |
| --- | --- |
| AUC10 | AU16–AU22, AU24, AU27: the three tables in the new migration (columns, checks, indexes, references and RLS as 3.B.3 — `comment_already_answered` in the comment log's `ignored_reason` list) and `automation-run.schema.ts`, `automation-run-event.schema.ts`, `automation-comment-log.schema.ts` on `appSchema` with every index, check and `pgPolicy`; the three in `EXPECTED_FORCE_RLS_TABLES`; `AutomationRunService` (the entry points of 3.B.8, each limited to the event's Instagram account; `startCommentRun`'s choice — post-linked first, the oldest match — written with every log of the comment in one short transaction, AQ1), `AutomationRunMessageService` (composes each message, the defaults, the channel, claim → send → record), `AutomationPublicReplySafetyService` (AU20) and their repositories with `createWorkerAutomationRunRepository(databaseHandle)` factories; the `queuedAutomationSchema`; wired in `app.container.ts` |
| AUC11 | AU22: `common:automationMessages.*` in `src/shared/locales/en/common.json` and `es/common.json` |
| AUC12 | AU25, AQ7: four workers (the fifth, next-post expiry, is AUC8) — in `automation-run/workers/`: `automation-run-wait-expiry` (hourly, batch 500, scan then per-organization cancel), `automation-run-retention` (daily 03:20 UTC, runs by `ended_at`) and `automation-comment-log-retention` (daily 03:30 UTC, logs by `created_at`), both `deleteInBatchesByCondition`; in `automation/workers/`: `automation-tombstone-retention` (daily 03:40 UTC, AQ7); the constants `AUTOMATION_RUN_WAIT_MAX_DAYS = 7`, `AUTOMATION_RUN_RETENTION_DAYS = 180`, `AUTOMATION_COMMENT_LOG_RETENTION_DAYS = 180` (product rules from D8, not settings) |
| AUC13 | AU26, CT5, CT8: the erasure step registered in the app container (no run cancel for a disconnect — IQ1); **the contacts list's `automation_id` filter** (sub-domain 2's CT5, built here): the optional `automation_id` query param in `listContactsQueryDto` (non-breaking), `findAutomationIdForFilter` (unknown → empty page, malformed → `400`) and `contactHadRunOfAutomation` (an `EXISTS` on `idx_automation_runs_automation_contact`), with its integration tests; the comment-log keys (`trigger_text`, `comment_text`, `commenter_username`, `email_received`, `phone_received`) in sub-domain 2's `SENSITIVE_KEY_FRAGMENTS` change; asks sub-domain 2 for `last_direct_message_received_at` (3.B.10) |
| AUC14 | Tests and docs for the runs: unit (each step with a fake Instagram client; the comment choice of AU16 — a post-linked match beats an older "any post" one, the oldest of a kind wins, two linked "next post" automations, every other match `comment_already_answered`, another account's and another post's automations untouched, a retry choosing nothing new; every row of AU17; the claim → send → record cycle, a retry after each crash point sending nothing twice; reply safety order with a fixed random source; the queued-automation shape; the default texts); integration (an event fixture per trigger through sub-domain 4's processor; delete cancels open runs; the erase step clears every copy; the contacts `automation_id` filter); worker tests (a repeat changes nothing; a run that got its answer just before is not cancelled; retention keeps open runs); an RLS security test (another organization's run unreadable, the scans read but cannot write across organizations) and the `test:rls-role` lane; bulk seed in `automation-run/seed/` (runs in every status with events and comment logs); TSDoc with `@remarks` on every service, worker and processor; a `runs` / `comment logs` row in `docs/reference/data/data-lifecycle-deletion.md` |

---

Hand-over notes (for the plan owner; not part of the section):

- Confirmed 2026-11-21 ([D26](decisions.md)): AQ1 your rule (AU16, AU24 — `comment_already_answered`); each automation
  belongs to one Instagram account (AU27, new); AQ2–AQ9 the recommendation. `startCommentRuns` is renamed
  `startCommentRun` (one automation answers a comment), here and in the header's call table.
- Checks run: sections 3.1–3.12, 3.A.1–3.A.11 and 3.B.1–3.B.11 present; every table row matches its header; ids AU1–AU27,
  AQ1–AQ9, AUC1–AUC14 are unique and every cited one exists;
  routes 11–15 run without a gap, each with a gate and an Idem cell, the one `POST` `req`; every table states its RLS,
  its branch rule (none) and its pointers (no membership pointer; `*_by_user_id` → users `SET NULL`; automations →
  Instagram accounts `RESTRICT`, AU27).
- Sub-domain 1: aligned 2026-11-21 — the read-only preHandler is landed by this sub-domain for routes 12, 14, 15 only
  (AUC3, D27); § 1's 1.3 cross-reference now names the account links from contacts and automations; the header's
  Connections diagram shows them.
- Sub-domain 2: aligned at its confirmation (D25) — CT8 matches comment logs by `contact_id` alone and
  `last_direct_message_received_at` landed; only its 2.3 diagram still draws the comment-log link as `┄┄<` (no foreign
  key) where AU24 makes it a reference — outside this pass (§ 2 is final).
- Sub-domain 4 to align: call the engine outside any database context with the job's scope and the event's account
  (AU5, AU19, AU27); pass `isLastAttempt`; call `linkNextPostAutomations` in a savepoint before `startCommentRun` — its
  dispatch table's Comment row and WH13 now point at AU16 (D26).
- The change files are synced with this section (D26): `db-changes.md` (automation, automation_run,
  automation_run_event, automation_comment_log and the overview), `route-changes.md` (RC-7–RC-11, F4, F10, F14),
  `worker-changes.md` (WC-1, WC-3–WC-6, WC-9, WC-12, WC-13, the new WC-15 purge, the notes).

---

## 4. Instagram webhook — final (rev 6, confirmed 2026-11-22) — nested sub-domains 4.A–4.B

*rev 2 (2026-11-21, at R13's build, [D39](decisions.md)): the webhook verify token is optional and fails closed, like the other Instagram settings (WH7, WHC6).*

*rev 3 (2026-11-22, at R14's review, [D44](decisions.md), [D45](decisions.md)): a token refusal on a profile or post read breaks the account and fails the event (WH13, WH14); a temporary failure ends the claim's lease and keeps its attempt spent (WH12, WH14 — the 5-minute lease would stall the 5-second backoff); WHC10's failure, outage and skipped-event tests run the processor on the database.*

*rev 4 (2026-11-22, at the R15–R18 review, [D47](decisions.md)): an event marked `failed` also tells the run engine, which fails the runs the event left `running` (WH14, AU19).*

*rev 5 (2026-11-22, at the engine-fix review, [D51](decisions.md)): a skipped event (a retry's account check) also tells the run engine, which fails the runs the event left `running` (WH12, AU19).*

*rev 6 (2026-11-22, at the pre-merge review, [D53](decisions.md)): nothing is parsed before the signature passes and a missing signature header is refused at once (WH8); text with NUL or lone surrogates is cleaned before storing and one bad entry never stops the others (WH10); the 180-day and 256 constants are centralised.*

Code: the **`instagram-webhook` sub-domain folder** — `app/sub-domains/instagram-webhook/` (the receiver and event
processing at the folder root) with `instagram-webhook-event/`.

4.1 Decisions (whole sub-domain) · 4.2 Open questions · 4.3 Tables and relations · 4.4 Permissions · 4.5 Common to every route ·
4.6 Objects returned · 4.7 Routes · 4.8 Request details · 4.9 Errors · 4.10 Rules worth knowing · 4.11 Code changes (whole sub-domain) ·
4.12 Nested sub-domains · then **4.A Instagram webhook · 4.B Instagram webhook events** — each with the same eleven sections.

Meta calls two public routes: one to check the subscription (16) and one to deliver comments, DMs, story replies and
button clicks (17). Each event is stored once before Meta gets its answer; background work then turns it into contact
updates and automation runs, one Instagram account's events at a time, in order. The team reads what arrived and what
happened to each in a list (18). Design read: `schema-routes.md` §2 (webhook rules), §5.3, §5.6, §6.4–6.6, §7, §8.7,
§9; `PRD.md` §1–§6 and §12 (legacy — D14 and D15: the new design wins); decisions D1, D4, D8, D13–D22. Builds on
sub-domain 1 (the account, its settings, the Instagram client, posts), 2 (contacts) and 3 (automations and the run
engine). Route numbers run 16–18.

### 4.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation" — change any of them before you confirm. A decision that
belongs to one part is in its nested sub-domain.

| # | Decision |
| --- | --- |
| WH1 | **Folder and names.** Today: nothing Instagram exists; the Stripe receiver is one flat folder (`billing/sub-domains/stripe-webhook/`: routes, ledger, workers) because it has no list route; notify nests `webhook/webhook-event/` and `webhook/webhook-delivery/` inside `webhook/`. → the folder `instagram-webhook/` holds the receiver (routes 16–17) and event processing at its root, with **no table of its own**; the nested `instagram-webhook-event/` owns `app.instagram_webhook_events` (D1), route 18 and the clean-up — mirroring notify's `webhook/` layout. The split earns its folder (`src/domains/CLAUDE.md`: flatten only when a nested folder has no distinct routes or tests): 16–17 are public Meta routes proved by a token or a signature, 18 is a signed-in list with its own permission, query DTO, serializer and tests. Every event row is written through the nested sub-domain's service; the root never holds the table's SQL. Public-id entity `instagram_webhook_event`, prefix `iwe` (free today); no path id. Other option: one flat `instagram-webhook/` folder like Stripe's, the list inside it. |
| WH2 | **One raw-body registry for both receivers.** Today: the registry is Stripe-named (`stripe-webhook-raw-body.registry.ts`), filled by an `onRoute` hook inside the Stripe routes file, and `src/app.ts` keeps the raw body only when the URL is registered **and** the request carries `stripe-signature`. → one registry in `src/shared/utils/http/` that records each route's URL with its own signature header (`stripe-signature`, `x-hub-signature-256`), filled by one app-level `onRoute` hook from the route config (`captureRawBody` + a new `rawBodySignatureHeader`); the parser keeps the raw body when the request carries that route's header. On a registered route the parser no longer refuses a body that is not JSON — it leaves the body empty, so the signature is checked first and the receiver decides (WH10); Stripe's outcome does not change (its plugin parses the raw bytes itself and still answers `400`). The Stripe registry, its unit test and its body-limit constant move into the shared one **in the same change** — never two registries (root `CLAUDE.md` › Reuse before you create). |
| WH3 | **Finding the organization opens no other organization's data (K5, D21).** Today: the Stripe receiver writes a system ledger with no tenant RLS, then finds the organization through SECURITY DEFINER resolvers that return only an organization public id (`billing.resolve_organization_public_id_for_stripe_subscription` / `_customer`) and works under `PRINCIPAL_SCOPE.JOB` (`stripe-webhook-organization.util.ts`). → the same pattern in three places: (1) the receiver calls **sub-domain 1's resolver** (Instagram user id → organization public id, account public id and the account's two Instagram ids, for the one account that is not `revoked`; `SET search_path`, `REVOKE … FROM PUBLIC`, `GRANT` to `meepzo_be_app` and `meepzo_be_maintenance`) and stores the events under `PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId })` — a signed Meta delivery is a flow-proved id, entered in the verified-usage ledger test; (2) processing runs under `PRINCIPAL_SCOPE.JOB` from the job's `organizationPublicId` (K8); (3) the two cross-organization sweeps (stuck events, clean-up) read ids only under `runGlobalRetentionWorkerJob` and add their jobs after the context closes, as `webhook-delivery-reclaim` does. The events table is an ordinary tenant table (K5), not a system ledger like Stripe's, because route 18 lists one organization's rows. |
| WH4 | **Events for an account no organization has are not stored** (WQ1). Today (drop §8.7): kept with no organization, skipped `unknown_account`, never listed. → the receiver logs one line per such entry (`instagram.webhook.unknown_account`: the Instagram user id and the event count, never the payload), counts it in a metric, and still answers `200`, so Meta does not retry. A `revoked` account (disconnected, D5, D22) is treated the same — no organization holds it any more; an `expired` or `error` account still belongs to its organization, and its events are stored `skipped account_disconnected`. Why: nobody can ever read such rows, they hold strangers' messages that no organization answers for, and a nullable `organization_id` would make this the one table outside K5 (an RLS arm for rows with no organization). `unknown_account` leaves the skip-reason list. Other option: the drop — keep them with no organization, plus that RLS arm. |
| WH5 | **Background work layout (K8, D15, D21).** Today: the legacy made a queue and a worker per account on demand, 5 events at once and out of order (PRD §4–§5); the repository has a fixed queue catalog and worker registry, so that cannot be copied. → three pieces in the worker registry under a new worker family `instagram` (beside `stripe`): **event processing** (throughput, built with `createProviderPausableWorker` on sub-domain 1's `instagram` circuit — an Instagram outage pauses the queue on every replica and spends no attempt); the **stuck-event pick-up** (a second job name on the same queue, the `subscription-seat-reconcile` pattern — no worker or connection budget of its own); the daily **clean-up** (`retentionDefinition`). **One account at a time, in order, with a fixed registry:** every processing job means "work through this account's waiting events", deduplicated per account with `keepLastIfActive` and a unique job id — the `subscriptionSeatSyncDeduplication` pattern (be-workers-events › per-aggregate ordering): while the account's job waits, more adds are dropped; while it runs, one follow-up job is kept; two replicas never run one account at once. The job reads the events from Postgres oldest first, so Redis never holds the order. Different accounts run side by side up to the family's concurrency (`WORKER_CONCURRENCY_INSTAGRAM`, falling back to `WORKER_CONCURRENCY`). No database context is held across an Instagram call (queue rules §5.6). |
| WH6 | **Personal data, audit, who did it.** No `*_by_user_id` column — nobody signed in acts here (K6). No audit entry — events are not team actions, as with the Stripe receiver (K9). Logs carry the request id, Instagram ids, kind, key, status and counts — never the payload, message or comment text, emails or phone numbers (K7, D21). No message-text key is added to `SENSITIVE_KEY_FRAGMENTS` (contacts CT12 offers it): that list matches by substring, so `text` would also redact every `context` key — the payload is simply never logged. Route 18 masks the payload it returns (WH17); a contact erase leaves that person's events to the 30-day clean-up (WH18); everything goes after 30 days (WH19). |

### 4.2 Open questions

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| WQ1 | Events for an Instagram account no organization has (and for a `revoked` one): keep them? | not stored — a log line and a metric · keep with no organization, never listed (the drop) | **not stored** — nobody can read them, they hold strangers' messages, and they would need an RLS arm for rows with no organization (WH4) |
| WQ2 | Route 18's `payload`: what does an Owner or Admin see? | the event as received with personal data masked · as received · left out (as notify's delivery-attempts list leaves `payload` out, sec-r4-D6) | **masked** — the debugging view keeps its shape; message text, emails, phone numbers and media links never leave the server in full (WH17) |
| WQ3 | When one event keeps failing, do the same account's later events wait? | wait until it is done or `failed` (strict order) · skip ahead and come back to it | **wait** — order keeps a contact's steps right (an email answer after its question, a click after its message); the wait is at most about 1–2 minutes before the event is `failed` (WH14) |
| WQ4 | A DM the team sends by hand from the Instagram app comes back as an `echo`. Should it count for the 24-hour opening-DM rule (D14)? | no — skip it, as the drop (D19) · yes — the echo refreshes the contact's last-DM-sent time | **no, for launch** — keeps echoes out of processing (every automated DM also comes back as an echo); a known gap: a comment soon after a hand-sent DM can still get the opening DM |

**Answered 2026-11-21** ([D28](decisions.md)): WQ1–WQ4 the recommendation — events of an account no team holds (or a
revoked one) are not stored; route 18 shows the payload masked; a failing event holds back its account's later events
until it is done or `failed`; a hand-sent DM's echo is skipped and does not reset the 24-hour rule at launch.

### 4.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.instagram_webhook_events` | one event from a Meta delivery, as received, with what happened to it | one row per account and event key (WH9); status `received` → `queued` → `processed` · `skipped` · `failed` (WH12); deleted after 30 days (WH19) — a contact erase leaves it (WH18); no soft delete |

```text
tenancy.organizations
   │
   └──< app.instagram_accounts (1) ──< app.instagram_webhook_events      every event received for the account (WH16)

A ──< B   one A has many B     ┄┄  matched by value, no foreign key
```

Pointing at it from other sub-domains: nothing. A contact erase (2) does not reach it — the person's events expire with the rest (WH18, contacts CQ1).

**PostgreSQL design**

Standard columns (K5): `id bigint` (identity), `public_id varchar(28)` unique, `organization_id bigint` →
organizations `ON DELETE CASCADE`, `created_at` / `updated_at timestamptz`; RLS enabled and forced. No
`*_by_user_id` (WH6), no soft delete (a 30-day log). The table's design is in 4.B.3.

### 4.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `instagram-webhook-event:read` | Instagram webhook events · View | the received-events list — the debugging view (D13) | 18 | Owner, Admin — not Member (D4) |

Routes 16 and 17 are PUBLIC: Meta proves itself with the verify token (16) and the `X-Hub-Signature-256` signature
(17). The catalog row, the presets and the backfill for the new code land with sub-domain 1 (K4); this sub-domain adds
the constant to the app domain's permissions file.

### 4.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (D1, D20); mounted under `/social/instagram` beside sub-domain 1's routes |
| Meta routes (16, 17) | PUBLIC: no `Authorization`, no organization, no CSRF check, no `X-Idempotency-Key` (K3 — Meta's own ids make a repeat safe). Meta's names pass through as received (`hub.mode`, `object`, `entry`, …) and unknown Meta fields are accepted (the third-party exception of the body-key rule). Success is `200 text/plain` — the challenge, or `OK` — not `{ data, meta }` |
| Signed-in route (18) | K1, K2: `Authorization: Bearer <access token>`, organization from the token, team only (a personal organization → `404 team_organization_required`); list `{ data: [...], meta: { request_id, pagination: { per_page, next, has_more, estimated_total } } }` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` from the error handler on every route, Meta's too (Meta reads only the status) — `400`, `401`, `403`, `404`, `413`, `415`, `429`, `503` |

### 4.6 Objects returned

| Object | Where |
| --- | --- |
| Instagram webhook event | 4.B.6 — Instagram webhook events |
| Plain text: the echoed challenge (16), `OK` (17) | 4.A.6 — Instagram webhook |

### 4.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 16 | GET | `/social/instagram/webhook` | Meta's subscription check | PUBLIC (verify token) | |
| 17 | POST | `/social/instagram/webhook` | Receive comments, DMs, story replies and button clicks | PUBLIC (`X-Hub-Signature-256`) | |
| 18 | GET | `/social/instagram/webhook-events` | List received events and what happened to each | `instagram-webhook-event:read` | |

### 4.8 Request details

In each nested sub-domain (4.A to 4.B, section .8).

### 4.9 Errors

Every route can answer the errors in 4.5; each route's own errors are in its nested sub-domain (4.A to 4.B, section .9).

### 4.10 Rules worth knowing

What one action sets off (same request or transaction unless marked worker):

```text
17 receive ─────────────► each event stored once (4.B) · the account's processing job added
   [worker] process ────► 2 contact upsert (+ profile read when new) · 1 post stored · 3 "next post" link · 3 run engine
                          (every send through 1's Instagram client)
   [worker] every minute ► pick up events still received/queued after 5 minutes
   [worker] 03:00 UTC ──► delete events received more than 30 days ago
10 erase contact (2) ───► nothing here — that person's events expire after 30 days (WH18)
```

- A skipped event is never processed later — not even when the automation switch is turned back on (PRD §6, D14).
- An event's status says how its **handling** went, not how a run went: the event is `processed` once its handling
  finished; a run that could not send shows that on the run and its comment log (sub-domain 3).
- No route writes an event; only Meta's delivery creates one.

### 4.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| WHC1 | WH1: folders `app/sub-domains/instagram-webhook/` and `…/instagram-webhook-event/`; the root routes plugin (routes 16–18, as notify's `webhook.routes.ts` also registers its nested `/webhook-events`) mounted by the app domain's routes at `/social/instagram`; `PUBLIC_ID_PREFIXES.instagram_webhook_event = 'iwe'`; OpenAPI tag `Instagram Webhook`; `instagram-webhook.overview.md` and `instagram-webhook-event.overview.md` (with the event lifecycle diagram); the `app` row of the sub-domain map in `src/domains/CLAUDE.md`; TSDoc on every export |
| WHC2 | WH2: `stripe-webhook-raw-body.registry.ts` → `src/shared/utils/http/raw-body-route.registry.ts` (`registerRawBodyRoute({ url, signatureHeader })`, `findRawBodySignatureHeader(url)`, `listRawBodyRoutes()`); one `onRoute` hook in `src/app.ts`; `FastifyContextConfig.rawBodySignatureHeader` in `src/fastify.d.ts`; `shouldCaptureRawBody` checks the route's own header; on registered routes the JSON parser leaves an unreadable body empty; the Stripe routes drop their own hook; `stripe-webhook-raw-body.registry.unit.test.ts` and `stripe-webhook-ingress.policy.unit.test.ts` move or widen with it; `STRIPE_WEBHOOK_BODY_LIMIT_BYTES` → a shared `WEBHOOK_INGRESS_BODY_LIMIT_BYTES` (5 MB) both receivers use; the message `errors:stripeWebhookVerificationFailed` → `errors:webhookSignatureVerificationFailed` for both; a raw-body HMAC-SHA256 hex compare in `webhook-signature.util.ts` that `verifyWebhookPayloadSignature` reuses |
| WHC3 | WH3: the receiver's entry in `verified-scope-usage.policy.unit.test.ts`; the resolver itself comes from sub-domain 1 (its code changes); an RLS security test as `meepzo_be_app`: the resolver returns only the named account's route, a `revoked` account returns nothing, and a store under one organization's scope never sees another's rows |
| WHC4 | WH5: family `instagram` in `WORKER_QUEUE_FAMILY_NAMES`; `WORKER_CONCURRENCY_INSTAGRAM` (env schema, `.env.example`) and `getWorkerConcurrencyInstagram()`; registry and queue-catalog entries (processing in the throughput list); scheduler entries; `isEnabled` from sub-domain 1's `isInstagramConfigured()`; the pinned counts in `worker-registration.registry.unit.test.ts` and `scheduler.unit.test.ts`; `resource-limits.md`, `worker-scaling.md`, `redis-topology.md`, `workers-and-events.md` |
| WHC5 | WH6: log fields as WH6 — a unit test that the receiver's and the processor's log lines never carry `payload` or text; nothing added to `SENSITIVE_KEY_FRAGMENTS` for message text |

### 4.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/instagram-webhook/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 4.A Instagram webhook | folder root | — (stores through 4.B) | 16–17, event processing | final |
| 4.B Instagram webhook events | `instagram-webhook-event/` | `app.instagram_webhook_events` | 18, clean-up | final |

---

### 4.A Instagram webhook — `instagram-webhook/` (folder root) — final

#### 4.A.1 Decisions

| # | Decision |
| --- | --- |
| WH7 | **Route 16, Meta's subscription check.** Today: no such route; the drop answers `403 text/plain Forbidden` on a mismatch. → `hub.mode` must be `subscribe` and `hub.verify_token` must equal the one setting `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (full name, D20), compared in constant time over the two values' SHA-256 digests (no length leak); then `hub.challenge` (1–256 characters, no spaces) is echoed as `200 text/plain`. A wrong mode or token → `400 invalid_webhook_verify_token`; the setting missing → `503 instagram_webhook_not_configured`. The setting is optional in every environment and fails closed while unset (the `503` above), like the other Instagram settings; when set it must be at least 32 characters (rev 2, D39). Why `400`: the repository files a failed webhook proof under `400` and keeps `403` for a signed-in caller without the right (`response-codes.md`, be-api-contract-guard — agent-os wins). Other option: `403`, as the drop. |
| WH8 | **Route 17, signature first (D15).** Today: Stripe's ingress plugin (`stripeWebhookIngressPlugin`) answers `503` without its secret and `400` for a missing or wrong signature (`ValidationError`), as `response-codes.md` says for every webhook signature. → an `instagramWebhookIngressPlugin` mirrors it: the app secret missing (sub-domain 1's one `INSTAGRAM_APP_SECRET` setting, D20) → `503 instagram_webhook_not_configured`; `X-Hub-Signature-256` missing, not `sha256=` + 64 hex characters, or not the HMAC-SHA256 of the **raw** body with the app secret (constant-time compare) → `400 invalid_webhook_signature`. Nothing is parsed, looked up or stored before the signature passes. Other option: `403 invalid_webhook_signature`, as the drop (§6.5, §7). |
| WH9 | **One event, one kind, one key (D15, D18, D19).** Today: the drop keys only comments, messages and `postback:{mid}`, unique across all accounts (§8.7). → a delivery's `entry[]` is split into events — each `changes[]` item and each `messaging[]` item is one event, stored with its entry's Instagram user id (`^[0-9]{1,64}$`; an entry without one is dropped with a log line). One pure classifier gives each event its kind and key (table in 4.A.10). Keys are unique **per Instagram account**, never across accounts, which closes the drop's three gaps: a button click with no `mid` is keyed by sender, time and a hash of its payload; a read receipt is `read:<mid>`, so it never collides with the message it read (`message:<mid>`); two connected accounts messaging each other give an echo on one account and a message on the other — two accounts, two keys. **The account's own activity is skipped as `echo`**: an echo, a message whose sender is the account, and a comment by the account itself (its own public reply comes back as a `comments` event) — so an automation never answers itself. Skipped at once with their reason: `echo`, `read_receipt`, `reaction`, `edit`, and `unsupported` for anything else (another change field, a deleted message, a referral). A `messages` change is a DM (D18). Echoes stay skipped (WQ4). |
| WH10 | **Store each event once, then answer (D15).** Today (PRD §2): the legacy answered first and queued after, so a crash lost the event; Stripe's receiver stores before it answers (`recordAtIngress`). → per entry: find the account (WH3); in that organization's unit read its connection status and automation switch through sub-domain 1; write all the entry's events in one `INSERT … ON CONFLICT DO NOTHING`, so a repeat delivery inserts nothing. Rows are born `received`, or already `skipped` with their reason: the kind's own (WH9), `automation_disabled` when the switch is off, `account_disconnected` when the account is `expired` or `error`. After the commit the account's processing job is added and the new rows turn `queued`; a failed add is logged and left to the stuck-event pick-up (WH15) — it never fails the answer (queue rules §4.5). Then `200 text/plain OK`. **A store failure is never `200`**: the error handler answers `500` or `503`, Meta delivers again and the part already stored dedupes. A body that passes the signature but is not JSON, or whose `object` is not `instagram`, answers `200 OK` with a warning log and stores nothing (D15; route-changes F12). An unknown or `revoked` account: `200`, nothing stored (WH4, WQ1). |
| WH11 | **Rate limit and body size (D21).** Today: the Stripe receiver runs under `WEBHOOK_RATE_LIMIT` (60 a minute per IP), and any route without its own preset falls under the global limit (`RATE_LIMIT_MAX`, 100 a minute per IP) — so "no rate limit" is not the default; the drop asks for none. Meta sends from a small pool of addresses, and one viral "comment to get the link" post brings thousands of comments a minute: 60 or 100 would throttle real events, and Meta answers repeated `429`s by slowing, then disabling the subscription. → route 17 gets its own preset `INSTAGRAM_WEBHOOK_RATE_LIMIT` beside `WEBHOOK_RATE_LIMIT` in `rate-limit-presets.constants.ts`: 1,200 a minute per IP (5,000 when caps are relaxed, like the others) — far above Meta's traffic, still a cap on a flood of unsigned junk, each of which costs one HMAC and never reaches the database. Route 16 uses `WEBHOOK_RATE_LIMIT` as it is (Meta calls it once per subscription). Body limit: the shared 5 MB of WHC2 (Meta batches events). Other option: no limit at all (`rateLimit: false`), as the drop. |
| WH12 | **Processing one account's events (D15, K8).** Today: nothing; Stripe's worker claims one ledger row per job with a 15-minute lease. → the account's job (WH5) loops: (1) in a short organization unit, **claim the oldest** `received` or `queued` event of the account — only when no other run holds it (no claim in the last 5 minutes) — adding one to its attempt count; a head that already used 5 attempts is marked `failed` (`processing_attempts_exhausted`) instead; (2) check the account again through sub-domain 1 — switch off → `skipped automation_disabled`, account not `connected` → `skipped account_disconnected` (either can change while an event waits); (3) run the event's handling (WH13), each step in its own short unit, every Instagram call outside any unit; (4) mark it `processed` with a guarded update (only while it is still this run's claim). The job stops when nothing waits or after 25 events, and then adds one follow-up job, so a busy account never keeps a worker slot from the others. Order is the order stored (`created_at`, `id`); two deliveries landing at the same moment on two servers may be stored in either order (WQ3 for a failing event). Other option: order by Meta's own time (`occurred_at`) — Meta does not promise delivery order either. |
| WH13 | **What each event does (D14, D18).** Today: the legacy ran every handler inside one transaction per entry (PRD §6). → **the contact first**: every comment, DM, story reply and button click calls sub-domain 2's `recordContactInteraction` before anything else; when that creates the contact, its profile (name, username, picture, followers) is read through sub-domain 1's Instagram client — outside any unit, failing open, except a token refusal, which breaks the account and fails the event (rev 3, D44) — and saved with `recordContactProfile` (answers contacts CQ3: yes). Then the kind's operation in sub-domain 3's run engine (dispatch table in 4.A.10). A comment also makes sure its post is stored (sub-domain 1 reads it from Instagram the first time) and tries **"next post" linking** (sub-domain 3: one conditional update, AU15) **before** the comment is matched, so a just-linked automation counts as linked to this post for this same comment; a failed post read or link is logged and the comment is still matched (D18) — one automation answers it, by sub-domain 3's rule (3.B AU16, D26). Every operation must be **safe to call twice for the same event** — a retried event calls them again — and the run engine resumes from its last saved step and never sends a saved message again (D16). |
| WH14 | **Failures (D16).** Today: the legacy handlers swallowed their own errors, so most failures were never retried (PRD §6); the Stripe ledger caps attempts (25) and then gives up, alerting once. → a **temporary** failure (an Instagram 5xx or timeout, a lost connection, a database blip) throws; the job retries with backoff (5 attempts, exponential from 5 s with `QUEUE_RETRY_JITTER_RATIO`, as `subscription-seat-sync`) while the account's later events wait (WQ3); the event's 5th failed attempt marks it `failed` with its error and the job moves on. A **permanent** failure (the run engine refuses the event; a token error — sub-domain 1 then sets the account `error`) marks it `failed` at once. An **Instagram outage** (open circuit) releases the claim, spends no attempt and pauses the queue (WH5). `error_message` is a code and a short reason (`instagram_api:<code>/<subcode>`, `processing_attempts_exhausted`) — never payload text. Nobody is told about a failed event; it shows in route 18 (D13). A smaller cap than Stripe's because one account's later events wait behind it. (rev 4, D47; rev 5, D51) Marking the event `failed` or `skipped` (WH12) also fails the runs it left `running` (AU19), so no run stays `running` after its event is over. |
| WH15 | **Picking up stuck events (D15).** Today: Stripe's reclaim is its own cron worker with a 15-minute lease; notify's `webhook-delivery-reclaim` reads stale rows across organizations under `runGlobalRetentionWorkerJob`, then adds their jobs. → every minute (worker-changes WC-2), one read across organizations (WH3) finds the accounts that have an event still `received` or `queued` more than 5 minutes after it arrived and not claimed in the last 5 minutes — up to 100 accounts a run — and adds each account's processing job (a no-op while that account's job is live). It is the processing queue's second job name, routed on `job.name`. One 5-minute constant is both "stuck" (D15) and the claim's lease; the attempt cap (WH12) replaces WC-2's "after 3 pick-ups". |

#### 4.A.2 Open questions

WQ1 (4.2) — WH4 and WH10; WQ3 (4.2) — WH12 and WH14; WQ4 (4.2) — WH9.

#### 4.A.3 Tables and relations

None of its own — the receiver and event processing write `app.instagram_webhook_events` only through 4.B's service
(WH1). They read sub-domain 1's resolver, account state and posts, write contacts through sub-domain 2's service and
runs through sub-domain 3's run engine. Branch rule: none. Membership or user pointers: none (K6).

#### 4.A.4 Permissions

| Code | Routes |
| --- | --- |
| — PUBLIC, proved by the verify token | 16 |
| — PUBLIC, proved by `X-Hub-Signature-256` | 17 |

#### 4.A.5 Common to every route

As 4.5 (Meta routes).

#### 4.A.6 Objects returned

Route 16: the `hub.challenge` value exactly as received, `text/plain`. Route 17: `OK`, `text/plain`. Both bypass the
`{ data, meta }` envelope (a non-JSON content type; `raw_response` route config).

#### 4.A.7 Routes (16–17)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 16 | GET | `/social/instagram/webhook` | Meta's subscription check | PUBLIC (verify token) | |
| 17 | POST | `/social/instagram/webhook` | Receive comments, DMs, story replies and button clicks | PUBLIC (`X-Hub-Signature-256`) | |

#### 4.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 16 | `hub.mode*` = `subscribe`, `hub.verify_token*`, `hub.challenge*` (1–256, no spaces); other parameters Meta adds are ignored | — | the challenge, `text/plain` |
| 17 | — | Meta's body as received (schema-routes §5.6): `object` = `instagram`, `entry[]` with `id`, `time`, `changes[]`, `messaging[]`; header `X-Hub-Signature-256*`; `Content-Type: application/json`; up to 5 MB | `OK`, `text/plain` |

#### 4.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 16 | `400` · `invalid_field` | a `hub.*` parameter is missing, or the challenge is too long |
| 16 | `400` · `invalid_webhook_verify_token` | `hub.mode` is not `subscribe`, or the token differs (WH7) |
| 16, 17 | `503` · `instagram_webhook_not_configured` | the verify token (16) or the app secret (17) is not set |
| 17 | `400` · `invalid_webhook_signature` | the header is missing, malformed, or not the raw body's HMAC (WH8) |
| 17 | `413` | the body is over 5 MB |
| 17 | `415` | the body is not `application/json` |
| 16, 17 | `429` · `rate_limited` | over the per-IP limit (WH11) |
| 17 | `500` / `503` | the events could not be stored — Meta delivers again (WH10) |
| 17 | `200 OK` — not an error | an unknown or `revoked` account, a signed body that is not readable, or `object` not `instagram`: nothing stored, one log line (WH4, WH10) |

#### 4.A.10 Rules worth knowing

**What counts as one event** (WH9). Keys are at most 512 characters; a longer one is stored as
`<prefix>:sha256:<64 hex>` of its parts.

| Meta item | Kind | Key (unique per account) | Stored as |
| --- | --- | --- | --- |
| `changes[]`, `field` = `comments`, by another user | `comment` | `comment:<value.id>` | `received` |
| `changes[]`, `field` = `comments`, `from.id` is the account itself | `comment` | `comment:<value.id>` | `skipped` · `echo` |
| `changes[]`, `field` = `messages` | as the `messaging[]` rows below (D18) | as below | as below |
| `changes[]`, any other field | `unknown` | `change:<field>:<SHA-256 of value>` | `skipped` · `unsupported` |
| `messaging[].message` with `is_echo`, or sent by the account itself | `echo` | `echo:<mid>` | `skipped` · `echo` |
| `messaging[].message` with `is_deleted` | `unknown` | `deleted:<mid>` | `skipped` · `unsupported` |
| `messaging[].message` with `reply_to.story.id` | `story_reply` | `message:<mid>` | `received` |
| `messaging[].message` — text, quick reply or attachments | `message` | `message:<mid>` | `received` |
| `messaging[].postback` | `postback` | `postback:<mid>`; without `mid`: `postback:<sender id>:<timestamp>:<SHA-256 of payload>` | `received` |
| `messaging[].read` | `read` | `read:<read.mid>` | `skipped` · `read_receipt` |
| `messaging[].reaction` | `reaction` | `reaction:<mid>:<action>:<timestamp>` | `skipped` · `reaction` |
| `messaging[].message_edit` | `edit` | `edit:<mid>:<num_edit>` | `skipped` · `edit` |
| any other `messaging[]` item | `unknown` | `messaging:<SHA-256 of item>` | `skipped` · `unsupported` |

A row this table stores as `received` is born `skipped automation_disabled` when the switch is off and `skipped
account_disconnected` when the account is `expired` or `error` (WH10). "The account itself" is either of its two
Instagram ids (the webhook's user id and the app-scoped id used in send URLs), both returned by sub-domain 1's resolver.

**What each event does** (WH13). Every call carries public ids and the event's public id; every callee opens its own
short unit and is safe to call twice.

| Event | Contact (sub-domain 2) | Then |
| --- | --- | --- |
| Comment | `recordContactInteraction` from `from.id`, `from.username`; profile read when new | 1: post stored (Instagram read the first time) → 3: "next post" link (a failure is logged, D18) → 3: `startCommentRun` — **one** automation answers, matched by this account + this post + keyword: the post-linked ones (this post, a linked "next post") first, else the "any post" ones; the oldest match runs, every other match is logged `ignored` · `comment_already_answered` (3.B AU16, D26) |
| DM (`message`, or a `messages` change) | `recordContactInteraction` from `sender.id`; profile read when new | 3: a run of this contact waiting for an email or phone takes it first — quick reply, attachment or typed text (D18); else the **first** live automation with the DM keyword trigger on and a matching keyword |
| Story reply | as DM | 3: the first live story-reply automation (any story, or this story) whose keywords match; an expired story simply stops matching (D18) |
| Button click (`postback`) | as DM | 3: continue the run named in `<aut_…>::<run_…>` — only if it is this organization's run of this contact; completed, failed and cancelled runs ignore it (D18); if another run waits for this contact's email, the email question goes first |

- The account's state is read twice: when the event is stored (WH10) and when it is processed (WH12).
- A contact erased while one of its events is being processed: the run engine checks `findLiveContact` before each
  send and stops (contacts 2.10); the event itself may still record a fresh contact — a narrow race the erase cannot
  close, since the event arrived before the erase.

#### 4.A.11 Code changes

| # | Change |
| --- | --- |
| WHC6 | WH7: route 16 in the root routes plugin; `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (env schema — optional, 32+ characters when set, no production `.refine()` (D39) — a Secret in `.env.example`, a test value in `src/tests/setup.ts`, GitHub environments — be-env-schema-add); constant-time compare; `text/plain` with `raw_response`; reasons `invalid_webhook_verify_token`, `instagram_webhook_not_configured` registered in `response-codes.md`, i18n keys in `src/shared/locales/en/errors.json` |
| WHC7 | WH8, WH11: `instagram-webhook-ingress.plugin.ts` (mirrors Stripe's; the app secret from sub-domain 1's setting); `X-Hub-Signature-256` in be-api-contract-guard's header matrix; reason `invalid_webhook_signature`; preset `INSTAGRAM_WEBHOOK_RATE_LIMIT`; the ingress policy test widened to the Instagram route (plugin registered before the route, raw-body config beside the preset) |
| WHC8 | WH9: `instagram-webhook-event-classifier.util.ts` — pure; kinds, keys, skip reasons, the account's own ids; a unit test for every row of the 4.A.10 table, including the three key gaps and the account's own comment |
| WHC9 | WH10: `instagram-webhook.controller.ts` and `instagram-webhook.service.ts` (ingest: resolve, read state, store through 4.B, add the job after commit, mark `queued`); metric `instagram_webhook_unknown_account_entries_total`; integration tests: a repeat delivery is stored once; a store failure is not `200`; an unknown or `revoked` account is `200` with no row; a signed unreadable body is `200`; switch-off and `expired` rows are born skipped |
| WHC10 | WH12–WH14: queue `instagram-webhook` (`queues/instagram-webhook.queue.ts` and `.job.schema.ts`: `organizationPublicId`, `instagramAccountPublicId`, `requestId`, the trace fields; job `process-instagram-webhook-events`; deduplication id `instagram-webhook-events-<account public id>` with `keepLastIfActive`, a unique job id; 5 attempts, exponential from 5 s with jitter, capped retention); `workers/instagram-webhook.worker.ts` and `.processor.ts` (`createProviderPausableWorker`, provider `instagram`, `parseJobDataOrDeadLetter`, `runWithPropagatedTraceContext`); constants `INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS = 5`, `INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES = 5`, `INSTAGRAM_WEBHOOK_EVENTS_PER_JOB = 25` in `src/shared/constants/` beside the Stripe ones; `InstagramWebhookEventPermanentError` like `StripeWebhookPermanentError`; real-Redis tests: one job per account at a time across two workers, order kept, a 5th failure marks `failed` and the next event runs, an outage spends no attempt, a skipped event never runs after the switch is back on |
| WHC11 | WH15: job `reclaim-instagram-webhook-events` on the same queue, routed on `job.name`; a scheduler entry every minute (`scheduled: true`); the read under `runGlobalRetentionWorkerJob`, the adds after it; its exemption in `tenant-scoped-job-data.policy.unit.test.ts` and its confinement entry |

---

### 4.B Instagram webhook events — `instagram-webhook/instagram-webhook-event/` — final

#### 4.B.1 Decisions

| # | Decision |
| --- | --- |
| WH16 | **Fields (D15, D19).** Today (drop §8.7): a nullable organization, a key unique across all accounts, no attempt count, and both `received_at` and `created_at`. → `organization_id` is required (WH4 — no row without an organization). Added beside the drop: `instagram_account_id` (a composite key to the account, K5; the key is unique per account), `contact_instagram_user_id` (the person on the other side — the sender, or for an echo the recipient), `occurred_at` (Meta's own time, for spotting late deliveries), `attempt_count` and `last_attempted_at` (the claim and its 5-minute lease, WH12), `request_id` (ties the row to its delivery's log line, as Stripe's ledger does). `received_at` **is** `created_at` — one instant, one column; the API still says `received_at`. `error_message` is set exactly when `failed`; `processed_at` exactly when the status is final (`processed`, `skipped`, `failed`). Value lists as §9, with `unsupported` (D19) and without `unknown_account` (WH4); the response types them as lists, not `string` (D19). |
| WH17 | **Route 18, the list (D4, D13).** Today: no such list; notify's delivery-attempts list leaves `payload` out because it can carry personal data (sec-r4-D6). → newest first by `received_at`, then `id`; keyset through `finishKeysetPage` (`limit` 1–100, default 25, `after`; the cursor carries the filters, so a cursor reused with other filters is `400`); filters `status` and `event_kind` (one value each, from their lists) and `received_from` (inclusive) / `received_to` (exclusive), ISO 8601 with an offset, `from` before `to`; `include_total` opt-in, as the notify and audit lists. Each row carries `payload` as received **with personal data masked** (WQ2): message and comment text cut to the first 40 characters, every email and phone number inside masked (`r***@g***.com`, `+91******34`), quick-reply and attachment emails masked, media and attachment links replaced by `[link]`; ids, kinds and usernames stay (an Owner or Admin sees usernames on the contact list anyway). A personal organization → `404 team_organization_required` (K1, the shared read guard of contacts CT3). Only the caller's organization's rows — RLS plus the repository's organization filter. |
| WH18 | **A contact erase leaves that person's events to the 30-day clean-up (contacts CQ1, your call 2026-11-21).** Today: the drop has no contact erase; contacts (CT8) erases through erasure steps the app container hands it, in one transaction. → 4.B registers **no** `ContactErasureStep`: the person's events stay until WH19 deletes them after 30 days (D8), and route 18 shows their payload masked (WQ2). An event of the erased person still waiting is processed like any new interaction and starts a fresh contact (CT9). Other option (the earlier recommendation): delete that person's events at once, inside route 10's transaction. |
| WH19 | **Clean-up after 30 days (D8).** Today: the Stripe ledger keeps 90 days (a setting), keeps `failed` rows, and runs under the system-table retention context. → once a day at 03:00 UTC (worker-changes rule 11), delete every event received more than 30 days ago, any status, in capped batches (`deleteInBatchesByCondition`) under `runGlobalRetentionWorkerJob` (the table's `USING` arm). 30 is D8's number: a constant, not a setting. `failed` rows go too — they are only the debugging view (D13). There are no rows without an organization to delete (WH4). |

#### 4.B.2 Open questions

WQ2 (4.2) — WH17.

#### 4.B.3 Tables and relations

`app.instagram_webhook_events` (no soft-delete columns, no `*_by_user_id` — WH6)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id` | `bigint` (bigserial) | no | identity | primary key, internal only |
| `public_id` | `varchar(28)` | no | | `iwe_…` from `generatePublicId('instagram_webhook_event')` |
| `organization_id` | `bigint` | no | | → `tenancy.organizations` `ON DELETE CASCADE` (K5) |
| `instagram_account_id` | `bigint` | no | | composite (`organization_id`, `instagram_account_id`) → `app.instagram_accounts` (`organization_id`, `id`) `ON DELETE CASCADE` |
| `instagram_user_id` | `varchar(64)` | no | | `^[0-9]{1,64}$`; the entry's `id` as received |
| `contact_instagram_user_id` | `varchar(64)` | yes | | `^[0-9]{1,64}$`; the sender (an echo: the recipient); null when the payload names nobody else |
| `event_kind` | `varchar(20)` | no | | `comment` · `message` · `postback` · `story_reply` · `echo` · `read` · `reaction` · `edit` · `unknown` |
| `event_key` | `varchar(512)` | no | | WH9; unique per account |
| `status` | `varchar(10)` | no | `'received'` | `received` · `queued` · `processed` · `skipped` · `failed` |
| `skip_reason` | `varchar(30)` | yes | | `automation_disabled` · `account_disconnected` · `echo` · `read_receipt` · `reaction` · `edit` · `unsupported`; `(status = 'skipped') = (skip_reason IS NOT NULL)` |
| `error_message` | `varchar(2000)` | yes | | a code and a short reason, never payload text; `(status = 'failed') = (error_message IS NOT NULL)` |
| `attempt_count` | `smallint` | no | `0` | `≥ 0`; one per claim (WH12) |
| `last_attempted_at` | `timestamptz` | yes | | the claim; held for 5 minutes |
| `payload` | `jsonb` | no | | the event item as received; `jsonb_typeof(payload) = 'object'` |
| `occurred_at` | `timestamptz` | yes | | Meta's time: the item's `timestamp`, else the entry's `time` |
| `processed_at` | `timestamptz` | yes | | `(status IN ('received', 'queued')) = (processed_at IS NULL)` |
| `request_id` | `varchar(128)` | yes | | the delivery's request id |
| `created_at`, `updated_at` | `timestamptz` | no | `now()` | `created_at` is the received time (API `received_at`); `updated_at >= created_at`; the app sets `updated_at` on every change |

Indexes (every one declared in `instagram-webhook-event.schema.ts` too — index-hygiene gate):

- `idx_instagram_webhook_events_public_id` — unique `(public_id)`.
- `idx_instagram_webhook_events_organization_id_instagram_account_id_event_key` — unique `(organization_id,
  instagram_account_id, event_key)`: the repeat-delivery guard (`ON CONFLICT`); it leads with the composite key's
  columns, so it also serves the account cascade and the organization cascade (be-sql-design-guard D.1).
- `idx_instagram_webhook_events_organization_id_created_at_id` — `(organization_id, created_at DESC, id DESC)`: the list.
- `idx_instagram_webhook_events_organization_id_status_created_at_id` — `(organization_id, status, created_at DESC,
  id DESC)`: the list filtered by status (the drop's `(organization_id, status)` made a keyset).
- `idx_instagram_webhook_events_pending` — `(instagram_account_id, created_at, id) WHERE status IN ('received',
  'queued')`: the claim and the stuck-event pick-up; small, since only waiting rows are in it.
- `idx_instagram_webhook_events_created_at` — `(created_at)`: the clean-up.
- No index on `event_kind`: a kind filter reads one organization's 30 days at most.

Checks (`chk_instagram_webhook_events_<rule>`): `kind`, `status`, `skip_reason` (the lists), `skipped`, `failed` and
`final` (the three pairings above), `payload`, `attempt_count`, `instagram_ids` (both id formats), `updated`.

Foreign keys: `instagram_webhook_events_organization_id_organizations_id_fk` (the repository's generated name);
`instagram_webhook_events_instagram_account_fk` (composite, as `memberships_role_fk`), which needs sub-domain 1's
unique `(organization_id, id)` on `app.instagram_accounts`. RLS (K5): enabled and forced; policy
`instagram_webhook_events_tenant_isolation` `FOR ALL` — `USING` the organization GUC OR
`maintenanceBypassArm('app.global_retention_cleanup')`, `WITH CHECK` the organization GUC only (the
`member-role.schema.ts` pattern); `{ schemaName: 'app', tableName: 'instagram_webhook_events' }` in
`EXPECTED_FORCE_RLS_TABLES`. Rows are written before the organization is known only through WH3's resolver and the
verified scope. Branch rule: none — the organization is the only scope. Membership or user pointers: none (K6).
Partitioning: none — the repeat-delivery key must hold across the whole table (a partitioned unique index must include
the partition key), and 30 days stays well under 10 million rows; revisit past that. Migration: a new dated file
(`pnpm db:migrate:new app_instagram_webhook_events`), after sub-domain 1's account tables — production holds data, so
the init file stays as it is.

#### 4.B.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-webhook-event:read` | 18 |

#### 4.B.5 Common to every route

As 4.5 (signed-in route).

#### 4.B.6 Objects returned

**Instagram webhook event**: `id` (`iwe_…`), `instagram_user_id`, `contact_instagram_user_id`, `event_kind`
(`comment` · `message` · `postback` · `story_reply` · `echo` · `read` · `reaction` · `edit` · `unknown`), `event_key`,
`status` (`received` · `queued` · `processed` · `skipped` · `failed`), `skip_reason` (`automation_disabled` ·
`account_disconnected` · `echo` · `read_receipt` · `reaction` · `edit` · `unsupported`, or null), `error_message`,
`attempt_count`, `payload` (masked — WH17), `occurred_at`, `received_at`, `processed_at`. Internal ids,
`last_attempted_at` and `request_id` are never returned.

#### 4.B.7 Routes (18)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 18 | GET | `/social/instagram/webhook-events` | List received events and what happened to each | `instagram-webhook-event:read` | |

#### 4.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 18 | `status`, `event_kind` (one value each), `received_from` / `received_to` (ISO 8601 with an offset; `to` exclusive, `from` before `to`), `limit` (1–100, default 25), `after`, `include_total` (`true` \| `false`, default `false`) | — | Instagram webhook event[] |

#### 4.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 18 | `400` · `status` / `event_kind` | not one of its list's values |
| 18 | `400` · `received_from` / `received_to` | not an ISO 8601 time with an offset, or `from` not before `to` |
| 18 | `400` · `limit` / `after` / `include_total` | out of range, a bad cursor, a cursor made with other filters, or an unknown parameter |
| 18 | `403` · `missing_permission` | no `instagram-webhook-event:read` — a Member included (D4) |
| 18 | `404` · `team_organization_required` | a personal organization (K1) |

#### 4.B.10 Rules worth knowing

- Rows are created only by 4.A (store), changed only by 4.A (claim, mark), and deleted only by the clean-up (WH19) — a
  contact erase leaves them (WH18); route 18 never changes one.
- The list never shows another organization's events, and no event exists without an organization (WH4).
- The masking runs in the serializer only; the stored payload stays as received, because processing needs the real
  text (keywords, an email answer).

#### 4.B.11 Code changes

| # | Change |
| --- | --- |
| WHC12 | WH16: `app.instagram_webhook_events` in a new dated migration — columns, checks, the composite key, the six indexes, RLS + FORCE, the policy with `USING` + `WITH CHECK`; `instagram-webhook-event.schema.ts` on `appSchema` declaring every index, check and the `pgPolicy`; `EXPECTED_FORCE_RLS_TABLES`; the composite-key test list (`tenant-composite-foreign-keys.integration.test.ts`); `instagram-webhook-event.repository.ts` (insert with `ON CONFLICT`, the claim in a `MATERIALIZED` CTE, guarded marks, list, clean-up — no delete by contact: a contact erase leaves the events, WH18, D25) with its worker factory, and `instagram-webhook-event.service.ts` |
| WHC13 | WH17: route 18 — query DTO (registered in `tooling/openapi/query-schema-map.ts`), validator, serializer with `instagram-webhook-event-payload-masking.util.ts` (value-level masking of text, emails, phones and links; unit-tested on every event kind), controller; gate `instagram-webhook-event:read` (catalog, presets and backfill with sub-domain 1, K4); the shared read guard `404 team_organization_required` (landed by contacts CTC5), O column `team`; integration tests: each filter, newest first across pages, a cursor reused with other filters, masking, a Member `403`, a personal organization `404`; another organization's events never listed, as `meepzo_be_app` and in the `test:rls-role` lane |
| WHC14 | WH18: no erasure step (contacts CQ1); a test that a contact erase leaves that person's events in place for the clean-up (WH19) |
| WHC15 | WH19: `workers/instagram-webhook-event-retention.worker.ts`, `.processor.ts`, `.constants.ts` (queue `instagram-webhook-event-retention`), family `instagram`, `retentionDefinition`; a scheduler entry daily at 03:00 UTC; constant `INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS = 30`; a database test: rows older than 30 days go, younger stay, any status |
| WHC16 | Seeds, docs: bulk seed in `instagram-webhook-event/seed/` (events of every kind and status for the seeded accounts; no reference seed); i18n keys for every new reason; a row in `docs/reference/data/data-lifecycle-deletion.md`; `pnpm routes:catalog`, success statuses (`200` ×3), `validate:route-organization-scope`, `docs:generate`, Postman |

---

Hand-over notes (for the plan owner; not part of the section):

- Checks run: sections 4.1–4.12, 4.A.1–4.A.11 and 4.B.1–4.B.11 present; every table row matches its header; ids
  WH1–WH19, WQ1–WQ4 and WHC1–WHC16 are unique and every cited one exists; routes 16–18 run without a gap, each with a
  gate and an Idem cell (17 is a `POST` but PUBLIC — K3 exempts it); the table states its RLS, its branch rule (none)
  and its pointers (no membership or user pointer).
- Change files to bring in line: `db-changes.md` › instagram_webhook_event — `organization_id` required, no
  `unknown_account`, added `instagram_account_id`, `contact_instagram_user_id`, `occurred_at`, `attempt_count`,
  `last_attempted_at`, `request_id`, `received_at` = `created_at`, the RLS open item answered (WH3, WH4).
  `route-changes.md` RC-4 / RC-5 — `400` (not `403`) for the verify token and the signature, the rate-limit preset; RC-6
  — masked payload, personal organization `404`; RC-15 — after a disconnect, later events are not stored (WH4), not
  `account_disconnected`; F11 — rate limit and error class answered; F12 — answered (WH10). `worker-changes.md` WC-1 —
  contact profile read on a new contact; WC-2 — every minute, the 5-attempt cap replaces "3 pick-ups"; WC-8 — no
  events without an organization; WC-14 — superseded by D22 (no background erase; a contact erase leaves the events, WH18).
