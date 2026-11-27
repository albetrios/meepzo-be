# Acceptance — feat-instagram-engage-2026-11-26-suzw

Filled at Close: `pass` (test file › test name, or a command), `partial`, `open` or `deferred`.

## Feature acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-1.1 — A comment that arrives by webhook is stored once (matched by an automation or not), a repl… | features/comment-inbox | open | |
| AC-1.2 — Route 175 lists the account's comments newest first within one processing cycle, filters `… | features/comment-inbox | open | |
| AC-1.3 — A hidden comment stays listed with `is_hidden`; a deleted one is gone; parts older than 90… | features/comment-inbox | open | |
| AC-2.1 — Route 176 sends a public reply through Meta, then shows `reply_state: team`, `replied_at`,… | features/comment-moderation | open | |
| AC-2.2 — Routes 177 / 178 hide and unhide through Meta; a repeat in the same state is `200` and cal… | features/comment-moderation | open | |
| AC-2.3 — Route 179 deletes through Meta and soft-deletes our row; a comment Meta already deleted is… | features/comment-moderation | open | |
| AC-2.4 — A viewer gets `403` on 176–179; another organization's comment is `404 instagram_comment_n… | features/comment-moderation | open | |
| AC-2.5 — Meta down or throttled is `503 instagram_unavailable`, a broken connection `409 instagram_… | features/comment-moderation | open | |
| AC-3.1 — With `mentions` subscribed, a caption mention and a comment mention are each stored once; … | features/mentions | open | |
| AC-3.2 — Route 180 lists the stored mentions newest first and filters `source`; another organizatio… | features/mentions | open | |
| AC-3.3 — Route 181 lists the tagged posts live from Meta; `409 instagram_not_connected` and `503 in… | features/mentions | open | |
| AC-3.4 — A live `mention` automation starts one run per stored mention of its `sources`, never twic… | features/mentions | open | |
| AC-3.5 — Mention and comment text never appear in logs. | features/mentions | open | |

## Brief acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| BRIEF-1 — A webhook comment shows in the inbox within one processing cycle, with the automation's answer | B:42-43 | open | |
| BRIEF-2 — `instagram-comment:manage` can reply, hide, unhide and delete; a viewer cannot (403) | B:44 | open | |
| BRIEF-3 — A mention arrives by webhook, is listed, and can start a mention automation | B:45 | open | |
| BRIEF-4 — Tagged media lists the account's tagged posts from Meta, read live | B:46 | open | |
| BRIEF-5 — Another organization's comment or mention is 404 | B:47 | open | |
