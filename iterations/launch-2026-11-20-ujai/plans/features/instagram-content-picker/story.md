Status: ready
Kind: screen
Depends on: instagram-connection
Route review: [routes-final.md](../../routes-final.md) § 1.C — IA16, IA17
Tables: `app.instagram_media` (stored posts — written by the comment and "next post" flows; the pickers read Instagram live), `app.instagram_accounts`

## Stories

- As an Owner, Admin or Member I want to pick one of our posts or reels when I build a comment automation so that it answers that post only.
- As an Owner, Admin or Member I want to pick one of our live stories when I build a story-reply automation so that it answers replies to that story.
- As an Owner, Admin or Member I want to be told when the account needs a reconnect, or when Instagram is busy, so that I know why the picker shows nothing.

## Rules

- Both pickers read the account's content live from Instagram, a page at a time (up to 50, default 25), following Instagram's own next page; they store nothing and show no total (operations.browse-media, operations.browse-stories)
- A post shows its type, caption, links, publish time, comment and like counts, and the items of a carousel (operations.browse-media)
- A story shows when it ends: 24 hours after it was published (operations.browse-stories)
- No account → `instagram_not_connected`; an `expired` or `error` account, or a token Instagram refuses, → `instagram_reconnect_required`, and a refused token takes the account out of `connected` (operations.browse-media, operations.browse-stories; D10)
- Instagram down or throttling → `instagram_unavailable` with a retry time (integrations.instagram-graph-api)
- A post is stored only when a comment arrives on it or a "next post" automation links to it; it belongs to one Instagram account and stays until the organization is deleted or Meta's data deletion erases it (data.instagram-media; D8, D24)
- Members may browse; it is team-only (access.team-only; D2)

## Acceptance criteria

- AC-3.1 — The post picker lists the account's posts and reels from Instagram with type, product type, caption, media and thumbnail links, permalink, publish time, comment and like counts, and carousel items — intake-files/schema-routes.md:475
- AC-3.2 — Both pickers take a page size of 1–50 (default 25) and Instagram's cursor; `has_more` and `next` follow Instagram's next page, and no total is given — intake-files/schema-routes.md:480
- AC-3.3 — The story picker lists the stories live now, each with an end time 24 hours after it was published — intake-files/schema-routes.md:263
- AC-3.4 — With no account, or only a revoked one, both pickers answer `instagram_not_connected` — intake-files/schema-routes.md:487
- AC-3.5 — With an `expired` or `error` account, or when Instagram refuses the token, both pickers answer `instagram_reconnect_required`; a refused token moves the account to `expired` or `error` — intake-files/schema-routes.md:488
- AC-3.6 — When Instagram is down or throttling, both pickers answer `instagram_unavailable` with a retry time — intake-files/schema-routes.md:489
- AC-3.7 — Browsing never adds or changes a stored post — intake-files/schema-routes.md:784
- AC-3.8 — Stored posts belong to one Instagram account: after the organization switches to another account, the first account's stored posts stay its own and never mix with the new account's — plans/decisions.md D24

## Work items

- data.instagram-media
- operations.browse-media
- operations.browse-stories
