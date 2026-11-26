# Feature 5 — notifications

**As** a team member, **I want** to be told of a new DM and of a window about to close, **so that** I answer before the window shuts.

Requirements: `notification.new-message`, `notification.window-closing`.

## Acceptance criteria

- AC-5.1 — A new DM notifies the holder, else every `contact:update` holder, per their in-app and email preference.
- AC-5.2 — A conversation waiting on us with under 2 hours of window left notifies its holder once.
