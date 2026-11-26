# change-plan-gates-2026-11-26-mfku — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (P35) · kickoff 2026-11-26

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | The pre-handler order test for go-live and broadcast send, written first (routes-final §3 RGC1; R2, P4) | Two integration cases beside each route's read-only test: `broadcast.integration.test.ts` › a read-only plan › *checks the plan first, then the permission, then the idempotency key*; `automation.integration.test.ts` › a read-only plan › *checks the plan before the permission on go-live*. They pin the order by which refusal wins: read-only + a viewer → `403 organization_read_only` (plan before permission); writable + a viewer with no key → permission 403, not `422` (permission before the claim); read-only + owner with no key → `403 organization_read_only`, not `422` (plan before the claim). | **Behavioural, not structural.** The plan said "pins the pre-handler order"; the permission pre-handler is an anonymous function, so a structural test can't recognise it, and an error response releases the idempotency key (`idempotency.middleware.ts` onSend/onResponse), so "the refused write holds no key" can't be told apart by outcome. The order is proven by which refusal wins. go-live takes an optional key, so its claim position is proven on broadcast send only. | A behavioural test survives row 5's rewiring unchanged, which is the point of writing it first. | P4, R2 | `63a97c1` | 2026-11-26 · Nikunj Mavani · `63a97c1` |

### Row 1 verification

- New cases on today's code: 2 passed (`pnpm test:lane -- pnpm vitest run <both files> -t change-plan-gates`).
- Mutation check: the permission check moved before the plan guard on both routes → both cases **fail** (2 failed); files restored with `git checkout`, diff clean.
- Both full files: 46 passed. `pnpm validate`: green (after formatting). Pre-commit guard: green.
- Acceptance: AC-10 (order part) — the cases must still pass after row 5.

## Revisions to upcoming rows

None yet.

## Summary

Written at Close.

## Standing deviations

Baseline `none`, so the starting list is empty. KICKOFF.md § 8 carries in the frozen
`feat-instagram-dm-sending-2026-11-23-oxak` deviations this change touches; the two kept ones are restated here
(P9). The two it resolves (Free's segments and broadcasts, P13; the read-only flag default, P5) are removed when
rows 3 and 4 land.

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Read-only plan | go-live, broadcast send and turning a PRO part on answer `organization_read_only` | the read-only guard is on go-live and broadcast send; turning a PRO part on answers `plan_lacks_feature` | feat-instagram-dm-sending-2026-11-23-oxak | P9 |
| A picture with text | counts as 2 DMs | counts as 1 | feat-instagram-dm-sending-2026-11-23-oxak | oxak P412 |
