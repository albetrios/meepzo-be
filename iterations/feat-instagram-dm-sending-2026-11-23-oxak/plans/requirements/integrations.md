# Integration requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: the outside systems this iteration talks to — Meta (Instagram through Unified Login), Stripe,
Apple, the IP-to-place data and email.

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids MC…, WH…, SN…, BL…, AT…, K… are in
[routes-final.md](../routes-final.md); RC-… are rows of [route-changes.md](../route-changes.md); WC-… rows
of [worker-changes.md](../worker-changes.md); `plan:L…` points into
`../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch built
(`iterations/launch-2026-11-20-ujai/plans/requirements/integrations.md` and its AS-BUILT).

### `integrations.meta-graph-client` — CHANGED

Every call to Meta goes through one client owned by the channel connection, on `graph.facebook.com` with
the Graph API version v27.0 kept fixed, the token only in the authorization header plus the app-secret
proof, never inside a database unit. Meta's circuit is a backstop per call class (send, upload, read); the
per-account outage decisions stay with the sending engine. Without the Meta app settings the Meta routes
answer that the service is not set up.

**Sources:** D24, P41, P97 (S14) · routes-final K10, § 1 MC2, MC3 · plan:L4346–L4480

### `integrations.channel-connection-unified-login` — CHANGED

Connecting uses Meta's Unified Login with a login configuration: one login per business portfolio for
Instagram (Facebook Pages and ads later through the same login), a system-user token that never expires,
the business id and its assigned Instagram accounts read after the code exchange. A business portfolio is
needed; no Facebook Page. A permission the feature check needs and the login lacks is asked for again by
reconnect. A refused code, a spent code and Meta down each answer differently; nothing is saved when a Meta
step fails.

**Sources:** D24, D25, D27, P41, P50, P54, P55, P58 · routes-final § 1 MC4–MC7, MC17 · RC-1–RC-3, RC-113 ·
plan:L4482–L4604 · BRIEF AC-2

### `integrations.channel-connection-meta-callbacks` — CHANGED

Meta's deauthorize and data-deletion callbacks are Meta-wide, so they live with the connection and are
signed with the Meta app secret. The connection finds who they reach by the provider account id, else by the
business id (every account of that connection). Deauthorize disconnects; data deletion also erases (see
`data.erasure`). An unmatched id still gets its confirmation code and the team an email. Revisited when the
Meta test shows whose id Meta sends.

**Sources:** D24, P46, P56 · routes-final § 1 MC14–MC16 · RC-17, RC-18 · plan:L4695–L4705

### `integrations.instagram-webhook-fields` — CHANGED

Each connected account is subscribed to six fields — comments, Live comments, messages, button taps,
referrals (links and ads) and message reactions — and the subscription is checked every 10 minutes, a field
off setting the account up again. New kinds are read: Live comment, story mention, shared post, starter
question tap and referral; read receipts are never saved; story repost stays unknown until its Meta test
passes.

**Sources:** D24, D64, P36 · routes-final § 5 WH8 · [WC-25, WC-30](../worker-changes.md#background-work) ·
plan:L598–L618

### `integrations.instagram-webhook-save` — CHANGED

Meta's Instagram webhook has its own address under the connection (one per Meta object; the Instagram one
now). The receiver checks the signature over the raw bytes with the Meta app secret, splits and classifies,
drops read receipts and echoes of our own sent messages (found in Postgres), saves events of accounts it
should (an `error` account's events too), drops a replay older than 8 days, saves each event once by its key,
then hands it to intake. The store has a 3-second budget: Postgres down or slow answers 500 / 503 so Meta
delivers again — there is no Redis buffer. Validly signed deliveries do not count against the per-IP limit.

**Sources:** D15, P32, P45, P53, P62, P97 (S9, S10) · routes-final § 5 WH2–WH4, WH9 · RC-16, RC-115 ·
plan:L4732–L4818

### `integrations.instagram-messaging` — CHANGED

What we send to Instagram: opening DMs as private replies or normal DMs by her window, DMs of seven message
kinds (text, image, cards, quick replies, audio, file, post), public replies, hides, follow checks, "mark as
seen", starter questions (ice breakers) and message files uploaded once per account. Buttons carry the
automation, run and message ids, so a tap finds its message.

**Sources:** D4, D29, D33, D42, D66 · routes-final § 6 SN16, SN20, WH8 · plan:L1136–L1194

### `integrations.instagram-login` — REMOVED

The launch's Instagram business login (short- then long-lived token, renewed daily) is removed from
meepzo-be; nothing is migrated.

**Sources:** D24 · RC-6 · routes-final § 1 MC5

### `integrations.send-pause` — REMOVED

The launch's fixed random 200–1,000 ms pause before every message goes; timing follows the lanes' boxes and
delays ([`operations.instagram-timing-boxes`](operations.md)).

**Sources:** D6, D11 · [WC-9](../worker-changes.md#background-work)

### `integrations.stripe-subscription-schedule` — NEW

Stripe stays the truth for payments: a move down between paid plans is a Stripe subscription schedule, a move
to Free is a cancel at the period end; the no-card trial is a Stripe subscription with a 7-day trial that
cancels when no card is added; the Stripe webhook applies the scheduled change and an unpaid trial's end. No
new Stripe event types; the client's idempotency key is forwarded to Stripe.

**Sources:** D57, D73, P77 · routes-final § 8 BL5, BL7, BL22, BL23 · RC-59, RC-65, RC-66

### `integrations.apple-sign-in` — NEW

Apple sign-in uses the same state, PKCE and nonce protection as Google; Apple posts its form to one callback
that never signs anyone in, keeps Apple's first-time name beside the state, and redirects the browser to
finish.

**Sources:** P28, P85 · routes-final § 10.B AT10, AT11 · RC-70, RC-102

### `integrations.session-place-data` — NEW

The session place comes from DB-IP "IP to City Lite" (CC BY 4.0), a local file refreshed with the monthly
image build; looked up in process, never by an outside call; a missing file leaves the place empty.

**Sources:** P86 · routes-final § 10.D AT18

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `integrations.meta-graph-client` | one Instagram client on Instagram's Graph API v24.0; its circuit pauses the intake queue | one Meta client in the connection on `graph.facebook.com` v27.0 with the app-secret proof; the circuit a per-call-class backstop | D24, P41, S14 |
| `integrations.channel-connection-unified-login` | Instagram business login per account, a 60-day token renewed daily | Unified Login per business portfolio, a never-expiring system-user token, accounts picked after the login | D24, P41 |
| `integrations.channel-connection-meta-callbacks` | under the Instagram account, the Instagram app secret, found by the app-scoped id | under the connection, the Meta app secret, found by account id else business id; unmatched id answered | P46, P56 |
| `integrations.instagram-webhook-fields` | comments, messages, button clicks; subscription retried on connect and daily | six fields and new kinds; subscription checked every 10 minutes | D24, D64 |
| `integrations.instagram-webhook-save` | at `…/social/instagram/webhook`; Instagram app secret; echoes skipped; one in-order job that also sends | at the connection's per-object address; Meta app secret; own echoes found in Postgres; key table; 8-day replay guard; intake only | P32, P53, P62 |
| `integrations.instagram-messaging` | DMs, private and public replies, follow check, profile read; email and phone as quick replies | + seven message kinds, hides, "mark as seen", starter questions, message files; channel by her window | D4, D29, D33 |
| `integrations.instagram-login` | the connect path and the daily renewal | removed | D24 |
| `integrations.send-pause` | a fixed 200–1,000 ms pause before every message | removed — boxes and delays per lane | D6, D11 |
