# Merge log

Every merge conflict of this iteration's merges into `feat/instagram-automation`: the file, the
two sides, the resolution and its risk. Decisions: [P144](decisions.md), [P145](decisions.md).
"ours" is `feat/instagram-automation`, "theirs" the lane branch.

## Round 2 · merge 1 — `lane-b/tenancy-auth` at 9bd3846 (commit c56b7a1)

Both branches had merged R40, R46, R49, R51 and lane C's R38 / R39 / R41 separately (main P141–P143,
lane B P223 / P224), so most conflicts are two resolutions of the same rows ([P144](decisions.md)).

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `src/domains/app/app.container.ts` (13 hunks) | ours: round-1 wiring + SonarQube splits; theirs: lane rules R43–R45, watches R48, month notice R53, `createChannelSendingServices`, `createInstagramIntakeTaskHandlers` | theirs as the base; re-applied `createSettingsChannelAccountPort`, `AppContainerDependencies`; account tasks wired with `channelAccountService` (P142 (3)) | low — typecheck, container-using tests green |
| `instagram-account/workers/instagram-account-tasks.processor.ts` (6) | ours: break through `ChannelAccountService.markAccountBroken` (lanes stop); theirs: `InstagramAccountService.markConnectionBroken`, renamed read, bounds in the queue file | ours' break and services; theirs' names (`listConnectedForWebhookSubscriptionSweep`, queue-file bounds); unused `MetaGraphApiError` import dropped | low — processor unit test asserts `markAccountBroken` |
| `instagram-account/instagram-account.constants.ts` (auto) | ours added the sweep bounds; theirs has them in `instagram-account-tasks.queue.ts` | theirs' file — one definition | none |
| `instagram-account.repository.ts`, `.service.ts`, `-extension.service.ts` | read name and TSDoc wording | theirs (one name across callers) | none |
| `channel-connection/workers/channel-connection-token-check.worker.ts` (3) | ours: direct import of the account sweep; theirs: optional services port `webhookSubscriptionSweep` | theirs (the connection imports no account job; the registry wires it) | low — registry wires it, unit tests green |
| token-check constants / processor, `meta-graph-error.util.ts`, `channel-connection-token.repository.ts` | TSDoc wording | either side's wording | none |
| `instagram-webhook/workers/instagram-missed-comment-check.processor.ts` (2) | ours: SonarQube split (`lookAtPost`, `saveReadComments`, `handFoundCommentsToIntake`); theirs: R53's `tellMissedCommentsFound` | both: the split plus the notice before the hand-off | low |
| `instagram-webhook-event.repository.ts` | TSDoc (nested recursive base) | ours | none |
| `src/infrastructure/queue/scheduler.ts`, `worker-registration.registry.ts`, `worker.ts`, `worker-containers.ts`, `constants-centralization.util.ts` | comments; the registry import | code identical to theirs; comments either | none |
| `worker-registration.registry.unit.test.ts`, `scheduler.unit.test.ts` | count pins (44 vs 46 workers, 40 vs 59 jobs) | theirs (the registry equals lane B's) | none |
| `instagram-account-queues.unit.test.ts`, `instagram-account-tasks.processor.unit.test.ts` | doc / read name | ours / theirs | none |
| `instagram-database-tasks.worker.unit.test.ts` (add/add) | both wrote the same test | ours (3b4583b's) | none |
| `__tests__/e2e/instagram-retention-erasure.e2e.test.ts` (4) | the same data-deletion repeat fix, two shapes (`issuedAt` vs signed once) | theirs (lane B's concurrent repeat test uses it) | none |
| `__tests__/e2e/instagram-acceptance-gaps.e2e.test.ts` | ours dropped the subscription stamp | theirs (keeps the stamp; harmless) | low |
| docs: `resource-limits.md`, `workers-and-events.md`, `credentials-and-env.md`, `FLOWS.md`, `OVERVIEW.md`, `POLICIES.md`, `instagram-account.overview.md` | counts and wording | theirs (lane B's counts are the merged registry's); `src/domains/CLAUDE.md` char-merged | low |
| `src-structure-tree.txt`, `frontend-route-map.md`, `docs/routes.txt` | generated | regenerated | none |
| `AS-BUILT.md` (6) | both sides' rows; interface lists | every row of both; struck items kept once (no live duplicates) | low |
| `plans/decisions.md` | both sides' rows | union by P number (no collision) + P144 | none |
| `plans/acceptance.md` (4) | Status / evidence | per row the most-advanced Status; equal → evidence of both, test names checked to exist | low |
| `plans/worker-changes.md` | Built cells | theirs (a superset) | none |

## Round 2 · merge 2 — `lane-d/r49` at be2411e (R50, P414)

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `instagram-sending/instagram-send-stop.repository.ts` (2) | ours: R53's `listStartedSinceAcrossOrganizations` + retention factory; theirs: R50's delete + gauge + retention factory | both methods, one factory (TSDoc names both uses) | low |
| `instagram-sending/message-month-count.repository.ts` (2) | ours: R53's `listOrganizationsCountedSince`; theirs: R50's delete + gauge | both, one factory | low |
| `contact/contact-tag-event/contact-tag-event.repository.ts` (auto-merged) | both added `createRetentionContactTagEventRepository` | duplicate removed (typecheck found it); one factory, TSDoc names both | none |
| `automation/automation.repository.ts` | ours: R41's post-linking read; theirs: purge TSDoc | both | none |
| `prometheus-metrics.ts` | ours: `recordRepairDutyRound`; theirs: `setRetentionCleanupGauges` | both | none |
| `scheduler.unit.test.ts` (3) | 59 vs 38 jobs | 60 jobs, 37 queues, 97 closes (R50 shares the upkeep queue) | none |
| `automation.overview.md`, `contact-tag-event.overview.md` | worker list wording | both facts kept | none |
| `KICKOFF.md` | Status cells | most-advanced (`kickoffmerge.py`) | none |
| `AS-BUILT.md`, `plans/decisions.md`, `plans/worker-changes.md` | rows / Built cells | union; Built cells joined | low |
| `plans/routes-final.md` (BCC9) | both appended an "as built" note | char 3-way of the one line | none |
| `src-structure-tree.txt` | generated | regenerated | none |

### Gate fixes at the source ([P145](decisions.md))

- `principal-scope-minting.policy`: `InstagramSendingRepairService` takes `jobScopeFor` from the repair
  worker; the Stripe "payment failed" notice uses `stripeWebhookOrganizationScope` (worker-side util);
  `instagram-lane-harness.factory.ts` allowlisted with its reason.
- R47 bug: migration `20261125210000_app_repair_sweep_arms.sql` — the sweep arm on
  `app.contact_activities` and `app.automation_reply_states` (WC-17 skipped every waiting DM, WC-18
  never trimmed, under the RLS-subject role); `rls-table-scope-map` updated.

## Lane B ← main d08b70f (round 2 + R50, P144 / P145)

"ours" is `lane-b/tenancy-auth` (c86eeb0: the password routes disabled P251, R60 P252), "theirs" main d08b70f.

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `AS-BUILT.md` › Rows | ours: R53, R47 (+ R60's fix line), lane C × lane B merge, the owner change (password routes), R60; theirs: the same R53 / R47 / lane C rows plus the round-2 rows, R50 and P145's fix on R53 | theirs' rows; R47 = theirs + R60's fix line; ours' stale R53 dropped (theirs carries P145's fix); the owner-change and R60 rows appended | low |
| `AS-BUILT.md` › Standing deviations | ours: "Password routes"; theirs: the R49 × main, acceptance-two and post-merge gates rows | union | none |
| `plans/decisions.md` | ours: P251, P252; theirs: P141–P145, P414 | union (theirs first) | none |
| `instagram-reconnect-flow.e2e.test.ts` (no conflict; typecheck) | P145 made `jobScopeFor` a required repair dependency | the test passes `PRINCIPAL_SCOPE.JOB` as the repair worker does | none |

## Lane B ← lane E e3cc504 (R57, R58 P501, R59, the Free-row fix P502)

"ours" is `lane-b/tenancy-auth` (9f54163), "theirs" `lane-e/flows` at e3cc504 (base b87c4c9).

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `plans/acceptance.md` (AC-22.1–AC-25.7) | ours: AC-25.* filled (R60); theirs: AC-22–AC-24 filled (R57–R59) | per row the filled side; no row filled on both | none |
| `KICKOFF.md` | Status cells R57–R60 | most-advanced (`kickoffmerge.py`) | none |
| `AS-BUILT.md` | rows on both sides; theirs' fix lines on R52, R53 (R57–R59) beside ours' main-merged rows | union (`resolve.py ours`); the six rows both edited (R46–R48, R51–R53) merged per row 3-way from b87c4c9 — theirs' fix lines applied on ours' text | low |
| `plans/decisions.md` | ours: P141–P145, P414, P251, P252; theirs: P501, P502 | union | none |
| `src-structure-tree.txt` | generated | regenerated | none |

## Main ← lane B f72b1b1 (password routes P251, R60, OAuth 409 doc, lane E R57–R59 + Free-row fix P502) — 2026-11-25

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `KICKOFF.md` | main R61 done; lane B R57–R60 done | `kickoffmerge.py`: most-advanced Status per row (R57–R61 all done) | none |
| `AS-BUILT.md` | main appended R6 × R61 fix + R61; lane B appended the password owner change, R60, R57, R58, R59 | union, main's rows first | none |
| `plans/acceptance.md` | main filled AC-26.*; lane B filled AC-22.*–AC-25.* | per row: AC-26.* from main, the rest from lane B (no row filled on both) | none |

## Lane D (`lane-d/flows`, R56 + R62) ← main `feat/instagram-automation` 96050a3 (round 2, R61, P251, R57–R60, P501–P502) — 2026-11-25

"ours" is `lane-d/flows`, "theirs" main.

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `KICKOFF.md` | ours R56, R62 done; theirs R57–R61 done | `kickoffmerge.py` (most-advanced Status per row) | none |
| `AS-BUILT.md` (2 hunks) | ours: R56, R62 rows and their fix lines on R46, R47, R48; theirs: round-2 merge rows, R50, R6 × R61, R61, P251, R57–R60 | row union keyed by the first cell, theirs' order then ours' new rows; rows edited on both sides 3-way per row against the base (no overlap) — every fix line kept | low — the duplicate-key rows (R6, R9, R14 …) are main's own |
| `plans/acceptance.md` | ours AC-21.*, AC-27.*; theirs AC-22.*–AC-26.* | per row, the filled side (no row filled on both) | none |
| `plans/decisions.md` | ours P451, P452; theirs P141–P145, P414, P251, P252, P501, P502 | union | none |
| `migrations/` | ours `20261125233000_app_sending_state_release.sql`; theirs `20261125210000_app_repair_sweep_arms.sql` | both kept, timestamp order (no conflict; different tables) | none |
| `app.container.ts`, `automation-run.service.ts`, the RLS-only allowlist, locales | auto-merged: ours' `runEndedHook` wiring and two allowlist entries beside theirs' R61 erasure changes | auto-merge checked by typecheck and the R61 erase flow | low |
| `instagram-outage-recovery-flow.e2e.test.ts` | theirs made `jobScopeFor` a required `InstagramSendingRepairService` dependency | ours' test passes `PRINCIPAL_SCOPE.JOB` (as main's repair tests do) | none |
| generated docs (`docs:all`) | regenerated | — | none |

## Lane D (`lane-d/flows`) ← lane E `lane-e/flows` 85043f9 (route 103 fix, P503; its parent e3cc504 already in main) — 2026-11-25

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `plans/decisions.md` | ours P451, P452 after main's rows; theirs P503 | union | none |
| `AS-BUILT.md`, `subscription.service.ts`, its unit test, `trial.e2e.test.ts`, `errors.json` (en, es) | auto-merged (lane E only) | — | none |

## Lane C · `feat/instagram-automation` at 2c1a20f into `lane-c/flows` (round 2, R56–R62)

Main's R56–R62, the password routes (P251), P501–P503 and P144 / P145 onto lane C's R54 / R55 (P351, P352).
"ours" is `lane-c/flows`, "theirs" main.

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `KICKOFF.md` | ours R54, R55 `done`; theirs R56–R62 `done` | `kickoffmerge.py` — the further status per row | none |
| `AS-BUILT.md`, `plans/acceptance.md`, `plans/decisions.md` | ours R54 / R55 rows, AC-19 / AC-20 ticks, P351 / P352; theirs R56–R62 rows, AC-21–AC-27, P251 / P451+ / P501–P503 | `rowmerge.py` row union, 3-way per row (0 overlaps) | none |
| `organization-filter-audit.allowlist.ts` | both added `0d64a385e504` (the usage lookup — ours R54, theirs R56 / P451); theirs also `d70319b2051c` | theirs (both entries, one copy of the shared fingerprint) | none |
| `docs/reference/architecture/src-structure-tree.txt` | both added e2e files | regenerated (`pnpm tool:project-structure-tree`) | none |
| `instagram-send-core.service.ts`, `app.container.ts`, `automation-run.service.ts` (runEndedHook), `automation.service.ts` / `.repository.ts`, `instagram-sending.constants.ts` / `.overview.md`, `FLOWS.md`, intake processor | auto-merged — R54's `bad_text` stop in `applyStops` and `automationStopPort` beside R60 / R62's send-core changes | kept both; typecheck + the R54–R62 flow suites pass | low |

## Lane C · `lane-b/close` at 892d39a into `lane-c/flows` (the Close records)

The Close records (acceptance results, frontend-route-map sections 1–4, the AS-BUILT summary, Standing deviations and
Owner items 1–27) onto lane C's R54 / R55. "ours" is `lane-c/flows`, "theirs" `lane-b/close`.

| File | Sides | Resolution | Risk |
| --- | --- | --- | --- |
| `plans/acceptance.md` | ours AC-19.\* / AC-20.\* results; theirs every other result | ours for AC-19 / AC-20 ids, theirs elsewhere; then BRIEF-3 (AC-20.\* `pass`, still `partial` for AC-16.11 / AC-16.12) and P35 (`pass`) rolled up | none |
| `AS-BUILT.md` | ours R54 / R55 rows and fix lines; theirs the merge rows, summary, deviations, owner items | both kept; summary says R1–R62 built, R54's source fixes under "Built, not planned"; owner items 15, 18, 26 cite [P351](decisions.md) / [P352](decisions.md) as links; the automations theme row lists them | none |
| `plans/frontend-route-map.md` | theirs sections 1–4 | section 3 regenerated — no change (`--check` passes, 203 routes) | none |
