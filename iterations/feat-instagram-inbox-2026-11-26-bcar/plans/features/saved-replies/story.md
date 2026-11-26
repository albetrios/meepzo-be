# Feature 4 — saved replies

**As** a team member, **I want** reusable answers with the contact's name filled in, **so that** I answer common questions in one click.

Requirements: `saved-reply.crud`, `saved-reply.use`, `data.saved-replies`.

## Acceptance criteria

- AC-4.1 — Routes 170–174 add, list, read, change and delete; a title taken (any case) is `409 saved_reply_title_taken`; the cap is `409 resource_limit_reached`.
- AC-4.2 — Route 165 with `saved_reply_id` fills `{first_name}` / `{username}` and counts the use; another organization's reply is `404`.
