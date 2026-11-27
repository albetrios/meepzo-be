`src/domains/app/sub-domains/saved-reply/`

# Saved reply

Parent: [App](../../app.overview.md)

## Purpose

The organization's reusable reply texts (feat-instagram-inbox routes-final § 3, SR1–SR6), shared across channels
(I-D2): `app.saved_replies`. The reply box inserts one, and a send that names one counts its use. ROUTE row R5 built
the table; routes 170–174 and route 165's `saved_reply_id` follow at R10.

## Layout

- `saved-reply.schema.ts` — the table: the organization (`CASCADE`) and the creating / updating users (`SET NULL`);
  one title per organization in any case; the most-used list; the title, text-bytes and use-count checks; RLS
- `saved-reply.constants.ts` — the title (100 characters) and text (1,000 bytes) caps
- `__tests__/unit/` — the table's database suite

## Key invariants

- **Title unique in any case** within the organization (SR3); **hard delete** (SR5) — nothing points at one.
- **Text in bytes** (1–1,000): Meta's limit is in bytes, so a reply that fits is never cut at send.
- **RLS:** the organization policy only.
