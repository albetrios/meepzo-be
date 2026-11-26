# Feature 4 — messages access

**As** an owner or admin, **I want** to see whether "Allow access to messages" is on for an account and re-check it after
I change it in Instagram, **so that** sending resumes without waiting.

Requirements: `instagram.message-access-stored`, `instagram.message-access-recheck`, `instagram.message-access-shown`,
`background.message-access-probe`, `data.instagram-message-access`.

## Acceptance criteria

- AC-4.1 — The account set-up job stores the probe's answer and its time.
- AC-4.2 — Route 154 `on` ends the `access_off` stop; `off` starts or keeps it; `unknown` leaves it; each stores the answer.
- AC-4.3 — A second check within 60 seconds answers the stored result with `is_from_meta: false` and calls Meta once.
- AC-4.4 — Route 154: a 190 breaks the connection; Meta down → `503`, nothing stored; a viewer → `403`; another organization → `404`.
- AC-4.5 — Routes 6 and 7 show `instagram.message_access { status, checked_at }`.
