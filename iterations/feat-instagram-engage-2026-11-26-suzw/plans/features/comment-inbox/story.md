# Feature 1 — comment inbox

**As** the team, **I want** to see every comment on our posts and reels with what the automation answered, **so that** we can follow the conversation in public without opening Instagram.

Requirements: `operations.comment-list`, `background.comment-store`, `data.instagram-comment`, `quality.comment-retention`, `quality.tenant-isolation`, `access.tenant-404`.

## Acceptance criteria

- AC-1.1 — A comment that arrives by webhook is stored once (matched by an automation or not), a reply with its parent link; a repeat delivery changes nothing.
- AC-1.2 — Route 175 lists the account's comments newest first within one processing cycle, filters `media_id` and `answered` (`none` · `automation` · `team` · `any`), pages by cursor, and shows the automation's latest public reply beside each.
- AC-1.3 — A hidden comment stays listed with `is_hidden`; a deleted one is gone; parts older than 90 days are dropped by the upkeep.
