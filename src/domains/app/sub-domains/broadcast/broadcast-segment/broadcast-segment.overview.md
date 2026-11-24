`src/domains/app/sub-domains/broadcast/broadcast-segment/`

# Broadcast segment

Parent: [Broadcast](../broadcast.overview.md)

## Purpose

A saved audience of one channel account — a name and a tree of conditions over the account's
contacts — that many broadcasts reuse (`app.segments`; routes-final § 7.B of the DM-sending
iteration, ROUTE row R21), and the audience count of saved or unsaved conditions. Routes under
`/api/v1/app`: list one account's segments (77, `GET /segments?channel_account_id=`), save one (78,
`POST /segments`), open (79), change its name or conditions (80, `PATCH /segments/{segment_id}`),
delete (81) and count an audience (82, `POST /segments/audience-count`).

## Layout

- `broadcast-segment.schema.ts` — `app.segments`: the composite key to the channel account
  (CASCADE), `channel`, `name`, `conditions` (jsonb object), creator and editor, soft delete; two list
  indexes led by the account, the tombstone index for the purge; RLS with the sweep arm in `USING`
- `broadcast-segment.dto.ts` — `segmentConditionsSchema` (BC12 — one schema for segments and a
  broadcast's one-off conditions) and the route DTOs
- `broadcast-segment.repository.ts` — the CRUD statements and the audience builder
  (`buildSegmentAudienceCondition`, BC13) with the count under its own 2 s statement timeout
- `broadcast-segment.service.ts` — team-only guards, the `segments` feature check, the automation
  check of a tree's ids, `409 record_changed`, the count and its background path
- `broadcast-segment.controller.ts`, `broadcast-segment.routes.ts`, `broadcast-segment.validator.ts`,
  `broadcast-segment.serializer.ts`, `broadcast-segment.types.ts`, `broadcast-segment.constants.ts`
- `seed/` — three segments per seeded live account (one deleted)

## Key invariants

- The tree (BC12): a group `{ op: and | or, items }` of conditions and groups of conditions — at most
  2 levels and 20 conditions; eight fields — `tags`, `automation`, `came_in`, `commented`, `active`,
  `details`, `story_activity`, `no_broadcast`; snake_case keys; strict (an unknown key is a `400`).
- Every automation a tree names (`aut_…`, the `automation` field and `came_in.first_automation`) is
  the account's — deleted ones included — else `400` on `conditions`. Instagram media ids are kept as
  given: they are matched only against the account's own contacts' comment logs (P309).
- Always left out of an audience: opted out, paused (`automations_off_at`), deleted, and anyone who
  got a broadcast in the last 24 hours. "Can receive now" adds her open chat — her last direct
  message within 24 hours less 15 minutes.
- PRO (BC19, P76): 78, 80 and 82 ask the channel account's one feature check for `segments` —
  `403 plan_lacks_feature` without the plan's switch; 77, 79 and 81 stay open, so a trial's segments
  stay saved and readable after a move down.
- One account each (BC5): fixed at create; a count of a saved segment names that account (`400` on
  `segment_id` otherwise).

## Lifecycle

Saved (78) → changed (80; drafts that use it follow it) → deleted (81, soft; in the same transaction
the registered delete steps run — ROUTE row R22 adds "empty `segment_id` on this account's drafts")
→ purged 90 days later (WC-62, ROUTE row R50).

## Events

None. Audit after commit: `app.segment.create`, `app.segment.update` (`changed_fields`, names only)
and `app.segment.delete`.

## Failure modes

- `400` on `channel_account_id`, `name`, `conditions`, `segment_id`; `404 channel_account_not_found`,
  `segment_not_found`, `team_organization_required`; `403 plan_lacks_feature`,
  `missing_permission`; `409 record_changed`; `422` on a personal organization or a missing
  `X-Idempotency-Key` (78, 82).
- The count past its 2 s statement timeout (57014) goes to the background count
  (`SegmentBackgroundCountPort`, the `segment-count` task and its 60 s Redis copy — ROUTE row R46)
  and answers `is_counting: true`; until R46 wires it, `503 segment_count_unavailable`.

## Policy constants

`SEGMENT_CONDITIONS_MAX_COUNT` (20), `SEGMENT_AUDIENCE_COUNT_STATEMENT_TIMEOUT_MS` (2000),
`SEGMENT_AUTOMATION_RUN_LOOKBACK_DAYS` (90), `SEGMENT_BROADCAST_COOLDOWN_HOURS` (24) — in
`broadcast-segment.constants.ts`.
