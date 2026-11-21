Status: ready
Kind: flow
Depends on: instagram-connection
Route review: [routes-final.md](../../routes-final.md) § 1 — IA8, IA9 (with § 1.10 status moves)
Tables: `app.instagram_accounts`, `app.instagram_account_tokens`

## Stories

- As an Owner or Admin I want the Instagram token renewed before it ends so that automation never stops by surprise.
- As an Owner, Admin or Member I want the account's profile kept fresh so that the Instagram page shows current details.
- As an Owner or Admin I want to be told in the app and by email when Instagram needs a reconnect so that I can fix it quickly.

## Rules

- Once a day, for every connected account, inside its own organization: renew the token when it ends within 7 days; refresh the profile (username, name, picture, counts, bio, website); subscribe the account to events again when it is not subscribed (background.daily-account-check; D9, D24)
- A failed renewal while Instagram is only down or busy, and the token is still valid, keeps the account `connected`, keeps the error, and the next day tries again — seven tries before the token ends (background.daily-account-check; D24)
- Instagram refusing the token makes the account `error` (`expired` when Instagram says it expired); a token past its end becomes `expired` without asking Instagram (background.daily-account-check; D24)
- The check is safe to repeat, and a renewal never overwrites a newer token that a reconnect saved meanwhile (background.daily-account-check, background.organization-scope; D24)
- While Instagram is down the check waits instead of failing every account (integrations.instagram-graph-api; D24)
- An account leaves `connected` only for `expired` or `error` — by the daily check, the post or story picker, or a token error on a send or a follow check (data.instagram-account; D24)
- One notice per break: an in-app notification and an email, in the organization's language, linking to the Instagram page, to every active member who may manage the Instagram account; a reconnect makes the account `connected` again, so a later break is told again (notifications.reconnect-required, background.reconnect-notice; D10, D24)

## Acceptance criteria

- AC-11.1 — The daily check renews the token of a connected account that ends within 7 days and the account shows the new end date; a token ending later is left alone — plans/decisions.md D9
- AC-11.2 — The daily check refreshes the account's username, name, picture, counts, bio and website, and its refresh time — plans/decisions.md D9
- AC-11.3 — An account not subscribed to events is subscribed again by the daily check — plans/decisions.md D24
- AC-11.4 — When Instagram is down or busy and the token is still valid, the account stays `connected`, the error is kept, and the next day's check tries again — plans/decisions.md D24
- AC-11.5 — When Instagram refuses the token the account becomes `error`, or `expired` when Instagram says it expired; a token past its end becomes `expired` without a call to Instagram — plans/decisions.md D24
- AC-11.6 — Running the daily check twice in one day changes nothing more, and a renewal never replaces a newer token saved by a reconnect — plans/decisions.md D24
- AC-11.7 — When the account leaves `connected` — by the daily check, a picker or a send — every active member holding `instagram-account:manage` gets one in-app notification and one email, in the organization's language, linking to the Instagram page — plans/decisions.md D10
- AC-11.8 — More token errors on an account that is already broken send no new notice; after a reconnect, a new break is told again — plans/decisions.md D24
- AC-11.9 — Members without `instagram-account:manage` get no notice — plans/decisions.md D10
- AC-11.10 — Reconnecting an `expired` or `error` account makes it `connected` again — intake-files/schema-routes.md:454

## Work items

- background.daily-account-check
- background.reconnect-notice
- notifications.reconnect-required
