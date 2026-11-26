# Coverage — feat-meta-connect-flow-2026-11-26-bqmw

Mode **initial** (Baseline `none`, Intake mode `brief`, from scratch) · Intake hash `f1ff32a8eb81` · 2026-11-26.
Source: `intake-files/BRIEF.md` (`brief:L…`). There is no `PRD.md` or `schema-routes.md`: the brief is reconciled
against the **code as built** (paths under `src/domains/app/sub-domains/`, `file:line`).

Status: `covered` (built today, no change) · `change` (built, must change) · `new` (not built) · `open` (waits for a
Step 4 answer) · `out-of-scope`. Proposals `RC-n` / `DB-n` / `WC-n` are in `route-changes.md`, `db-changes.md`,
`worker-changes.md`; questions `Qn` are asked at Step 4.

## Coverage — the 19 outcomes (brief:L42–L76)

| # | Outcome (brief) | Today (code) | Gap | Proposal | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Cancel / close the Meta dialog — state spent, nothing saved (brief:L44) | callback body is `{code, state}` strict → `400` validation; state not spent, expires in 10 min (`channel-connection/channel-connection.dto.ts:36-41`, `channel-connection-state.ts:59-64`) | backend never learns of a cancel | RC-1 | new — [C-D1](decisions.md) |
| 2 | Bad / used / foreign state (brief:L45) | `400 channel_connect_state_invalid`, read-and-deleted (`channel-connection-state.ts:69-73,128-141`) | — | — | covered |
| 3 | Required permission missing names which (brief:L46) | `422 provider_permissions_missing`, no list (`channel-connection.service.ts:376-379`, `channel-connection-error.util.ts:95-99`) | body lacks the missing names | RC-2 | change |
| 4 | Optional permission missing → per-account capability with permission name (brief:L48) | only `scopes` / `has_ads_access` on the connection (`channel-connection.serializer.ts:59-60`); a feature refusal is `409 permission_not_granted` with the plan feature key, not the permission (`channel-account/channel-account-error.util.ts:57,64`) | no capability read; no permission name | RC-6, RC-9 | new |
| 5 | Permission read cannot tell (brief:L51) | `409 instagram_connect_restart_required` (code spent) — fix F-D3/F-D10 (`channel-connection-error.util.ts:124,127`) | frontend copy only | RC-2 | covered (decided by the fix) |
| 6 | No Instagram account shared → nothing saved, `no_accounts_shared` (brief:L52) | connection + token saved, `200` with `accounts: []` (`channel-connection.service.ts:389-410,464-477`) | saves a token with no account | RC-3 | change — [C-D2](decisions.md) |
| 7 | None picked → connection stays; picker reopens; cleanup after a set time (brief:L54) | connection stays `connected` with its token; no cleanup job; no GET re-reads Meta's list — only the pick POST (`channel-connection.service.ts:529`) and the daily token check (`workers/channel-connection-token-check.processor.ts:578`) | no re-read route; no cleanup | RC-5, WC-1 | new — [C-D3](decisions.md) 7 days |
| 8 | Live in another organization (brief:L57) | pick result `connected_elsewhere` (`channel-connection.service.ts:590-595`); race → `409 instagram_account_connected_elsewhere` | "what to do" copy | RC-5 (pick state) | covered |
| 9 | Over the plan limit (brief:L58) | `409 plan_account_limit` with `limit`, `used`, `upgrade_required`, all-or-nothing (`channel-connection-error.util.ts:75-85`, `channel-connection.service.ts:957-959`) | policy choice | RC-4 | change — [C-D4](decisions.md) |
| 10 | Revoked account back, settings kept (brief:L60) | upsert on `(organization_id, channel, provider_account_id)`; settings insert-if-absent (`channel-account/channel-account.repository.ts:404-431`; `instagram-account/instagram-account-settings/instagram-account-settings.service.ts:141-161`) | — | — | covered |
| 11 | Same portfolio again — new accounts in picker; unshared marked, never deleted (brief:L61) | new ones only in the callback's `accounts[]` (`state: free`); unshared marked only by the daily token check (`error` + `account_not_shared` stop, `channel-connection-token-check.processor.ts:458-466`), seen via `active_stop` (`channel-account/channel-account.serializer.ts:111`) | callback does not mark unshared accounts | RC-3, RC-5 | change |
| 12 | Second portfolio = second connection (brief:L63) | unique `(organization_id, provider, client_business_id)` (`channel-connection.schema.ts:78-82`) | — | — | covered |
| 13 | Reconnect into another portfolio names the expected business (brief:L64) | `409 channel_connection_business_mismatch`, no business named (`channel-connection-error.util.ts:64-68`) | body lacks expected id | RC-2 | change |
| 14 | Not professional / personal — explained (brief:L66) | Meta does not list it; nothing to detect | frontend copy only (route map) | RC-3 (`no_accounts_shared` hint) | covered by copy |
| 15 | Messages access off — stored, readable, re-checkable (brief:L68, L85) | probe result only logged; `off` adds an `access_off` lane stop (`instagram-account/workers/instagram-account-tasks.processor.ts:331-355,751-773`) | not stored; no re-check route | DB-1, RC-7, RC-8, WC-2 | new |
| 16 | Shared without its Page — says so, offers it (brief:L70, L87) | `instagram.is_messages_webhook_missing` on route 7 (`instagram-account/instagram-account.serializer.ts:45`); `with_page` on start/reconnect (`channel-connection.dto.ts:106-109`) | linked Page id not stored | DB-2, WC-3 | change — Q6 (Meta source) |
| 17 | Token dies → error, reconnect offered; dated token warns (brief:L72) | connection + accounts `error`, `login_expired` stop, notice (`channel-connection.service.ts:804-833`); dated warning (fix F4) | — | — | covered |
| 18 | Meta down in the callback → "try again" (brief:L74) | `503 instagram_unavailable` before the exchange, `409 instagram_connect_restart_required` after (`channel-connection-error.util.ts:124-131`) | — | — | covered |
| 19 | Roles (brief:L75) | manage: routes 1, 2, 3, 5, 40, 8–11; read: 4, 41, 42, 6, 7 (`channel-connection.routes.ts:45-175`, `channel-account/channel-account.routes.ts:21`) | new routes follow the same split | all new RCs | covered |

## Coverage — stored facts, frontend reads, Pages (brief:L78–L96)

| Item | Today | Proposal | Status |
| --- | --- | --- | --- |
| Message access stored (`on/off/unknown`, checked at) (brief:L85) | logged only | DB-1, WC-2 | new |
| Linked Facebook Page id stored (brief:L87) | not read | DB-2, WC-3 | new — Q6 |
| Permissions per account from `granular_scopes` (brief:L89) | connection `scopes` only | DB-3, WC-4 | new — gated on fix owner test O1 |
| Re-read what the login shared, with pick state (brief:L94) | no GET | RC-5 | new — Q5 (name) |
| Capabilities per account with the blocking reason (brief:L95) | not exposed | RC-6 | new |
| Connect-start preconditions (brief:L96, L13) | none; route 1 fails `503` / `400` | RC-10 | new |
| `channel` on every asset; Pages adds no route change (brief:L78) | `channel` on accounts, only `instagram` (`channel-connection.constants.ts:30`) | RC-5, RC-6 carry `channel`; a Pages sketch in the route review | change — Q7 |

## Coverage — acceptance (brief:L100–L112)

| Brief line | Covered by |
| --- | --- |
| L100 every outcome documented + tested | the route review's error table per route; one test per outcome row above |
| L101 missing permissions named | RC-2 |
| L102 `no_accounts_shared` | RC-3 |
| L103 picker re-read | RC-5 |
| L104 cleanup job | WC-1 |
| L105 capabilities read | RC-6 |
| L107 message access + Page id | DB-1, DB-2, RC-7, RC-8 |
| L108 per-account permissions | DB-3, WC-4 |
| L110 `channel` + Pages sketch | RC-5, RC-6, route review |
| L112 docs, OpenAPI, route map, i18n | every RC (kickoff gates) |

## Delta

`n/a — initial` (Baseline `none`). `pnpm iteration:diff` has no Baseline to compare; the snapshot is `BRIEF.md` alone.

## Reconciliation — brief vs the code as built

| # | Item | Brief says | Code says | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| R1 | Cancel reaches the backend | brief:L44 "the state is spent" | the callback refuses an `error` body (`channel-connection.dto.ts:36-41`) | brief asks for new behaviour | RC-1 (Q1 decides the answer) |
| R2 | Messages-off visibility | brief:L68 "its message capabilities say why they are off" | an `access_off` lane stop already shows via `active_stop` (`instagram-account-tasks.processor.ts:331-355`) | partly built | reuse the stop for the capability reason; store the probe (DB-1) |
| R3 | No-Page detection | brief:L70 "today's `with_page` login" | detection is the webhook watch, not the Page id (`instagram-account-tasks.processor.ts:491-560`) | built differently | keep the watch; DB-2 adds the id, does not replace it |
| R4 | Unshared accounts | brief:L61 "marked, never silently deleted" | marked only by the daily token check (`channel-connection-token-check.processor.ts:458-466`) | partly built | the callback marks them too (RC-3) |
| R5 | Permission-read outage | brief:L51 "the plan decides" | already decided by fix F-D3 / F-D10 → `409 instagram_connect_restart_required` | settled | frontend copy only |
| R6 | Feature refusal names the permission | brief:L49 "with the permission name" | `error.feature` is the plan key (`channel-account-error.util.ts:57,64`) | gap | RC-9 adds `permission` |

## Findings

- F1 — the brief's per-account permissions (L89) rest on owner test O1 of the fix iteration; until it passes, DB-3/WC-4 stay
  behind a "connection scopes stand" fallback.
- F2 — there is **no documented Instagram-user field** for the linked Facebook Page under Unified Login (the Page side has
  `instagram_business_account`) ⚠️ unverified — Q6.
