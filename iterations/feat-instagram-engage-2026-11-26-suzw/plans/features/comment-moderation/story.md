# Feature 2 — comment moderation

**As** a team member with `instagram-comment:manage`, **I want** to reply, hide, unhide and delete comments from our app, **so that** we handle questions and clean spam in one place.

Requirements: `operations.comment-moderation`, `access.comment-moderation`, `quality.comment-writes-paced`, `data.comment-delete`, `access.tenant-404`.

## Acceptance criteria

- AC-2.1 — Route 176 sends a public reply through Meta, then shows `reply_state: team`, `replied_at`, `replied_by_user_id`; an empty or too-long text is `400`.
- AC-2.2 — Routes 177 / 178 hide and unhide through Meta; a repeat in the same state is `200` and calls nothing new.
- AC-2.3 — Route 179 deletes through Meta and soft-deletes our row; a comment Meta already deleted is marked deleted (`204`).
- AC-2.4 — A viewer gets `403` on 176–179; another organization's comment is `404 instagram_comment_not_found`.
- AC-2.5 — Meta down or throttled is `503 instagram_unavailable`, a broken connection `409 instagram_not_connected`; neither changes our row.
