# Coverage — feat-instagram-engage-2026-11-26-suzw

Mode initial · Intake mode brief (from scratch) · Intake hash 98219bc48cfb · 2026-11-26.
Sources: `intake-files/BRIEF.md` (B:<line>) and the code today (file:line).

## Coverage

| Source (file:line) | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| B:5-6 | Comment inbox — every comment on the account's posts and reels, newest first; filters post / not answered / automation answered | operations.comment-list | comment-inbox | B:42 | open |
| B:7-8 | Reply publicly, hide / unhide, delete a comment from the inbox | operations.comment-moderation | comment-moderation | B:44 | open |
| B:9-10 | @mentions arrive by webhook, listed; a mention can start an automation | operations.mention-list, integrations.mentions-webhook | mentions | B:45 | open |
| B:11 | Tagged media (`/{ig-user-id}/tags`) listed beside mentions, read live | operations.tagged-media | mentions | B:46 | open |
| B:22 | Screen: comments inbox (new) | operations.comment-list | comment-inbox | B:42 | open |
| B:22 | Screen: mentions & tags list (new) | operations.mention-list | mentions | B:45 | open |
| B:22 | Automation editor — one more trigger: mention | operations.mention-trigger | mentions | B:45 | open |
| B:23 | Entity `app.instagram_comments` (new) | data.instagram-comment | comment-inbox | B:42 | open |
| B:23-24 | Entity `app.instagram_mentions` (new) | data.instagram-mention | mentions | B:45 | open |
| B:24 | Existing `app.instagram_media`, `app.automation_comment_logs`, contacts | data.instagram-comment | comment-inbox | B:42 | open |
| B:25-26 | Routes under `…/instagram/accounts/{channel_account_id}/comments…` and `…/mentions`; webhook route unchanged | (route-changes.md) | all | B:42-46 | open |
| B:30-31 | Read with `instagram-account:read`; writes with new `instagram-comment:manage` (Owner, Admin, Editor) | access.comment-moderation | comment-moderation | B:44 | open |
| B:32-33 | Every write through the sending gate and Meta usage; a deleted comment soft-gone | quality.comment-writes-paced, data.comment-delete | comment-moderation | B:44 | open |
| B:34-35 | `instagram_` prefix, FORCE RLS, Meta ids bounded (C-D16) | quality.tenant-isolation | all | B:47 | open |
| B:36-37 | `mentions` webhook field subscribed; mention text stored; never contact the media owner without an automation | integrations.mentions-webhook, quality.mention-privacy | mentions | B:45 | open |
| B:38 | Comment retention follows run / comment-log retention | quality.comment-retention | comment-inbox | — | open |
| B:42-43 | Webhook comment shows within one processing cycle with the automation's answer | background.comment-store | comment-inbox | B:42 | open |
| B:47 | Another organization's comment or mention → 404 | access.tenant-404 | all | B:47 | open |
| B:51-52 | Out of scope: likes (`instagram_manage_engagement`), Facebook Page comments, comment insights | — | — | — | out-of-scope (brief) |

## Reconciliation

Brief mode from scratch — no `PRD.md` / `schema-routes.md`; the brief is reconciled against the code today.

| # | Item | Brief says (B:line) | Code today says (file:line) | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| E1 | Where comments live | a new `app.instagram_comments`, "from webhooks and reads" (B:23) | the only comment store is `app.automation_comment_logs`, one row per comment **per automation**, monthly parts, 90 days (`automation-comment-log.schema.ts:42-115`, `automation-run.constants.ts:209`) | consistent — the inbox needs one row per comment, any automation or none | new table; the inbox joins the comment log for "automation answered" — Step 4 Q (what is stored) |
| E2 | Mentions intake | `mentions` webhook field (B:9, B:36) | not subscribed (`meta-graph.client.ts:40-47`); a `mentions` change is saved `unknown`, skipped `unsupported` (`instagram-webhook-event-classifier.util.ts:440-470`); 13 kinds (`instagram-webhook-event.constants.ts:7-21`) | gap — new field + new kind | worker-changes WC-2, WC-3 |
| E3 | Delete / unhide | delete and unhide from the inbox (B:7-8) | Meta client has reply (`:1117`) and hide (`:1151`) only — no delete, no unhide | gap | two client calls at kickoff (route review) |
| E4 | Mention trigger | "a mention can start an automation" (B:10, B:22) | 15 trigger types, only `story_mention` (a DM attachment) (`channel-account-capabilities.constants.ts:47-63`) | gap — a 16th trigger type | Step 4 Q (scope of the trigger) |
| E5 | Retention | "follows the run / comment-log retention" (B:38) | comment logs: 90 days after the month (`automation-run.constants.ts:209`) | consistent | 90 days — confirm in Step 4 |
| E6 | Writes paced | through the sending gate and Meta usage (B:32) | replies and hides run on the reply lane (`instagram-reply-lane.service.ts`) | consistent | team writes use the reply lane or a direct gated call — Step 5 |
| E7 | Meta's mention payloads ⚠️ unverified | caption and comment mentions arrive as `mentions` (B:9) | — (not in code) | **owner test** — which payload Meta sends under Unified Login, and the read (`mentioned_media` / `mentioned_comment`) | owner item EO1 |

## Delta

n/a — initial (Baseline none).
