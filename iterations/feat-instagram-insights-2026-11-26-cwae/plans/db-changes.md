# DB changes — feat-instagram-insights-2026-11-26-cwae

Mode initial · Intake mode brief · 2026-11-27 (staged draft). Every table below is a proposal until the route review
confirms it; names follow the brief (B:23) and [N-D3](decisions.md).

| Change | Count |
| --- | --- |
| NEW | 3 |
| CHANGED | 1 |
| REMOVED | 0 |

## Overview

```mermaid
erDiagram
  channel_account["channel_account · app.channel_accounts"]
  instagram_media["instagram_media · app.instagram_media"]
  automation["automation · app.automations"]
  broadcast["broadcast · app.broadcasts"]
  instagram_insight_snapshot["instagram_insight_snapshot · NEW · app.instagram_insight_snapshots"]
  instagram_story_insight["instagram_story_insight · NEW · app.instagram_story_insights"]
  instagram_analytics_day_count["instagram_analytics_day_count · NEW · app.instagram_analytics_day_counts"]
  plan["plan · billing plans · unchanged (N-D1)"]
  channel_account ||--o{ instagram_insight_snapshot : "ADDED: is snapshotted daily"
  instagram_media ||--o{ instagram_insight_snapshot : "ADDED: per post / reel"
  channel_account ||--o{ instagram_story_insight : "ADDED: final story numbers"
  channel_account ||--o{ instagram_analytics_day_count : "ADDED: our numbers per day"
  automation ||--o{ instagram_analytics_day_count : "ADDED: per automation"
  broadcast ||--o{ instagram_analytics_day_count : "ADDED: per broadcast"
```

## Stage 1 — our own numbers

### instagram_analytics_day_count

- **Holds** — per account, day of the organization's time zone, and automation or broadcast (or neither): DMs sent,
  replies received, links tapped, emails and phones collected, new contacts, response count and total response
  seconds (B:5-7).
- **Table** — `app.instagram_analytics_day_counts` (name proposed, [N-D3](decisions.md)).
- **Sources** — B:5-7, B:24, B:33-34.
- **Added / Replaced** — new; raised in the commits that already write the source rows (WC-4), never by a scan.
- **Open** — the history at release ([N-D4](decisions.md)); response times follow the inbox (coverage N4).

```mermaid
erDiagram
  instagram_analytics_day_count["instagram_analytics_day_count · NEW · app.instagram_analytics_day_counts"] {
    id organization_id FK
    id channel_account_id FK
    date day_date "organization's day"
    id automation_id "nullable"
    id broadcast_id "nullable"
    int slot "spread hot rows"
    int dms_sent
    int replies_received
    int links_tapped
    int emails_collected
    int phones_collected
    int new_contacts
    int responses
    bigint response_seconds_total
    datetime updated_at
  }
```

## Stage 2 — Meta's numbers

### instagram_insight_snapshot

- **Holds** — one row per account (or per post / reel) per day: the metrics Meta answered that day (B:8-11, B:23).
- **Table** — `app.instagram_insight_snapshots` (the brief's name).
- **Sources** — B:8-11, B:23, B:32, B:36.
- **Added / Replaced** — new; written only by the daily snapshot (WC-1).
- **Open** — which media are snapshotted ([N-D5](decisions.md)); the metric names ⚠️ unverified (NO1); split by month,
  kept 13 months through the shared upkeep.

```mermaid
erDiagram
  instagram_insight_snapshot["instagram_insight_snapshot · NEW · app.instagram_insight_snapshots"] {
    id id PK
    id organization_id FK
    id channel_account_id FK
    choice subject "account · media"
    id instagram_media_id "nullable, our media row"
    date snapshot_date
    json metrics "name → value, as Meta answered"
    json demographics "account only, nullable"
    datetime taken_at
  }
```

### instagram_story_insight

- **Holds** — one row per ended story: its final numbers from the `story_insights` webhook, kept after the story is
  gone (B:12-13).
- **Table** — `app.instagram_story_insights` (name proposed).
- **Sources** — B:12-13, B:23.
- **Added / Replaced** — new; written by the story-insight processing (WC-3).
- **Open** — the payload ⚠️ unverified (NO1); kept 13 months.

```mermaid
erDiagram
  instagram_story_insight["instagram_story_insight · NEW · app.instagram_story_insights"] {
    id id PK
    id organization_id FK
    id channel_account_id FK
    text instagram_story_id "Meta's"
    text permalink
    json metrics "final numbers"
    datetime story_posted_at
    datetime received_at
  }
```

## Stage 3 — the plan

### plan features (billing)

- **Holds** — the plan switches and limits every plan carries.
- **Change** — **none** ([N-D1](decisions.md): analytics open on every plan, no history limit) — kept as a record.

| Field | Before | After |
| --- | --- | --- |
| plan feature keys | 11 Instagram feature switches (`channel-account-capabilities.constants.ts:16-28`) | unchanged (N-D1: open to all plans) | B:35 |
