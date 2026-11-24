# Alignment re-check — feat-instagram-dm-sending-2026-11-23-oxak/plans (after routes-final rev 5, P100)

2026-11-24. Same method and scope as `plans/reviews/alignment-check-2026-11-24.md`, done again by script after the
sync to routes-final rev 5 and P100. RF = routes-final.md (source of truth, not edited), RC = route-changes.md,
DB = db-changes.md, WC = worker-changes.md, COV = coverage.md. Scripts:
`/tmp/claude-0/-home-user-meepzo-be/3f88a5a9-e63e-5fc8-9298-3bd816ce4a1e/scratchpad/recheck/`
(`routes.py`, `cmp.py`, `rfcounts.py`, `tables.py`, `cols.py`, `wc.py`, `leftovers.py`, `decisions.py`, `prior.py`).

## What changed in the sync (Job 1)

- **RC:** RC-102–RC-111 Source cells now cite `routes-final § n, route m` (141–150: § 9 141–142, § 10 143–147,
  § 11 148–149, § 12 150). A note under the counts table ties the totals to RF: 105 routes = 49 NEW + 55 CHANGED
  + RC-67 as built, + 5 REMOVED. Counts 49 / 55 / 5 (unchanged). The Stage row and the "Since the last version" note
  are updated.
- **DB:** NEW table `automation_run_open_key` (`app.automation_run_open_keys`), with its own Stage 3 section and
  diagram. Its columns match RF 4.B.3 / AU37 exactly: organization_id, automation_id, contact_id (PK),
  automation_run_id and automation_run_started_at (→ run), created_at. Also added: overview entity + 3 relations,
  counts NEW 21 → 22 (22 / 15 / 1 / 1), the Before → after for `automation_runs`, and the stale P71 /
  "contact-lock" text updated. **Fixed during the re-check:** `automation_comment_log` gains
  `automation_run_started_at` (RF 4.B.3, AU36), where DB had said "not added".
- **WC:** NEW **WC-67**, which removes open-run keys whose run has ended. It runs every minute as its own run with a
  40 s budget (P94). WC-45 now deletes the run's key (P100). WC-1 and WC-2 write or swap the key. NEW 44 → 45, total
  60 → 61. **Fixed during the re-check:** WC-28 and WC-29 (broadcast start and end) now run under P94 as RF SN6,
  BC7 and BC11 describe: each its own run with a 40 s budget, and the end works in pieces of 500 (it was "every
  minute, up to 500 a round").
- **COV:** a P100 row was added (covered), the section was renamed P91–P100, and the totals are 134 rows / 126
  covered / 8 out-of-scope. The P94 row now lists WC-28, WC-29 and WC-67. The P96, P68–P71 and R4 rows note that
  P100 reverses P71.

## Results

| Check | Result |
| --- | --- |
| Routes: method, path, access, idempotency, Source cite (§ + route number) for all 109 RC rows vs 177 RF §7 rows (parent + nested) | **match**: every NEW/CHANGED RC is under exactly one route number, cites it and the right section; parent and nested RF tables agree for all 105 numbers |
| Route totals | RF header 105 = §7 parent rows 105 (per sub-domain 11/6/3/9/13/3/2/13/9/11/14/9/2); RC 49 NEW + 55 CHANGED + RC-67 = 105; REMOVED 5 = RF's 5 |
| Change kind | match. The script's 13 "KIND ?" hits are sub-domain 7's rows (RC-41–RC-53): the whole sub-domain is marked **(new)** in the RF header, and its rows carry no per-row "(new)". RC-67 sits in RC's EXISTING list, not a table |
| Table set | 39 DB entities = 39 RF tables; RF-only `.3` mentions are the rows-only platform tables (roles, permissions, tokens, notifications…), as before |
| Columns | `automation_run_open_keys` is identical to RF. The "db only" diffs are context, referenced or unchanged fields that RF lists only in combined cells or shared rows (spot-checked). No RF column is missing from DB |
| Background work | WC 45 / 13 / 3 = 61 rows = count table; every CHANGED row has Before → after; every WC-n RF cites has a row; all 16 duty names in RF SN6 map to a WC row; no queue, job or worker names in WC |
| Leftover names | Every remaining hit is a history note ("was …", "reversed by P100", "the plan's …") or an entity name |
| Decisions P54–P100 | Each is in decisions.md and has a COV row (none missing). P100 is cited in RF 37×, RC 3×, DB 14×, WC 13×, COV 9× |
| The 17 mismatches of the first check | all 16 counted ones still fixed (`prior.py`: 16 / 16 OK) |
| Mermaid | db-changes 40 blocks: mermaid 11 parse 0 invalid; the DB Viewer's `parseErDiagrams` gives 39 entities, 54 relations, 0 warnings; the logical-type and label check gives 0 errors. The other three files have no diagrams. All markdown tables are well-formed, and markdownlint reports 0 issues |

## Remaining mismatches

None in the four change files.

These would need routes-final changed (cite only, not done here):

1. RF names the open-run key repair duty only as `repair-open-run-keys` (AU37 L2060, AUC15 L2149, SN6 L2721). It has
   no WC number. The plain-words row is **WC-67** (worker-changes.md:219). RF could cite "WC-67".
2. Wording in RF SN6 L2721: "`repair-owner-emails` (WC-57) 7's `repair-broadcast-start`" is missing a separator
   before "7's".

**Verdict: aligned.** Only the two RF-side cite and wording notes above remain.
