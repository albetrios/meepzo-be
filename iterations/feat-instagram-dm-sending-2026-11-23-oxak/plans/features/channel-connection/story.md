Status: draft
Kind: screen
Depends on: plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 1 — routes 1–5, 15–17, 40–42

## Stories

- As an Owner or Admin I want to connect Instagram through Meta's Unified Login with my business portfolio so that the organization can automate its Instagram accounts.
- As an Owner or Admin I want to pick which of the portfolio's assigned accounts join the organization, up to my plan's room, so that I connect only the accounts I pay for.
- As an Owner or Admin I want to see every connection with its status, granted permissions and last daily check so that I know when one needs attention.
- As an Owner or Admin I want to reconnect a connection that stopped working so that waiting DMs go again without losing anything.
- As an Owner or Admin I want to disconnect a whole business portfolio so that all its accounts stop and its token is erased.
- As an Owner, Admin or Editor I want to pick an ad account and then one of its ads so that I can build ad-comment and ad "Send message" automations.
- As Meta I want my deauthorize and data-deletion callbacks honoured for every account and person they reach so that the app stays compliant.

## Rules

- Unified Login is the only login; the launch's Instagram Login, its token table, its renewal job, its scopes and its host are removed and nothing is migrated (integrations.channel-connection-unified-login; D24, P41)
- The login state is one-use, valid 10 minutes, bound to the person and the organization; nothing is lost when it is (integrations.channel-connection-unified-login; P26)
- One connection per organization and business portfolio holds the granted permissions and one encrypted token; the token is of type system user, never expires by itself, has an empty refresh token for Meta, and is never answered, logged, queued or emailed (data.channel-connection-token-refresh, quality.token-secrecy; D25, P49)
- A callback whose token lacks a required permission is refused and saves nothing (integrations.channel-connection-unified-login; D25)
- A pick re-reads the assigned accounts from Meta; it runs under the organization's lock and is refused over the plan's `channel_accounts_max`; an account live in another organization is refused for that account only (operations.channel-account-connect-multi, billing.plan-channel-accounts-max; D26, P55, P60)
- A new account gets its default settings and its four lanes in the pick's commit; the account set-up (profile read, six webhook fields) runs after the commit (background.account-setup; D25)
- The daily token check runs once per connection; a "token not valid" answer sets the connection and every account of it to error, stops their lanes and tells the organization once (background.token-check; D25, P17)
- A reconnect is its own action; the same portfolio reuses the connection, only an account whose Instagram id matches an existing row of the organization returns to connected, and an account that moved to another portfolio moves to the new connection at the callback (integrations.channel-connection-unified-login; P54, P58)
- Disconnecting a business disconnects every account of it as a one-account disconnect would, and erases the token (operations.channel-account; P41)
- Meta's deauthorize and data-deletion callbacks are signed, belong to the connection, and match the provider account id first, else every account of the business id; an unmatched id still gets its confirmation code and the team an email (integrations.channel-connection-meta-callbacks; P46, P56)
- Ad accounts and ads are read live through the connection, never stored, one ad account at a time (operations.channel-connection-ad-picker; P52, P57)
- Meta's usage is kept per connection: at 80 % calls slow, at 95 % they wait the time Meta gives (background.meta-usage-per-connection; P51, P97)
- Owner and Admin manage connections; Editor and Viewer only read them (`channel-account:read` / `channel-account:manage`) (access.channel-account-codes; P59)
- The callback and the pick need an idempotency key; start and reconnect do not (quality.idempotency; P89)
- Every callback, pick, reconnect, disconnect and Meta callback leaves one audit entry (quality.audit)

## Acceptance criteria

- AC-1.1 — Starting a connect answers a Meta login address with a one-use state; a callback with a missing, used, expired, or another person's or organization's state is refused with `meta_connect_state_invalid` and nothing is saved — intake-files/Instagram-DM-Sending-Plan-v8.md:4571
- AC-1.2 — A callback whose token lacks one of the required permissions is refused and nothing is saved — intake-files/Instagram-DM-Sending-Plan-v8.md:4574
- AC-1.3 — A good callback stores one connection for the business portfolio with its granted permissions and an encrypted token, and answers the assigned accounts, each marked free, already connected here, or connected in another organization, with the plan's room — intake-files/Instagram-DM-Sending-Plan-v8.md:4578
- AC-1.4 — Picking more accounts than the plan's room is refused with `plan_account_limit` and nothing is saved; two picks at the same moment in one organization never both pass — intake-files/Instagram-DM-Sending-Plan-v8.md:4597
- AC-1.5 — An account live in another organization is refused for that account only, with `instagram_account_connected_elsewhere`; the other picks connect — plans/decisions.md P60
- AC-1.6 — An account no longer assigned to the portfolio at pick time is refused `not_assigned` — plans/decisions.md P55
- AC-1.7 — A newly picked account has default settings and four ready lanes in the same commit; after the commit its six webhook fields are subscribed, and a failed subscription still leaves it connected and shown as not subscribed — intake-files/Instagram-DM-Sending-Plan-v8.md:4600
- AC-1.8 — Reconnecting a portfolio puts the connection back to connected with the new token, clears the login stops of its accounts and wakes their lanes; another Instagram account never takes an old account row — intake-files/Instagram-DM-Sending-Plan-v8.md:4677
- AC-1.9 — An account that moved to another portfolio of the same organization is moved to the new connection at the callback, keeping its automations, contacts and history — plans/decisions.md P54
- AC-1.10 — Disconnecting a business revokes each of its accounts, stops their lanes and erases the token; their automations, contacts and history stay — intake-files/Instagram-DM-Sending-Plan-v8.md:2623
- AC-1.11 — A validly signed deauthorize revokes the matched accounts (the Instagram account id first, else every account of the business id) and erases the token where no account still uses it; an unmatched id still gets its confirmation code and the team an email; a badly signed one is refused — plans/decisions.md P56
- AC-1.12 — A data-deletion request erases the matched accounts' data and answers a stable confirmation code; repeating it is harmless and answers the same code — intake-files/Instagram-DM-Sending-Plan-v8.md:4695
- AC-1.13 — The ad picker lists the connection's ad accounts, then the ads of one ad account at a time, read live and never stored; a list without an ad account is refused — plans/decisions.md P57
- AC-1.14 — The daily token check marks a connection whose token Meta refuses as `error`, every account of it `error`, stops all their lanes and gives each account one reconnect notice; Meta down or "too fast" changes nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:4654
- AC-1.15 — An Editor or a Viewer can list and read connections and is refused start, callback, pick, reconnect and disconnect with `missing_permission` — plans/decisions.md P59
- AC-1.16 — Callback and pick without an idempotency key are refused; repeated with the same key they answer the first result and change nothing twice — plans/decisions.md P89
- AC-1.17 — No Instagram Login route, table, job, scope or host remains in the code — intake-files/BRIEF.md:69
- AC-1.18 — The token never appears in an answer, a log line, a job payload or an email — intake-files/Instagram-DM-Sending-Plan-v8.md:4658
- AC-1.19 — A connection read at 95 % of Meta's usage makes the next call of every channel on that connection wait the time Meta gave; at 80 % calls slow — plans/decisions.md P51

## Work items

- integrations.channel-connection-unified-login
- integrations.channel-connection-meta-callbacks
- operations.channel-connection-ad-picker
- operations.channel-account-connect-multi
- data.channel-common-core
- data.channel-connection-token-refresh
- background.account-setup
- background.token-check
- background.meta-usage-per-connection
- billing.plan-channel-accounts-max
- access.channel-account-codes
- quality.token-secrecy
- quality.idempotency
- quality.audit
- background.daily-account-check
- data.app-migrations-in-place
- data.channel-connection
- data.connection-states
- data.instagram-account-token
- integrations.instagram-login
- integrations.meta-graph-client
- operations.channel-connection-list
