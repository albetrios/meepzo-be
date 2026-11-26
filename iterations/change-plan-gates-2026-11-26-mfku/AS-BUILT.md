# change-plan-gates-2026-11-26-mfku — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (P35) · kickoff 2026-11-26

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |

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
