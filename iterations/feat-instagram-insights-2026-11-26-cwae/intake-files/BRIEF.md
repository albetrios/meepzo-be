# Brief — Meepzo shows what Instagram automations bring: Instagram insights beside our own analytics

## What changes

- An **analytics screen** per account: Meepzo's own numbers (DMs sent, replies, links tapped, emails and phones
  collected, new contacts, first / last response times from the inbox) by day, week and month, per automation
  and per broadcast.
- **Account insights** from Meta (reach, views, profile taps, follower count and demographics) when the owner
  granted `instagram_manage_insights` (optional in the Unified Login configuration).
- **Post / reel insights** (views, reach, saves, shares) next to "DMs started from this post", so the owner ranks
  posts by conversations, not only by reach.
- **Story insights**: the final numbers Meta sends by webhook (`story_insights`) when a story ends, kept after the
  story disappears.

## Why

Owners pay for automations because they bring conversations and leads; today they see only the monthly DM
meter. Putting Meta's reach next to what Meepzo started shows the value and tells them which posts to automate.

## Affected screens, entities and routes

- Screens: account analytics (new), post detail (insights panel), automation detail (results panel)
- Entities: `app.instagram_insight_snapshots` (new — daily account / media snapshots), story insights (new),
  existing run / message / contact tables (read-only aggregates)
- Routes: new reads under `/app/social/instagram/accounts/{channel_account_id}/insights…` and
  `/app/analytics…`; the capabilities route (153) gains an `insights` feature

## Rules

- Meta insights need `instagram_manage_insights`; without it the screen shows Meepzo's numbers only and the
  capability read names the missing permission (`reconnect` fix).
- Snapshots are taken by a daily job (pull-based worker), never on screen open; reads never call Meta.
- Our own analytics read pre-aggregated counts (no full scans on page open); timezones use the organization's
  day.
- Plan switch: a new `analytics` feature key (Free: last 7 days only).
- New tables `instagram_` prefixed, FORCE RLS, retention 13 months.

## Acceptance criteria

- [ ] The analytics screen shows DMs sent, replies, links tapped, emails and phones collected per day for the
      chosen range, matching the run and message tables.
- [ ] With `instagram_manage_insights`, account and post insights show the last snapshot; without it, the
      capability read says `permission_not_granted` + the permission.
- [ ] A story's final insights arrive by webhook and stay after the story ends.
- [ ] A Free plan sees 7 days; a paid plan the full range.
- [ ] No read calls Meta; the daily job respects Meta usage and the sending gate.

## Out of scope

Ads insights, competitor benchmarks, exporting reports (later), Facebook Page insights.
