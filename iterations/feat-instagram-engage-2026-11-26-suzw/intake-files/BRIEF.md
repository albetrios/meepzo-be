# Brief — the team moderates Instagram comments and @mentions from Meepzo

## What changes

- A **comment inbox**: every comment on the account's posts and reels in one list (newest first), beside the
  conversations inbox of `feat-instagram-inbox` — filter by post, by "not answered", by "automation answered".
- From the comment inbox a team member can **reply publicly**, **hide / unhide**, and **delete** a comment
  (Meta's `/{comment-id}/replies`, `hide`, `DELETE /{comment-id}`); today only automations reply and hide.
- **@mentions**: the account's mentions in other people's captions and comments arrive by webhook
  (`mentions`) and show as a "Mentions" list; a mention can start an automation (mention → DM).
- **Tagged media**: posts the account is tagged in (`/{ig-user-id}/tags`) listed beside mentions.

## Why

Brands answer comments by hand in Instagram's app today and lose track of which were answered by an
automation. One list in Meepzo, with the automation's answer shown beside each comment, saves the
switching and lets the team clean spam. Mentions are user-generated content the brand wants to thank or
repost, and a natural trigger for a DM.

## Affected screens, entities and routes

- Screens: comments inbox (new), mentions & tags list (new), automation editor (one more trigger: mention)
- Entities: `app.instagram_comments` (new — stored comments, from webhooks and reads), `app.instagram_mentions`
  (new), existing `app.instagram_media`, `app.automation_comment_logs`, contacts
- Routes: new under `/app/social/instagram/accounts/{channel_account_id}/comments…` and `…/mentions`; Meta's
  webhook route unchanged (new field `mentions` handled by intake)

## Rules

- Permissions: read with `instagram-account:read`; reply / hide / delete with a new `instagram-comment:manage`
  (Owner, Admin, Editor).
- Every write goes through the sending gate and Meta usage like automations do; a deleted comment is soft-gone
  in our table.
- All new tables `instagram_` prefixed, FORCE RLS by organization, Meta ids bounded by the shared
  `INSTAGRAM_ID_*` rules (C-D16).
- Mentions need the `mentions` webhook field subscribed (the set-up's field list grows); the mention text is
  stored, the media's owner is never contacted without an automation.
- Comment retention follows the run / comment-log retention already in place.

## Acceptance criteria

- [ ] A comment that arrives by webhook shows in the comment inbox within one processing cycle, with the
      automation's answer (if any) beside it.
- [ ] A team member with `instagram-comment:manage` can reply, hide, unhide and delete; a viewer cannot (403).
- [ ] A mention arrives by webhook, is listed, and can start a "mention" automation.
- [ ] Tagged media lists the account's tagged posts from Meta, read live.
- [ ] Another organization's comment or mention is 404.

## Out of scope

Liking posts or comments (`instagram_manage_engagement` — a new permission and Meta review), Facebook Page
comments, comment insights (→ `feat-instagram-insights`).
