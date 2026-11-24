Status: draft
Kind: screen
Depends on: channel-accounts
Route review: [routes-final.md](../../routes-final.md) § 2.C — routes 13–14

## Stories

- As an Owner, Admin or Editor I want to pick a post, reel or story of the selected account so that an automation answers only there.
- As any member I want the picker to show what Instagram has now so that I never pick something deleted.

## Rules

- Posts, reels and ad posts are read live with the connection's token, with caption and kind; a missing picture falls back to the thumbnail or the link (operations.instagram-media-pickers)
- Live stories are read for "one story"; a story way to start whose Meta test has not passed is built but refused at go-live (operations.automation-trigger-types, operations.feature-check; P36)
- A post is stored the first time a comment arrives on it, not by listing (data.instagram-media)
- Reads go through the connection's Meta usage check (background.meta-usage-per-connection; P51)
- Reading needs account read access; another organization's or a revoked account is not reachable (access.channel-account-codes; P59)

## Acceptance criteria

- AC-4.1 — The post list answers the account's posts and reels, newest first, each with its caption and kind (post, reel, ad post), read live from Instagram; a missing picture falls back to the thumbnail or the link — plans/routes-final.md route 13
- AC-4.2 — The story list answers the account's live stories for "one story" — plans/routes-final.md route 14
- AC-4.3 — Listing stores nothing; a post row appears only when a comment arrives on it — intake-files/Instagram-DM-Sending-Plan-v8.md:2946
- AC-4.4 — Listing another organization's or a revoked account is refused (not found or not connected) — intake-files/Instagram-DM-Sending-Plan-v8.md:2595
- AC-4.5 — Instagram down or the connection over Meta's usage answers a temporary refusal with a retry time and stores nothing — plans/decisions.md P51
- AC-4.6 — A Viewer can list posts and stories; a story automation whose Meta test has not passed is refused at go-live with `feature_not_offered` — plans/decisions.md P36

## Work items

- operations.instagram-media-pickers
- operations.automation-trigger-types
- data.instagram-media
- background.meta-usage-per-connection
- access.channel-account-codes
