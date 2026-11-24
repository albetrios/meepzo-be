# Data requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: what is stored, owned by whom, related how, kept how long, removed how. The fields and the
diagrams live in [db-changes.md](../db-changes.md); each requirement links its table sections there
instead of repeating them. How long each kind of row stays is [`quality.retention`](quality.md); who may
read and write which rows is [access.md](access.md).

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids MC…, CA…, IA…, CT…, AU…, WH…, SN…, BC…, BL…, TN…, AT…,
UN…, UP…, K… are in [routes-final.md](../routes-final.md); RC-… are rows of
[route-changes.md](../route-changes.md), WC-… rows of [worker-changes.md](../worker-changes.md);
`plan:L…` points into `../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch
built (`iterations/launch-2026-11-20-ujai/AS-BUILT.md`, Standing deviations) or the platform today.

## Where the data lives

### `data.app-migrations-in-place` — CHANGED

The launch's seven `app` migrations are changed in place, not followed by new ones: the launch is frozen
but not merged, and this iteration ships with it in one pull request on `feat/instagram-automation`. A
fresh database built from the migrations ends up with this iteration's tables directly; nothing is migrated
from a launch database, because no customer data exists yet.

Tables: [overview](../db-changes.md#overview).

**Sources:** D1, P29 · plan:L212, plan:L2888 · BRIEF AC-10

### `data.merged-domains-forward-only` — NEW

What this iteration changes in the platform's merged domains — auth, tenancy, billing, user, notify,
upload — goes in new migrations only; their existing migrations are never edited. The new platform tables
sit in their own domains' schemas (trusted devices in auth, trial accounts in billing), and the plan rows
stay in billing.

Tables: [Stage 7](../db-changes.md#stage-7--plans-and-the-platform-pieces-sending-needs),
[Stage 8](../db-changes.md#stage-8--product-around-sending).

**Sources:** D48, P28, P38 · plan:L259, plan:L8467

### `data.channel-common-core` — NEW

The data is split into a common core any channel uses and Instagram's own adapter around it. Common:
the provider login (channel connection and its token), the connected account (channel account), the
organization's month count of messages and the global send state. Instagram's own: the account's Instagram
extension, its settings and posts, the sending tables, the message files sent to Instagram and the webhook
tables. A later channel (WhatsApp, TikTok, Facebook Pages) adds its own adapter tables beside Instagram's
and reuses the common and shared ones.

Tables: [overview](../db-changes.md#overview),
[Stage 1](../db-changes.md#stage-1--channel-connections-and-accounts),
[Stage 6](../db-changes.md#stage-6--sending-engine).

**Sources:** P40–P43, P45, P48 · routes-final § 1, § 1B, K15

### `data.shared-product-tables` — CHANGED

Contacts, tag changes, automations with their counters, reply pacing and past-comment reads, runs, run
history, comment logs, segments, broadcasts and recipients are **shared by every channel**: each row
belongs to one channel account, and contacts, automations and broadcasts also say their channel. The four
launch tables (contacts, automations, runs with their history, comment logs) keep their names and change in
place; nothing is renamed. (This id replaces the earlier proposal `data.instagram-product-tables`, P44,
which P48 superseded.)

Tables: [Stage 2](../db-changes.md#stage-2--audience-and-automations),
[Stage 3](../db-changes.md#stage-3--runs-and-logs), [Stage 5](../db-changes.md#stage-5--broadcasts).

**Sources:** P48 (supersedes P44) · routes-final § 3, § 4, § 7, K15 · plan:L2798–L2884

### `data.organization-ownership` — NEW

Every new row belongs to one organization and goes away with it, and a child row never points at another
organization's row. Two named exceptions: the global send state has no organization (read and written only
by the maintenance login, [`access.global-sending-tables`](access.md)), and a trial account record outlives
its organization — its organization and subscription are emptied when they go, so an Instagram account that
had a trial never gets a second one. People's "who did it" pointers empty when the person is deleted; the
row stays.

Tables: [overview](../db-changes.md#overview), [trial_account](../db-changes.md#trial_account),
[sending_state](../db-changes.md#sending_state).

**Sources:** D73, P16 · routes-final K5, K6 · plan:L2800, plan:L4223–L4298

### `data.organization-naming` — NEW

The plan's and Flowdm's word "workspace" is the platform's organization everywhere: every table, column,
route, code and setting says `organization`; only screens may say "workspace". The plan's short names are
written out in full (`direct_message_…`, `once_key`, `turn_number`, `…_milliseconds`), and new yes / no
fields take the `is_` / `has_` form.

Tables: [overview](../db-changes.md#overview).

**Sources:** P6, P21, P72 · routes-final K1 · plan:L8483–L8498

### `data.split-tables` — CHANGED

Seven high-volume tables are split by time so that expiry drops a whole part instead of deleting rows:
webhook events and send attempts by day, messages by week of the run's start, runs and run history by month
of the run's start, comment logs by month, and webhook event keys by Meta's event day. Broadcast recipients
stay one plain table. A rule that must hold across parts — one open run per automation and person — is held
by its own small key table (`data.automation-run-open-key`), never by
a unique rule inside one part.

Tables: [overview](../db-changes.md#overview), [automation_run](../db-changes.md#automation_run),
[automation_run_event](../db-changes.md#automation_run_event),
[automation_comment_log](../db-changes.md#automation_comment_log),
[instagram_webhook_event](../db-changes.md#instagram_webhook_event),
[instagram_webhook_event_key](../db-changes.md#instagram_webhook_event_key),
[instagram_message](../db-changes.md#instagram_message),
[instagram_send_attempt](../db-changes.md#instagram_send_attempt).

**Sources:** P33, P96, P100 · routes-final K16, AU36, WH19, WH20, SN17 · plan:L4124–L4220

## Channel connections and accounts

### `data.channel-connection` — NEW

One provider login of an organization — for Meta, one business portfolio reached through Unified Login,
which serves Instagram now and Facebook Pages and ads later. It holds the portfolio, the granted permissions
(the input of [`operations.feature-check`](operations.md)), who connected it, its status and last daily
check, and Meta's usage for that business ([`background.meta-usage-per-connection`](background.md)).

Tables: [channel_connection](../db-changes.md#channel_connection).

**Sources:** P41, P51, P54–P56, P99 · routes-final § 1 MC1, MC19 · plan:L3517–L3553

### `data.channel-connection-token-refresh` — NEW

One encrypted token per channel connection, with its type — a system-user token (Meta's, which never
expires) or a person's login token — and room for an encrypted refresh token, empty for Meta, so a later
provider whose tokens expire needs no new table. The token is read only on the provider client's path
([`quality.token-secrecy`](quality.md)).

Tables: [channel_connection_token](../db-changes.md#channel_connection_token).

**Sources:** P41, P49 · routes-final § 1 MC9, MC18 · plan:L3555–L3574

### `data.channel-account` — NEW

One connected account of an organization on one channel: its channel, connection, provider account id,
display name and connection status, plus the owner's pause (and who paused it), the team's suspend, the
plan stop (`plan_limit`, `plan_ended`, `plan_downgrade`) and the automation switch. One provider account is
live in at most one organization at a time. Every product and sending row names its account by this one id;
there is no second Instagram id.

Tables: [channel_account](../db-changes.md#channel_account).

**Sources:** P42, P47, P60, P99 · routes-final § 1B CA1, CA3, CA4 · plan:L2922–L2944, plan:L3385–L3419

### `data.instagram-account-extension` — CHANGED

The Instagram account becomes the 1:1 Instagram extension of its channel account: Instagram user id,
username, account type, private flag, followers, picture, webhook subscription time and when the starter
questions were set. The connection fields, the token and the automation switch leave it.

Tables: [instagram_account](../db-changes.md#instagram_account).

**Sources:** P42, P47, P99 · routes-final § 2 IA8 · plan:L2922–L2944

### `data.instagram-account-settings` — CHANGED

The Instagram account's own settings, keyed by its channel account: the owner's sending limits (opening
hour and day, fast, per person, broadcast), stop words, the automatic notice, comment replies, once per
person per post, mark as seen and the PRO extra delay. An empty number means the settings file's value. The
five public-reply safety settings move to each automation; the automation switch moves to the channel
account.

Tables: [instagram_account_setting](../db-changes.md#instagram_account_setting).

**Sources:** D5, D11, D14, D22, D32, D64–D68, P42 · routes-final § 2.B IA12 · plan:L2895–L2920

### `data.instagram-account-token` — REMOVED

The per-account Instagram Login token table goes; the one token is the channel connection's
(`data.channel-connection-token-refresh`). No data moves.

Tables: [instagram_account_token](../db-changes.md#instagram_account_token).

**Sources:** D24, P41 · plan:L2938, plan:L8458

### `data.instagram-media` — CHANGED

Stored posts of an Instagram account, now named by the channel account, plus the missed-comment watch
times, the Live's end and the Live product type.

Tables: [instagram_media](../db-changes.md#instagram_media).

**Sources:** D40, D41, P47 · routes-final § 2.C IA17 · plan:L2946–L2958

### `data.connection-states` — CHANGED

A channel connection is `connected`, `error` or `revoked`; a channel account's connection status is
`connected`, `error` or `revoked` — `expired` goes, because the Meta system-user token never expires. A
broken connection breaks every account on it.

Tables: [channel_connection](../db-changes.md#channel_connection),
[channel_account](../db-changes.md#channel_account).

**Sources:** D24, P99 · routes-final § 1 MC11, § 1B CA4 · plan:L3998–L4013

## Audience and automations

### `data.contact` — CHANGED

One person who wrote to or commented on one channel account. Shared across channels, it adds her channel,
the 24-hour window, opted out, the "via" automation and how she came in, the owner's private note, her first
message, the owner's pause of automations for her (and who set it), comment and story activity and her last
broadcast. Plus addresses are accepted in an email; at most 50 tags. A contact stays until the owner deletes
it, Meta asks to delete the data, or the organization is deleted (`data.erasure`).

Tables: [contact](../db-changes.md#contact).

**Sources:** D8, D27, D45, D46, D49, D51, D71, P19, P48 · routes-final § 3 CT2, CT3, CT9 ·
plan:L2960–L2993

### `data.contact-tag-event` — NEW

One row per tag added to or removed from a contact, written in the same commit as the tag change, so a
tag start is never lost; kept 8 days.

Tables: [contact_tag_event](../db-changes.md#contact_tag_event).

**Sources:** D45 · routes-final § 3.B CT16 · plan:L3685–L3717

### `data.automation` — CHANGED

An automation belongs to one channel account and says its channel (checked against the channel's
capability list). It is `draft`, `live` or `paused`; it has one of 15 ways to start, its steps, "also start
from", targeting (any post, my next post, between dates, one post), a ref link, starter questions, an ad, a
tag, a default reply, per-automation public reply pacing and `@username`, the hide option and an automatic
stop reason. Its counters move out to their own tables.

Tables: [automation](../db-changes.md#automation).

**Sources:** D28–D45, D52, D57, D59, D63, P11, P12, P48 · routes-final § 4.A AU8, AU9 ·
plan:L2995–L3145

### `data.automation-counters` — NEW

All-time counters per automation (runs started, taps, typed answers, and the same per version), saved in the
commit of the event that moves them and spread over several slots; they survive the run clean-up. A second
table keeps each automation's public reply pacing state ("reply like a person").

Tables: [automation_count](../db-changes.md#automation_count),
[automation_reply_state](../db-changes.md#automation_reply_state).

**Sources:** D32, D36, D61 · routes-final § 4.A AU19

### `data.automation-backfill` — NEW

One past-comments read of an automation (1 to 7 days back): its status, progress, who asked, and its result;
one running per automation.

Tables: [automation_backfill](../db-changes.md#automation_backfill).

**Sources:** D69 · routes-final § 4.C AU31–AU33

## Runs and logs

### `data.automation-run` — CHANGED

A run of an automation for one person, now with its once key, the 7-day clock, the first DM time, the last
list message and the step versions shown to her; the send claim moves to the message row; her free text is
never kept. Run history adds the two tap events and a copy of the run's start so both split by the same
month. Kept 90 days after the run ends.

Tables: [automation_run](../db-changes.md#automation_run),
[automation_run_event](../db-changes.md#automation_run_event).

**Sources:** D13, D16, D17, D61, P48, P96 · routes-final § 4.B AU21, AU36 · plan:L3147–L3173

### `data.automation-run-open-key` — NEW

One row per open run, unique on organization, automation and person, pointing at the run. The new run and
its key are written in one commit; the key is deleted in the commit that ends or replaces the run; a repair
duty removes keys a commit missed. This holds "one open run per automation and person" across the month
parts.

Tables: [automation_run_open_key](../db-changes.md#automation_run_open_key).

**Sources:** P35, P100 (reverses P71) · routes-final § 4.B AU23, AU37 · plan:L3465–L3480

### `data.automation-comment-log` — CHANGED

One row per comment an automation handled: the message list and hide steps, the comment time, more step
statuses and reasons, and a copy of its run's start; kept 90 days, split by month of when it was logged.

Tables: [automation_comment_log](../db-changes.md#automation_comment_log).

**Sources:** D16, D32, D33, D64, P24, P48, P96 · routes-final § 4.B AU28, AU36 · plan:L3184–L3205

### `data.run-states` — CHANGED

A run is `running`, `waiting` (for a tap, any message of hers, a follow, an email or a phone), `completed`,
`failed` or `cancelled`, with a cancel reason that now includes `replaced`, `wait_expired`, `window_closed`,
`opted_out` and `contact_excluded`.

Tables: [automation_run](../db-changes.md#automation_run).

**Sources:** D17, D29, D49, D71, P35 · plan:L3848–L4123

## Received content

### `data.instagram-webhook-event` — CHANGED

What Meta sent, per channel account: kept 8 days, split by day, its body cleared when done; five new kinds
and `read` gone; echoes and reactions saved `received`; skip reasons `own_comment` and `flood`; a failed
event retried hourly up to 7 days.

Tables: [instagram_webhook_event](../db-changes.md#instagram_webhook_event).

**Sources:** D15, P24, P32, P62, P63 · routes-final § 5.B WH18, WH19, WH21, WH22 · plan:L3207–L3225

### `data.instagram-webhook-event-key` — NEW

The dedupe key of each received event in its own table, led by the organization and split by Meta's event
day, so the same event is saved once.

Tables: [instagram_webhook_event_key](../db-changes.md#instagram_webhook_event_key).

**Sources:** D15, P96 · routes-final § 5.B WH20

## Broadcasts

### `data.broadcast-segment` — NEW

A segment is a saved audience of one channel account (AND / OR condition groups, two levels, up to 20
conditions); a broadcast holds its account, channel, 1–3 messages, mode and schedule; a recipient row is one
person of one broadcast, once per person per broadcast. Deleted segments and broadcasts are soft-deleted,
then purged after 90 days.

Tables: [segment](../db-changes.md#segment), [broadcast](../db-changes.md#broadcast),
[broadcast_recipient](../db-changes.md#broadcast_recipient).

**Sources:** D68, P9, P48, P75, P76 · routes-final § 7 BC4, BC8, BC12, BC16

### `data.broadcast-states` — NEW

A broadcast is `draft`, `scheduled`, `sending`, `done` or `cancelled`, moved by actions only; a recipient
moves from waiting to sent, skipped or replied.

Tables: [broadcast](../db-changes.md#broadcast), [broadcast_recipient](../db-changes.md#broadcast_recipient).

**Sources:** D68 · routes-final § 7 BC9 · plan:L4070–L4089

## Sending engine

### `data.instagram-sending` — NEW

The engine's rows: one send lane per account and kind (slow, reply, fast, broadcast), one message row per
message of a run or broadcast (kept about 30 days), send attempts (8 days), minute counts, the stop history
(90 days) and the message files uploaded to Instagram (by the upload's public id only).

Tables: [instagram_send_lane](../db-changes.md#instagram_send_lane),
[instagram_message](../db-changes.md#instagram_message),
[instagram_send_attempt](../db-changes.md#instagram_send_attempt),
[instagram_send_minute_count](../db-changes.md#instagram_send_minute_count),
[instagram_send_stop](../db-changes.md#instagram_send_stop),
[instagram_attachment](../db-changes.md#instagram_attachment).

**Sources:** D4, D16, D50, P25, P43 · routes-final § 6 SN12, SN13, SN16, SN17, SN19, SN20

### `data.message-states` — NEW

A message is `waiting`, `sending`, `sent`, `unknown`, `failed`, `skipped`, `expired` or `cancelled`, with a
reason (`window_closed`, `plan_limit`, `live_ended`, `opted_out`, `contact_excluded`, `hour_limit`,
`replaced`, …); an `unknown` is never sent again by itself.

Tables: [instagram_message](../db-changes.md#instagram_message).

**Sources:** D9, D17, D29, D40, D62 · routes-final § 6.B · plan:L3848–L4123

### `data.lane-states` — NEW

A lane is ready, waiting for its turn, or stopped — by its own Instagram error stop with an end time (half
speed, too fast, blocked) — while the account's pause, suspend and plan stop are read from the channel
account; every stop is written to the stop history.

Tables: [instagram_send_lane](../db-changes.md#instagram_send_lane),
[instagram_send_stop](../db-changes.md#instagram_send_stop).

**Sources:** D19, P42, P99 · routes-final § 6 SN5, SN12, SN13 · plan:L3848–L4123

### `data.message-month-count` — NEW

The organization's count of messages this calendar month (its time zone), across every channel, spread over
16 slots and raised in the send's commit; kept 13 months.

Tables: [message_month_count](../db-changes.md#message_month_count).

**Sources:** D34, P43 · routes-final § 6 SN8

### `data.sending-state` — NEW

One global row: the send switch's environment id, the outage state and the minimum compatible settings
version. It has no organization.

Tables: [sending_state](../db-changes.md#sending_state).

**Sources:** D20, D21, P16, P95 · routes-final § 6 SN7

## Plans and the product around sending

### `data.plan-subscription` — CHANGED

Plans become Free, Creator and Studio with typed features (`message_month_limit`, `channel_accounts_max`,
`has_priority_support` and one switch per feature); the old Starter, Growth and Pro rows are switched off and
carry Free's features. A subscription mirrors a scheduled move down and the accounts kept after it.

Tables: [plan](../db-changes.md#plan), [subscription](../db-changes.md#subscription).

**Sources:** D26, D34, D55, D57, P37, P77, P80, P83 · routes-final § 8 BL11, BL12, BL24

### `data.platform-columns` — CHANGED

Users gain an Instagram handle and a goal, and every password hash is emptied (the column stays); user
settings gain reduce motion; sessions gain the place (city and country code); organizations gain a required
tile colour, backfilled from the name.

Tables: [user](../db-changes.md#user), [user_setting](../db-changes.md#user_setting),
[session](../db-changes.md#session), [organization](../db-changes.md#organization).

**Sources:** P28, P81, P84, P86 · routes-final § 9 TN8, § 10 AT1, AT18, § 11 UN3, UN4

### `data.trusted-device` — NEW

A device a person chose to trust for 30 days (at most 10 live per person); removed 30 days after it expired
or was revoked.

Tables: [trusted_device](../db-changes.md#trusted_device).

**Sources:** D56 · routes-final § 10 AT17

### `data.trial-account` — NEW

Which Instagram accounts had a trial, across organizations, so an account never trials twice.

Tables: [trial_account](../db-changes.md#trial_account).

**Sources:** D73 · routes-final § 8 BL7, BL18

### `data.reference-data` — CHANGED

The permission catalog gains `channel-account:read` / `:manage` (granted wherever the `instagram-account:*`
twin is) and `contact:update`; the role tone `lav` becomes `lavender`; the password sign-in rows go; nine new
notification types are added, saved per kind.

Tables: [Reference data](../db-changes.md#reference-data-no-new-tables).

**Sources:** P20, P59, P81, P84, P87 · routes-final K4, TN12, UN8

### `data.kickoff-defaults` — NEW

Data the scale review's defaults add, built at kickoff as its Fix column says and synced back into
`db-changes.md` then: a narrow 1:1 table of a contact's fast-changing fields (S5), a tag count table kept in
the tag commit (S7), a per-account, per-day sending counter (S8), Meta usage per connection, asset and type
with the app-level usage on the global send state (S13), and the stored waiting estimate (S29).

Tables: [overview](../db-changes.md#overview) ("Not drawn here").

**Sources:** P97 · routes-final "Kickoff defaults from the scale review" ·
[scale review](../reviews/scale-review-2026-11-24.md)

## Removal

### `data.erasure` — CHANGED

Three erasures, each inside the request or callback that asks for it. (1) The team deletes a contact: her
personal data is wiped and the row kept; her open runs are cancelled and now also her waiting messages, her
tag events and her broadcast recipient rows. (2) Meta's data deletion: every account it reaches — matched by
the account id, else every account of the business — is disconnected and its profile and posts erased, the
token erased with the connection's last account. (3) Deleting the team erases every connection's token. A
deauthorize only disconnects.

Tables: [contact](../db-changes.md#contact), [channel_account](../db-changes.md#channel_account),
[channel_connection_token](../db-changes.md#channel_connection_token),
[instagram_account](../db-changes.md#instagram_account).

**Sources:** D49, D51, P46, P56 · routes-final K7, § 1 MC15, MC16, § 3 CT11, IAC5 · RC-18, RC-25 ·
plan:L2628, plan:L4695–L4705

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `data.app-migrations-in-place` | the launch's seven `app` migrations, frozen as built | changed in place, shipped in one pull request with the launch | D1, P29 |
| `data.shared-product-tables` | contacts, automations, runs and comment logs belong to one Instagram account (`instagram_account_id`) | shared by every channel, keyed by `channel_account_id` with a `channel` column; same table names | P48 |
| `data.split-tables` | every launch table plain, emptied by daily batch deletes | seven high-volume tables split by time and expired by dropping parts; broadcast recipients plain | P33, P96 |
| `data.instagram-account-extension` | the whole account: status, Instagram Login ids, scopes and token end; one not-revoked account per organization | the 1:1 Instagram extension of a channel account; connection, status and switch on the channel account | P42, D24 |
| `data.instagram-account-settings` | the automation switch and five public-reply safety settings | owner limits, stop words, notice, comment replies, once per post, mark as seen, extra delay; reply safety per automation; switch on the channel account | D14, D22, D64–D68, P42 |
| `data.instagram-account-token` | one Instagram Login token per account, renewed daily | removed; one token per channel connection | D24, P41 |
| `data.instagram-media` | stored posts of the account | named by the channel account; + missed-comment watch, Live end and type | D40, P47 |
| `data.connection-states` | `connected` · `expired` · `error` · `revoked` on the account | `connected` · `error` · `revoked` on the connection and the account; a broken connection breaks its accounts | D24, P99 |
| `data.contact` | a person per Instagram account; plus addresses refused; tags 1–255 | shared across channels; + window, opted out, via, note, first message, owner pause, activity, last broadcast; plus addresses accepted; at most 50 tags | D45, D46, D49, D71, P19, P48 |
| `data.automation` | `live` · `inactive`; 3 trigger types; message fields as columns; a "next post" window that expires | `draft` · `live` · `paused`; 15 ways to start; steps; targeting; per-automation reply pacing; never-expiring "next post"; counters moved out | D28–D45, P12, P48 |
| `data.automation-run` | send claim on the run; free trigger text kept; 180 days | once key, 7-day clock, versions; claim on the message; free text never kept; 90 days, split by month | D13, D16, P96 |
| `data.automation-comment-log` | final DM step; 180 days | list and hide steps, more statuses and reasons; 90 days, split by month | D16, D32, D33, P96 |
| `data.run-states` | cancel reasons of the launch; a wait cancelled after 7 days | + `replaced`, `wait_expired` for any wait, `window_closed`, `opted_out`, `contact_excluded`; a run waits for `any` after an unknown result | D17, D49, D71, P35 |
| `data.instagram-webhook-event` | kept 30 days with its key and body; `failed` final after 5 tries; `read` events; echoes and reactions skipped | kept 8 days, split by day, body cleared when done; key in its own table; failed retried hourly for 7 days; new kinds; `own_comment`, `flood` | D15, P32, P62, P63, P96 |
| `data.plan-subscription` | Free, Starter, Growth, Pro with free-form features and seats; every change at once | Free, Creator, Studio with typed features and one switch per feature; old rows hold Free's; a scheduled move down mirrored | D57, P77, P80, P83 |
| `data.platform-columns` | users with a password hash; settings with dark mode; sessions without a place; organizations without a tile colour | + handle and goal, hashes emptied; + reduce motion; + place; + tile colour (`lavender` tone) | P28, P81, P84, P86 |
| `data.reference-data` | `instagram-account:*` on every account route; `lav` tone; password rows; 11 notification types | + `channel-account:*`, `contact:update`; `lavender`; password rows gone; 20 types saved per kind | P20, P59, P81, P84, P87 |
| `data.erasure` | a contact delete wipes her data and cancels open runs; data deletion erases the one account found by its app-scoped id | + her waiting messages, tag events and recipient rows; data deletion matched by account id, else business id, across the connection's accounts | P46, P56, CT11 |
