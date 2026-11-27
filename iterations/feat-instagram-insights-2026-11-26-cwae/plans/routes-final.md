# Meepzo API — Instagram insights and our analytics, final routes, sub-domain by sub-domain

**Route review final — 2026-11-27.** Every sub-domain is confirmed; the frontend may kick off on these routes.

Started from branch `feat/instagram-automation` at `c76dade`. Every decision reads **today → after**; today is the code as
built (`src/domains/app/sub-domains/…`, `file:line`). Sources: [`coverage.md`](coverage.md) (N1–N9, `B:<line>` =
`intake-files/BRIEF.md`), [`decisions.md`](decisions.md) (N-D1–N-D8), [`route-changes.md`](route-changes.md) (RC-n),
[`db-changes.md`](db-changes.md), [`worker-changes.md`](worker-changes.md) (WC-n).

## File header — legend

Paths are under `/api/v1/app`; `{x_id}` is a public id; **Gate** is the permission the caller needs; **Idem** `req` =
`X-Idempotency-Key` required; `*` = required. Route numbers continue after engage (ends at 181): new ones start at
**182**. Every route here is a read — none calls Meta (B:32).

## File header — sub-domains (in build order)

| # | Sub-domain | Folder (`src/domains/app/sub-domains/…`) | Paths | Routes touched | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Instagram analytics (our numbers) | `instagram-analytics/` | `/analytics/…` | 3 new (182–184) | contact, automation, broadcast, sending, inbox | **final (rev 1, confirmed 2026-11-27)** |
| 2 | Instagram insight (Meta's numbers) | `instagram-account/instagram-insight/` (+ nested `instagram-story-insight/`) | `/social/instagram/accounts/{channel_account_id}/insights…`; route 153 | 4 new (185–188), 1 changed (153) | instagram-account, instagram-media, channel-account | **final (rev 1, confirmed 2026-11-27)** |

Total: **7 new routes, 1 changed** — none removed.

## File header — code layout and tables without routes

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `app.instagram_analytics_day_counts` | `instagram-analytics/` | the source commits (WC-4) and the one-time fill (WC-5) |
| 2 | `app.instagram_insight_snapshots` | `instagram-account/instagram-insight/` | the daily snapshot (WC-1) |
| 2 | `app.instagram_story_insights` | `instagram-account/instagram-insight/instagram-story-insight/` | the story-insight processing (WC-3) |

## File header — rules for every sub-domain

| # | Rule |
| --- | --- |
| K1 | **Reads never call Meta** (B:32): Meta's numbers come only from the daily snapshot and the story webhook. |
| K2 | **No full scans on page open** (B:33): our numbers read the pre-aggregated day counts only. |
| K3 | **Every new tenant table** has FORCE RLS with USING and WITH CHECK on `organization_id`, the retention-sweep arm, and is kept **13 months** (B:36) by the shared partition upkeep. |
| K4 | **The organization's day** (B:34): every day is `tenancy.organizations.timezone`'s day, as `instagram_send_day_counts` already counts (`instagram-send-day-count.schema.ts:37`). |
| K5 | **Open on every plan** ([N-D1](decisions.md)): no plan gate, no history limit; only retention bounds a range. |

## File header — connections

```text
1) WHO POINTS AT WHOM
   app.channel_accounts ◄── app.instagram_analytics_day_counts (channel_account_id; automation / broadcast / media ids copied)
   app.channel_accounts ◄── app.instagram_insight_snapshots (channel_account_id)
   app.instagram_media  ◄── app.instagram_insight_snapshots (instagram_media_id, media subject)
   app.channel_accounts ◄── app.instagram_story_insights (channel_account_id)

2) WHAT ONE ACTION SETS OFF
   a DM sent / reply / tap / email / phone / new contact / response ► +1 on that day's count row   [same commit]
   the organization's day ends            ► 1 account snapshot + 1 per chosen post (N-D5)    [worker]
   story_insights webhook                 ► 1 story-insight row (a repeat updates it)        [worker]
```

---

## 1. Instagram analytics (our numbers) — final (rev 1, confirmed 2026-11-27) — no nested sub-domains

Code: a new top-level folder `instagram-analytics/` (schema, repository, service, controller, routes, dto, validator,
serializer, types). The increments are a small port (`InstagramAnalyticsCountPort`) the source services call inside
their own commits.

### 1.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| AN1 | **Counts raised in the source commit** ([N-D3](decisions.md)). Today the only day counts are the send meter's (`instagram_send_day_counts`, slots, `instagram-send-day-count.schema.ts`) and all-time automation counts. After: one upsert-increment per event in the commit that already writes it — the send result save (`dms_sent`), the inbound intake (`replies_received`), the run engine's tap / email / phone steps, contact creation (`new_contacts`), the inbox's first-response write (`responses`, `response_seconds_total`). A failed commit counts nothing; a retry of the same event counts once (the increment rides the source row's own once-only write). |
| AN2 | **One row per account × day × automation × broadcast × post × slot.** `automation_id`, `broadcast_id` and `instagram_media_id` (the post a run started from — `trigger_instagram_media_id`, `automation-run.schema.ts:51`) are nullable copies, no reference, so a deleted automation's history stays. `slot` (0–7) spreads hot rows as the send meter does; reads `SUM` over slots. The post dimension is what route 186 / 187's "DMs started from this post" reads after the runs' 90 days. |
| AN3 | **The organization's day** (K4): `day_date` is computed at write time in the organization's time zone; a time-zone change applies from the next event on (past days are not moved). |
| AN4 | **History at release** ([N-D4](decisions.md)): a one-time fill (WC-5) rebuilds the counts from what is still stored (runs 90 days, messages a year, contacts all) — resumable, idempotent (it writes absolute values per day, never increments). Response times only from the inbox's rows (N-D8). |
| AN5 | **Retention 13 months** (K3): monthly parts by `day_date`, the upkeep's CASE entry, `INSTAGRAM_ANALYTICS_KEEP_DAYS`. |
| AN6 | **Access** ([N-D6](decisions.md)): `instagram-account:read` on all three routes (Viewer included); 183 / 184 also check the automation / broadcast is this organization's. |

### 1.2 Open questions

None RED. AMBER N-D8 (response times appear once the inbox writes them) stays as decided.

### 1.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.instagram_analytics_day_counts` | **NEW** — `organization_id`, `channel_account_id`, `day_date`, `automation_id`, `broadcast_id`, `instagram_media_id` (Meta's media id, bounded), `slot`, `dms_sent`, `replies_received`, `links_tapped`, `emails_collected`, `phones_collected`, `new_contacts`, `responses`, `response_seconds_total`, `updated_at` |

**PostgreSQL design**: partitioned by month on `day_date`; unique `(organization_id, channel_account_id, day_date,
coalesce(automation_id, 0), coalesce(broadcast_id, 0), coalesce(instagram_media_id, ''), slot)` — the upsert target;
read indexes `(organization_id, channel_account_id, day_date)`, `(organization_id, automation_id, day_date)` where set,
`(organization_id, broadcast_id, day_date)` where set, `(organization_id, channel_account_id, instagram_media_id,
day_date)` where set; every count ≥ 0 (CHECK); FORCE RLS organization policy + the retention arm.

### 1.4 Permissions

| Code | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `instagram-account:read` | read our numbers | 182–184 | Owner, Admin, Editor, Viewer |

### 1.5 Common to every route

Team organizations only (a personal one: `404 team_organization_required`); `from` / `to` are dates in the
organization's time zone, `to` inclusive, default the last 30 days, at most 13 months back and never past today.

### 1.6 Objects returned

| Object | Shape |
| --- | --- |
| Analytics | `{ range: { from, to, time_zone, group_by }, totals: <numbers>, series: [{ period_start, …<numbers> }] }` |
| Numbers | `dms_sent, replies_received, links_tapped, emails_collected, phones_collected, new_contacts, responses, average_response_seconds \| null` |

### 1.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 182 | GET | `/analytics/channel-accounts/{channel_account_id}` | The account's numbers by day / week / month | `instagram-account:read` | |
| 183 | GET | `/analytics/automations/{automation_id}` | One automation's numbers (the automation detail's results panel) | `instagram-account:read` | |
| 184 | GET | `/analytics/broadcasts/{broadcast_id}` | One broadcast's numbers | `instagram-account:read` | |

### 1.8 Request details

- 182: query `from`, `to`, `group_by` (`day` · `week` · `month`, default `day`; a week starts Monday).
- 183, 184: query `from`, `to`, `group_by` (as 182).

### 1.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 182 | `404` · `channel_account_not_found` | not this organization's Instagram account |
| 183 | `404` · `automation_not_found` | not this organization's automation (a deleted one still answers until purged) |
| 184 | `404` · `broadcast_not_found` | not this organization's broadcast |
| all | `400` · `invalid_field` | `from` after `to`, a range past 13 months or into the future, an unknown `group_by` |

### 1.10 Rules worth knowing

- A day with nothing is returned with zeros, so a chart has no gaps.
- A revoked account's history stays readable until retention drops it.
- Numbers before the release come from the one-time fill; runs older than 90 days at release are not recoverable.

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| ANC1 | AN2, AN5: the table + migration (partitioned, upkeep entry, FORCE RLS), schema, repository with the slotted upsert |
| ANC2 | AN1, AN3: the count port and its calls in the send result save, the inbound intake, the run engine's tap / email / phone steps, contact creation, the inbox's first response (WC-4) |
| ANC3 | AN4: the one-time fill (WC-5), resumable, with its run log |
| ANC4 | routes 182–184, controller, service, dto, validator, serializer; OpenAPI, catalogs, i18n |
| ANC5 | Tests: each source commit counts once (and nothing on rollback); the day in a non-UTC time zone; the fill matches the live counts; group_by day / week / month with zero days; 404s; Viewer reads; another organization 404 |

### 1.12 Nested sub-domains

None.

---

## 2. Instagram insight (Meta's numbers) — final (rev 1, confirmed 2026-11-27)

Code: a new nested folder `instagram-account/instagram-insight/` (snapshots, routes 185–187) with the nested
`instagram-story-insight/` (story insights, route 188). The capability change lives in `channel-account/`.

### 2.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| IN1 | **The permission is optional** ([N-D2](decisions.md)). Today the login asks exactly three permissions and `ads_read` is the one optional extra. After: `instagram_manage_insights` is a second optional one; the capability read (route 153) gains feature `insights`, refused `permission_not_granted` with the permission and fix `reconnect` when it is missing. |
| IN2 | **Snapshots by a daily job only** (K1, WC-1): after the organization's day ends, one account snapshot and one per chosen post ([N-D5](decisions.md): the last 30 days' posts and reels + any with a live automation). Meta down or throttled → retried within the day; a day still missing is a gap (never back-filled from Meta). Without the permission, no call. |
| IN3 | **Metrics stored as Meta answered** (`metrics` jsonb, name → value) ⚠️ the metric names and periods are unverified (owner test NO1); the routes pass them through with a fixed list of known names documented, unknown names kept but not documented. Demographics on the account snapshot only, when Meta answers them. |
| IN4 | **Story insights by webhook** ([N-D7](decisions.md)): `story_insights` subscribed (WC-2); one row per story, a repeat updates it (WC-3). ⚠️ payload unverified (NO1). |
| IN5 | **"DMs started from this post"** (route 186 / 187) reads sub-domain 1's day counts by `instagram_media_id` — never the runs (K2). |
| IN6 | **Retention 13 months** (K3): both tables split by month (`snapshot_date`, `received_at`), upkeep entries. |
| IN7 | **Access**: `instagram-account:read` (Viewer included); route 153 unchanged in access. |

### 2.2 Open questions

None RED. Owner test NO1 (metric names, periods, demographics threshold, `story_insights` payload, App Review for the
permission) stays open; a failing NO1 changes the snapshot's Meta calls and the documented metric list, not the routes.

### 2.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.instagram_insight_snapshots` | **NEW** — `id`, `public_id` (`igis_`), `organization_id`, `channel_account_id`, `subject` (`account` · `media`), `instagram_media_id` (our media row, for `media`), `snapshot_date`, `metrics`, `demographics`, `taken_at` |
| `app.instagram_story_insights` | **NEW** — `id`, `public_id` (`igsi_`), `organization_id`, `channel_account_id`, `instagram_story_id` (Meta's, bounded), `permalink`, `media_type`, `metrics`, `story_posted_at`, `received_at`, `updated_at` |

**PostgreSQL design**: snapshots partitioned by month on `snapshot_date`, unique `(organization_id, channel_account_id,
subject, coalesce(instagram_media_id, 0), snapshot_date)`, read index `(organization_id, channel_account_id, subject,
snapshot_date DESC)`; story insights partitioned by month on `received_at`, unique `(organization_id, channel_account_id,
instagram_story_id, received_at)` with the once-per-story lookup by `(channel_account_id, instagram_story_id)`; keyset
`(organization_id, channel_account_id, story_posted_at DESC, id DESC)`; `subject` CHECK with `instagram_media_id`
present exactly for `media`; FORCE RLS + the retention arm; upkeep entries.

### 2.4 Permissions

| Code | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `instagram-account:read` | read Meta's numbers | 185–188 | Owner, Admin, Editor, Viewer |
| `channel-account:read` | the capability read | 153 (changed) | as today |

### 2.5 Common to every route

Team organizations only; `{channel_account_id}` a `cha_` id of this organization's Instagram account (a revoked one
still reads its stored numbers). Without the permission, 185–188 answer `200` with empty data and
`meta.insights_status: permission_not_granted` (with `fix: reconnect`), so the screen shows our numbers beside.

### 2.6 Objects returned

| Object | Shape |
| --- | --- |
| Account insights | `{ insights_status, latest: { snapshot_date, metrics, demographics } \| null, series: [{ snapshot_date, metrics }] }` |
| Media insight | `{ media: { id, permalink, thumbnail_url, media_type, posted_at }, latest_metrics, dms_started, rank_value }` |
| Media insight detail | `{ media, series: [{ snapshot_date, metrics }], dms_started_series: [{ day_date, dms_started }] }` |
| Story insight | `{ id, instagram_story_id, permalink, media_type, metrics, story_posted_at, received_at }` |

### 2.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 185 | GET | `/social/instagram/accounts/{channel_account_id}/insights` | The account's latest snapshot and its daily series | `instagram-account:read` | |
| 186 | GET | `/social/instagram/accounts/{channel_account_id}/insights/media` | Posts and reels ranked by DMs started or by reach | `instagram-account:read` | |
| 187 | GET | `/social/instagram/accounts/{channel_account_id}/insights/media/{instagram_media_id}` | One post's series beside its DMs started | `instagram-account:read` | |
| 188 | GET | `/social/instagram/accounts/{channel_account_id}/insights/stories` | Ended stories with their final numbers | `instagram-account:read` | |
| 153 | GET | `/social/channel-accounts/{channel_account_id}/capabilities` | **+ feature `insights` (changed)** | `channel-account:read` | |

### 2.8 Request details

- 185: query `from`, `to` (as 1.5).
- 186: query `sort` (`dms_started` · `reach` · `views`, default `dms_started`), `from`, `to`, `limit` (≤ 50), `cursor`.
- 187: query `from`, `to`; `{instagram_media_id}` is our media row's public id.
- 188: query `limit` (≤ 50), `cursor` (newest first).

### 2.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| all | `404` · `channel_account_not_found` | not this organization's Instagram account |
| 187 | `404` · `instagram_media_not_found` | not this account's media |
| 185–187 | `400` · `invalid_field` | a bad range or an unknown `sort` |

### 2.10 Rules worth knowing

- Nothing here calls Meta; numbers are as of the last snapshot (`taken_at`).
- A post outside N-D5's set has no snapshots and ranks by DMs started only (`rank_value` null for reach / views).
- Story numbers arrive only for stories that end after `story_insights` is subscribed.

### 2.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| INC1 | IN6: the two tables + migrations (partitioned, upkeep entries, FORCE RLS), schemas, repositories; prefixes `igis`, `igsi` |
| INC2 | IN1: the optional permission in the login configuration's list; capability feature `insights` (route 153) |
| INC3 | IN2, IN3: Meta client account / media insight reads; the daily snapshot (WC-1) |
| INC4 | IN4: `story_insights` subscribed (WC-2), the event kind and its processing (WC-3) |
| INC5 | routes 185–188, controller, service, dto, validator, serializer; OpenAPI, catalogs, i18n |
| INC6 | Tests: the snapshot's chosen set and a Meta-down gap; no call without the permission; a story repeat updates once; ranking by each sort with the keyset; `permission_not_granted`; another organization 404 |

### 2.12 Nested sub-domains

| Nested sub-domain | Folder | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 2.A Instagram insight | folder root | `app.instagram_insight_snapshots` | 185–187 | final (as § 2) |
| 2.B Instagram story insight | `instagram-story-insight/` | `app.instagram_story_insights` | 188 | final (as § 2) |
