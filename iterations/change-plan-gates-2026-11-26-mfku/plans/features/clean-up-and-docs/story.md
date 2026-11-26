Status: ready
Kind: module (backend only; no screen)
Depends on: app-gate-users, seat-gate, job-gates
Spec: routes-final ENC7, RGC7; P9

## Stories
- As a maintainer I want a policy test banning direct plan reads so that the pattern holds after this iteration.

## Rules
- No plan-access read outside subscription and entitlement (`quality.no-direct-plan-reads`)
- Docs describe the pattern and the shapes (`quality.plan-gates-docs`)

## Acceptance criteria
- AC-4, see [acceptance.md](../../acceptance.md)
- AC-12, see [acceptance.md](../../acceptance.md)
- AC-13, see [acceptance.md](../../acceptance.md)

## Work items
- `quality.no-direct-plan-reads`
- `quality.plan-gates-docs`
- `quality.gates-green`
