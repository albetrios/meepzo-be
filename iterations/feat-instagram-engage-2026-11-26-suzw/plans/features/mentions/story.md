# Feature 3 — mentions and tagged media

**As** the team, **I want** to see where people @mention us or tag us, and to thank them automatically, **so that** we answer user-generated content quickly.

Requirements: `operations.mention-list`, `operations.tagged-media`, `operations.mention-trigger`, `integrations.mentions-webhook`, `background.mention-store`, `data.instagram-mention`, `quality.mention-privacy`, `access.tenant-404`.

## Acceptance criteria

- AC-3.1 — With `mentions` subscribed, a caption mention and a comment mention are each stored once; a failed text read stores the row with `is_text_read: false`.
- AC-3.2 — Route 180 lists the stored mentions newest first and filters `source`; another organization's account is `404`.
- AC-3.3 — Route 181 lists the tagged posts live from Meta; `409 instagram_not_connected` and `503 instagram_unavailable` as the comment writes.
- AC-3.4 — A live `mention` automation starts one run per stored mention of its `sources`, never twice; a comment mention replies privately to that comment; a caption mention without an open 24-hour window ends `no_message_path` and sends nothing.
- AC-3.5 — Mention and comment text never appear in logs.
