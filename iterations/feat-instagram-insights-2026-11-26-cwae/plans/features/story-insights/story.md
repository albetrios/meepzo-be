# Feature 4 — story insights

**As** an owner, **I want** to keep a story's final numbers after it disappears, **so that** I can compare stories later.

Requirements: `insights.story`, `integrations.story-insights-webhook`, `data.instagram-story-insight`.

## Acceptance criteria

- AC-4.1 — With `story_insights` subscribed, a story's final numbers are stored once (a repeat updates the row) and route 188 lists them newest first after the story ended.
