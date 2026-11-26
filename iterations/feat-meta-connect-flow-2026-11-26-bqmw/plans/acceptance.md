# Acceptance — feat-meta-connect-flow-2026-11-26-bqmw

Filled at Close: Result `pass` (Evidence: test file › test name, or a command), `partial`, `open` or `deferred`.
Features: 1 `connect-outcomes` · 2 `shared-assets-picker` · 3 `account-capabilities` · 4 `message-access`.

## Feature acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-1.1 — cancel | brief:L44 | pass | `channel-connection.integration.test.ts` › answers Meta's cancel with outcome cancelled, spends the state and saves nothing; › refuses a body with both a code and a cancel |
| AC-1.2 — outcome on every success | brief:L15 | pass | `channel-connection.integration.test.ts` › names the outcome of a first connect and of a reconnect |
| AC-1.3 — missing permissions named | brief:L46, L101 | pass | `channel-connection.integration.test.ts` › the missing-permission callback asserts `missing_permissions`; `app.error.unit.test.ts` pins the field kind |
| AC-1.4 — expected business named | brief:L64 | pass | `channel-connection.integration.test.ts` › puts an error connection back, reconnects its account, and refuses another business (`expected_client_business_id`) |
| AC-1.5 — no accounts shared (first / reconnect) | brief:L52, L102 | pass | `channel-connection.integration.test.ts` › refuses a first connect that shares no Instagram account; › keeps a reconnect that shares none |
| AC-1.6 — unshared accounts marked by the callback | brief:L61 | pass | `channel-connection.integration.test.ts` › marks only the accounts a complete list no longer shares |
| AC-1.7 — plan limit with `plan_room` | brief:L58 | pass | `channel-connection.integration.test.ts` › the plan-limit pick asserts `plan_room`; `channel-connection-error.util` unit |
| AC-1.8 — connect options | brief:L13, L96 | pass | `channel-connection.integration.test.ts` › answers the connect options for an owner, a viewer and an unconfigured Meta |
| AC-1.9 — unpicked clean-up after 7 days | brief:L54, L104 | pass | `channel-connection-token-check.integration.test.ts` › a login nobody picked from (3 tests) |
| AC-2.1 — shared assets list and states | brief:L94, L103 | pass | `channel-connection.integration.test.ts` › lists what the login shares now with each pick state, re-read from Meta |
| AC-2.2 — shared assets re-read, errors | brief:L94 | pass | `channel-connection.integration.test.ts` › breaks the connection when Meta refuses its token on the shared-assets read |
| AC-2.3 — viewer reads; Pages sketch | brief:L78, L110 | pass | `channel-connection.integration.test.ts` › the shared-assets read by a viewer; › reads, lists shared assets … of another organization: 404; Pages sketch routes-final 2.10 |
| AC-3.1 — capabilities per feature | brief:L95, L105 | pass | `channel-account-capabilities.integration.test.ts` › lists every feature through the one check on Creator; › names the plan switch and the upgrade fix |
| AC-3.2 — blockers with fixes | brief:L20, L95 | pass | `channel-account-capabilities.integration.test.ts` › lists the stored blockers with their start and fix; constants unit › names every lane stop and every plan stop as a blocker |
| AC-3.3 — refusal names the permission | brief:L49 | pass | `channel-account-feature-check.service.unit.test.ts` › permission_not_granted names Meta's permission; `instagram-account-settings.integration.test.ts` › 409 permission_not_granted (asserts `permission`) |
| AC-3.4 — per-account scopes | brief:L89, L108 | partial | `channel-account-capabilities.integration.test.ts` › reads the account's own permissions over the connection's; feature-check unit › account scopes override / fall back — the writer waits on owner test O1 (CN10) |
| AC-3.5 — capabilities access | brief:L75 | pass | `channel-account-capabilities.integration.test.ts` › lets a viewer read it; answers 404 for another organization and on a personal one |
| AC-4.1 — set-up stores the probe | brief:L85, L107 | pass | `instagram-account-tasks.processor.unit.test.ts` › the set-up stores the probe (on, off) |
| AC-4.2 — re-check moves the stop | brief:L69 | pass | `instagram-account-message-access.integration.test.ts` › stores off and stops every lane, then on ends the stop; › stores unknown and leaves the lanes; send-core db unit › a send's own access_off … stores message access off |
| AC-4.3 — re-check once a minute | brief:L69 | pass | `instagram-account-message-access.integration.test.ts` › answers the stored result within 60 seconds without calling Meta |
| AC-4.4 — re-check errors and access | brief:L75 | pass | `instagram-account-message-access.integration.test.ts` › breaks the connection when Meta refuses the token, then 409; › 503 storing nothing; › refuses a viewer (403) and 404 for another organization |
| AC-4.5 — accounts show message access | brief:L107 | pass | `instagram-account-message-access.integration.test.ts` › shows the stored answer on routes 6 and 7; serializer units |

## Brief acceptance lines

| Item | Source | Proved by | Result |
| --- | --- | --- | --- |
| BRIEF-1 — every outcome has one documented answer and a test | brief:L100 | AC-1.1–AC-1.9, AC-2.2; routes-final 1.9 / 1.10 | pass |
| BRIEF-2 — missing permissions named | brief:L101 | AC-1.3 | pass |
| BRIEF-3 — `no_accounts_shared` | brief:L102 | AC-1.5 | pass |
| BRIEF-4 — picker re-read | brief:L103 | AC-2.1 | pass |
| BRIEF-5 — unpicked clean-up job | brief:L104 | AC-1.9 | pass |
| BRIEF-6 — capabilities read | brief:L105 | AC-3.1, AC-3.2 | pass |
| BRIEF-7 — message access + Page id stored | brief:L107 | AC-4.1, AC-4.5; **Page id deferred** (C-D13, owner test O6) | partial (Page id deferred by C-D13, owner test O6) |
| BRIEF-8 — per-account permissions | brief:L108 | AC-3.4 (behind owner test O1) | partial (behind owner test O1) |
| BRIEF-9 — `channel` everywhere, Pages sketch | brief:L110 | AC-2.3 | pass |
| BRIEF-10 — routes.txt, OpenAPI, route map, i18n | brief:L112 | the Close gates | pass — routes.txt 211, `pnpm docs:check`, frontend-route-map, i18n en/es |
