# Coverage — feat-instagram-insights-2026-11-26-cwae

Mode initial · Intake mode brief (from scratch) · Intake hash 8610bfdbae37 · 2026-11-27 (staged draft, Steps 1–3).
Sources: `intake-files/BRIEF.md` (B:<line>) and the code today (file:line). Gate: `pnpm iteration:intake
feat-instagram-insights-2026-11-26-cwae --check` → passed.

## Coverage

| Source (file:line) | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| B:5-7 | Account analytics screen: DMs sent, replies, links tapped, emails / phones collected, new contacts, first / last response times; by day, week, month; per automation and per broadcast | analytics.own-numbers | account-analytics | B:40-41 | covered |
| B:8-9 | Account insights from Meta (reach, views, profile taps, follower count, demographics) when `instagram_manage_insights` is granted | insights.account | account-insights | B:42-43 | covered |
| B:10-11 | Post / reel insights (views, reach, saves, shares) beside "DMs started from this post"; rank posts by conversations | insights.media, analytics.media-conversations | post-insights | B:42-43 | covered |
| B:12-13 | Story insights: final numbers by webhook (`story_insights`), kept after the story ends | insights.story, integrations.story-insights-webhook | story-insights | B:44 | covered |
| B:22 | Screens: account analytics (new), post detail (insights panel), automation detail (results panel) | analytics.own-numbers, insights.media | account-analytics, post-insights | B:40-43 | covered |
| B:23 | Entity `app.instagram_insight_snapshots` (new — daily account / media snapshots) | data.instagram-insight-snapshot | account-insights, post-insights | B:42-43 | covered |
| B:23 | Entity: story insights (new) | data.instagram-story-insight | story-insights | B:44 | covered |
| B:24 | Existing run / message / contact tables read as aggregates | data.analytics-day-counts | account-analytics | B:40-41 | covered |
| B:25-26 | Routes under `…/instagram/accounts/{channel_account_id}/insights…` and `/app/analytics…` | (route-changes.md) | all | B:40-46 | covered |
| B:26 | Capabilities route gains an `insights` feature | access.insights-capability | account-insights | B:42-43 | covered |
| B:30-31 | Without `instagram_manage_insights`: our numbers only; capability says `permission_not_granted` + the permission (`reconnect`) | access.insights-capability | account-insights | B:42-43 | covered |
| B:32 | Snapshots by a daily pull-based job, never on screen open; reads never call Meta | background.insight-snapshot, quality.reads-never-call-meta | account-insights, post-insights | B:46 | covered |
| B:33-34 | Our analytics read pre-aggregated counts; the organization's day | quality.pre-aggregated, analytics.organization-day | account-analytics | B:40-41 | covered |
| B:35 | Plan: a new `analytics` feature key; Free sees the last 7 days only | access.analytics-plan | account-analytics | B:45 | out-of-scope (N-D1: open to all plans, user 2026-11-27) |
| B:36 | New tables `instagram_` prefixed, FORCE RLS, retention 13 months | quality.tenant-isolation, quality.insights-retention | all | — | covered |
| B:46 | The daily job respects Meta usage and the sending gate | quality.meta-usage | account-insights | B:46 | covered |
| B:50 | Out of scope: ads insights, competitor benchmarks, report export, Facebook Page insights | — | — | — | out-of-scope (brief) |

## Reconciliation

Brief mode from scratch — no `PRD.md` / `schema-routes.md`; the brief is reconciled against the code today.

| # | Item | Brief says (B:line) | Code today says (file:line) | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| N1 | The insights permission | `instagram_manage_insights`, optional in the login configuration (B:8-9, B:30) | the login requires exactly `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments` (`channel-connection.constants.ts:38-42`); the one optional permission today is `ads_read` (`:52`, MC13); no code names `instagram_manage_insights` | gap — a second optional permission, as `ads_read` | Step 4 N-D2; Meta app review ⚠️ unverified (owner test NO1) |
| N2 | The `insights` capability | route 153 gains `insights` (B:26) | 11 feature keys, each one permission or none and exactly one plan switch (`channel-account-capabilities.constants.ts:16-28, 85-140`); the refusal order `channel_lacks_feature` → `permission_not_granted` → `plan_lacks_feature` → `feature_not_offered` with the `reconnect` fix (`channel-account.service.ts:183-194, 216-222`) | consistent — a 12th key `insights` (permission `instagram_manage_insights`, plan switch per N-D1) | route review |
| N3 | Our own numbers per day | DMs sent, replies, taps, emails, phones, new contacts, response times — per day, per automation and broadcast, pre-aggregated (B:5-7, B:33) | per account and day: sent / unknown / skipped / expired only (`instagram-send-day-count.schema.ts:18-45`, kept 13 months); per automation: all-time `runs_started`, `taps`, `typed_answers` in 16 slots, no day (`automation-count.schema.ts:37-63`); contacts carry `email`, `phone`, `first_seen_at` with no counter (`contact.schema.ts:80-102`); no per-broadcast day counts | gap — no day × automation / broadcast counter for replies, taps, emails, phones, new contacts | Step 4 N-D3 (a new day-count table raised in the commits) and N-D4 (history at release) |
| N4 | Response times | first / last response times "from the inbox" (B:6) | `app.instagram_conversations.first_response_at` / `last_response_at` exist (`instagram-conversation.schema.ts:75-76`) but are written only once the inbox's ROUTE rows R8 / R11 land (feat-instagram-inbox, implementing) | dependency | AMBER: response times follow the inbox; this plan reads them once written |
| N5 | Story insights webhook | `story_insights` field (B:12) | 6 subscribed fields (`meta-graph.client.ts:40-47`; engage adds `mentions` as a 7th); 13 webhook kinds, no story-insight kind (`instagram-webhook-event.constants.ts:7-21`) | gap — an 8th field and a new kind | worker-changes WC-2, WC-3; payload ⚠️ unverified (NO1) |
| N6 | Meta's insight endpoints and metrics ⚠️ unverified | reach, views, profile taps, follower count, demographics; media views, reach, saves, shares (B:8-11) | no insights call in the Meta client (no `insights` path in `meta-graph.client.ts`) | **owner test NO1** — the metric names valid for `v27.0`, their periods (day / lifetime), the follower-count history window and the demographics' follower threshold are Meta facts not verified here | owner item NO1 |
| N7 | Plan gating | `analytics` key; Free: last 7 days (B:35) | plan switches are booleans read by `can()` (`channel-account.service.ts:188`); a "last 7 days" range is a limit, not a switch | gap — a switch plus a range limit | Step 4 N-D1 |
| N8 | Retention 13 months | B:36 | the shared partition upkeep caps `keep_days` at 400 (13 months ≈ 396 days fits); day counts already keep 13 months (`instagram-send-day-count.schema.ts:24-26`) | consistent | the snapshot table joins the upkeep; day counts the 13-month clean-up |
| N9 | Reads never call Meta (B:32, B:46) | — | the media pickers read Meta live (`listInstagramMedia` callers in `instagram-media.service.ts`) | consistent for new routes — every insights route reads Postgres only | rule K-reads in the route review |

## Delta

n/a — initial (Baseline none).

## Findings for the user

- **Cross-iteration:** the `story_insights` field (WC-2) and engage's `mentions` field change the same subscribed-field
  list; whichever lands second extends it. Response times (N4) need the inbox's R8 / R11.
- **Meta app review ⚠️ unverified:** `instagram_manage_insights` most likely needs Advanced Access through App Review
  before non-tester accounts can grant it — owner item NO1.
