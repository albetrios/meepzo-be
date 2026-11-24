`src/domains/app/sub-domains/broadcast/`

# Broadcast

Parent: [App](../../app.overview.md)

## Purpose

Sending 1 to 3 messages to the contacts of one channel account who match an audience — shared by
every channel (P48; Instagram the only one now) — and the audiences themselves (routes-final § 7 of
the DM-sending iteration, routes 70–82). Built one ROUTE row at a time: the saved segments and the
audience count (7.B, routes 77–82) land with ROUTE row R21; the broadcast at this folder's root
(7.A, `app.broadcasts`, routes 70–76, the start and end duties) with R22 and R47; the recipients
(7.C, `app.broadcast_recipients`) with R23. Sending itself is sub-domain 6's broadcast lane.

## Layout

- `broadcast-segment/` — saved audiences of one account (`app.segments`), the audience builder and
  the audience count — [Broadcast segment](broadcast-segment/broadcast-segment.overview.md)
- the folder root — the broadcast itself (ROUTE row R22)
- `broadcast-recipient/` — who a broadcast goes to (ROUTE row R23)

## Key invariants

- One account each (BC5): a segment and a broadcast name their channel account at create and keep
  it; their conditions read only that account's contacts.
- The automation codes gate every route (P20): `automation:read` · `create` · `update` · `delete`.
- PRO through the plan's switches (BC3, BC19, P76, P83): segment create, edit and the audience count
  need the `segments` switch; broadcast create and send the `broadcasts` switch; reading and
  deleting stay open.
- Soft delete, then purge 90 days later (BC4, P9, P75 — the purge is ROUTE row R50).

## Lifecycle

The broadcast's status machine (draft → scheduled / sending / waiting for chats → done, or
cancelled) is documented here with ROUTE row R22, which builds it.
