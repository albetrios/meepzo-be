# DB changes — feat-instagram-engage-2026-11-26-suzw

Mode initial · Intake mode brief · 2026-11-26 · logical types only (the physical design is the route review's, Step 5).

## Overview

```mermaid
erDiagram
  instagram_account["instagram_account · EXISTING · app.instagram_accounts"]
  instagram_media["instagram_media · EXISTING · app.instagram_media"]
  automation_comment_log["automation_comment_log · EXISTING · app.automation_comment_logs"]
  contact["contact · EXISTING · app.contacts"]
  instagram_comment["instagram_comment · NEW · app.instagram_comments"]
  instagram_mention["instagram_mention · NEW · app.instagram_mentions"]
  instagram_account ||--o{ instagram_comment : "ADDED: receives"
  instagram_media ||--o{ instagram_comment : "ADDED: is commented on"
  instagram_comment |o--o{ automation_comment_log : "ADDED: answered by"
  contact |o--o{ instagram_comment : "ADDED: wrote"
  instagram_account ||--o{ instagram_mention : "ADDED: is mentioned in"
```

## Stage 1 — the comment

### instagram_comment

- **Holds** — one row per comment on the account's posts and reels (any automation or none), so the inbox lists them
  in one place; the team's reply, hide and delete state.
- **Table** — `app.instagram_comments` ([E-D5](decisions.md)).
- **Sources** — B:5-8, B:23, B:32-33, B:38, B:42.
- **Added / Replaced** — new; the per-automation comment log stays (E1).
- **Open** — none: every comment ([E-D2](decisions.md)), kept 90 days ([E-D3](decisions.md)).

```mermaid
erDiagram
  instagram_comment["instagram_comment · NEW · app.instagram_comments"] {
    id id PK
    id organization_id FK
    id channel_account_id FK
    id instagram_media_id FK
    text instagram_comment_id
    text parent_comment_id "a reply's parent"
    id contact_id FK
    text commenter_username
    text commenter_instagram_user_id
    text text
    datetime commented_at
    boolean is_hidden
    datetime hidden_at
    datetime deleted_at "soft delete (B:32)"
    choice reply_state "none · automation · team"
    datetime replied_at
    id replied_by_user_id FK
    datetime created_at
  }
```

## Stage 2 — the mention

### instagram_mention

- **Holds** — one row per @mention of the account in someone's caption or comment (B:9).
- **Table** — `app.instagram_mentions` ([E-D5](decisions.md)).
- **Sources** — B:9-10, B:23-24, B:36-37, B:45.
- **Added / Replaced** — new.
- **Open** — Meta's payload under Unified Login (E7, owner test EO1); kept 90 days ([E-D3](decisions.md)); both sources start the `mention` trigger ([E-D4](decisions.md)).

```mermaid
erDiagram
  instagram_mention["instagram_mention · NEW · app.instagram_mentions"] {
    id id PK
    id organization_id FK
    id channel_account_id FK
    choice source "caption · comment"
    text instagram_media_id "the other account's media"
    text instagram_comment_id "when source = comment"
    text mentioned_by_username
    text text
    text permalink
    datetime mentioned_at
    datetime created_at
  }
```

Tagged media (B:11) is read live from Meta — no table.
