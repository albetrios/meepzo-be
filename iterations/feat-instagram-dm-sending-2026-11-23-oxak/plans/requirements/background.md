# Background requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: the rules every piece of background work follows — timing, order, retries, scope, stops. The list
of background work itself — what each piece does, when it runs, what it touches, what happens on failure and
who is told — is [worker-changes.md](../worker-changes.md) (WC-1–WC-67); each rule below links the rows it
governs instead of repeating them. The ids in that file's Requirement column (`background.chat-event-intake`,
`background.slow-lane-send`, …) name its rows and are each defined below under **The background work, one
requirement per row**; the rules here are what those rows obey.

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids MC…, WH…, SN…, AU…, K… are in
[routes-final.md](../routes-final.md); `plan:L…` points into
`../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch built
(`iterations/launch-2026-11-20-ujai/AS-BUILT.md`, Standing deviations, and its `plans/requirements/background.md`).
Kept from the launch unchanged: background work is pull-based, registered in the worker registry, runs one
organization (or account) at a time inside that organization's scope with its id in the job, and is safe to
run twice.

## Rules for all background work

### `background.instagram-owned-work` — NEW

The webhook intake, the four sending lanes, the repair duties and the clean-ups are Instagram's own; a
later channel brings its own. The one common piece is the daily token check, which belongs to the channel
connection. Jobs around sending (account set-up, starter questions, file uploads, bulk tags, month wake,
plan changes, segment counts, broadcast audiences, past comments, retry) never send a DM.

**Sources:** D3, P45, P47 · routes-final K8, § 6 SN2 · [WC-1–WC-67](../worker-changes.md#background-work)

### `background.channel-send-interface` — NEW

The shared run engine and broadcasts never send: they hand every message to the account's channel through
one interface — save a waiting message — and take the result back at one entry point each. The channel's
sending sub-domain alone sends.

**Sources:** P48 · routes-final K15, AU35, SN22, BC18 · [WC-1–WC-8](../worker-changes.md#background-work)

### `background.never-waits` — NEW

No piece of background work waits or keeps a timer inside itself: every wait — a message's delay, a lane's
next turn, a nudge, a retry — is a delayed ticket, and what waits is held in Postgres.

**Sources:** plan:L290–L305 (version-7 rules) · routes-final K8 · [WC-5–WC-8](../worker-changes.md#background-work)

### `background.never-send-twice` — CHANGED

Each message goes out at most once: it is claimed on its own row in the commit that marks it `sending`, the
result is saved through one shared save retried inside the send, and an outcome we cannot know becomes
`unknown` — never sent again by itself (`operations.automation-unknown-outcome`). A stuck send is settled by
its lease, never resent.

**Sources:** D17, D18, P32 · routes-final § 6 SN4, AU25 · [WC-5–WC-8, WC-14](../worker-changes.md#background-work)

### `background.retry-policy` — CHANGED

A database error tries again without using a try; a deadlock retries 3 times; after 5 failed tries an
event is `failed` and tried again every hour while under 7 days. Provider calls retry on their own schedule
(1, 5, 15, 60 minutes for set-up work). Nothing is ever lost to a retry limit while it can still be sent.

**Sources:** D19 · routes-final § 5 WH21 · [WC-1, WC-12, WC-30](../worker-changes.md#background-work)

### `background.per-account-order` — CHANGED

One account's events are handled by kind, in passes of 25: chat events and Live comments first, comments
behind them, past comments and flooded accounts lowest; one event's writes are one commit. A person's order
is kept by her contact lock, not by one in-order job per account, so a viral post never slows other
accounts or her own taps.

**Sources:** P47, P97 (S11) · routes-final § 5 WH5, WH11, WH12 · [WC-1–WC-4](../worker-changes.md#background-work)

### `background.account-stops` — NEW

Every lane reads the account's owner pause, team suspend and plan stop from its channel account, and the
organization's suspended status: `plan_limit` holds the slow, fast and broadcast lanes while the reply lane
goes on; `plan_ended` and `plan_downgrade` hold all four. A lane's own Instagram error stop stays on the
lane.

**Sources:** D62, P42, P99, TN5 · routes-final § 1B CA3 · [WC-5–WC-8, WC-37, WC-38, WC-56, WC-59](../worker-changes.md#background-work)

### `background.times` — NEW

Times are UTC unless a rule names the organization's time zone: the month starts at 00:00 on the 1st, the
weekly summary on Monday 09:00, and the once-key day in that zone.

**Sources:** D34 · [WC-37, WC-58](../worker-changes.md#background-work)

### `background.scale-defaults` — NEW

The scale review's background defaults are built at kickoff as its Fix column says: the new-contact profile
read as a low-priority task and several comment-intake passes per account (S11); the tasks split into
Meta-calling and database-heavy, capped per organization (S19); one tag-intake piece per 500 contacts (S20);
a per-organization cap on fast sends in flight (S21); no `queued` mark after the webhook's save (S25); the
token check re-encrypting a token on an old key (S26); the waiting estimate stored by its run (S29).

**Sources:** P97 · [worker-changes note 14](../worker-changes.md#notes-and-open-questions)

## Intake and sending

### `background.intake` — CHANGED

Intake only decides and saves: it turns each saved event into runs and waiting messages and never sends. It
is never paused by a provider outage — only its own Meta call (a new contact's profile) checks the circuit.
Every intake path takes its locks in one order, contact → automation → runs, tested with two intake jobs
racing on one contact. Our own echoes are found by a Postgres lookup (an early echo matched within 10
minutes) and the flood guard (over 20 of her messages a minute) is counted in Postgres.

**Sources:** P47 (F3, F5), P62, P63 · routes-final § 5 WH25–WH27 · [WC-1–WC-4](../worker-changes.md#background-work)

### `background.sending-lanes` — NEW

Each account has four lanes: slow (opening DMs as private replies, one at a time), reply (public replies and
hides, one at a time), fast (every other DM, Live private replies, nudges, "mark as seen", many at once) and
broadcast (one at a time, lowest priority), on three shared send queues plus a task queue — never a queue per
account.

**Sources:** D3, D4, P43, P45 · routes-final § 6 SN2, SN12 · [WC-5–WC-8](../worker-changes.md#background-work) · BRIEF AC-4

### `background.opening-turn` — NEW

A slow-lane turn sends one opening DM at its box second, picking new and old comments 4 : 1 (3 : 2 when one
has under 12 hours left), re-checking everything just before it sends.

**Sources:** D5–D7 · [WC-5](../worker-changes.md#background-work) · plan:L5177–L5272

### `background.reply-turn` — NEW

A reply-lane turn posts a public reply or hide only after the DM to that comment went, by the automation's
pacing.

**Sources:** D32, D33 · [WC-6](../worker-changes.md#background-work) · plan:L5333–L5413

### `background.fast-messages` — NEW

A fast message goes when its not-before time comes, up to 20 at once per account and one per person at a
time, her window checked before each.

**Sources:** D11, D29 · [WC-7](../worker-changes.md#background-work) · plan:L5415–L5636

### `background.send-gates` — NEW

Before a send: a quick Redis count asked outside any transaction, then the Postgres minute count raised in
the commit that marks the message `sending`, and the organization's month count in that same commit. Redis is
never the last check and never called inside a transaction; a lost Redis is rebuilt from Postgres.

**Sources:** D18, D34 · routes-final § 6 SN3, SN10 · [WC-5–WC-8, WC-20, WC-21](../worker-changes.md#background-work) · BRIEF AC-6

### `background.instagram-error-stops` — NEW

An Instagram error stops only what it is about — the account's lane, the account, or every account on an
app-level limit — and sending starts again by itself when the stop ends; half speed for 1 hour after "too
fast", 24 hours after a block. A stop error never fails the message.

**Sources:** D19 · routes-final § 6 SN5 · [WC-5–WC-8, WC-22](../worker-changes.md#background-work) · BRIEF AC-4

### `background.meta-usage-per-connection` — NEW

Meta's usage numbers are read after every call and kept on the channel connection (Postgres, with a short
Redis copy); every lane and read checks it before a call — at 80 % it slows, at 95 % it waits the time Meta
gives or 15 minutes. No lane keeps its own usage.

**Sources:** P51, P97 (S13) · routes-final § 1 MC19, § 6 SN23 · [WC-6, WC-26, WC-41](../worker-changes.md#background-work)

### `background.missed-comment-check` — NEW

Watched posts are read for missed comments every 30 minutes, skipped at 80 % Meta usage; after an outage a
full pass keeps the normal limits (7 days, 25 posts), runs one per account at the lowest priority and stops
at 60 % usage.

**Sources:** P51, P93 · [WC-26](../worker-changes.md#background-work)

### `background.attachment-upload` — NEW

A message file is uploaded to Meta once per account and Meta's id kept; only a confirmed file that passed
the type and content checks.

**Sources:** D29, P25, P34 · routes-final § 6.C SN20 · [WC-32](../worker-changes.md#background-work)

### `background.account-setup` — NEW

A connected or reconnected account is set up at Meta after its commit — six webhook fields subscribed,
starter questions set, message access probed — and again whenever the 10-minute subscription check finds a
field off.

**Sources:** D25 · [WC-25, WC-30](../worker-changes.md#background-work)

### `background.token-check` — CHANGED

Each connection's token and account list are checked once every 24 hours, spread over the day; a refused
token breaks the connection and every account on it (lanes stopped, the reconnect notice); each Instagram
profile is refreshed in the same pass; nothing renews a token.

**Sources:** D24, D25, P17, P47 · routes-final § 1 MC10, MC11 · [WC-34](../worker-changes.md#background-work)

## The repair duties (the plan's every-minute helper)

### `background.helper-one-run-per-duty` — NEW

The every-minute repair runs on the existing scheduler with one scheduled run per duty, all in parallel,
each working until a 40 s budget is spent and re-adding lost tickets in bulk, with its round time and backlog
measured; there are no shared helper slots.

**Sources:** P7, P73, P94 · routes-final § 6 SN6 · [WC-13–WC-15, WC-17–WC-20, WC-28, WC-29, WC-37, WC-56, WC-57, WC-67](../worker-changes.md#background-work)

### `background.helper-never-sends` — NEW

A repair duty never sends a message: it adds turns, settles stuck sends to `unknown`, expires, skips or
cancels waiting rows and keeps the counts right.

**Sources:** plan:L6042–L6093 · [WC-12–WC-20](../worker-changes.md#background-work)

### `background.helper-cross-organization-reads` — NEW

A duty that looks across organizations reads ids only, then changes each organization inside its own scope;
it is safe to skip a round (the next one catches up) and safe to run twice.

**Sources:** routes-final K8, § 6 SN6 · [WC-13–WC-20, WC-45, WC-67](../worker-changes.md#background-work)

### `background.helper-per-server-duties` — NEW

Two duties are each server's own and run in every server process: the clock check against Postgres (over 2
s apart, that server takes no send turns) and the "Redis lost" rebuild.

**Sources:** P73 · routes-final § 6 SN6, SN10 · [WC-21, WC-23](../worker-changes.md#background-work)

### `background.helper-open-run-key-repair` — NEW

Every piece of work that starts a run writes its open-run key in that commit and every one that ends a run
deletes it in that commit; a repair duty only removes keys whose run has ended, never one whose run is open.

**Sources:** P100 · routes-final § 4.B AU37 · [WC-2, WC-3, WC-45, WC-67](../worker-changes.md#background-work)

## Clean-ups

### `background.retention-hourly-budget` — CHANGED

Every clean-up runs hourly: a batch-delete one until a time budget (about 10 minutes) is spent, capped per
table at the plan's rows a day × 2.

**Sources:** P92 · routes-final K16 · [WC-47, WC-53, WC-54, WC-62, WC-64](../worker-changes.md#background-work)

### `background.retention-drop-parts` — CHANGED

A split table is cleaned by dropping whole parts past their keep time, with a short lock timeout, retried the
next hour — never by deleting rows.

**Sources:** P33, P96 · [WC-48–WC-52, WC-55](../worker-changes.md#background-work)

### `background.retention-oldest-row-gauge` — NEW

Each cleaned table has a gauge "oldest row past its keep time" that alerts the team after 1 day.

**Sources:** P92 · [WC-47–WC-54, WC-62, WC-64](../worker-changes.md#background-work)

### `background.partition-upkeep` — NEW

Parts of the seven split tables are made at least 14 days ahead (alert below 7) and each split table has an
explicit default part whose any row alerts; the upkeep runs under its own maintenance scope through one
function only the maintenance login may run, never the migration login.

**Sources:** P33, P96, P97 (S17) · routes-final § 5 WH19 · [WC-55](../worker-changes.md#background-work)

## The background work, one requirement per row

Each piece of background work in [worker-changes.md](../worker-changes.md) has its own requirement here, under the
id in that file's Requirement column; what it does, when it runs, what it touches and who is told stay in that row.

### `background.chat-event-intake` — CHANGED

The background work WC-1 in [worker-changes.md](../worker-changes.md#background-work): intake of chat events. Before → after below.

### `background.comment-intake` — CHANGED

The background work WC-2 in [worker-changes.md](../worker-changes.md#background-work): intake of comments and ad comments. Before → after below.

### `background.live-comment-intake` — NEW

The background work WC-3 in [worker-changes.md](../worker-changes.md#background-work): intake of Live comments.

### `background.tag-event-intake` — NEW

The background work WC-4 in [worker-changes.md](../worker-changes.md#background-work): intake of tag events.

### `background.slow-lane-send` — NEW

The background work WC-5 in [worker-changes.md](../worker-changes.md#background-work): slow-lane turn: send the next opening DM of an account's slow lane.

### `background.reply-lane-send` — NEW

The background work WC-6 in [worker-changes.md](../worker-changes.md#background-work): reply-lane turn: post the next public reply or hide of an account.

### `background.fast-message-send` — NEW

The background work WC-7 in [worker-changes.md](../worker-changes.md#background-work): fast messages: send each message after the opening.

### `background.broadcast-lane-send` — NEW

The background work WC-8 in [worker-changes.md](../worker-changes.md#background-work): broadcast-lane turn: send the next broadcast message of an account (PRO).

### `background.stuck-event-pickup` — CHANGED

The background work WC-12 in [worker-changes.md](../worker-changes.md#background-work): pick up stuck events. Before → after below.

### `background.lost-turn-repair` — NEW

The background work WC-13 in [worker-changes.md](../worker-changes.md#background-work): put back lost send turns.

### `background.stuck-send-settle` — NEW

The background work WC-14 in [worker-changes.md](../worker-changes.md#background-work): settle stuck sends.

### `background.message-expiry` — NEW

The background work WC-15 in [worker-changes.md](../worker-changes.md#background-work): expire waiting messages past their 7 days.

### `background.live-check` — NEW

The background work WC-16 in [worker-changes.md](../worker-changes.md#background-work): check whether a Live is still on.

### `background.window-closed-skip` — NEW

The background work WC-17 in [worker-changes.md](../worker-changes.md#background-work): skip messages whose chat window closed.

### `background.reply-backlog-trim` — NEW

The background work WC-18 in [worker-changes.md](../worker-changes.md#background-work): trim too many waiting public replies.

### `background.paused-automation-cancel` — NEW

The background work WC-19 in [worker-changes.md](../worker-changes.md#background-work): cancel the waiting messages of an automation paused with Cancel.

### `background.send-count-upkeep` — NEW

The background work WC-20 in [worker-changes.md](../worker-changes.md#background-work): keep the send counts right.

### `background.send-count-rebuild` — NEW

The background work WC-21 in [worker-changes.md](../worker-changes.md#background-work): rebuild after Redis was lost.

### `background.outage-check` — NEW

The background work WC-22 in [worker-changes.md](../worker-changes.md#background-work): check for an Instagram outage and the app limit.

### `background.clock-check` — NEW

The background work WC-23 in [worker-changes.md](../worker-changes.md#background-work): check the server clock against Postgres.

### `background.waiting-estimate` — NEW

The background work WC-24 in [worker-changes.md](../worker-changes.md#background-work): work out the "will go / may expire" estimate.

### `background.webhook-subscription-check` — NEW

The background work WC-25 in [worker-changes.md](../worker-changes.md#background-work): check each connected account's webhook subscription.

### `background.tag-event-pickup` — NEW

The background work WC-27 in [worker-changes.md](../worker-changes.md#background-work): start tag events that were not started.

### `background.scheduled-broadcast-start` — NEW

The background work WC-28 in [worker-changes.md](../worker-changes.md#background-work): start broadcasts at their set time.

### `background.broadcast-end` — NEW

The background work WC-29 in [worker-changes.md](../worker-changes.md#background-work): end broadcasts.

### `background.starter-question-sync` — NEW

The background work WC-31 in [worker-changes.md](../worker-changes.md#background-work): sync an account's starter questions.

### `background.bulk-tag` — NEW

The background work WC-36 in [worker-changes.md](../worker-changes.md#background-work): change many contacts at once.

### `background.month-wake` — NEW

The background work WC-37 in [worker-changes.md](../worker-changes.md#background-work): wake an organization at the new month or after an upgrade.

### `background.plan-change` — NEW

The background work WC-38 in [worker-changes.md](../worker-changes.md#background-work): apply a plan change at the end of the billing period.

### `background.segment-count` — NEW

The background work WC-39 in [worker-changes.md](../worker-changes.md#background-work): count a segment's audience.

### `background.broadcast-audience` — NEW

The background work WC-40 in [worker-changes.md](../worker-changes.md#background-work): build a broadcast's audience.

### `background.past-comments` — NEW

The background work WC-41 in [worker-changes.md](../worker-changes.md#background-work): read an automation's past comments.

### `background.retry-failed` — NEW

The background work WC-42 in [worker-changes.md](../worker-changes.md#background-work): retry the owner's failed messages.

### `background.next-post-linking` — CHANGED

The background work WC-43 in [worker-changes.md](../worker-changes.md#background-work): link a "my next post" automation to the first post after go-live. Before → after below.

### `background.waiting-run-cancel` — CHANGED

The background work WC-45 in [worker-changes.md](../worker-changes.md#background-work): cancel a run that has waited 7 days. Before → after below.

### `background.reconnect-notice` — CHANGED

The background work WC-46 in [worker-changes.md](../worker-changes.md#background-work): tell the organization that an account must be reconnected. Before → after below.

### `background.deleted-automation-purge` — CHANGED

The background work WC-47 in [worker-changes.md](../worker-changes.md#background-work): remove a deleted automation for good. Before → after below.

### `background.webhook-event-retention` — CHANGED

The background work WC-48 in [worker-changes.md](../worker-changes.md#background-work): delete webhook events and their event keys older than 8 days. Before → after below.

### `background.send-attempt-retention` — NEW

The background work WC-49 in [worker-changes.md](../worker-changes.md#background-work): delete send attempts older than 8 days.

### `background.message-retention` — NEW

The background work WC-50 in [worker-changes.md](../worker-changes.md#background-work): delete messages older than 30 days.

### `background.run-retention` — CHANGED

The background work WC-51 in [worker-changes.md](../worker-changes.md#background-work): delete ended runs and their history 90 days after they ended. Before → after below.

### `background.comment-log-retention` — CHANGED

The background work WC-52 in [worker-changes.md](../worker-changes.md#background-work): delete comment logs older than 90 days. Before → after below.

### `background.broadcast-recipient-retention` — NEW

The background work WC-53 in [worker-changes.md](../worker-changes.md#background-work): delete broadcast recipients and stop history older than 90 days.

### `background.small-table-retention` — NEW

The background work WC-54 in [worker-changes.md](../worker-changes.md#background-work): delete tag events older than 8 days and month counts older than 13 months.

### `background.month-limit-notice` — NEW

The background work WC-56 in [worker-changes.md](../worker-changes.md#background-work): tell the organization at 80 % and 100 % of its DMs this month.

### `background.owner-problem-email` — NEW

The background work WC-57 in [worker-changes.md](../worker-changes.md#background-work): email the owners about account problems.

### `background.weekly-summary` — NEW

The background work WC-58 in [worker-changes.md](../worker-changes.md#background-work): send the weekly summary.

### `background.plan-state-check` — NEW

The background work WC-59 in [worker-changes.md](../worker-changes.md#background-work): check plan states.

### `background.broadcast-segment-purge` — NEW

The background work WC-62 in [worker-changes.md](../worker-changes.md#background-work): purge deleted broadcasts and segments for good.

### `background.contact-details-notice` — NEW

The background work WC-63 in [worker-changes.md](../worker-changes.md#background-work): send the grouped "new contact details" note.

### `background.session-cleanup` — CHANGED

The background work WC-64 in [worker-changes.md](../worker-changes.md#background-work): delete old sessions — and now trusted devices. Before → after below.

### `background.seat-sync` — CHANGED

The background work WC-65 in [worker-changes.md](../worker-changes.md#background-work): seat sync switched off. Before → after below.

### `background.open-run-key-repair` — NEW

The background work WC-67 in [worker-changes.md](../worker-changes.md#background-work): remove open-run keys whose run has ended.
## Removed

### `background.message-sends` — REMOVED

The launch's event processing sent each run's messages inline with a fixed 200–1,000 ms pause; intake now
only decides, and the lanes send.

**Sources:** D3 · [WC-9](../worker-changes.md#background-work)

### `background.daily-account-check` — REMOVED

The launch's daily account check renewed Instagram Login tokens; the system-user token never expires, so
renewal goes and the connection's token check takes over.

**Sources:** D24 · [WC-34, WC-35](../worker-changes.md#background-work)

### `background.next-post-expiry` — REMOVED

The launch's 15-minute expiry of "next post" windows goes: "my next post" never expires.

**Sources:** P12 · [WC-44](../worker-changes.md#background-work)

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `background.never-send-twice` | each send claimed on the run; an unknown outcome fails the step | claimed on the message row; one shared result save retried inside the send; `unknown` never resent by itself; a lease settles stuck sends | D17, P32 |
| `background.retry-policy` | 5 tries from 5 s, then the event and its running runs `failed` for good | database errors use no try, deadlocks retry 3 times; a `failed` event retried hourly while under 7 days | D19, WH21 |
| `background.per-account-order` | one in-order job per account for every kind, paused by an Instagram outage | passes by kind and priority; her order kept by the contact lock; never paused by an outage | P47, WH11 |
| `background.intake` | event processing decided and sent; echoes skipped; paused on the open Instagram circuit | decides and saves only; never paused (F3); one lock order (F5); own echoes and floods found in Postgres | P47, P62, P63 |
| `background.token-check` | daily per account at 04:00 UTC: renew the token, refresh the profile, retry the subscription | per connection every 24 h, spread; check token and accounts, refresh profiles; subscription moved to its own check; no renewal | D24, P17, P47 |
| `background.retention-hourly-budget` | each clean-up once a day at a fixed UTC time, 250,000 rows a run | hourly within a time budget, capped per table | P92 |
| `background.retention-drop-parts` | batch deletes on plain tables | split tables drop whole parts | P33, P96 |
| `background.message-sends` | sends inline from event processing | removed — the four lanes send (WC-5–WC-8) | D3 |
| `background.daily-account-check` | daily token renewal and profile refresh per account | removed — the connection's token check (WC-34) | D24 |
| `background.next-post-expiry` | a 15-minute timer expired ended "next post" windows | removed — "my next post" never expires | P12 |
| `background.chat-event-intake` | one in-order job per account for every kind, paused by an Instagram outage; it also sent | its own first-priority pass, 25 events at a time, never paused; decides and saves only | P47, P48, P50 |
| `background.comment-intake` | in the account's one in-order run with every other kind; sent inline | its own pass behind chat events; once per person per post; replaces her open run and swaps its key in one commit; never sends | P35, P48, P100 |
| `background.stuck-event-pickup` | every minute, an event stuck 5 minutes; 5 tries then `failed` for good | stuck after 1 minute; a `failed` event tried again hourly while under 7 days | plan:L6063, L5112 |
| `background.next-post-linking` | when a comment arrives on a post inside the window | every 15 minutes, reads posts since go-live and links the first; no window | P12 |
| `background.waiting-run-cancel` | hourly, a run waiting over 7 days for a button, follow, email or phone; no open-run key | also a run waiting for any message of hers, its waiting messages cancelled with it; its open-run key deleted in the same commit; reads two month parts | P96, P99, P100 |
| `background.reconnect-notice` | an account becomes `expired` or `error` | an account or its channel connection becomes `error`; every account of a broken connection is told | P41 |
| `background.deleted-automation-purge` | the automation once its runs and logs are gone, once a day at 03:40 UTC | + counters, reply state, past-comment reads, file links; hourly within a time budget | P92 |
| `background.webhook-event-retention` | 30 days, batch deletes once a day at 03:00 UTC | 8 days, the event and event-key parts dropped, every hour | D15, P33, P92, P96 |
| `background.run-retention` | 180 days after the run ended, batch deletes once a day at 03:20 UTC | 90 days or a little more, month parts by the run's start dropped, every hour | D16, P92, P96 |
| `background.comment-log-retention` | 180 days, batch deletes once a day at 03:30 UTC | 90 days, month parts dropped, every hour | D16, P92, P96 |
| `background.session-cleanup` | expired and revoked sessions, once a day at 04:00 UTC | + trusted devices expired or revoked over 30 days ago; hourly within a time budget | AT17, D56, P92 |
| `background.seat-sync` | the member count pushed to Stripe on each member change; an hourly reconcile | off — unlimited members, quantity stays 1; lapsed grace ends through WC-59 | D55, BL9 |
