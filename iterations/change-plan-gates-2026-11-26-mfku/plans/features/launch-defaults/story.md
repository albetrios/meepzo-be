Status: ready
Kind: module (backend only; no screen)
Depends on: entitlement-module
Spec: routes-final §2; P5

## Stories
- As a product owner I want Free to include segments and broadcasts so that the launch is generous.
- As an operator I want read-only off by default so that a lapsed plan keeps working until we turn it on.

## Rules
- Free and the 3 switched-off plans share the new values (`data.free-plan-segments-broadcasts`)
- The flag defaults to `false` everywhere (`quality.read-only-flag-default`)

## Acceptance criteria
- AC-14, see [acceptance.md](../../acceptance.md)
- AC-15, see [acceptance.md](../../acceptance.md)

## Work items
- `data.free-plan-segments-broadcasts`
- `quality.product-first-defaults`
- `quality.read-only-flag-default`
