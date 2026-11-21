# Integration requirements — launch-2026-11-20-ujai

Answers: the outside systems this iteration talks to — here Instagram and Meta only.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, AU…, WH…, K… (and the answered questions IQ…, AQ…, WQ…) are in
[routes-final.md](../routes-final.md); `file:line` points into `../../intake-files/`. Every requirement
here is NEW against the platform today.

### `integrations.instagram-graph-api` — NEW

Every call to Instagram goes through one Instagram client, on Instagram's Graph API version v24.0, kept
fixed. A slow or failing Instagram never holds up the rest of the product: each call has a time limit,
and while Instagram is down the work that needs it waits instead of failing. Instagram refusing one
request (a bad code, a dead token) is not counted as Instagram being down. Instagram's error answers are
sorted into four kinds: the token is refused or expired (the account then needs a reconnect), Instagram
asks us to slow down, Instagram refuses the request, Instagram is down. Without the Instagram app
settings, every Instagram action answers that the service is not set up. Nothing that talks to Instagram
keeps our records waiting while it waits for Instagram.

**Sources:** D20, D21 · `routes-final.md` K10, § 1 IA4, § 1.10 · `schema-routes.md:571` ·
`PRD.md:148`–`:151`

### `integrations.instagram-login` — NEW

"Connect Instagram" uses Instagram's business login. The code that comes back is exchanged for a
short-lived token, then for a long-lived one (about 60 days); the account's profile is read; the account
must be a professional one and must grant the basic profile, messaging and comment permissions. The
frontend makes a random state value for each login, keeps it, and drops a callback whose state differs
before it sends us the code. The token is renewed once a day when it ends within 7 days
(`background.daily-account-check`). The app is set up with one app id, one app secret (shared with the
webhook signature) and one redirect address, each with its full name — never the environment in a name.

**Sources:** D9, D20, D24 (IQ6) · `routes-final.md` § 1.A IA12, § 1 IA4, IA8 · `schema-routes.md:440`,
`:450`, `:451`, `:701`, `:775`

### `integrations.webhook-subscription` — NEW

A connected account is subscribed to Instagram's comment, message and button-click events. A failed
subscription never fails the connect; the next connect and the daily account check try again until it
works, and the account screen shows whether the account receives events. A disconnect asks Instagram to
stop sending them, without ever blocking the disconnect. Meta's subscription check is answered with a
verify token set up for the app — required in production, and long enough that it cannot be guessed.

**Sources:** D24 · `routes-final.md` § 1.A IA12, IA13, IA14, § 1 IA8, § 4.A WH7 · `schema-routes.md:457`,
`:502`–`:512`

### `integrations.meta-signed-requests` — NEW

Meta proves every call it makes. An event delivery carries a signature over the exact bytes received;
the deauthorize and data-deletion callbacks carry Meta's signed request. Both are checked with the one
app secret, compared so that timing gives nothing away, before anything else happens; a bad proof is
refused, and a missing app secret answers that the service is not set up. Meta's callbacks name the
person by their app-scoped id — confirmed with a test account before those two routes ship. Meta's
data-deletion callback gets Meta's own answer shape: a status link and a confirmation code.

**Sources:** D15, D22, D24 (IQ3) · `routes-final.md` § 1.D IA18, IA20, § 4.A WH8 · `schema-routes.md:520`,
`:525` · `PRD.md:16`–`:18`

### `integrations.instagram-messaging` — NEW

What we send to Instagram: DMs, private replies to a comment (one per comment), public replies to a
comment, the follow check, and the profile read of a new contact (name, username, picture, followers —
a failed read saves the contact without it). Which channel a DM uses follows Instagram's rules (to be
confirmed at kickoff): a normal DM when the person sent us a DM, a story reply, a quick reply or a click
in the last 24 hours; otherwise, on a comment run, a private reply to the comment; otherwise the step
fails. The email and phone questions offer Instagram's quick replies, and go as plain text when
Instagram refuses them. Buttons name the automation and the run, so a click finds its run. Every
message we send comes back from Instagram as an echo and is skipped.

**Sources:** D14, D18, D26 (AQ1, AQ2, AQ3), D28 (WQ4) · `routes-final.md` § 3.B AU18, AU22, § 3.B.10,
§ 4.A WH9, WH13 · `schema-routes.md:425`, `:569`, `:571` · `PRD.md:149`–`:151`

### `integrations.send-pause` — NEW

Before each message we send — public reply, private reply or DM — there is a random pause of 200 to
1000 milliseconds, so replies look human.

**Sources:** `routes-final.md` K10 · `schema-routes.md:571` · `PRD.md:152`

## Before → after

none — every requirement here is NEW.
