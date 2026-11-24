# Alignment check — feat-instagram-dm-sending-2026-11-23-oxak/plans

Read-only audit, 2026-11-24. Files under `iterations/feat-instagram-dm-sending-2026-11-23-oxak/plans/`
(abbreviated RF = routes-final.md, RC = route-changes.md, DB = db-changes.md, WC = worker-changes.md,
COV = coverage.md, DEC = decisions.md). routes-final is the source of truth (P90).

Method: python3 parsers (scripts in `../scripts/`): all 158 rows of the RF `N.7` / `N.X.7` route tables against the 109
RC table rows (method, path suffix, access code, idempotency, change kind, the RC row's "routes-final § n, route m"
cite); RF `.3` table names and column rows against the DB Mermaid labels and entity blocks; every `WC-n` in RF
against the 60 WC rows; a grep for each stale name and each of P54–P90 across all six files.

## What matched

- **Routes (method/path/access/idempotency):** every RC cited by an RF §7 row matches its method, its path (RF without the
  `/api/v1/app` prefix and the `/api/v1` platform prefix), its access code (P59: routes 1–11, 15 and 40–42 use `channel-account:*`, routes 12–14 and 63 use
  `instagram-account:*`, route 62 uses `instagram-webhook-event:read`) and its X-Idempotency-Key rule (P89: same set both sides — RC finding 13 =
  RF "POST without req" list). Parent and nested tables agree for all 95 route numbers. No RC appears under two route numbers.
- **Counts:** RC area counts (9/2/1, 4/2/0, 0/1/0, 0/2/0, 0/3/0, 4/2/0, 4/5/0, 6/0/0, 13/0/0, 2/0/0, 1/0/0,
  6/38/4 = 49/55/5) equal the rows. RF sub-domain counts (11, 6, 3, 9, 13, 3, 2, 13, 9, 9, 9, 7, 1 = 95) equal the §7
  tables. WC 45/12/3 = 60 rows. DB 21 NEW / 15 CHANGED / 1 REMOVED / 1 EXISTING equal the Mermaid labels.
- **Table set:** all 38 DB tables appear in RF `.3` sections, with the same names. The shared tables have no `instagram_` prefix
  (P48). There is no `sending_helper_slots` table (P73). RF-only `.3` mentions are rows-only platform tables (roles, permissions,
  verification tokens, notifications…), which DB covers under "Reference data (no new tables)". `provider_account_id`
  (P60), `encrypted_refresh_token` + `token_type` (P49), `usage_percent` / `usage_wait_until` (P51) and the `channel_account_id`
  pointers agree (one exception, #7 below). There is no `pro_features` / `is_pro_enabled` column.
- **Leftovers:** every hit of `meta_connection`, `meta_attachment`, `direct_message_month`, `dm_month`,
  `instagram_contacts|automations|broadcasts|segments`, `pro_features`, `is_pro_enabled`, `sending_helper_slot`,
  `workspace_` and `awaiting your OK` is a history note ("was …", "renamed from …", a superseded M-note, an answered-question
  row) or the RF self-check line (L5498). The two real leftovers are #4 and part of #10.
- **Decisions P54–P90:** each one is cited where it applies, and its substance matches. The exceptions are P51 (#7), P59
  wording (#17), P80 (#6, #14) and P83 (#13).

## Mismatches

| # | Kind | Mismatch | File:line A | File:line B | Fix (which file should change) |
| --- | --- | --- | --- | --- | --- |
| 1 | Route | RC-102–RC-111 (10 CHANGED rows) are served by no RF route number. RF still calls 8 of them "Not RC rows … for the route-changes sync" and calls `POST /uploads/{upload_id}/confirm` (RC-111) an "Unchanged route", and it has no row for `POST /tenancy/organizations` (RC-109) or `GET /tenancy/organization` (RC-110), only TN7/TN8 prose. The totals therefore differ: RF 95 = 49 new + 45 changed + 1 as built, while RC is 49 NEW + 55 CHANGED (+ RC-67 EXISTING). | RC:327–336 (and Before → after L405–414) | RF:57, 4586–4588, 5046–5047, 5438; RF 9.A TN7/TN8 L4263–4264 | routes-final (cite RC-102–RC-111 as changed routes without a review number; drop "Not RC rows" / "Unchanged"; note 45 + 10 = 55 in the total) |
| 2 | Route (cite) | RC Source cites the wrong section. RC-7–RC-11 and RC-60 cite "routes-final § 2, route 6–11", but those routes are in § 1B. RC-15, RC-17 and RC-18 cite "§ 2, route 15/16/17", but those routes are in § 1. | RC:160–162, 173–178 | RF:553–555, 801–806 | route-changes |
| 3 | Route (cite) | RC-112, RC-113 and RC-114 have no routes-final cite in Source (RF routes 42, 40, 41). | RC:156, 158, 159 | RF:547, 550, 552 | route-changes |
| 4 | Leftover | The RC intro says the Instagram webhook stays under `/api/v1/app/social/instagram/…`. Since P53 the receiver is `/social/channel-connections/meta/webhooks/instagram` (RC-115, RC-16); only the debugging list stays under `social/instagram`. | RC:26–28 | RF:157 (M11), 2302–2303; RC:202–203 | route-changes |
| 5 | Route (cite) | The RC column of route 60's row reads `CHANGED` instead of `RC-115`. The 5.A.7 / 5.B.7 rows carry no RC cite at all. | RF:2302 (2407, 2579) | RC:202 | routes-final (cite only) |
| 6 | Route | RC-64 (`GET /auth/me/context`) omits `is_plan_choice_required` (P80, BL24), which route 108 returns. | RC:297, 381 | RF:3864, 3867, 3928 | route-changes |
| 7 | Table column | `channel_connections`: RF has `usage_read_at`, while DB (and COV) have `usage_checked_at` (P51). | RF:465 | DB:73, 290, 318; COV:76 | db-changes, coverage |
| 8 | Table column | `channel_accounts` status: RF keeps `connection_status` with no `*_changed_at`, and the launch's `connection_status_changed_at` is in neither its moved nor its removed list. DB renames it `status` + `status_changed_at` and moves `connection_status_changed_at` there. | RF:734, 741, 1029 | DB:394–395, 411–412, 459, 487 | db-changes (or RF lists the dropped column) |
| 9 | Table column | `channel_accounts.paused_by_user_id` is in RF but missing from DB. | RF:737 | DB:415 | db-changes |
| 10 | Table / work | Plan stop placement. RF: the account holds only `plan_stopped_at` ("not in your plan"), and the organization-wide `plan_limit` / `plan_ended` stay on the lanes as `plan_stop_reason` + `plan_stopped_at` (CA3, SN9, SN12). DB: `channel_account.plan_stop_reason` (plan_limit · plan_ended · plan_downgrade), and the lane keeps only its error stop. WC-37 and WC-56 follow DB (stops "on its channel accounts"). RF SN12's "db-changes has one `stop_reason` for both" is itself stale. | RF:678, 739, 2659, 2842, 2866 | DB:398, 417–418, 1256–1259, 1265–1268; WC:75, 152, 170 | db-changes, worker-changes |
| 11 | Table column | `app.broadcasts.channel` is in DB but not in RF 7.A.3 (columns or object). | DB:1170 | RF:3332–3369 | db-changes (or RF adds it — M10 L156 lists broadcasts among the tables with `channel`) |
| 12 | Table column | Plan features: RF names the nested key `feature_switches` (4 top-level keys + `feature_switches: { key: boolean }`, `chk_plans_features`). DB never names `feature_switches`, although RF claims DB was synced with it. | RF:3786, 3799, 3821, 5519 | DB:1573–1583, 1611, 1889 | db-changes |
| 13 | Decision (P83) | Same issue as #12, seen from P83. | — | — | (covered by #12) |
| 14 | Background work | The retired-plan notice (P80). RF puts it in WC-59 as a third finding: a 15-minute sweep, once per subscription, emitting `moved_down` (WC-38) and `billing.plan_choice_required`, with the notice on route 108 (`is_plan_choice_required`). WC adds a separate WC-66 instead: once at release, notice read on RC-56 (RC-56 lists no such notice). RF never names WC-66. | RF:3867, 3977, 5520 | WC:25–28, 178, 238–240; DB:1589; COV:95 | worker-changes (fold into WC-59), db-changes, coverage |
| 15 | Background work | RF lists WC-45 among sub-domain 4's changed workers (AU30 "as built, changed", AUC11 "WC-45 without a key"). WC has no WC-45 row and calls it unchanged. | RF:1670, 2020, 2090 | WC:109–111 | worker-changes (add a CHANGED row) or RF |
| 16 | Background work (cite) | RF describes WC-62–WC-65 without their numbers: purge BC4 (L3165), grouped note UN13 (L5315; 11.D and the §11 header cite only WC-56–58, L4960, L5077), trusted-device clean-up (L4816–4817, "a worker-changes row, for its sync"), seat sync off BL9 (L3646). | RF:3165, 4816–4817, 4960, 5077, 5315, 3646 | WC:174–177 | routes-final (cite only) |
| 17 | Decision (P59) | DB and COV say "Instagram settings, media and webhook keep `instagram-account:*`" (DEC P59's wording). In fact the webhook receiver is PUBLIC, the webhook list is `instagram-webhook-event:read`, and sending status (route 63 / RC-35) is `instagram-account:read`. RC L48 states this correctly. | DB:1686; COV:87; DEC:96 | RF:2278, 2304, 2724; RC:48 | db-changes, coverage (DEC binding — add a clarifying note) |

Low-severity / not counted: RF L130 (M2, "both names kept") is superseded by M10 L156 (a history note). RF says "Viewer's 4"
grants (L4160, L4187), and DB says five codes (L1689–1690); the same five once TNC8 copies `channel-account:read`. RC L104 and
DEC P59 say "the 17 shared routes take channel-account", but 15 take it and 2 are PUBLIC.

**Verdict: 16 mismatches (#1–#12, #14–#17; #13 is folded into #12).** The table set, route paths, access codes and
idempotency agree. The drift is in RC-102–RC-111's standing in RF, source cites, five column details, plan-stop
placement, and the retired-plan worker.
