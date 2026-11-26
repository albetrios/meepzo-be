Status: ready
Kind: module (backend only; no screen)
Depends on: route-gates, app-gate-users
Spec: routes-final §6

## Stories
- As an engineer I want every background job to declare its plan gate so that a new paid job can't forget one.

## Rules
- Paid jobs meet their gate as today; no send gains a plan read (`background.job-plan-gate-declaration`)

## Acceptance criteria
- AC-2, see [acceptance.md](../../acceptance.md)
- AC-3, see [acceptance.md](../../acceptance.md)

## Work items
- `background.job-plan-gate-declaration`
- `quality.plan-gate-coverage-test`
