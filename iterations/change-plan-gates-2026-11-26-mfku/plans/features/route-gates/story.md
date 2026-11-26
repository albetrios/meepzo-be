Status: ready
Kind: module (backend only; no screen)
Depends on: entitlement-module
Spec: routes-final §3

## Stories
- As an engineer I want every write route to declare its plan gate so that a forgotten gate can't merge.

## Rules
- Order: authenticate → plan guard → permission → idempotency claim (`access.read-only-before-idempotency`)
- The guard enforces `read_only` only (`access.route-plan-gate-enforcement`)

## Acceptance criteria
- AC-1, see [acceptance.md](../../acceptance.md)
- AC-3, see [acceptance.md](../../acceptance.md)
- AC-10, see [acceptance.md](../../acceptance.md)

## Work items
- `access.route-plan-gate-declaration`
- `access.route-plan-gate-enforcement`
- `access.read-only-before-idempotency`
- `quality.plan-gate-coverage-test`
