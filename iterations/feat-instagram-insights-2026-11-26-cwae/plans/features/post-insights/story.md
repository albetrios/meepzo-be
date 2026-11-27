# Feature 3 — post and reel insights

**As** an owner, **I want** to rank posts by the conversations they started, not only by reach, **so that** I know which posts to automate.

Requirements: `insights.media`, `analytics.media-conversations`, `background.insight-snapshot`, `data.instagram-insight-snapshot`.

## Acceptance criteria

- AC-3.1 — The daily job snapshots the last 30 days' posts and reels plus any with a live automation.
- AC-3.2 — Route 186 ranks by `dms_started`, `reach` or `views` with a keyset; route 187 shows one post's series beside its DMs started, including days older than the runs' 90 days.
