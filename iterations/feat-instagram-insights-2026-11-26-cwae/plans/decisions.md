# Decisions — feat-instagram-insights-2026-11-26-cwae

Staged draft (Steps 1–3). The Step 4 RED questions below are **open** — the user answers them; the recommendation is
Claude's.

| # | Question | Options | Recommendation | Date | By | Level | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N-D1 | How the plan limits analytics (coverage N7) | (a) a new switch `analytics` on every plan + a limit `analytics_history_days` (Free 7, paid 13 months) · (b) switch off on Free, with Free's 7 days hard-coded · (c) no switch, the limit only | **open to all plans, no history limit** (user's choice over the recommended switch + limit; overrides B:35 "Free sees the last 7 days") — no billing change | 2026-11-27 | user | RED | answered |
| N-D2 | `instagram_manage_insights` at the login (N1) | (a) optional, as `ads_read`: the connect works without it, the capability says `permission_not_granted` + `reconnect` · (b) required for every connection | **(a) optional, as `ads_read`** | 2026-11-27 | user | RED | answered |
| N-D3 | Where our day numbers come from (N3) | (a) a new day-count table raised in each source commit · (b) a nightly job that adds up the day from the source tables · (c) read the source tables live | **(a) a day-count table raised in each source commit** | 2026-11-27 | user | RED | answered |
| N-D4 | History at release | (a) start empty at release · (b) fill once from what is stored (runs and comment logs 90 days, messages a year, contacts all) | **(b) fill once from what is stored** | 2026-11-27 | user | RED | answered |
| N-D5 | Which posts get a daily snapshot | (a) the account + posts / reels from the last 30 days + any with a live automation · (b) every post · (c) only posts with an automation | **(a) the account + the last 30 days' posts and reels + any with a live automation** | 2026-11-27 | user | RED | answered |
| N-D6 | Who may read our analytics (routes 182–184) | (a) `instagram-account:read` (Viewer included) · (b) `automation:read` · (c) a new `analytics:read` | **(a) `instagram-account:read` (Viewer included)** | 2026-11-27 | user | RED | answered |
| N-D7 | Story insights | (a) the final numbers by webhook only · (b) also read while the story is live | **(a)** — the brief (B:12); no extra Meta reads | 2026-11-27 | Claude | AMBER | open |
| N-D8 | Response times before the inbox writes them (N4) | (a) shown once the inbox's rows land, empty before · (b) drop them from this iteration | **(a)** | 2026-11-27 | Claude | AMBER | open |

## Owner items

| # | Item | Needed for |
| --- | --- | --- |
| NO1 | With the Meta developer app: the `v27.0` metric names and periods for account and media insights, the follower-count history window, the demographics' follower threshold, the `story_insights` payload, and whether `instagram_manage_insights` needs Advanced Access (App Review) | N6, N5, N1 — all ⚠️ unverified |
