# Meepzo API — Meta connect flow, final routes, sub-domain by sub-domain

Started from branch `feat/instagram-automation` at `cda7b73` (after the frozen `fix-meta-unified-login`). Every
decision reads **today → after**; today is the code as built (`src/domains/app/sub-domains/…`, `file:line`).
Sources: [`coverage.md`](coverage.md) (outcomes 1–19, `brief:L…`), [`decisions.md`](decisions.md) (C-D1–C-D8),
[`route-changes.md`](route-changes.md) (RC-n), [`db-changes.md`](db-changes.md) (DB-n), [`worker-changes.md`](worker-changes.md) (WC-n).

## File header — legend

Paths are under `/api/v1/app/social`; `{x_id}` is a public id; `{provider}` is `meta` (a non-entity param);
**Gate** is the permission the caller needs; **Idem** `req` = `X-Idempotency-Key` required; `*` = required.
Route numbers continue the earlier reviews' numbering: today's routes keep theirs (1–11, 16–17, 40–42), new ones
start at **151**.

## File header — sub-domains (in build order)

| # | Sub-domain | Folder (`src/domains/app/sub-domains/…`) | Paths (`/social/…`) | Routes touched | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Channel connection | `channel-connection/` | `channel-connections` (+ `connect-options`, `shared-assets`) | 2 changed (2, 3), 2 new (151, 152) | team, billing plan access | **final (rev 1, confirmed 2026-11-26)** |
| 2 | Channel account | `channel-account/` | `channel-accounts` (+ `capabilities`) | 1 new (153), 1 error change (every `409 permission_not_granted`) | 1 | **final (rev 1, confirmed 2026-11-26)** |
| 3 | Instagram account | `instagram-account/` | `instagram/accounts/{channel_account_id}/message-access-checks`; the `instagram` block of routes 6, 7 | 2 changed (6, 7), 1 new (154) | 2 | **rev 1 — awaiting your OK** |

Total: **4 new routes, 4 changed** — no route removed. Every new path names the `channel` of what it answers, so a
Facebook Page arrives as one more `channel` value (Pages sketch, sub-domain 2).

## File header — code layout and tables without routes

No new table. Three tables gain columns (DB-1–DB-3); each stays in its folder.

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 2 | `app.channel_accounts` (+ `scopes`, `scopes_read_at`) | `channel-account/` | the token check (WC-4) through the channel-account service |
| 3 | `app.instagram_accounts` (+ `message_access`, `message_access_checked_at`; `linked_page_id` deferred — IG3) | `instagram-account/` | the account set-up job and route 154 (WC-2) |

## File header — rules for every sub-domain

| # | Rule |
| --- | --- |
| K1 | **Meta reads are never cached** for an answer that decides a pick or a capability (P55 kept): routes 151 and 3 re-read Meta. |
| K2 | **A Meta read refused with code 190 breaks the connection** (`markConnectionBroken`, MC11) on every new route, as on today's. |
| K3 | **Gates keep today's split** — `channel-account:manage` for anything that writes or calls Meta to change state, `channel-account:read` for reads (`channel-connection.routes.ts:45-175`, `channel-account/channel-account.routes.ts:21`). |
| K4 | **Every outcome has one documented answer** — the `.9 Errors` tables below plus the callback's outcome list (1.10) are the contract the frontend's route map copies. |

## File header — connections

```text
1) WHO POINTS AT WHOM
   app.channel_connections ◄── app.channel_accounts (channel_connection_id)
   app.channel_accounts    ◄── app.instagram_accounts (channel_account_id, 1:1)

2) WHAT ONE ACTION SETS OFF (same transaction unless marked worker)
   2 callback (reconnect, none shared) ► 2 accounts of that connection marked not shared   (C-D2)
   2 callback (new accounts)           ► answer lists them; nothing auto-connected
   3 pick                              ► 3 account set-up job: subscribe + message-access probe   [worker]
   154 re-check                        ► 3 message_access stored; the access_off stop lifted or kept
   token check (daily)                 ► 1 revoke after 7 days unpicked (C-D3) · 2 per-account scopes (WC-4)   [worker]
```

---

## 1. Channel connection — final (rev 1, confirmed 2026-11-26) — no nested sub-domain changes

Code: `channel-connection/` (the connection at the folder root; the adapter folder `channel-connection-meta/` has no
routes). The provider login: start, callback, pick, reconnect, list, read, disconnect, ad picker, Meta's callbacks.
This iteration makes every callback outcome explicit (brief outcomes 1–3, 5–7, 9, 11–13, 18), adds a re-readable list
of what the login shared (151) and the connect-start preconditions (152), and the clean-up of unpicked connections.

### 1.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| CN1 | **Cancel reaches the backend** (outcome 1, C-D1). Today the callback body is `{code, state}` strict → a cancel is a `400` and the state is never spent (`channel-connection.dto.ts:36-41`). After: the body is `{ state, code }` **or** `{ state, error, error_reason?, error_description? }` (Meta's redirect parameters, exactly one of `code` / `error`); a cancel spends the state (this caller's, else `400 channel_connect_state_invalid` as today), saves nothing, calls no Meta, and answers `200` with `data.outcome = "cancelled"` and `meta.error_reason` echoed. |
| CN2 | **One `outcome` on every callback success** — today the callback answers the picker without saying which case it was. After: `data.outcome` is `connected` (a first connect), `reconnected`, `cancelled`, or `no_accounts_shared` (a reconnect that shares none — CN4); the existing body stays for the first two. Other option: separate routes per outcome — rejected, the frontend makes one call. |
| CN3 | **Errors name what to fix** (outcomes 3, 13). Today `422 provider_permissions_missing` and `409 channel_connection_business_mismatch` carry no detail (`channel-connection-error.util.ts:64-68,95-99`). After: the first adds `missing_permissions` (Meta permission names, the required set minus the granted); the second adds `expected_client_business_id` (already serialized on the connection, not secret). |
| CN4 | **No Instagram account shared** (outcome 6, C-D2). Today the connection and token are saved and `200` answers `accounts: []` (`channel-connection.service.ts:389-410`). After: a **first** connect (no connection of this business in the organization, or only a revoked one) saves nothing → `422 provider_no_accounts_shared`; a **reconnect** (route 40's state, or this business already connected) stores the fresh token and marks every not-revoked account of that connection not shared — the token check's `account_not_shared` path, reused — and answers `200` `outcome: no_accounts_shared`. |
| CN5 | **The callback marks accounts no longer shared** (outcome 11). Today only the daily token check does (`channel-connection-token-check.processor.ts:458-466`). After: in the callback's commit, every not-revoked account of this connection whose id is missing from a **complete** assigned list (`isComplete`, P353) gets the same `account_not_shared` treatment; newly shared ones are listed `free`, never auto-connected. |
| CN6 | **Plan limit stays all-or-nothing** (outcome 9, C-D4); the `409 plan_account_limit` adds `plan_room` `{ accounts_max, accounts_used }` beside today's `limit`, `used`, `upgrade_required`. |
| CN7 | **Route 151 — `GET /channel-connections/{channel_connection_id}/shared-assets`** (outcomes 7, 11; C-D5). Today nothing re-reads Meta's list outside the pick (P55). After: re-reads `/me/assigned_instagram_accounts` (K1) and answers each asset with `channel` (`instagram`), `provider_account_id`, `username`, `state` (`free` · `connected_here` · `connected_elsewhere` · `not_shared_any_more` — a not-revoked account of this connection Meta no longer lists), the `channel_account_id` when here, plus `meta.plan_room` and `meta.is_complete`. No profile reads (they stay in the pick). |
| CN8 | **Route 152 — `GET /channel-connections/{provider}/connect-options`** (brief:L13, L96). Today route 1 is the only way to learn Meta is off (`503`) or the Page login is not offered (`400`). After: a read answering `is_configured`, `is_page_login_offered`, `can_manage` (the caller holds `channel-account:manage`), `plan_room`; never `503` — an unconfigured Meta is `is_configured: false`. Gate `channel-account:read`, so a Viewer's screen can say "ask an admin". |
| CN9 | **Unpicked connections are revoked after 7 days** (outcome 7, C-D3) — inside the **existing daily token check** (reuse rule): a `connected` connection with no not-revoked account and `connected_at` older than 7 days is revoked and its token deleted instead of being checked (`CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS = 7`, a policy constant). Other option: a separate scheduled job — rejected, the token check already visits every connection once a day with the right scope. |
| CN10 | **Per-account permissions** (DB-3) are read by the token check from `/debug_token` `granular_scopes` once owner test O1 passes; until then nothing changes (sub-domain 2 owns the column). |

### 1.2 Open questions

None — C-D1–C-D5 answered; CN9 and CN10 follow the reuse rule. Owner test O1 gates CN10.

### 1.3 Tables and relations

No table change in this sub-domain. `app.channel_connections` and `app.channel_connection_tokens` as built (and
`provider_user_id` from the fix, F3). The clean-up (CN9) reads `connected_at` and the connection's accounts; it needs no
column and no new index — the token check already selects due connections by `idx_channel_connections_check_due`.

### 1.4 Permissions

| Code | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `channel-account:manage` | start, finish (incl. cancel), pick, reconnect, disconnect | 1, 2, 3, 5, 40 | Owner, Admin |
| `channel-account:read` | list, read, ad picker, **shared assets, connect options** | 4, 41, 42, **151, 152** | Owner, Admin, Editor, Viewer |

### 1.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app/social` |
| Auth | `Authorization: Bearer`; the active organization from the token; team organizations only (P59) |
| Writes | route 2 and 3 need `X-Idempotency-Key` (as today) |
| Success | `200` `{ data, meta }`; `DELETE` → `204` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` |

### 1.6 Objects returned

| Object | Change |
| --- | --- |
| Callback answer (route 2) | **+ `outcome`** (`connected` · `reconnected` · `cancelled` · `no_accounts_shared`); `cancelled` answers `data: { outcome }` and `meta.error_reason`; `no_accounts_shared` answers the connection and `marked_not_shared_account_ids` |
| Shared asset (route 151) | **new**: `{ channel, provider_account_id, username, state, channel_account_id }` |
| Connect options (route 152) | **new**: `{ provider, is_configured, is_page_login_offered, can_manage, plan_room: { accounts_max, accounts_used } }` |
| Channel connection | unchanged |

### 1.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 152 | GET | `/channel-connections/{provider}/connect-options` | Can this caller connect now, and how **(new)** | `channel-account:read` | |
| 1 | POST | `/channel-connections/{provider}/start` | Start the Meta login (unchanged) | `channel-account:manage` | |
| 2 | POST | `/channel-connections/{provider}/callback` | Finish the login, a reconnect, **or a cancel; answers the outcome (changed)** | `channel-account:manage` | req |
| 151 | GET | `/channel-connections/{channel_connection_id}/shared-assets` | What the login shares now, each with its pick state **(new)** | `channel-account:read` | |
| 3 | POST | `/channel-connections/{channel_connection_id}/accounts` | Connect the picks — **limit error carries `plan_room` (changed)** | `channel-account:manage` | req |
| 4, 42, 5, 40, 41, 16, 17 | | today's paths | unchanged | as today | |

### 1.8 Request details

| Route | Body / query |
| --- | --- |
| 2 | `{ state*, code }` **or** `{ state*, error*, error_reason, error_description }` — exactly one of `code` / `error`; `error` ≤ 100, `error_reason` ≤ 100, `error_description` ≤ 500 chars; strict (an unknown field is a `400`) |
| 151 | none; paging is not offered — the list is capped like the pick's read (10 pages × 100, `meta.is_complete`) |
| 152 | none |

### 1.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 2 | `400` · `invalid_field` | both or neither of `code` / `error` |
| 2 | `400` · `channel_connect_state_invalid` | as today (a cancel with a bad state too) |
| 2 | `422` · `provider_permissions_missing` + **`missing_permissions`** | a required permission not granted (CN3) |
| 2 | `422` · **`provider_no_accounts_shared`** (new) | a first connect sharing no Instagram account (CN4) |
| 2 | `409` · `channel_connection_business_mismatch` + **`expected_client_business_id`** | reconnect into another portfolio (CN3) |
| 2 | `409` · `instagram_connect_restart_required` · `503` · `instagram_unavailable` · `422` · `provider_code_invalid` | as today (fix F-D3 / F-D10) |
| 3 | `409` · `plan_account_limit` + **`plan_room`** | as today, plus the room (CN6) |
| 151 | `404` · `channel_connection_not_found` · `409` · `channel_connection_not_connected` | not this organization's / not `connected` |
| 151 | `409` · `instagram_connect_restart_required`-style mapping of route 3's Meta reads (`toChannelConnectionReadError`) | Meta refuses or is down; a 190 also breaks the connection (K2) |
| 152 | `400` · `provider` | a provider other than `meta` |

### 1.10 Rules worth knowing

- The callback's outcomes, in order of the checks: bad state → cancel → exchange → permissions read (fix F-D10) →
  business mismatch → missing required permission → no account shared (first connect: refuse; reconnect: mark) →
  commit (connect / reconnect, mark unshared accounts) → after commit, set-up jobs.
- `not_shared_any_more` on route 151 and the callback's marking use one rule: an account of this connection missing
  from a **complete** list; an incomplete list (`is_complete: false`) marks nothing (P353).
- Personal or non-professional Instagram accounts never appear in Meta's list; the frontend's `no_accounts_shared`
  copy explains converting and sharing (route map, section 4).

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| CNC1 | CN1, CN2: the callback DTO as a union (`code` xor `error`), the cancel path in `ChannelConnectionService.finishLogin` (spend the state, no Meta call), `outcome` in the serializer; OpenAPI + `docs/routes.txt` description |
| CNC2 | CN3: `missing_permissions` and `expected_client_business_id` via `withFields` on the two errors; i18n `errors.json` detail copy |
| CNC3 | CN4, CN5: the empty-list refusal (`provider_no_accounts_shared`, new reason + i18n) and the reconnect marking, reusing the token check's `account_not_shared` path through the account port |
| CNC4 | CN6: `plan_room` on `plan_account_limit` |
| CNC5 | CN7: route 151 (routes, controller, service read over `listMetaAssignedInstagramAccounts`, serializer `serializeSharedAsset`), schema doc, route catalog, seed n/a |
| CNC6 | CN8: route 152 (reads `isMetaConfigured`, `readMetaPageConfigId`, the caller's permission set, the plan room) |
| CNC7 | CN9: the token check revokes unpicked connections after `CHANNEL_CONNECTION_UNPICKED_KEEP_DAYS` (POLICIES.md entry, TSDoc @remarks, a db unit test) |
| CNC8 | Tests: one integration test per outcome row of 1.9 and 1.10 (cancel, both/neither, missing permissions named, no accounts first vs reconnect, unshared marked, mismatch named, plan room), route 151 (states, incomplete list, 190 breaks), route 152 (configured / not, page login, viewer), the clean-up (6 days kept, 8 days revoked, a picked one never) |

### 1.12 Nested sub-domains

None changed — `channel-connection-meta/` (no routes) gains nothing in this sub-domain.

---

## 2. Channel account — final (rev 1, confirmed 2026-11-26) — no nested sub-domains

Code: `channel-account/` (the common account row, the capability list `CHANNEL_CAPABILITIES`, the one feature check).
This iteration lets the frontend read **what each account can do and why not** (brief outcomes 4, 15, 16, 17), gives the
feature check per-account permissions (DB-3), names the Meta permission in its refusal, and writes the Pages sketch.

### 2.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| AC1 | **Route 153 — `GET /channel-accounts/{channel_account_id}/capabilities`** (outcome 4, C-D7). Today the feature check runs only when a feature is used and refuses `409 permission_not_granted` / `plan_lacks_feature` (`channel-account.service.ts:159-185`); nothing lists the states. After: one read answering `features[]` — **every** feature of `CHANNEL_FEATURES` run through the **same** `checkFeature` (no second rule set), each `{ feature, is_allowed, reason, permission, plan_switch, fix }` — and `blockers[]`, the account-level states that stop sending whatever the feature (AC2). |
| AC2 | **Blockers reuse what is already stored** — no new state: `connection_error` (the connection or account `error`, `last_check_error`), `account_not_shared` / `login_expired` / `access_off` / `plan_*` (the account's `active_stop.reason`, the lane service's answer route 7 already reads), `messages_webhook_missing` (`instagram.is_messages_webhook_missing`), `paused` (`paused_at`). Each with its `fix`: `reconnect` · `reconnect_with_page` · `turn_on_message_access` · `share_account_in_meta` · `upgrade` · `resume` · `none`. |
| AC3 | **The fix of a feature refusal** is fixed per reason: `permission_not_granted` → `reconnect` (Meta's login asks for the missing permission again), `plan_lacks_feature` → `upgrade`, `feature_not_offered` → `none` (waits on Meta's review), `channel_lacks_feature` → `none`. |
| AC4 | **The refusal names the permission** (RC-9). Today `409 permission_not_granted` carries `feature` = the plan key (`channel-account-error.util.ts:57,64`). After: it also carries `permission` (`CHANNEL_FEATURES[feature].permission`), so the frontend asks for exactly that one. |
| AC5 | **Per-account permissions** (DB-3, outcome 4, brief:L89). Today `checkFeature` reads `connectionScopes` (the connection's `scopes`). After: `app.channel_accounts.scopes` (nullable list) and `scopes_read_at`; the check reads `account.scopes ?? connection.scopes`. The daily token check fills it from `/debug_token` `granular_scopes`: a permission whose `target_ids` include the account's `provider_account_id` — or that lists no `target_ids` (app-wide) — is the account's. Until owner test O1 shows `granular_scopes` for this token type, the column stays `null` and nothing changes. |
| AC6 | **Pages sketch** (brief:L78, L110) — written below (2.10) and checked against every route: a Facebook Page is one more `channel` value; **no route of this iteration changes**. |

### 2.2 Open questions

None. AC5 is gated on owner test O1 (behaviour unchanged until then).

### 2.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.channel_accounts` | **+ `scopes`** — list of Meta permission names, nullable (`null` = the connection's stand), at most 20 (as the connection's); **+ `scopes_read_at`** — timestamp, nullable. Written only by the token check through the channel-account service. RLS unchanged (row-level, FORCE). |

**PostgreSQL design**: `scopes text[] NULL` with `CHECK (scopes IS NULL OR cardinality(scopes) <= 20)` added `NOT
VALID` then validated (every row `NULL`); `scopes_read_at timestamptz NULL`. No index — read with the row.

### 2.4 Permissions

| Code | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `channel-account:read` | list, read, **capabilities** | 6, 7, **153** | Owner, Admin, Editor, Viewer |
| `channel-account:manage` | disconnect, pause, resume, activate | 8–11 | Owner, Admin |

### 2.5 Common to every route

As 1.5 (base `/api/v1/app/social`, team organizations only).

### 2.6 Objects returned

| Object | Shape |
| --- | --- |
| Capabilities (route 153) **new** | `{ channel_account_id, channel, scopes_source: "account" \| "connection", features: [{ feature, is_allowed, reason, permission, plan_switch, fix }], blockers: [{ blocker, since, fix }] }` — `reason`, `permission`, `plan_switch`, `fix` are `null` when allowed |
| `409 permission_not_granted` | **+ `permission`** beside `feature` |
| Channel account (routes 6, 7) | unchanged in this sub-domain (its `instagram` block changes in sub-domain 3) |

### 2.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 153 | GET | `/channel-accounts/{channel_account_id}/capabilities` | What this account can do, and why not **(new)** | `channel-account:read` | |
| 6–11 | | today's paths | unchanged | as today | as today |

### 2.8 Request details

Route 153: none.

### 2.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 153 | `404` · `channel_account_not_found` | not this organization's, or revoked |
| every feature use | `409` · `permission_not_granted` **+ `permission`** | as today, now naming Meta's permission (AC4) |

### 2.10 Rules worth knowing — and the Pages sketch

- Route 153 and every feature use read the **same** `checkFeature` with the same inputs, so the screen and the
  refusal never disagree. Route 153 calls no Meta.
- `scopes_source` tells the frontend whether a per-account answer (AC5) or the connection's stands.

**Pages sketch** (not built — the check that this iteration's contract needs no change):

| Piece | A Facebook Page later | Changes a route of this iteration? |
| --- | --- | --- |
| Login | the same Unified Login configuration adds `pages_*` permissions; route 1, 2, 40 unchanged | no |
| What the login shared (151) | lists Pages as `channel: "facebook_page"` assets beside Instagram ones (`/me/assigned_pages` or Meta's documented read — a Meta test then) | no — `channel` already in the shape |
| Pick (3) | `provider_account_ids` with a `channel` per pick (today's body already carries `channel`) | no |
| Account row | `app.channel_accounts.channel = 'facebook_page'` + a `facebook_pages` extension (like `instagram_accounts`), a Page token per account | no |
| Capabilities (153) | a `CHANNEL_CAPABILITIES.facebook_page` entry; the same check | no |
| Page-only routes | under `/social/facebook/pages/{channel_account_id}/…`, as Instagram-only ones are under `/social/instagram/accounts/…` | new routes, none changed |
| Webhooks | Meta's `page` object at its own per-object path beside `…/meta/webhooks/instagram` | new routes, none changed |

### 2.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| ACC1 | AC1–AC3: route 153 (routes, controller, `ChannelAccountService.listCapabilities` over `checkFeature` and the stored states, serializer, schema doc, route catalog); the fix map as a constant beside `CHANNEL_FEATURE_REFUSAL_REASONS` |
| ACC2 | AC4: `permission` via `withFields` on `permission_not_granted`; i18n detail |
| ACC3 | AC5: columns + migration (expand only), Drizzle schema, the check's input `account.scopes ?? connection.scopes`; the token check's writer (sub-domain 1 worker, through this service) behind owner test O1 |
| ACC4 | Tests: route 153 — allowed, each refusal reason with its permission / plan switch / fix, each blocker from a stored state, viewer can read, another organization's 404; the 409 names the permission; per-account scopes override the connection's and a `null` falls back |

### 2.12 Nested sub-domains

None.

---

## 3. Instagram account — rev 1 (2026-11-26) — nested sub-domains unchanged; awaiting your OK

Code: `instagram-account/` (the Instagram part of a channel account, 1:1; nested `instagram-account-settings/`,
`instagram-media/` unchanged). This iteration **stores** the "Allow access to messages" result the set-up probe
already reads (outcome 15, brief:L85), lets the owner re-check it on demand (route 154), and shows it on the account.

### 3.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| IG1 | **Store the probe result** (DB-1, outcome 15). Today the set-up job's probe (`probeInstagramMessageAccess`) is logged only; `off` starts an `access_off` stop on every lane (`instagram-account/workers/instagram-account-tasks.processor.ts:331-355,751-773`). After: `app.instagram_accounts.message_access` (`on` · `off` · `unknown`, default `unknown`) and `message_access_checked_at` are written by the same probe; the stop behaviour is unchanged. |
| IG2 | **Route 154 — `POST /instagram/accounts/{channel_account_id}/message-access-checks`** (C-D9). Runs the same probe now: `on` → stored, and the account's `access_off` stop ended (the lane service, as a login stop is ended — R18); `off` → stored, the stop started or kept; `unknown` → stored, the stop untouched. A re-check within **60 seconds** of the last answers the stored result without calling Meta (`MESSAGE_ACCESS_RECHECK_MIN_SECONDS = 60`, a policy constant) — Meta's usage is spent once a minute at most per account. A 190 breaks the connection (K2). Safe to repeat, so no idempotency key (as pause / resume, CA7). |
| IG3 | **Linked Facebook Page id — deferred** (DB-2, C-D6). No documented Instagram-user field gives it under Unified Login ⚠️; a column nobody can fill is dead schema (reuse rule). After owner test O6 names the source, a later fix adds `linked_page_id` with its writer. Outcome 16 stays covered by today's webhook watch (`is_messages_webhook_missing`) and the `reconnect_with_page` fix (sub-domain 2, AC2). Other option: add the nullable column now — rejected. |
| IG4 | **The account shows it** (RC-7). Today the `instagram` block of routes 6 and 7 has `is_webhook_subscribed`, `is_messages_webhook_missing` (`instagram-account.serializer.ts:38-50`). After: **+ `message_access: { status, checked_at }`**. |
| IG5 | **Capabilities read it** — sub-domain 2's `message_access_off` blocker comes from the `access_off` stop (as built); `message_access` is shown beside it so the screen can say "checked 5 min ago — still off". |

### 3.2 Open questions

None. IG3 waits on owner test O6.

### 3.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.instagram_accounts` | **+ `message_access`** — text, `on` · `off` · `unknown`, not null, default `unknown`; **+ `message_access_checked_at`** — timestamp, nullable |

**PostgreSQL design**: `message_access varchar(10) NOT NULL DEFAULT 'unknown'` with `chk_instagram_accounts_message_access
CHECK (message_access IN ('on', 'off', 'unknown'))` (`NOT VALID` then validated); `message_access_checked_at timestamptz
NULL`. Expand-only: the default fills existing rows; the previous release never writes the column. RLS unchanged.

### 3.4 Permissions

| Code | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `instagram-account:manage` | settings, **message-access re-check** | 12, **154** | Owner, Admin |
| `instagram-account:read` | media, stories, sending status | 13, 14, 63, 64 (as built) | Owner, Admin, Editor, Viewer |
| `channel-account:read` | the `instagram` block on routes 6, 7 | 6, 7 | as sub-domain 2 |

### 3.5 Common to every route

As 1.5.

### 3.6 Objects returned

| Object | Change |
| --- | --- |
| Message access check (route 154) **new** | `{ channel_account_id, status: "on" \| "off" \| "unknown", checked_at, is_from_meta }` — `is_from_meta: false` when the 60-second rule answered the stored result |
| Channel account's `instagram` block (routes 6, 7) | **+ `message_access: { status, checked_at }`** |

### 3.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 154 | POST | `/instagram/accounts/{channel_account_id}/message-access-checks` | Check "Allow access to messages" now **(new)** | `instagram-account:manage` | |
| 6, 7 | GET | `/channel-accounts`, `/channel-accounts/{channel_account_id}` | **+ `instagram.message_access` (changed)** | `channel-account:read` | |

### 3.8 Request details

Route 154: no body.

### 3.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 154 | `404` · `channel_account_not_found` | not this organization's, revoked, or not Instagram |
| 154 | `409` · `channel_account_not_connected` | the account is not `connected` (a broken login is fixed by reconnecting first) |
| 154 | `503` · `instagram_unavailable` | Meta down or its circuit open — nothing stored |
| 154 | (a 190) | breaks the connection (K2), then `409` as above |

### 3.10 Rules worth knowing

- One probe, three callers: the set-up job, route 154, and — unchanged — a send answered `access_off`.
- `message_access` is the last probe's answer; the **stop** is what blocks sending. They agree after any probe; a send's
  own `access_off` answer starts the stop and also sets `message_access = off` (one writer per answer).

### 3.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| IGC1 | IG1: columns + migration (expand only), Drizzle schema; the set-up job writes the probe's answer |
| IGC2 | IG2: route 154 (routes, controller, service method over `probeInstagramMessageAccess`, the 60-second rule, the stop ended / started through the lane port), schema doc, route catalog; `MESSAGE_ACCESS_RECHECK_MIN_SECONDS` in POLICIES.md |
| IGC3 | IG4: the serializer's `message_access`; a send's `access_off` answer also stores `off` |
| IGC4 | Tests: route 154 — `on` ends the stop, `off` starts it, `unknown` leaves it, the 60-second rule calls Meta once, 190 breaks the connection, 503 stores nothing, viewer refused, another organization 404; the set-up job stores the probe; routes 6/7 show it |

### 3.12 Nested sub-domains

None changed — `instagram-account-settings/`, `instagram-media/` as built.

