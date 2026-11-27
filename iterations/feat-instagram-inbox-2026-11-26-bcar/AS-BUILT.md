# feat-instagram-inbox-2026-11-26-bcar — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (I-D19) · kicked off 2026-11-26 under the user's /goal

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Revisions to upcoming rows

- Paused before R1 by the user (I-D20): the rename's dry run was shown; nothing applied. Resume at R1.
- #R1: rename `app.instagram_messages` → **`app.instagram_outgoing_messages`** (not `instagram_automation_messages`) with every dependent name, folder `instagram-outgoing-message/`, identifiers `InstagramOutgoingMessage…`; the conversation message links it by `instagram_outgoing_message_id` — [I-D21](plans/decisions.md)

## Summary

- Planned, not built (deferred — user OK): —
- Built, not planned: —
- Follow-ups for the next iteration: —

## Standing deviations

The complete list of where the code differs from the drop — the Baseline's list (empty for an
initial iteration), minus what this iteration resolved, plus its new ones.

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
