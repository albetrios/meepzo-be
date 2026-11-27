`src/domains/app/sub-domains/instagram-conversation/instagram-conversation-note/`

# Instagram conversation note

Parent: [Instagram conversation](../instagram-conversation.overview.md)

## Purpose

The team's internal notes on a conversation (feat-instagram-inbox routes-final § 2.C.3, CV3):
`app.instagram_conversation_notes` — never sent, never shown to the contact. ROUTE row R4 built the table; routes
167–169 follow at R9.

## Layout

- `instagram-conversation-note.schema.ts` — the table: the conversation key (`CASCADE`) and the author's membership
  (kept as history), the live-notes list index, the key indexes, the text check, RLS
- `instagram-conversation-note.constants.ts` — the text cap (2,000)
- `__tests__/unit/` — the table's database suite

## Key invariants

- **Soft delete** (`deleted_at`): the list reads live notes only.
- **The author stays** when the member leaves — a membership is ended, never deleted.
- **RLS:** the organization policy only — nothing reads notes across organizations.
