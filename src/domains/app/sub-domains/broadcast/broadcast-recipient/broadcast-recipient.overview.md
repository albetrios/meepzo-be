`src/domains/app/sub-domains/broadcast/broadcast-recipient/`

# Broadcast recipient

Parent: [Broadcast](../broadcast.overview.md)

## Purpose

Who a broadcast goes to and what happened to her first message (`app.broadcast_recipients`;
routes-final § 7.C of the DM-sending iteration, ROUTE row R23) — a persistence module with no
routes: it is read only through the broadcast's numbers (`matched`, `sent`, `skipped`, `failed`,
`replies`), never listed. Shared by every channel: it hands each message to the account's channel's
`ChannelSendingPort` and takes the results back (BC18).

## Layout

- `broadcast-recipient.schema.ts` — `app.broadcast_recipients`: composite keys to the broadcast
  (CASCADE) and the contact (RESTRICT), the account copy, `status`, `reason`, `version_number`,
  `sent_at`, `replied_at`; the unique once-per-person key, the status, contact and age indexes; RLS
  with the sweep arm in `USING`
- `broadcast-recipient.repository.ts` — the audience piece's read (BC13's audience expression plus
  "her chat is open now"), the insert on conflict, each status move as one guarded `UPDATE`, and the
  parent broadcast's numbers moved in the same commit
- `broadcast-recipient.service.ts` — `BroadcastRecipientService`: the audience piece, the "when her
  chat opens" row, `recordMessageResult`, the skips (her erasure or pause, a cancel's piece) and her
  first reply
- `broadcast-recipient.types.ts`, `broadcast-recipient.constants.ts`
- `queues/broadcast-audience.job.schema.ts`, `workers/broadcast-audience.processor.ts` — the
  `broadcast-audience` task (WC-40, R46): one piece per job (`bcaud-<brc_…>-<piece>`), chained from the
  piece's last contact (by public id), the account's lane woken after a piece that made recipients;
  the last piece sets the broadcast's `audience_built_at` (the end duty's mark, 7.A.10). Wrapped as an
  Instagram database-heavy task by the app container (S19), so `broadcast/` imports no channel.

## Key invariants

- Once per person per broadcast (BC16): a plain table (P33, P96) with the unique
  `(organization_id, broadcast_id, contact_id)` key; every insert is `ON CONFLICT DO NOTHING`, so a
  second audience build makes no second row.
- A recipient never waits without a message (7.C.10): its first message is saved through the port in
  the same commit; a message the port refuses at once settles the recipient `skipped` with its reason.
- The status is her first message's result: `waiting` → `sent` (`sent_at`) · `skipped` · `failed`
  (with a reason) · `unknown`; a `sent` message N saves message N + 1 while the broadcast is not
  cancelled. Each move adds to the broadcast's numbers in its own commit.
- Only contacts whose chat is open now are made recipients by the audience piece; the sender checks
  again just before each message (AC-9.5, the broadcast lane — ROUTE row R45).
- No channel folder is imported under `broadcast/` (`broadcast-channel-seam.policy.unit.test.ts`).

## Lifecycle

```text
audience piece (R46's task) or her chat opening (R47's hook) ──► waiting + message 1
waiting ──► sent · skipped · failed · unknown        (the channel's result save → recordMessageResult)
waiting ──► skipped (contact_deleted · contact_excluded · opted_out)   her erasure or pause
waiting ──► skipped (broadcast_cancelled · plan_feature_off)           the end duty's piece (R47)
skipped · owner_chat ──► waiting (same row, once more)                 her next message (R47)
sent ──► replied_at set once, replies + 1                              her first reply (R38)
made + 90 days ──► deleted                                             hourly clean-up (WC-53, R50)
```

## Events

None, and no audit: the owner's send and cancel are audited on the broadcast (BC6).

## Failure modes

- A broadcast whose channel has no sending port throws — the caller's commit rolls back and its job
  retries.
- A `skipped` or `failed` result without a reason throws (a channel's bug); the CHECKs refuse a
  reason on `waiting` / `sent`, a missing one on `skipped` / `failed`, and `sent_at` without `sent`.

## Policy constants

`BROADCAST_AUDIENCE_PIECE_SIZE` (500), `BROADCAST_RECIPIENT_KEEP_DAYS` (90),
`BROADCAST_RECIPIENT_VERSION_MAX` (3) — in `broadcast-recipient.constants.ts`.
