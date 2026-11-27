# Worker changes — feat-instagram-insights-2026-11-26-cwae

Mode initial · Intake mode brief · 2026-11-27 (staged draft).

| Change | Count |
| --- | --- |
| NEW | 4 |
| CHANGED | 2 |
| REMOVED | 0 |

| # | Change | Background work | When it runs | What it touches | On failure | Who is told | Requirement | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WC-1 | NEW | take each account's daily insight snapshot: the account, then its posts and reels per [N-D5](decisions.md) | daily, after the organization's day ends | instagram_insight_snapshot | per account; Meta down or usage high → retried later that day, never twice for one day; a missing permission → skipped (the capability says why) | nobody | `background.insight-snapshot` | B:32, B:46 |
| WC-2 | CHANGED | the account set-up and subscription check subscribe `story_insights` too | at set-up and every subscription check | the account's webhook fields | as today (retry ladder) | as today | `integrations.story-insights-webhook` | B:12 |
| WC-3 | NEW | process a story-insight event: store the story's final numbers | a `story_insights` webhook item | instagram_story_insight | the event's own retry; one row per story (a repeat updates it) | nobody | `insights.story` | B:12-13 |
| WC-4 | CHANGED | the commits that send a DM, record a tap, save an email or phone, create a contact and answer a conversation also add to that day's counts | in each of those commits | instagram_analytics_day_count | rolls back with its commit | nobody | `quality.pre-aggregated` | B:33 |
| WC-5 | NEW | fill the day counts once from what is still stored ([N-D4](decisions.md)) | once, at release | instagram_analytics_day_count | resumable; safe to rerun | the operator (run log) | `analytics.own-numbers` | B:40-41 |
| WC-6 | NEW | snapshot, story-insight and day-count retention, 13 months | daily | instagram_insight_snapshot, instagram_story_insight, instagram_analytics_day_count | safe to retry | nobody | `quality.insights-retention` | B:36 |

## Before → after

| # | Background work | Before | After |
| --- | --- | --- | --- |
| WC-2 | subscribed webhook fields | 6 today (engage adds `mentions`) | + `story_insights` |
| WC-4 | the send result save, the run engine's tap / email / phone steps, contact creation, the inbox's response write | write their own rows and counts | + one day-count increment in the same commit |
