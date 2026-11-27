`src/domains/app/sub-domains/instagram-conversation/instagram-conversation-message/`

# Instagram conversation message

Parent: [Instagram conversation](../instagram-conversation.overview.md)

## Purpose

Every message of a conversation, both ways (feat-instagram-inbox routes-final § 2.B.3, I-D14):
`app.instagram_conversation_messages` — the contact's, an automation's, a broadcast's, a team member's and the
Instagram app's, with its kind, text, files, reply and reaction links and a team reply's send status. ROUTE row R3
built the table; the intake write, the result save's copy and routes 164–166 follow at R8.

## Layout

- `instagram-conversation-message.schema.ts` — the table, split by month of `sent_at`: the conversation key
  (`CASCADE`) and the sending member; copies of the account, contact, automation, run, broadcast and ledger ids; the
  thread keyset, once-per-Meta-id, stuck-`sending` and key indexes; the checks; RLS
- `instagram-conversation-message.constants.ts` — kinds, send statuses, the text and file caps, the 365-day keep
- `__tests__/unit/` — the table's database suite

## Key invariants

- **Split by month, kept a year** (I-D5): the shared partition upkeep (`app.fn_manage_time_partitions`, the eighth
  time-split table) makes the parts ahead and drops one 365 days after its month.
- **One writer per source** (K1); Meta's ids are opaque and bounded, with no format check (C-D16); text never reaches
  a log (K2).
- **Team replies only** carry a send status and a sending member (CV5).
