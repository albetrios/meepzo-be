# Feature 2 — account insights (Meta)

**As** an owner who granted `instagram_manage_insights`, **I want** to see Meta's reach, views, profile taps and followers beside our numbers, **so that** I see the whole picture in one place.

Requirements: `insights.account`, `access.insights-capability`, `background.insight-snapshot`, `data.instagram-insight-snapshot`, `quality.reads-never-call-meta`, `quality.meta-usage`.

## Acceptance criteria

- AC-2.1 — The daily job stores one account snapshot after the organization's day ends; Meta down leaves a gap, never a call on screen open.
- AC-2.2 — Route 185 shows the latest snapshot and the series; without the permission it answers empty with `insights_status: permission_not_granted`, and route 153 names the permission with fix `reconnect`.
