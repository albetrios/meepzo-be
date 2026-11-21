Status: ready
Kind: screen
Depends on: app-permissions
Route review: [routes-final.md](../../routes-final.md) § 1.A, § 1.B, § 1.D (with § 1.1 IA4–IA7, IA10; rules K1, K3, K5, K7, K10)
Tables: `app.instagram_accounts`, `app.instagram_account_settings`, `app.instagram_account_tokens`, `app.instagram_media` (erased by Meta's data deletion)

## Stories

- As an Owner or Admin I want to connect our Instagram professional account to the team so that automations can answer its comments and messages.
- As an Owner, Admin or Member I want to see the connected account, its status and its settings so that I know whether automation works and whether the account needs a reconnect.
- As an Owner or Admin I want to switch all automation off and tune public reply safety so that I control how the account behaves.
- As an Owner or Admin I want to disconnect the account so that the team can stop automation or connect another account.
- As Meta I want to tell the app that the account's owner removed it, or asked for their data to be deleted, so that the account is disconnected and the owner's data is erased.
- As an Owner I want the Instagram token kept secret inside the Instagram connection so that nobody can take over the account through our app.

## Rules

- All the new Instagram, contact and automation data lives in one new app area and belongs to one organization (data.app-domain, data.organization-scope; D1)
- An organization holds at most one account that is not revoked, and an Instagram account belongs to at most one organization at a time (data.instagram-account; D5)
- Connecting swaps Instagram's one-time code for a long-lived token of about 60 days and reads the account's profile (integrations.instagram-login, operations.connect-instagram)
- Connect refuses, and stores nothing, when: the code is expired, used or for another address; the Instagram account is personal, not professional; a needed permission was left unticked on Instagram's consent screen; this organization has another live account; this account is live in another organization (operations.connect-instagram, quality.error-reasons; D24)
- Connecting an account this organization had before — revoked included — reuses it: its settings come back and the answer says it is not a new connection (data.instagram-account; D24)
- Connect needs an idempotency key; a repeat with the same key replays the first answer (quality.idempotency)
- After a connect the account is subscribed to Instagram's comment, message and button-click events; a failed subscription never fails the connect, and the next connect or the daily check tries again (integrations.webhook-subscription; D24)
- A first connect creates the settings with the defaults: automation on, public reply safety off, an 80 % reply chance, 60 replies an hour, a gap of 20 to 60 seconds (data.instagram-account-settings)
- The account read shows the profile, the status (`connected`, `expired` or `error`), when the token ends, whether events are subscribed, and the settings — never the token; a revoked account is never shown (operations.read-instagram-account; D5)
- A settings change takes at least one field: the chance 0–100, the hour limit 1–1000, both gaps 5–3600 seconds with the minimum not above the maximum; it works while the account is `expired` or `error`, and a save based on older settings is refused (operations.change-account-settings; D5, D24)
- Disconnect: the account becomes `revoked`, its token is erased, its settings and profile stay, and the organization may connect another account; no run is cancelled and automations stay `live` — nothing runs while no account is connected, a waiting run goes on if the same account reconnects, else the 7-day wait limit ends it (operations.disconnect-instagram; D5, D24)
- Meta's deauthorize request disconnects the account in every organization that holds it; Meta's data-deletion request does the same and also erases the account's profile and stored posts, revoked records included, and answers a confirmation code with a status link; contacts are never touched (operations.meta-deauthorize, operations.meta-data-deletion, data.erasure; D22, D24)
- Meta's two requests come without sign-in and are proved by Meta's signed request; a bad one is refused and changes nothing; a person we never stored still gets a success answer (access.public-meta-routes, integrations.meta-signed-requests; D22)
- The token is stored encrypted and only the Instagram connection reads it; it is never returned, logged or read by another feature (access.token-isolation, data.instagram-account-token; D21)
- A lookup made before the organization is known — "connected elsewhere", Meta's requests, webhook routing — learns only which organization holds the account and reads none of another organization's data (access.cross-organization-lookups; D21)
- Every Instagram call goes through one connection on Graph API v24.0; Instagram down or throttling answers "unavailable, try again later" and stores nothing; missing Instagram app settings answer "not configured" (integrations.instagram-graph-api; D20)
- A read-only plan blocks none of this: connecting, changing the settings and disconnecting stay open (quality.read-only-plan; D27)
- Connect, disconnect, a settings change, Meta's deauthorize and Meta's data deletion each leave an audit entry (quality.audit)
- Logs never hold the token, the app secret or the code (quality.log-masking)

## Acceptance criteria

- AC-2.1 — Connecting with a valid code, in an organization with no account, creates the account `connected` with its default settings and answers that it is a new connection — intake-files/schema-routes.md:453
- AC-2.2 — A first connect's settings are: automation on, public reply safety off, chance 80, hour limit 60, gap 20 to 60 seconds — intake-files/schema-routes.md:753
- AC-2.3 — Connecting the same Instagram account again, also after a disconnect, updates its profile and token, makes it `connected`, keeps its settings and answers that it is not a new connection — intake-files/schema-routes.md:454
- AC-2.4 — After a connect the account shows a token end about 60 days ahead — intake-files/schema-routes.md:450
- AC-2.5 — Connecting another account while this organization has one that is not revoked is refused with `organization_already_has_instagram_account`, and nothing changes — intake-files/schema-routes.md:455
- AC-2.6 — Connecting an Instagram account that is live in another organization is refused with `instagram_account_connected_elsewhere`; the other organization's account is untouched — intake-files/schema-routes.md:456
- AC-2.7 — An expired or used code is refused with `instagram_code_invalid`, and a personal Instagram account with `instagram_account_not_professional`; nothing is stored — intake-files/schema-routes.md:466
- AC-2.8 — A connect where a needed permission was not granted on Instagram's consent screen is refused with `instagram_scopes_missing`; nothing is stored — plans/decisions.md D24
- AC-2.9 — Connect without an idempotency key is refused; repeated with the same key, it returns the first answer and stores nothing new — intake-files/schema-routes.md:77
- AC-2.10 — After a connect the account is subscribed to comments, messages and button clicks; when Instagram refuses the subscription the connect still succeeds and the account read shows it as not subscribed — intake-files/schema-routes.md:457
- AC-2.11 — The account read shows the profile, status, token end, subscription and settings, never the token; with no account, or only a revoked one, it answers `instagram_not_connected` — plans/decisions.md D5
- AC-2.12 — A settings change saves values in range only (chance 0–100, hour limit 1–1000, gaps 5–3600 with the minimum not above the maximum on the result), refuses an empty change, records who changed it, and works on an `expired` or `error` account — intake-files/schema-routes.md:201
- AC-2.13 — A settings change sent with an `expected_updated_at` older than the saved settings is refused with `record_changed` — plans/decisions.md D24
- AC-2.14 — Disconnecting makes the account `revoked`, erases its token, keeps its settings and profile, and the organization can then connect another account — plans/decisions.md D5
- AC-2.15 — A disconnect cancels no run and leaves every automation `live`; a run that was waiting goes on when the same account reconnects — plans/decisions.md D24
- AC-2.16 — Meta's deauthorize request with a valid signed request revokes the account and erases its token in every organization holding it; a person we never stored still gets a success answer; a bad signed request is refused with `instagram_signed_request_invalid` and changes nothing — plans/decisions.md D22
- AC-2.17 — Meta's data-deletion request also erases the account's profile and stored posts (that person's revoked records too), leaves contacts untouched, and answers a confirmation code with a status link; the same request again gives the same code — plans/decisions.md D22
- AC-2.18 — The token is stored encrypted, never appears in any answer or log line, and no feature outside the Instagram connection reads it — intake-files/schema-routes.md:766
- AC-2.19 — The lookups made before the organization is known return only which organization holds the account; a user of another organization never sees this organization's account — plans/decisions.md D21
- AC-2.20 — When Instagram is down or throttling, connect answers `instagram_unavailable` with a retry time and stores nothing; without the Instagram app settings it answers `instagram_not_configured` — intake-files/schema-routes.md:471
- AC-2.21 — Every Instagram call uses Graph API version v24.0 — intake-files/PRD.md:148
- AC-2.22 — Connect, disconnect, a settings change, Meta's deauthorize and Meta's data deletion each leave one audit entry, with neither the token nor the code in it — intake-files/schema-routes.md:458
- AC-2.23 — Every refusal in this feature carries its stable reason and a translated message — intake-files/schema-routes.md:124
- AC-2.24 — No log line holds the token, the app secret or the code — intake-files/PRD.md:176
- AC-2.25 — While the organization's plan is read-only, connecting, changing the settings and disconnecting still work — plans/decisions.md D27

## Work items

- data.app-domain
- data.organization-scope
- data.instagram-account
- data.instagram-account-settings
- data.instagram-account-token
- data.erasure (Meta's data deletion)
- operations.connect-instagram
- operations.read-instagram-account
- operations.change-account-settings
- operations.disconnect-instagram
- operations.meta-deauthorize
- operations.meta-data-deletion
- access.public-meta-routes
- access.token-isolation
- access.cross-organization-lookups
- integrations.instagram-graph-api
- integrations.instagram-login
- integrations.webhook-subscription
- integrations.meta-signed-requests
- quality.audit
- quality.idempotency
- quality.error-reasons
- quality.log-masking
