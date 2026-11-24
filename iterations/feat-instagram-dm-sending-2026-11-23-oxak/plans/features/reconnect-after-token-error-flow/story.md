Status: draft
Kind: flow
Depends on: channel-connection, channel-accounts, instagram-sending-engine, organization-usage-and-notices
Route review: [routes-final.md](../../routes-final.md) § 1 (reconnect, route 40), § 6 (stops); worker-changes WC-34, WC-46, WC-57

## Stories

- As an Owner whose Meta connection stopped working I want to be told at once and to fix it with one Reconnect so that my waiting DMs go again.

## Rules

- A "token not valid" answer — from the daily check or from any send — sets the connection and every account on it to `error` and stops their lanes at once, never waiting for the daily check (background.token-check, background.instagram-error-stops; plan §25.8)
- Each account gets one reconnect notice and email per break (background.reconnect-notice, notifications.owner-emails)
- An account moved to another portfolio, or switched to a personal account, is `error` on its own (background.token-check; plan §25.9)
- Waiting messages stay waiting and expire by the 7-day rule (operations.instagram-message-expiry)
- Reconnect clears the login stops of the matching accounts and wakes their lanes spread over 5 minutes; the account set-up runs again (integrations.channel-connection-unified-login, background.account-setup; P58)
- `error` is fixed by a reconnect; `revoked` only by a new connect (integrations.channel-connection-unified-login)

## Acceptance criteria

- AC-25.1 — The app removed from the business portfolio: the next send gets the token error, the connection and all its accounts become `error`, all their lanes stop, and other connections' accounts keep sending — intake-files/Instagram-DM-Sending-Plan-v8.md:4666
- AC-25.2 — Each affected account gets one "Your Meta connection stopped working … Press Reconnect" banner, notice and email, not one per failed message — intake-files/Instagram-DM-Sending-Plan-v8.md:2538
- AC-25.3 — An account moved to another portfolio becomes `error` alone; its sister accounts on the old connection keep sending — intake-files/Instagram-DM-Sending-Plan-v8.md:4667
- AC-25.4 — While in `error`, waiting messages stay waiting; one whose 7 days end becomes `expired` — intake-files/Instagram-DM-Sending-Plan-v8.md:7296
- AC-25.5 — Reconnect with the same portfolio puts the connection and its accounts back to `connected`, ends their login stops, subscribes the webhooks again and the waiting DMs go, spread over 5 minutes — intake-files/Instagram-DM-Sending-Plan-v8.md:4680
- AC-25.6 — Reconnecting from the portfolio an account moved to moves that account to the new connection and it sends again — plans/decisions.md P54
- AC-25.7 — A revoked account is not brought back by a reconnect — intake-files/Instagram-DM-Sending-Plan-v8.md:4672

## Work items

- integrations.channel-connection-unified-login
- background.token-check
- background.instagram-error-stops
- background.reconnect-notice
- background.account-setup
- operations.instagram-message-expiry
- notifications.owner-emails
- notifications.reconnect-required
