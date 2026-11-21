Status: ready
Kind: flow
Depends on: comment-automation-flow
Route review: [routes-final.md](../../routes-final.md) § 3.A — AU9, AU15 (with § 3.2 AQ4), § 3.B — AU16
Tables: `app.automations`, `app.instagram_media`

## Stories

- As an Owner, Admin or Member I want a "next post" automation to attach itself to the first post I publish inside its window so that I can prepare the automation before the post exists.
- As an Owner, Admin or Member I want a "next post" window that passes with no post to expire so that the automation stops waiting.

## Rules

- A comment on a post published inside the window of a live, waiting "next post" automation of the same Instagram account links that automation to the post — status `linked`, the post and the link time — unless an automation of that account had already targeted that post (background.next-post-linking; D26)
- Every such automation links, so two may link one post; the comment rule then lets the older one answer (background.next-post-linking; D26)
- Linking runs before the comment is matched, so a just-linked automation counts as linked to the post for that same comment; an inactive draft never links (background.next-post-linking; D26)
- A failed link is logged and never stops the comment from being matched (background.next-post-linking; D18)
- A linked post is stored the first time (data.instagram-media)
- A link and a save of a "next post" automation never cross: they take turns inside one organization (background.next-post-linking; D26)
- A window that ends with nothing linked becomes `expired` within 15 minutes; doing it again changes nothing; a `waiting` or `expired` automation answers no comment; changing an expired one's window puts it back to `waiting` (background.next-post-expiry; D9)
- A post published just before the end whose first comment comes after the expiry does not link — accepted for launch (background.next-post-expiry; D26)
- Nobody is told; the list shows the new status on refresh (D11)

## Acceptance criteria

- AC-10.1 — The first comment on a post published inside a live, waiting "next post" window links that automation: its status becomes `linked`, with the post and the link time — intake-files/schema-routes.md:536
- AC-10.2 — The just-linked automation counts as linked to the post when that same comment is matched — plans/decisions.md D26
- AC-10.3 — A post that an automation of the account targeted before (set to it, or linked earlier) is never taken by a waiting "next post" automation — intake-files/schema-routes.md:536
- AC-10.4 — Two waiting automations whose windows hold the post both link to it; for a comment both match, the older one answers — plans/decisions.md D26
- AC-10.5 — Only the post's own account's live automations link; an inactive draft or another account's automation never links — plans/decisions.md D26
- AC-10.6 — When linking fails, the comment is still matched and answered — intake-files/PRD.md:92
- AC-10.7 — A "next post" automation that is still `waiting` or is `expired` answers no comment — intake-files/PRD.md:93
- AC-10.8 — Within 15 minutes after a window ends with nothing linked, the automation becomes `expired`; a second check changes nothing, and a linked one is never expired — plans/decisions.md D9
- AC-10.9 — A linked post is stored once, the first time — intake-files/schema-routes.md:784

## Work items

- background.next-post-linking
- background.next-post-expiry
