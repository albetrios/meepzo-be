# Decisions — feat-instagram-dm-sending-2026-11-23-oxak

Add-only: a changed mind is a new row that supersedes an old one. Kind: `RED` (answered by the user),
`AMBER` (safe default, still open), `SCOPE` (scope decision during implementation).

The plan's own decisions **D1–D73** (`intake-files/Instagram-DM-Sending-Plan-v8.md` §2, plan:L210–L284, approved
by the user on 22–23 Nov 2026) are locked inputs and are not repeated here. Rows below are this plan's own,
numbered `P<n>` so they never collide with the plan's `D<n>`.

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | A1 — account routes for many accounts (D26) | nested `…/instagram/accounts/{instagram_account_id}/…` · singular + query · an active-account claim | nested; the singular `/social/instagram/account*` routes removed in the same change | 2026-11-23 | Claude | AMBER |
| P2 | A2 — go-live check list (plan:L690–707 vs L2635–2653) | §5.1 · §15.5 | §5.1 + the database check: a hello always has a "next step" button when later steps exist | 2026-11-23 | Claude | AMBER |
| P3 | A3 — lanes stopped at the month limit (plan:L2014 vs L4051) | slow+fast+broadcast · slow+fast | slow + fast + broadcast (D62) | 2026-11-23 | Claude | AMBER |
| P4 | A4 — settings home (D22) | one plan file + version gate · per-sub-domain constants · one app-domain constants file | one app-domain constants file; environment-varying values only as env vars with production-safe defaults (`SENDING_ENABLED` default off); the D21 version gate kept | 2026-11-23 | Claude | AMBER |
| P5 | A5 — Redis copies | plan keys · be-read-cache-guard | be-read-cache-guard: organization-scoped keys, tombstone after commit, TTL ≤ 60 s | 2026-11-23 | Claude | AMBER |
| P6 | A6 — full-names rule on plan identifiers | rename · keep | rename (`direct_message_*`, `once_key`, `turn_number`, `_MILLISECONDS`, `count:`, `idx_`) | 2026-11-23 | Claude | AMBER |
| P7 | A7 — the every-minute helper | per-server slot leases · the existing cron scheduler | the existing scheduler, one repeat job per rule group, plus a 10-second repeat for the Redis-down check | 2026-11-23 | Claude | AMBER |
| P8 | A8 — go live, pause, duplicate, try it | action routes · `PATCH status` | action routes; `PATCH` saves content only | 2026-11-23 | Claude | AMBER |
| P9 | A9 — segments, broadcasts delete | soft delete + purge · hard delete | soft delete + purge | 2026-11-23 | Claude | AMBER |
| P10 | A10 — read-only plan | plan · launch | the owner may pause, delete, disconnect; only go-live and turning a PRO part on are refused | 2026-11-23 | Claude | AMBER |
| P11 | A11 — automation delete reason | optional · required | optional; `other` needs a note | 2026-11-23 | Claude | AMBER |
| P12 | A12 — "next post" expiry | never · launch window | never expires; the 15-minute expiry removed | 2026-11-23 | Claude | AMBER |
| P13 | A13 — message rows dropped by run-start week | accept ≈ 30 days · partition by created time | accept; "what happened" and "retry failed" read about the last 30 days | 2026-11-23 | Claude | AMBER |
| P14 | A14 — workspace DM meter | new app route · field on `/auth/me/context` | new app route | 2026-11-23 | Claude | AMBER |
| P15 | A15 — undo toast | client replays · undo route | client replays; no route | 2026-11-23 | Claude | AMBER |
| P16 | A16 — global sending tables without organization | documented exemption · per-organization rows | documented RLS exemption, maintenance login only | 2026-11-23 | Claude | AMBER |
| P17 | A17 — daily profile refresh | inside the token check · own job | inside the token check | 2026-11-23 | Claude | AMBER |
| P18 | A18 — team "suspend account" | column now, route later · both now | `suspended_at` column now, the platform-admin route later | 2026-11-23 | Claude | AMBER |
| P19 | A19 — plus addresses in email answers | accept + ask again ×3 · launch refusal | accept; ask again up to 3 times with wordings | 2026-11-23 | Claude | AMBER |
| P20 | A20 — permission codes | reuse `automation:*` + `contact:update` · new codes | broadcasts, segments, past comments reuse `automation:*` (D68, D69); `contact:update` for note, tags, pause | 2026-11-23 | Claude | AMBER |
| P21 | A21 — yes/no field names (db-changes N1) | `is_` / `has_` (be-sql-design-guard) · plan names | `is_` forms (`is_reply_like_person`, `is_counted_as_direct_message`, …); the launch's `is_public_reply_enabled` keeps its name | 2026-11-23 | Claude | AMBER |
| P22 | A22 — public-id prefixes for new tables (N2) | chosen at kickoff by `generatePublicId` · now | chosen at kickoff, recorded in AS-BUILT | 2026-11-23 | Claude | AMBER |
| P23 | A23 — launch ignored reasons `waiting_for_other_email`, `already_waiting` (N3) | keep · drop | keep (the plan is silent) | 2026-11-23 | Claude | AMBER |
| P24 | A24 — own comments skip reason (N4) | rename `echo` → `own_comment` · keep `echo` | `own_comment` for comments; `echo` stays for DM echoes | 2026-11-23 | Claude | AMBER |
| P25 | A25 — attachments point at `upload.uploads` (N5) | documented exception · keep the upload public id only | the upload public id only, read through the upload service (no cross-domain foreign key) | 2026-11-23 | Claude | AMBER |

## Waiting for the user (RED, Step 4 batch)

Q1 scope · Q2 how it ships · Q3 both repositories · Q4 route-review confirmation · Q5 Redis buffer ·
Q6 partitioning · Q7 file scan · Q8 one open run · Q9 Meta-test-gated features · Q10 plan prices ·
Q11 where new things live · Q12 referral payouts (only with Part F). Each answer becomes a `RED` row here.
