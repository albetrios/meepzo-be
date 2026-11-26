Status: ready
Kind: module (backend only; no screen)
Depends on: none
Spec: routes-final §1

## Stories
- As an engineer adding a gated feature I want one module to ask by key so that no feature knows plan names.
- As a super-admin I want an override row to change a switch or limit so that one organization gets more without code.
- As the frontend I want each entitlement value to say where it came from so that I show the right upsell.

## Rules
- Merge: override → plan → registry default (`data.entitlement-merge-order`)
- One read per request or job (`quality.entitlement-single-read`)
- One refusal builder, statuses unchanged (`quality.plan-refusal-shape`)
- Keys stay bare; product recorded (`data.entitlement-key-namespacing`)

## Acceptance criteria
- AC-5, see [acceptance.md](../../acceptance.md)
- AC-6, see [acceptance.md](../../acceptance.md)
- AC-7, see [acceptance.md](../../acceptance.md)
- AC-8, see [acceptance.md](../../acceptance.md)
- AC-11, see [acceptance.md](../../acceptance.md)

## Work items
- `quality.entitlement-key-registry`
- `access.entitlement-module-single-entry`
- `data.entitlement-merge-order`
- `data.entitlement-key-namespacing`
- `data.entitlement-override-row`
- `quality.entitlement-single-read`
- `quality.plan-refusal-shape`
- `operations.entitlements-read-source`
