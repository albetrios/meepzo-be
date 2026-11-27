# KICKOFF — feat-instagram-insights-2026-11-26-cwae

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-insights-2026-11-26-cwae` |
| Mode | initial (Baseline `none`) |
| Intake mode | brief — from scratch |
| Intake note | 1 received (`BRIEF.md`) · from scratch |
| Drop placed | 2026-11-26 |
| Intake hash | `8610bfdbae37` |
| Schema-routes | — (brief) |
| Date | 2026-11-27 |

## 2. Goal and scope

Owners see what Instagram automations bring: our own numbers (DMs, replies, taps, emails, phones, new contacts,
response times) by day, week and month per account, automation and broadcast, beside Meta's account, post and story
insights — read from stored snapshots, never from Meta on screen open. Route review:
[`plans/routes-final.md`](plans/routes-final.md) (final 2026-11-27).

- **In scope:** `app.instagram_analytics_day_counts`, `app.instagram_insight_snapshots`, `app.instagram_story_insights`;
  routes 182–188 and the change to route 153; the optional `instagram_manage_insights` permission; the day-count
  increments in the source commits; the one-time fill; the daily snapshot; `story_insights` subscribed and processed;
  13-month retention.
- **Out of scope:** a plan gate or history limit ([N-D1](plans/decisions.md) — overrides the brief's Free 7 days), ads
  insights, competitor benchmarks, exporting reports, Facebook Page insights, reading a live story's numbers
  ([N-D7](plans/decisions.md)), the frontend screens.

## 3. Locked decisions

| # | Summary |
| --- | --- |
| [N-D1](plans/decisions.md) | Analytics open on every plan, no history limit (user, over the brief) |
| [N-D2](plans/decisions.md) | `instagram_manage_insights` optional, as `ads_read` |
| [N-D3](plans/decisions.md) | A day-count table raised in each source commit |
| [N-D4](plans/decisions.md) | The day counts filled once from what is stored |
| [N-D5](plans/decisions.md) | Snapshots: the account + the last 30 days' posts and reels + any with a live automation |
| [N-D6](plans/decisions.md) | `instagram-account:read` reads every route |
| [N-D9](plans/decisions.md)–[N-D10](plans/decisions.md) | Route review sub-domains 1–2 confirmed |

## 4. Features and order

1 `account-analytics` → 2 `account-insights` → 3 `post-insights` → 4 `story-insights` ([stories](plans/features/)).

## 5. ROUTE

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `app.instagram_analytics_day_counts` (monthly, 13 months, upkeep entry) — routes-final § 1.3 (ANC1) | table | — | staged-build prompt (NEW table) | AC-1.4 | — | open |
| R2 | `app.instagram_insight_snapshots` (monthly, 13 months) — § 2.3 (INC1) | table | — | staged-build prompt (NEW table) | AC-2.1 | — | open |
| R3 | `app.instagram_story_insights` (monthly, 13 months) — § 2.3 (INC1) | table | — | staged-build prompt (NEW table) | AC-4.1 | — | open |
| R4 | 1 Instagram analytics: routes 182–184 — § 1 (ANC4) | sub-domain | R1 | `/be-build-requirement` | AC-1.2, AC-1.4 | — | open |
| R5 | 2 Instagram insight: routes 185–188, route 153's `insights` feature, the optional permission — § 2 (INC2, INC5) | sub-domain | R2, R3 | `/be-build-requirement` | AC-2.2, AC-3.2 | — | open |
| R6 | Background — the day-count increments in the source commits (WC-4) — AN1, AN3 (ANC2) | background | R1 | `/be-worker-complete` | AC-1.1 | — | open |
| R7 | Background — the one-time fill (WC-5) — AN4 (ANC3) | background | R6 | `/be-worker-complete` | AC-1.3 | — | open |
| R8 | Background — the daily snapshot and its Meta reads (WC-1) — IN2, IN3 (INC3) | background | R2, R5 | `/be-worker-complete` | AC-2.1, AC-3.1 | — | open |
| R9 | Background — `story_insights` subscribed (WC-2) and processed (WC-3) — IN4 (INC4) | background | R3 | `/be-worker-complete` | AC-4.1 | — | open |
| R10 | Flow and close — every route's errors end to end; privacy (organization delete, no Meta text in logs); `docs/routes.txt`, OpenAPI, i18n, `plans/frontend-route-map.md` | flow | R1–R9 | `/be-build-requirement` | BRIEF-1–BRIEF-3, BRIEF-5 | — | open |

## 6. Requirements index

| File | Identifiers |
| --- | --- |
| [analytics.md](plans/requirements/analytics.md) | `analytics.own-numbers`, `analytics.media-conversations`, `analytics.organization-day` |
| [insights.md](plans/requirements/insights.md) | `insights.account`, `insights.media`, `insights.story` |
| [integrations.md](plans/requirements/integrations.md) | `integrations.story-insights-webhook` |
| [access.md](plans/requirements/access.md) | `access.insights-capability`, `access.analytics-read` |
| [background.md](plans/requirements/background.md) | `background.insight-snapshot`, `background.day-count-increment`, `background.day-count-fill` |
| [quality.md](plans/requirements/quality.md) | `quality.reads-never-call-meta`, `quality.pre-aggregated`, `quality.tenant-isolation`, `quality.insights-retention`, `quality.meta-usage` |
| [data.md](plans/requirements/data.md) | `data.analytics-day-counts`, `data.instagram-insight-snapshot`, `data.instagram-story-insight` |

## 7. Open AMBER items

| # | Default | Settles when |
| --- | --- | --- |
| [N-D7](plans/decisions.md) | story insights by webhook only — no live read | — (a later iteration) |
| [N-D8](plans/decisions.md) | response times shown once the inbox writes them, empty before | inbox R8 / R11 |
| NO1 (owner test) | Meta's metric names and periods, the follower history window, the demographics threshold, the `story_insights` payload, App Review for `instagram_manage_insights` — as routes-final IN2–IN4 assume | the Meta dev app, before R8 / R9 close |

## 8. Standing deviations

`n/a — initial` (Baseline `none`). Shared with iterations in flight: the subscribed webhook fields (engage adds
`mentions`, this adds `story_insights` — whichever lands second extends the list), the partition upkeep (each adds
entries), and the source commits the day counts ride (the inbox's intake and first response, the sender's result save)
— R6 builds on the inbox's rows once it closes.

## 9. Definition of done

Every ROUTE row `done` (or `deferred` with the user's OK); `plans/acceptance.md` filled; the `AS-BUILT.md` summary and
Standing deviations written; the gates green.

## 10. Verification

Brief mode: every `BRIEF.md` acceptance line traced in `plans/acceptance.md` (BRIEF-4 out of scope by N-D1). Gates:
`pnpm validate`, `pnpm tsdoc:check`, `pnpm db:migrate:lint`, `pnpm routes:catalog:check`, `pnpm docs:check`, the touched
suites, `pnpm test:rls-role:changed`, `pnpm test:contract` (Meta client), `pnpm iteration:frontend-map <iteration> --check`.
