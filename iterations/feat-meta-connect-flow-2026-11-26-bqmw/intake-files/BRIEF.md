# Brief — every Meta connect outcome, from the login to a working account, shaped for Facebook Pages later

## What changes

Today's connect (routes 1–5, 40–42, channel-account routes 6–11) handles the happy path and a few refusals. This
iteration makes **every** outcome of a Meta Unified Login explicit, recoverable from the frontend, and readable
again after a page reload — and shapes the contract so a second channel on the same login (Facebook Pages)
is an addition, not a rewrite.

Screens (no designer drop — named by purpose):

- **Connect start** — "Connect Instagram", "Add more accounts", "Connect another business portfolio" and
  "Reconnect" all start the same Meta login with a fresh one-use state; the screen knows beforehand whether
  connecting is possible (Meta configured, role allows it, plan room left) and whether the Page login is offered.
- **Login return** — one answer that says which outcome happened (below) and what the user can do next.
- **Account picker** — the accounts the login shared, each with its pick state; can be reopened later without a
  new Meta login; picks under the plan limit.
- **Connections and accounts** — every connection (one per business portfolio) with its accounts, statuses,
  and what each account can and cannot do and why (permission, plan, Meta setting, Meta test).
- **Fix-it prompts** — reconnect, grant a missing permission, turn on "Allow access to messages", share the
  account's Page, convert to a professional account, upgrade the plan.

## Why

A connect that half-works is the most expensive support ticket: the user sees "connected" but DMs never arrive,
or sees a bare error. The frontend needs the outcome, the reason and the next step for each case, and needs to
read the account's permissions and capabilities at any time — not only in the callback's answer.

## Affected screens, entities and routes

- Screens: connect start, login return, account picker, connections and accounts, fix-it prompts (above)
- Entities: channel connection (`app.channel_connections`), its token, channel account (`app.channel_accounts`),
  Instagram account, the capability list (`CHANNEL_CAPABILITIES`)
- Routes: `POST /app/social/channel-connections/{provider}/start` (1), `…/{provider}/callback` (2),
  `…/{channel_connection_id}/accounts` (3), `GET …/channel-connections` (4), `GET …/{channel_connection_id}`,
  `DELETE …/{channel_connection_id}` (5), `…/{channel_connection_id}/reconnect` (40), `…/ad-accounts` (41),
  `GET/DELETE /app/social/channel-accounts[/{channel_account_id}]` and `activate` / `pause` / `resume` (6–11);
  new read routes as the plan decides

## Rules

Outcomes the plan must cover (each: what is saved, what the frontend gets, the next step):

1. The person cancels or closes the Meta dialog (`error=access_denied` comes back) — the state is spent, nothing saved.
2. The state is missing, used, expired, or another person's or organization's — refused, nothing saved (today's AC-1.1).
3. A **required** permission is not granted — nothing saved; the answer names which permissions are missing so the
   screen can ask for exactly those (today: a bare 422).
4. An **optional** permission is not granted (`ads_read`, `instagram_manage_insights`, `instagram_content_publish`,
   later `pages_*`) — the connect succeeds; the capabilities that need it show `permission_not_granted` with the
   permission name, per account.
5. The permission read itself cannot tell (see fix iteration F-D3) — the plan decides the answer.
6. The login shares **no Instagram account** (review C5) — nothing saved, outcome `no_accounts_shared` with how to
   share one (business portfolio settings), never a connection holding a token and no account.
7. Accounts are shared, the person **picks none** or closes the picker — the connection stays `connected` with no
   account; the picker can be reopened from the connections screen; a connection with no account for a set time
   has its token deleted and is revoked (the plan sets the time).
8. A picked account is live in **another organization** — `connected_elsewhere` (today), with what to do.
9. Picks over the **plan limit** — refused as a whole today (`409 plan_account_limit`); the plan decides whether
   to keep that or connect up to the limit, and the answer carries the plan room.
10. An account this organization had **revoked** — brought back, settings kept (today).
11. The **same portfolio** logs in again ("add more accounts") — same connection, newly shared accounts appear in
    the picker; accounts no longer shared are marked as such, never silently deleted.
12. A **second portfolio** — a second connection; the two never share accounts.
13. **Reconnect** logs into a different portfolio than the bound connection — refused (today's 409), with the expected
    business named.
14. An account that is **not professional**, or a personal account — not in Meta's list; the login-return screen
    explains how to convert it.
15. "Allow access to messages" is **off** — the account connects, its message capabilities say why they are off
    and how to turn it on; re-checked on demand.
16. An account shared **without its linked Page** (no `messages` webhooks) — today's `with_page` login; the account
    says so and offers it.
17. The token dies (Meta code 190, the app removed from the portfolio, the account moved) — connection and accounts
    `error`, reconnect offered (today); a dated token warns before its end.
18. Meta down or busy during the callback — the code is spent; the answer says "try again", nothing half-saved.
19. Roles — only `channel-account:manage` starts, finishes, picks, reconnects or disconnects; `channel-account:read`
    reads everything listed here.

Pages-ready: one Meta login (connection) can bring in **several channels** of assets. The contract the frontend
reads must name the channel of each asset (`instagram` today, `facebook_page` later) so a Page arrives as one more
channel account type, one more capability block and one more webhook object — with no change to the routes above.
Build Instagram only.

Stored facts the frontend needs (gaps found in the schema-v3 mapping — today they are logged or not read):

- **Message access** — the "Allow access to messages" check's result (`on`, `off`, `unknown`) and when it ran, kept on
  the Instagram account (today the set-up job only logs it), re-checked on demand, read by outcome 15.
- **Linked Facebook Page** — the account's linked Page id from the profile read, kept on the Instagram account: it
  detects outcome 16 (shared without its Page) and is the join a Page channel account uses later.
- **Permissions per account** — `/debug_token`'s `granular_scopes` (each permission with the asset ids it covers)
  kept per channel account, so a capability answers for that account, not for the whole connection. ⚠️ depends on
  the fix iteration's owner test O1 (that this token type answers `granular_scopes`); until then the connection's
  scopes stand for every account.

Frontend reads (the plan names the routes): what the login shared (re-read from Meta, with each asset's pick state)
for a connection at any time; each account's permissions and capability states with the blocking reason; the
connect-start preconditions.

## Acceptance criteria

- [ ] Each of the 19 outcomes has one documented answer (status, reason, body) and a test.
- [ ] A required-permission refusal names the missing permissions; nothing is saved.
- [ ] A login that shares no Instagram account saves nothing and answers `no_accounts_shared`.
- [ ] The picker's list can be read again for a connection without a new Meta login, with each account's pick state.
- [ ] A connection left with no account past the set time loses its token and is revoked by a background job.
- [ ] Each account's capabilities answer allowed or the first blocking reason (permission with its name, plan,
      Meta setting, Meta test) on a read route.
- [ ] An account's message access (with its check time) and linked Page id are stored and readable; a re-check updates them.
- [ ] With per-account permissions available, a capability of one account can be blocked while another account of the
      same connection is allowed.
- [ ] Every asset in the frontend contract carries its channel; adding `facebook_page` needs no route change (checked
      against a written Pages sketch in the plan).
- [ ] `docs/routes.txt`, OpenAPI, `plans/frontend-route-map.md` and the i18n keys move with every route change.

## Out of scope

Building the Facebook Page channel (its webhooks, Messenger sending, Page tokens), WhatsApp, ads management beyond
today's read-only ad picker, the frontend screens themselves (meepzo-fe plans them from this iteration's route map),
and the review fixes F1–F4 (`fix-meta-unified-login-2026-11-26-ceuy`).
