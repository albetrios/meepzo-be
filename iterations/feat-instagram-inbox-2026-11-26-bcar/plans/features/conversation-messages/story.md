# Feature 2 — the messages

**As** a team member, **I want** every message both ways in order, with who sent it, **so that** I have the whole context before I answer.

Requirements: `message.inbound-once`, `message.outbound-captured`, `message.team-reply-direct`, `message.echo-matched`, `message.edit-unsent`, `message.read-receipts`, `message.reactions`, `message.files-copied`, `message.sender-type-kind`, `data.instagram-conversation-messages`, `data.upload-purpose`.

## Acceptance criteria

- AC-2.1 — Every inbound kind the classifier knows appears once, in Meta's order, with `sender_type: contact` and its `kind`.
- AC-2.2 — Every automation and broadcast send appears with its text, automation or broadcast and status; its echo is not shown twice.
- AC-2.3 — A team reply inside the window is sent directly and stored `sent` with Meta's id; outside the window `409` with `window_ends_at`; a stopped account `409` with `stop_reason`; Meta's usage at the wait percent `429` with `Retry-After`; a reused key replays; it never adds to the month count.
- AC-2.4 — A team reply interrupted before Meta answered is settled by the repair sweep.
- AC-2.5 — An edit replaces the text and marks it edited; an unsent message's text and copied files are gone from the database.
- AC-2.6 — A read receipt sets `seen_at` on our messages up to it.
- AC-2.7 — An inbound file is copied into uploads and served from the copy; until then Meta's link is shown.
- AC-2.8 — Route 166 reacts and unreacts inside the window.
