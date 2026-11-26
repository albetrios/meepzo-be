# KICKOFF — feat-meta-connect-flow-2026-11-26-bqmw

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `feat-meta-connect-flow-2026-11-26-bqmw` |
| Mode | initial (Baseline `none`) |
| Intake mode | brief — from scratch |
| Intake note | 1 received (`BRIEF.md`) · from scratch |
| Drop placed | 2026-11-26 |
| Intake hash | `f1ff32a8eb81` |
| Schema-routes | — (brief) |
| Date | 2026-11-26 |

## 2. Goal and scope

Every outcome of a Meta Unified Login is explicit, recoverable from the frontend and readable again after a reload,
and the contract is shaped so a Facebook Page is an addition, not a rewrite. The route review is
[`plans/routes-final.md`](plans/routes-final.md) (final 2026-11-26).

- **In scope:** the callback's outcomes (cancel, outcome field, named errors, no accounts shared, unshared accounts
  marked, plan room); routes 151 shared assets, 152 connect options, 153 capabilities, 154 messages-access re-check;
  `message_access` stored and shown; per-account permissions (behind owner test O1); the unpicked clean-up.
- **Out of scope:** building the Facebook Page channel, WhatsApp, ads management (brief:L116); the linked Page id —
  deferred to a fix after owner test O6 ([C-D13](plans/decisions.md)); the frontend screens (meepzo-fe plans them
  from the route map).

## 3. Locked decisions

| # | Summary |
| --- | --- |
| [C-D1](plans/decisions.md) | Cancel → `200` `outcome: cancelled` |
| [C-D2](plans/decisions.md) | First connect sharing none → `422`; reconnect sharing none → keep token, mark accounts |
| [C-D3](plans/decisions.md) | Unpicked connection revoked after 7 days |
| [C-D4](plans/decisions.md) | Plan limit all-or-nothing + `plan_room` |
| [C-D11](plans/decisions.md), [C-D12](plans/decisions.md), [C-D14](plans/decisions.md) | Route review sub-domains 1–3 confirmed as drafted |

## 4. Features and order

1. `connect-outcomes` — [story](plans/features/connect-outcomes/story.md)
2. `shared-assets-picker` — [story](plans/features/shared-assets-picker/story.md)
3. `account-capabilities` — [story](plans/features/account-capabilities/story.md)
4. `message-access` — [story](plans/features/message-access/story.md)

## 5. ROUTE

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `app.instagram_accounts` + `message_access`, `message_access_checked_at` — db-changes DB-1, routes-final § 3.3 | table | — | `/be-schema-complete` (CHANGE table) | AC-4.1 (column) | — | done |
| R2 | `app.channel_accounts` + `scopes`, `scopes_read_at` — db-changes DB-3, routes-final § 2.3 | table | — | `/be-schema-complete` (CHANGE table) | AC-3.4 (column) | — | open |
| R3 | 1 Channel connection — routes-final § 1 (CN1–CN8; code changes CNC1–CNC6, CNC8): callback outcomes, routes 151, 152, plan room | sub-domain | — | `/be-build-requirement` | AC-1.1–AC-1.8, AC-2.1–AC-2.3 | — | open |
| R4 | 2 Channel account — routes-final § 2 (AC1–AC5; ACC1–ACC4): route 153, the named permission, per-account scopes in the check | sub-domain | R2 | `/be-build-requirement` | AC-3.1–AC-3.5 | — | open |
| R5 | 3 Instagram account — routes-final § 3 (IG1, IG2, IG4, IG5; IGC1–IGC4): the probe stored, route 154, routes 6/7 show it | sub-domain | R1, R4 | `/be-build-requirement` | AC-4.1–AC-4.5 | — | open |
| R6 | Background — the daily token check: unpicked clean-up (CN9, CNC7) and per-account scopes behind owner test O1 (CN10, AC5) | background | R2, R3 | `/be-worker-complete` | AC-1.9, AC-3.4 | — | open |
| R7 | Flow and close — every outcome of routes-final 1.9 / 1.10 end to end; `docs/routes.txt`, OpenAPI, i18n, `plans/frontend-route-map.md` | flow | R3–R6 | `/be-build-requirement` | BRIEF-1–BRIEF-10 | — | open |

## 6. Requirements index

| File | Identifiers |
| --- | --- |
| [connect.md](plans/requirements/connect.md) | `connect.cancel`, `connect.outcome`, `connect.missing-permissions-named`, `connect.business-mismatch-named`, `connect.no-accounts-shared`, `connect.unshared-marked`, `connect.plan-room`, `connect.shared-assets`, `connect.options` |
| [accounts.md](plans/requirements/accounts.md) | `accounts.capabilities`, `accounts.permission-named`, `accounts.per-account-scopes`, `accounts.pages-ready` |
| [instagram.md](plans/requirements/instagram.md) | `instagram.message-access-stored`, `instagram.message-access-recheck`, `instagram.message-access-shown` |
| [background.md](plans/requirements/background.md) | `background.unpicked-cleanup`, `background.per-account-scopes-refresh`, `background.message-access-probe` |
| [data.md](plans/requirements/data.md) | `data.channel-accounts-scopes`, `data.instagram-message-access` |

## 7. Open AMBER items

| # | Default | Settles when |
| --- | --- | --- |
| [C-D5](plans/decisions.md) | route 151 named `shared-assets` | kickoff of R3 |
| [C-D7](plans/decisions.md) | capabilities as their own route 153 | kickoff of R4 |
| [C-D9](plans/decisions.md) | re-check at `/instagram/accounts/{channel_account_id}/message-access-checks` | kickoff of R5 |
| [C-D10](plans/decisions.md) | the clean-up inside the daily token check | kickoff of R6 |
| [C-D13](plans/decisions.md) | linked Page id deferred | owner test O6 |
| O1 (owner test) | per-account scopes stay `null` until `/debug_token` `granular_scopes` is confirmed | the Meta dev app |

## 8. Standing deviations

`n/a — initial` (Baseline `none`). The frozen `fix-meta-unified-login-2026-11-26-ceuy` left one standing deviation this
iteration keeps: the `/debug_token` customer token in the query (F-D4) — route 151 and the token check reuse that read.

## 9. Definition of done

Every ROUTE row `done` (or `deferred` with the user's OK); `plans/acceptance.md` filled; the `AS-BUILT.md` summary and
Standing deviations written; the gates green.

## 10. Verification

Brief mode: every `BRIEF.md` acceptance line (brief:L100–L112) traced in `plans/acceptance.md`. Gates: `pnpm validate`,
`pnpm tsdoc:check`, `pnpm db:migrate:lint`, `pnpm routes:catalog:check`, `pnpm docs:check`, the touched suites,
`pnpm test:rls-role:changed`, `pnpm test:contract` (Meta client), `pnpm iteration:frontend-map <iteration> --check`.
