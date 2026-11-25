`src/domains/app/sub-domains/automation/automation-backfill/`

# Automation backfill (nested resource)

Parent: [Automation](../automation.overview.md)

## Purpose

An automation's past-comments reads (`app.automation_backfills`, feat-instagram-dm-sending
routes-final § 4.C, AU31–AU33, ROUTE row R15): "also answer comments from the last N days" (1–7) on
a live comment or ad-comment automation, a PRO feature (`past_comments`, P83). Route 38
(`POST /api/v1/app/automations/{automation_id}/backfills`, `automation:update`, `X-Idempotency-Key`)
saves a `queued` read; route 39 (`GET …/backfills/{automation_backfill_id}`, `automation:read`)
reads one; the automation's object (routes 28–30, 32–34) carries its open read as `open_backfill`.
The read itself — Meta's comments saved as "old" comment events, one read at a time per account,
the 10-minute watch, the `automation.backfill_done` notice — is the read job of ROUTE row R41
(WC-41), enqueued through the `AutomationBackfillReadQueue` port once R41 wires it.

## Layout

- `automation-backfill.schema.ts` — the table, its two composite keys (automation `CASCADE`, account
  `RESTRICT`), the checks of 4.C.3, the open, watch and queued indexes, the RLS policy (the
  organization arm plus the retention sweep arm in `USING` for the watch)
- `automation-backfill.repository.ts` — the open read of an automation, one read by its public id
  under its automation, the `queued` insert
- `automation-backfill.service.ts` — `AutomationBackfillService`: route 38's checks and insert,
  route 39, `findOpenAutomationBackfill` (the automation service's `openBackfills` port)
- `automation-backfill.routes.ts` / `.controller.ts` / `.dto.ts` / `.validator.ts` — routes 38–39:
  the strict body (`days` 1–7), the audit entry after commit
- `automation-backfill.serializer.ts` / `.types.ts` — the Automation backfill object (4.C.6); the
  ports `AutomationBackfillReadQueue` (R41) and `AutomationOpenBackfillReader`
- `automation-backfill.constants.ts` — statuses, fail reasons, `PAST_COMMENTS_MAX_DAYS` (7), the
  ways to start it supports
- `seed/` — bulk: a read in every status on each seeded team's live comment automations
- `__tests__/` — unit (validator, serializer), the repository against the database, routes 38–39
  over HTTP

## Key invariants

- **One open read per automation** — the partial unique `idx_automation_backfills_open` over
  `(organization_id, automation_id) WHERE status IN ('queued', 'reading')`; a second start answers
  `409 automation_backfill_in_progress` ("Past comments are already being read"), the race loser
  too. A start after a `done` or `failed` read makes a new row.
- **Route 38's order** (AU31): team-only (`422`), the automation locked `FOR UPDATE`
  (`404 automation_not_found`), 1B's one feature check `past_comments` (`403 plan_lacks_feature`,
  `422 channel_lacks_feature`, `409 permission_not_granted`), `live` only (`409 automation_not_live`),
  `comment` or `ad_comment` only (`422 automation_backfill_not_supported` — never `live_comment`), no
  open read; then the row, its account copied.
- **A read is found under its own automation only**: another automation's or organization's answers
  `404 automation_backfill_not_found` (AU33). No list route.
- **`fail_reason` is set exactly when `failed`** (`meta_error` · `plan_feature_off`); `last_error`
  holds codes only and never leaves (support reads the logs).
- **No Meta call in a request** (4.10): the start writes a row; the job reads.
- **Kept with its automation**: the purge of a deleted automation takes its reads by cascade.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued: POST backfills (route 38)
    queued --> reading: the account's read starts (R41)
    reading --> done: every post read (R41)
    reading --> failed: meta_error or plan_feature_off (R41)
    queued --> failed: plan_feature_off (R41)
    done --> [*]
    failed --> [*]
```

## Failure modes

- **Route 38**: no `automation:update` → `403 missing_permission`; no `X-Idempotency-Key` →
  `422`; a personal organization → `422`; `days` missing, not whole, outside 1–7, or an unknown
  field → `400`; then the refusals of the order above. Nothing is written and no audit entry is
  recorded on any of them.
- **Route 39**: no `automation:read` → `403`; a personal organization →
  `404 team_organization_required`; `404 automation_not_found`; `404 automation_backfill_not_found`.

## Audit

`app.automation_backfill.start` (INFO, resource type `automation_backfill`, metadata
`automation_backfill_public_id`, `automation_public_id`, `days`), after route 38 commits,
best-effort.
