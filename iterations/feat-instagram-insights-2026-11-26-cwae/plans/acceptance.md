# Acceptance — feat-instagram-insights-2026-11-26-cwae

Filled at Close: `pass` (test file › test name, or a command), `partial`, `open` or `deferred`.

## Feature acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-1.1 — Each source commit (a DM sent, a reply, a tap, an email, a phone, a new contact, a first r… | features/account-analytics | open | |
| AC-1.2 — Route 182 answers totals and a zero-filled series by day, week or month in the organizatio… | features/account-analytics | open | |
| AC-1.3 — After the one-time fill, the stored history (runs 90 days, messages a year) shows; rerunni… | features/account-analytics | open | |
| AC-1.4 — A Viewer reads; another organization's account, automation or broadcast is 404; no plan li… | features/account-analytics | open | |
| AC-2.1 — The daily job stores one account snapshot after the organization's day ends; Meta down lea… | features/account-insights | open | |
| AC-2.2 — Route 185 shows the latest snapshot and the series; without the permission it answers empt… | features/account-insights | open | |
| AC-3.1 — The daily job snapshots the last 30 days' posts and reels plus any with a live automation. | features/post-insights | open | |
| AC-3.2 — Route 186 ranks by `dms_started`, `reach` or `views` with a keyset; route 187 shows one po… | features/post-insights | open | |
| AC-4.1 — With `story_insights` subscribed, a story's final numbers are stored once (a repeat update… | features/story-insights | open | |

## Brief acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| BRIEF-1 — The analytics screen shows DMs, replies, taps, emails and phones per day, matching the run and message tables | B:40-41 | open | |
| BRIEF-2 — With the permission, account and post insights show the last snapshot; without it the capability names the permission | B:42-43 | open | |
| BRIEF-3 — A story's final insights arrive by webhook and stay after the story ends | B:44 | open | |
| BRIEF-4 — A Free plan sees 7 days; a paid plan the full range | B:45 | out-of-scope — N-D1 (user, 2026-11-27): open to every plan, no history limit | |
| BRIEF-5 — No read calls Meta; the daily job respects Meta usage and the sending gate | B:46 | open | |
