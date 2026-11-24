Status: draft
Kind: screen
Depends on: automations, instagram-webhook-intake, plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 4.C — routes 38–39 (automation backfills)

## Stories

- As an Owner, Admin or Editor on Creator or Studio I want to press "Also answer comments from the last N days" on a live comment automation so that people who commented before it went live still get their DM.
- As any member I want to see how a past-comments read is going and how it ended so that I know how many will be answered.

## Rules

- Only a live comment or ad-comment automation (not Live), N from 1 to 7 days; "any post" reads the newest 50 posts with comments in those days (operations.automation-past-comments; D69)
- PRO: refused on a plan without the past-comments switch (billing.plan-pro-features, operations.feature-check; P83)
- One read at a time per automation; a second press while one runs is refused (operations.automation-past-comments; plan §15.10)
- Each found comment goes through normal intake as an old comment: the once rule, the open-run rule, the lowest priority, the 7-day expiry (operations.automation-past-comments, background.intake; D69)
- A read moves `queued` → `reading` → `done` or `failed`; a read that cannot finish is retried, then `failed` with its reason (operations.automation-past-comments; plan §20.11)
- A move down that removes the feature ends an unfinished read `failed` · `plan_feature_off`; opening DMs it already queued go on (billing.plan-downgrade; D57)
- Ends with a notification of kind "a broadcast or a past-comments run is done" (in-app on, email off by default) (notifications.kinds-v8; D54)
- Starting needs `automation:update` and an idempotency key (access.editor-viewer-roles, quality.idempotency; P20, P89)

## Acceptance criteria

- AC-8.1 — Starting a read on a live comment automation with N from 1 to 7 answers the read `queued`; N outside 1–7, a draft or paused automation, or a Live-comment automation is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:280
- AC-8.2 — On Free the start is refused with `plan_lacks_feature` — intake-files/Instagram-DM-Sending-Plan-v8.md:8054
- AC-8.3 — A second start while a read of the same automation is queued or reading is refused ("Past comments are already being read") — intake-files/Instagram-DM-Sending-Plan-v8.md:2698
- AC-8.4 — The read's status shows found, matched and queued so far, then `done` with its numbers, or `failed` with its reason — intake-files/Instagram-DM-Sending-Plan-v8.md:2697
- AC-8.5 — A comment already answered by this automation, or whose once key is used, gets no second DM; a comment older than 7 days minus 30 minutes is never sent — intake-files/Instagram-DM-Sending-Plan-v8.md:1400
- AC-8.6 — Past comments go at the lowest priority behind fresh comments, and an urgent one (little time left) goes early in the old line — intake-files/Instagram-DM-Sending-Plan-v8.md:2787
- AC-8.7 — A move down to a plan without past comments ends an unfinished read `failed` · `plan_feature_off`; the opening DMs it already queued still go — intake-files/Instagram-DM-Sending-Plan-v8.md:8015
- AC-8.8 — The member who started it, and Owner and Admin, get one "past comments done" notification in-app with the numbers, no email by default — intake-files/Instagram-DM-Sending-Plan-v8.md:8159
- AC-8.9 — A Viewer is refused the start with `missing_permission`; a start without an idempotency key is refused — plans/decisions.md P89

## Work items

- operations.automation-past-comments
- operations.feature-check
- background.intake
- billing.plan-pro-features
- billing.plan-downgrade
- notifications.kinds-v8
- access.editor-viewer-roles
- quality.idempotency
