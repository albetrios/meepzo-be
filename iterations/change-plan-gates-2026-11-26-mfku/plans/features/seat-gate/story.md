Status: ready
Kind: module (backend only; no screen)
Depends on: entitlement-module, route-gates
Spec: routes-final §5

## Stories
- As an engineer I want the seat ceiling answered through the module so that seats follow the same pattern as other limits.

## Rules
- The locked seat check is unchanged; no seat override (`operations.entitlement-consume`, `data.entitlement-override-row`)

## Acceptance criteria
- AC-5, see [acceptance.md](../../acceptance.md)
- AC-9, see [acceptance.md](../../acceptance.md)

## Work items
- `operations.entitlement-consume`
