# Quality requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: audit, privacy, retention, limits, idempotency, performance and scale expectations, safe deploys
and restores.

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids MC…, WH…, SN…, AU…, K… are in
[routes-final.md](../routes-final.md); S… are findings of the
[scale review](../reviews/scale-review-2026-11-24.md); RC-… are rows of
[route-changes.md](../route-changes.md), WC-… rows of [worker-changes.md](../worker-changes.md); `plan:L…`
points into `../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch built
(`iterations/launch-2026-11-20-ujai/plans/requirements/quality.md` and its AS-BUILT) or the platform today.

## Data kept and private

### `quality.retention` — CHANGED

How long each kind of row is kept (product rules, not settings): webhook events and their keys 8 days, their
body cleared once handled; send attempts 8 days; messages about 30 days (dropped by week of the run's
start, so "What happened" and "retry failed" read about the last 30 days); runs and their history 90 days
after the run ends — 90 days or a little more, never sooner; comment logs 90 days; tag events 8 days;
broadcast recipients and the stop history 90 days; month counts 13 months; deleted automations purged once
nothing points at them; deleted broadcasts and segments purged after 90 days; old sessions and trusted
devices 30 days after they expired or were revoked; contacts until the owner deletes them, Meta asks, or the
organization goes. A run waits at most 7 days. Everything an organization holds goes with it. The clean-ups
keep up hourly (`background.retention-hourly-budget`) and a late one alerts
(`background.retention-oldest-row-gauge`).

**Sources:** D13, D15, D16, D50, D51, P13, P33, P75, P92, P96 · routes-final K16 · plan:L4124–L4220 ·
[db-changes "How long rows stay"](../db-changes.md#overview) · BRIEF AC-8

### `quality.message-privacy` — CHANGED

A contact's personal data — email, phone, name, username, picture, the owner's note and the text of her
comments and our messages — is shown only to people who may see contacts, never written to logs, and erased
when the team deletes her (with her waiting messages, tag events and recipient rows). Her own free text is
never kept on a run; "What happened" never shows the email or phone values. A webhook event's body is
cleared once handled, and events older than 8 days are refused as replays.

**Sources:** D15, D46, P13 · routes-final K7, § 3 CT4, CT11, CT14, § 5 WH6, WH22 · plan:L7181–L7375

### `quality.token-secrecy` — CHANGED

The channel connection's token is stored encrypted, readable only in its organization's own context and only
on the Meta client's path, sent only in the authorization header with the app-secret proof, and never shown
in any answer; the daily check re-encrypts a token still on an old key. A disconnect of the connection's last
account erases it.

**Sources:** D24, P41, P97 (S26) · routes-final K7, K10, § 1 MC9 · plan:L4236–L4251, plan:L7181–L7375

### `quality.audit` — CHANGED

Every change people make is written to the audit log after commit in the form
`<domain>.<resource>.<verb>` — new entries for the connection (connect, reconnect, disconnect), the channel
account (pause, resume, activate, disconnect), automations (go live, pause, duplicate), messages (retry),
contacts (note, tags, bulk, pause), broadcasts, segments, plan changes, cards and sign-in.

**Sources:** routes-final K9, § 1 MC12, § 1B CA10, § 10 AT4

## Requests

### `quality.idempotency` — CHANGED

Every signed-in `POST` that creates a row or starts background work requires `X-Idempotency-Key`; the same
key gets the first answer and a missing or reused key is refused. State switches (go live, pause, resume)
answer a repeat with the same state and take none; a `POST` that saves nothing (the keyword test) and the
login and reconnect starts take none; Meta's public routes take none — Meta's own ids make them safe to
repeat. The platform routes keep their as-built set; the key is forwarded to Stripe on subscription changes.

**Sources:** P89 · routes-final K3 · route-changes Access note

### `quality.error-reasons` — CHANGED

Every refusal carries a stable reason, one name across sub-domains — `plan_lacks_feature`,
`plan_account_limit`, `channel_account_not_found`, `message_month_limit_reached`, `trial_used_by_account`,
`team_organization_required`, and the feature check's four reasons with their statuses (`422`, `409`, `403`,
`422`). Go-live answers every problem at once (`409 automation_not_ready` with its list); sign-in errors add
the tries left and the seconds to wait.

**Sources:** P61, P68 · routes-final K2, K14, § 10 AT2, AT3

### `quality.method-status-exception` — NEW

Success stays `200` (`DELETE` `204`) everywhere, with one named exception: Apple's form callback answers
`303`, listed in one allowlist read by the method-status middleware and the success-status gate and pinned by
a test.

**Sources:** P85 · routes-final K2, § 10.B AT10

### `quality.rate-limit` — CHANGED

Meta's webhook keeps its per-IP cap for unsigned traffic, but validly signed deliveries are not counted
against it, so a viral post is never throttled; the webhook gets its own pool slice or service and the UI
sheds first under load.

**Sources:** P97 (S9, S10) · routes-final § 5

### `quality.read-only-plan` — CHANGED

While a plan has ended, the owner may still read everything, pause and delete automations, and disconnect
accounts; only going live and turning a PRO part on are refused.

**Sources:** P10 (A10) · routes-final § 4 AU4 · plan:L2066

### `quality.no-plan-limits` — REMOVED

The launch had no plan limits; plans now limit accounts, messages a month and PRO features
(`billing.plan-channel-accounts-max`, `billing.plan-message-month-limit`, `billing.plan-pro-features`).

**Sources:** D26, D34, D35

### `quality.reply-safety` — REMOVED

The launch's account-level public reply safety (chance, hour limit, gap, counted from comment logs) goes;
pacing is per automation (`operations.automation-public-reply-per-automation`).

**Sources:** D14, D32

## Sending safety

### `quality.restore-never-sends` — NEW

A restored or copied database can never send: sending needs the deployment's `SENDING_ENABLED` switch,
held outside the database, and the server's environment id must equal the one in the database (written once
when missing, never overwritten), read at start and every minute — a mismatch stops that server's sending and
alerts the team.

**Sources:** D20, P4 · routes-final § 6 SN7 · plan:L7047–L7115 · BRIEF AC-9

### `quality.sending-settings` — NEW

Every number of the engine lives in one app-domain settings file (no secrets), the owner's values in the
account settings (empty = the file's value), plan values in the plan row; environment-varying values are env
vars with production-safe defaults. `SENDING_ENABLED` defaults to off in the schema and is on in
`.env.example`, so a developer's machine sends and a deploy sends nothing until it is set.

**Sources:** D22, P4, P74 · routes-final K12, § 6 SN7 · plan:L6189–L6869

### `quality.rolling-deploy` — NEW

Servers restart one at a time and finish their sends on the way (30 s). Each release writes a minimum
compatible settings version, raised only by a release that is actually incompatible: a server older than it
takes no send tickets; an older but compatible one does, so a rollback keeps sending. The rollback step and
how the host rolls several replicas are written down.

**Sources:** D21, P95 · routes-final § 6 SN7 · plan:L6943–L7045

### `quality.lock-order` — NEW

Every intake path takes its locks in one order — contact → automation → runs — so two intake jobs on one
contact never deadlock; a test races two intake jobs on one contact.

**Sources:** P47 (F5) · routes-final § 5 WH26 · plan:L6095–L6185

### `quality.redis-notes` — NEW

Redis holds tickets, quick counts, short notes and short copies only — never something Postgres does not
have, never the last check, never called inside a Postgres transaction. Copies follow the read-cache rules
(organization-scoped keys, tombstone after commit, at most 60 s); the login state is a one-use Redis nonce;
the Meta usage copy is keyed by connection, Postgres first.

**Sources:** P5, P26, P32, P51 · routes-final § 6 SN11 · plan:L4302–L4342

### `quality.sending-health` — NEW

Each server's health check adds Postgres, the ticket Redis, the last repair round, the oldest late ticket and
unhandled event, parts ready ahead, the clock against Postgres, the settings version and the last token-check
round; an outside checker calls it every minute and alerts by a second channel. Watch numbers — tap-to-answer
time, `unknown` share, accounts in a stop, failed events, pool wait, Meta usage, month-count drift, repair
round time and backlog — alert the team, and owner-facing ones the owner.

**Sources:** P94 · plan:L7117–L7179

## Capacity

### `quality.capacity` — NEW

Built for 1,000 accounts (20–200 now): the plan's sizing is the estimate; there is no load test this
iteration.

**Sources:** plan:L7377–L7494, plan:L290–L305

### `quality.connection-budget` — NEW

The send, intake and task work share an in-process database limiter (about 16–24 places a process; a unit
that waits over 2 s for one goes back to wait its turn), and the connection budget counts that limiter, not
job places. The send work has its own concurrency settings with their own maximum and runs as its own
service, so the API's and workers' pools are sized apart; the arithmetic for now and for 1,000 accounts is
written into the resource-limits doc.

**Sources:** P91 · routes-final K8, K16, § 6 SN24 · [worker-changes note 12](../worker-changes.md#notes-and-open-questions)

### `quality.worker-places` — NEW

Places per server start at 5 intake, 40 fast and 40 slow (20 / 100 / 50 at 1,000 accounts), within the
limiter's database slots; an Instagram outage never pauses intake.

**Sources:** P47 (F3), P91 · plan:L4346–L4480

### `quality.database-links` — NEW

Postgres on Neon: the app uses Neon's pooler link; migrations and partition upkeep use the direct link under
their own roles; no pooler of our own. Neon's pooler limits for the plan's compute range are written down and
first-byte latency per transaction measured and alerted; the Neon set-up runbook itself is ops, not code.

**Sources:** D2, P97 (S2) · plan:L6871–L6941

### `quality.scale-defaults` — NEW

The scale review's "decide at kickoff" findings are built as its Fix column says, and any difference goes
into `AS-BUILT.md`: S2, S5–S11, S13, S14, S17–S21, S25, S26, S29 (their data in `data.kickoff-defaults`,
their background work in `background.scale-defaults`); `REDIS_BULLMQ_URL` is required when sending is on and
the ticket Redis is sized for peak delayed jobs (S18).

**Sources:** P97 · routes-final "Kickoff defaults from the scale review"

## Close

### `quality.gates` — NEW

The iteration closes only when every decision D1–D73 holds in the built code or has an accepted `AS-BUILT.md`
deviation, the repository's gates are green, the pre-merge review is run, and `plans/acceptance.md` is filled
with each item's evidence.

**Sources:** plan:L8527–L8531 · BRIEF AC-1

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `quality.retention` | webhook events 30 days; runs, run events and comment logs 180 days; deleted automations 180 days; clean-ups once a day | events and keys 8 days, attempts 8 days, messages about 30 days, runs and logs 90 days, tag events 8 days, recipients 90 days; hourly clean-ups with a gauge | D15, D16, D50, P92, P96 |
| `quality.message-privacy` | personal data masked in logs and the events list; events kept 30 days, masked | + note and message text; her free text never kept; event body cleared when handled; 8-day replay guard | D15, D46 |
| `quality.token-secrecy` | an encrypted Instagram Login token per account, the app role may select the encrypted row | one encrypted token per connection, read only on the Meta client's path, re-encrypted on an old key | D24, P41, S26 |
| `quality.audit` | connect, settings, disconnect, automation create / edit / delete, contact delete | + connection, channel account, go live, pause, duplicate, retry, contact changes, broadcasts, segments, plans, cards, sign-in | K9 |
| `quality.idempotency` | the key required on connect and automation create only | required on every signed-in `POST` that creates a row or starts background work | P89 |
| `quality.error-reasons` | stable reasons per route; go-live not a separate action | one shared reason list; the feature check's four reasons; go-live lists every problem; sign-in tries left | P61, P68 |
| `quality.rate-limit` | 1,200 a minute per IP on every webhook delivery | signed deliveries not counted; the webhook's own pool slice | S9, S10 |
| `quality.read-only-plan` | read-only refuses automation create, edit and delete | the owner may pause, delete and disconnect; only go-live and turning PRO on are refused | P10 |
| `quality.no-plan-limits` | no plan limits automations, contacts or events | removed — accounts, messages and PRO limited by plan | D26, D34, D35 |
| `quality.reply-safety` | account-level public reply safety | removed — pacing per automation | D14, D32 |
