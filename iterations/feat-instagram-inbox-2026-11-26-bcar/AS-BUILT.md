# feat-instagram-inbox-2026-11-26-bcar — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (I-D19) · kicked off 2026-11-26 under the user's /goal

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 1 The ledger rename — routes-final § 1 (AM1–AM4; AMC1–AMC3) | `app.instagram_messages` → **`app.instagram_outgoing_messages`** (I-D21) by migration `20261127010000_app_instagram_outgoing_messages_rename.sql`: the parent, every weekly part and the DEFAULT part (`instagram_outgoing_messages_p<IYYY>w<IW>`), the id sequence, every constraint and index carrying the old name (parent, parts, the tables pointing at it — a name over 63 bytes keeps 54 and an 8-character hash), the RLS policy, and the partition upkeep's CASE entry (`fn_manage_time_partitions` re-created with the one entry renamed; owner and grants kept). Code: folder `instagram-sending/instagram-outgoing-message/` (`git mv`, files `instagram-outgoing-message.*`), the ledger's exported types and classes `InstagramOutgoingMessage…`, `createWorkerInstagramOutgoingMessageRepository`, `chooseInstagramOutgoingMessagePlace`, `instagramOutgoingMessageStepOf`, the service variable and the test factories (`insertInstagramOutgoingMessage`, `readInstagramOutgoingMessages`); the FORCE-RLS list, the upkeep spec, overviews, the domain map, the DB diagram, the structure tree — 89 files | Kept as they are: the `INSTAGRAM_MESSAGE_*` value constants, the `instagramMessage` public-id entity (`igm_`), `instagramMessageId` / `instagram_message_id` (Meta's message id), Meta client calls (`sendInstagramMessage`) and `InstagramMessageAccess*`; the long-name hash guard; two `migration-safety: allow` lines (rename, the copied upkeep's DROP TABLE) | Those names describe a message or Meta's ids, not the ledger table; Postgres truncates names at 63 bytes and two generated part-index names collided on the first local run; the rename cannot be expand-only (AM1) | I-D21, AM1–AM3 | (this commit) | — |
| R2 | `app.instagram_conversations` — routes-final § 2.A.3 | `app.instagram_conversations` by migration `20261127020000_app_instagram_conversations.sql` and `instagram-conversation/instagram-conversation.schema.ts`: every 2.A.3 column; keys to the contact `(organization_id, contact_id)` CASCADE, the account RESTRICT, the holder membership `(organization_id, taken_by_membership_id)`; unique public id, `(organization_id, id)` (parent key of 2.B / 2.C), one per contact; indexes — list keyset `(organization_id, last_message_at DESC, id DESC)`, mine, unread, idle release, the account key; checks — state, `taken_by`, the holder in step, sender type, unread ≥ 0, preview ≤ 200, updated ≥ created; FORCE RLS with the retention arm. Constants file (states, holders, sender types, preview cap, `INSTAGRAM_CONVERSATION_IDLE_RELEASE_HOURS = 24`); public-id prefix `igcv`; FORCE-RLS list; RLS matrix A/B pair; OpenAPI entity label; overview; domain map. Test: `instagram-conversation.schema.db.unit.test.ts` (defaults + `igcv_`, one per contact, the four list checks, the holder rule, the contact cascade) | The holder key has no `ON DELETE SET NULL` (a composite SET NULL would null `organization_id`; memberships are ended, never deleted — the service clears the holder, R7); one more index for the account key; the path-param registry entry waits for its routes (R7); no seed rows yet (conversations are born from messages, R8) | be-sql-design-guard (an index per foreign key); the param registry is checked against routes | CV1, CV2, CV4 | (this commit) | — |

Verification (R1): `pnpm db:migrate` applied locally; `pnpm db:migrate:lint` 0 violations (165 files); `pnpm vitest run src/domains/app src/tests/global src/tests/security/rls src/tests/unit` — 634 files, 6127 tests (1 skipped); `pnpm validate`, `pnpm tsdoc:check`, `pnpm docs:check` clean.

Verification (R2): `pnpm db:migrate:lint` 0 violations (166 files); `pnpm vitest run` instagram-conversation + `src/tests/global` + `src/tests/security/rls` — the RLS matrix needed the new table's A/B pair, then 39 files, 339 tests; `validate:domain`, `pnpm validate`, `pnpm tsdoc:check` clean.

## Revisions to upcoming rows

- Paused before R1 by the user (I-D20), resumed after dry run v2 (2026-11-27).
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
