Status: ready
Kind: module (backend only; no screen)
Depends on: entitlement-module, route-gates
Spec: routes-final §4

## Stories
- As an organization owner I want plan refusals to name the feature or limit, the numbers and the reset so that I know what to upgrade.

## Rules
- The channel feature check keeps its order (`access.feature-gate-order`)
- Counters keep their locks (`operations.entitlement-consume`)
- The run engine skips switched-off steps (`operations.entitlement-downgrade-rule`)

## Acceptance criteria
- AC-5, see [acceptance.md](../../acceptance.md)
- AC-9, see [acceptance.md](../../acceptance.md)
- AC-10, see [acceptance.md](../../acceptance.md)

## Work items
- `access.feature-gate-order`
- `operations.entitlement-consume`
- `operations.entitlement-downgrade-rule`
