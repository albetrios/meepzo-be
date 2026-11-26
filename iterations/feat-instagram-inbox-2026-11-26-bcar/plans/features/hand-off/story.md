# Feature 3 — hand-off

**As** a team member, **I want** the bot to step aside while a person talks, **so that** a bot never answers over a person.

Requirements: `conversation.take-release`, `hand-off.hold`, `hand-off.idle-release`, `hand-off.instagram-app-takeover`.

## Acceptance criteria

- AC-3.1 — While a conversation is taken, every automation DM to that contact on that account waits (`conversation_taken`) and is sent after release.
- AC-3.2 — Release, close, or 24 hours without a team message ends the hold; 23 hours does not.
- AC-3.3 — An echo our app did not send takes the conversation as `instagram_app`; an echo of a team reply does not.
- AC-3.4 — Taking a conversation another member holds is `409 instagram_conversation_taken`; replying to an unassigned one assigns it.
