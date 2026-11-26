# Acceptance — feat-meta-connect-flow-2026-11-26-bqmw

Filled at Close: Result `pass` (Evidence: test file › test name, or a command), `partial`, `open` or `deferred`.
Features: 1 `connect-outcomes` · 2 `shared-assets-picker` · 3 `account-capabilities` · 4 `message-access`.

## Feature acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-1.1 — cancel | brief:L44 | open | |
| AC-1.2 — outcome on every success | brief:L15 | open | |
| AC-1.3 — missing permissions named | brief:L46, L101 | open | |
| AC-1.4 — expected business named | brief:L64 | open | |
| AC-1.5 — no accounts shared (first / reconnect) | brief:L52, L102 | open | |
| AC-1.6 — unshared accounts marked by the callback | brief:L61 | open | |
| AC-1.7 — plan limit with `plan_room` | brief:L58 | open | |
| AC-1.8 — connect options | brief:L13, L96 | open | |
| AC-1.9 — unpicked clean-up after 7 days | brief:L54, L104 | open | |
| AC-2.1 — shared assets list and states | brief:L94, L103 | open | |
| AC-2.2 — shared assets re-read, errors | brief:L94 | open | |
| AC-2.3 — viewer reads; Pages sketch | brief:L78, L110 | open | |
| AC-3.1 — capabilities per feature | brief:L95, L105 | open | |
| AC-3.2 — blockers with fixes | brief:L20, L95 | open | |
| AC-3.3 — refusal names the permission | brief:L49 | open | |
| AC-3.4 — per-account scopes | brief:L89, L108 | open | |
| AC-3.5 — capabilities access | brief:L75 | open | |
| AC-4.1 — set-up stores the probe | brief:L85, L107 | open | |
| AC-4.2 — re-check moves the stop | brief:L69 | open | |
| AC-4.3 — re-check once a minute | brief:L69 | open | |
| AC-4.4 — re-check errors and access | brief:L75 | open | |
| AC-4.5 — accounts show message access | brief:L107 | open | |

## Brief acceptance lines

| Item | Source | Proved by | Result |
| --- | --- | --- | --- |
| BRIEF-1 — every outcome has one documented answer and a test | brief:L100 | AC-1.1–AC-1.9, AC-2.2; routes-final 1.9 / 1.10 | open |
| BRIEF-2 — missing permissions named | brief:L101 | AC-1.3 | open |
| BRIEF-3 — `no_accounts_shared` | brief:L102 | AC-1.5 | open |
| BRIEF-4 — picker re-read | brief:L103 | AC-2.1 | open |
| BRIEF-5 — unpicked clean-up job | brief:L104 | AC-1.9 | open |
| BRIEF-6 — capabilities read | brief:L105 | AC-3.1, AC-3.2 | open |
| BRIEF-7 — message access + Page id stored | brief:L107 | AC-4.1, AC-4.5; **Page id deferred** (C-D13, owner test O6) | open (partial by decision) |
| BRIEF-8 — per-account permissions | brief:L108 | AC-3.4 (behind owner test O1) | open |
| BRIEF-9 — `channel` everywhere, Pages sketch | brief:L110 | AC-2.3 | open |
| BRIEF-10 — routes.txt, OpenAPI, route map, i18n | brief:L112 | the Close gates | open |
