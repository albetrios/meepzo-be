`src/domains/app/sub-domains/instagram-conversation/`

# Instagram conversation

Parent: [App](../../app.overview.md)

## Purpose

The team inbox (feat-instagram-inbox, `iterations/feat-instagram-inbox-2026-11-26-bcar/`, routes-final § 2): one
conversation per contact (`app.instagram_conversations`, 2.A.3) with its state, who holds it — a team member, or
the Instagram app when an echo our app did not send arrives (CV4) — the unread count, the newest message and the
response times. Created lazily by the contact's first message (CV2). ROUTE row R2 built the table; the
conversation messages (2.B, R3), the notes (2.C, R4) and the routes 155–169 (R7–R9) follow.

## Layout

- `instagram-conversation.schema.ts` — `app.instagram_conversations`: the composite keys to the contact
  (`CASCADE`), its account (`RESTRICT`) and the holder's membership; the state / holder / sender checks; the
  list keyset, "mine", unread and idle-release indexes; RLS
- `instagram-conversation.constants.ts` — states, holders, sender types, the preview cap, the 24-hour idle release
- `instagram-conversation-message/` — every message both ways, split by month, kept a year (2.B, ROUTE row R3) —
  [overview](instagram-conversation-message/instagram-conversation-message.overview.md)
- `instagram-conversation-note/` — the team's notes, soft-deleted (2.C, ROUTE row R4) —
  [overview](instagram-conversation-note/instagram-conversation-note.overview.md)
- `__tests__/unit/` — the table's database suite

## Key invariants

- **One per contact** (CV2): unique `(organization_id, contact_id)` — the lazy upsert's target.
- **The holder in step** (CV4): no take time without a holder; the Instagram app never names a member.
- **RLS:** the organization arm plus the maintenance arm (`app.global_retention_cleanup`) in `USING`; `WITH
  CHECK` the organization only (K3).
