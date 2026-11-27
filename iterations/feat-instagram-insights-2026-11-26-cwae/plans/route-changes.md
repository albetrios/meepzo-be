# Route changes — feat-instagram-insights-2026-11-26-cwae

Mode initial · Intake mode brief · 2026-11-27 (staged draft). Route numbers continue after engage (ends at 181): new
ones start at **182**. Paths under `/api/v1/app`. Every route reads Postgres only — none calls Meta (B:32, B:46).

| Area | New | Changed | Removed |
| --- | --- | --- | --- |
| Our analytics | 3 | 0 | 0 |
| Meta insights | 4 | 0 | 0 |
| Capabilities | 0 | 1 | 0 |

## Our analytics

| # | Change | Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-1 | NEW (route 182) | GET | `/analytics/channel-accounts/{channel_account_id}` | per [N-D6](decisions.md) | the account's numbers by day / week / month for a range | B:5-7, B:40 |
| RC-2 | NEW (route 183) | GET | `/analytics/automations/{automation_id}` | per N-D6 | one automation's numbers by day (the automation detail's results panel) | B:7, B:22 |
| RC-3 | NEW (route 184) | GET | `/analytics/broadcasts/{broadcast_id}` | per N-D6 | one broadcast's numbers by day | B:7 |

## Meta insights

| # | Change | Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-4 | NEW (route 185) | GET | `/social/instagram/accounts/{channel_account_id}/insights` | instagram-account · read | the account's last snapshot and its daily series | B:8-9, B:42 |
| RC-5 | NEW (route 186) | GET | `/social/instagram/accounts/{channel_account_id}/insights/media` | instagram-account · read | posts and reels ranked by DMs started or by reach | B:10-11 |
| RC-6 | NEW (route 187) | GET | `/social/instagram/accounts/{channel_account_id}/insights/media/{instagram_media_id}` | instagram-account · read | one post's snapshots beside "DMs started from this post" (the post detail panel) | B:10, B:22 |
| RC-7 | NEW (route 188) | GET | `/social/instagram/accounts/{channel_account_id}/insights/stories` | instagram-account · read | ended stories with their final numbers | B:12-13, B:44 |

## Capabilities

| # | Change | Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-8 | CHANGED (route 153) | GET | `/social/channel-accounts/{channel_account_id}/capabilities` | channel-account · read | + feature `insights` | B:26, B:30-31 |

## Before → after

| # | Route | Part | Before | After | Source |
| --- | --- | --- | --- | --- | --- |
| RC-8 | `GET /social/channel-accounts/{channel_account_id}/capabilities` | output | 11 features | + `insights` (permission `instagram_manage_insights`; refused `permission_not_granted` with the permission and fix `reconnect`) | B:26, B:30-31 |

Every range read honours the plan's history ([N-D1](decisions.md)): a Free organization asking past 7 days gets the
last 7 days and `meta.range_limited: true` (proposed; the route review settles the shape).
