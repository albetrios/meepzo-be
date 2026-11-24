# Operations requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: what people can do — connect, change, cancel, approve, list, search, filter, sort, create, edit,
delete — and what the product does with what they set up. Each operation names its route proposal in
[route-changes.md](../route-changes.md) (RC-…); the paths live only there. Who may do each one is in
[access.md](access.md); the background work an operation sets off is in
[worker-changes.md](../worker-changes.md).

This file also holds the ids with a `billing.` or `tenancy.` prefix (plans, limits, trial, cards, the
organization's tile colour): they are operations on plans and the organization, kept under their exact
coverage ids — see **Plans and limits** and **Organization and people** below.

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids MC…, CA…, IA…, CT…, AU…, WH…, SN…, BC…, BL…, TN…, AT…,
UN…, K… are in [routes-final.md](../routes-final.md); WC-… are rows of
[worker-changes.md](../worker-changes.md); `plan:L…` points into
`../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch built
(`iterations/launch-2026-11-20-ujai/AS-BUILT.md`, Standing deviations) or the platform today.

## Channel connections and accounts

### `operations.channel-account-connect-multi` — CHANGED

A person who may manage accounts connects a business through Meta's Unified Login: start a login (a
one-use state valid 10 minutes, bound to the person and organization), finish it with Meta's code, then
pick which of the business's Instagram accounts to connect. The pick re-reads the business's assigned
accounts from Meta, checks the plan's account limit under the organization's lock (over it → refused,
nothing saved), and creates each account with its Instagram extension, settings and lanes in one commit;
each is then set up at Meta (`background.account-setup`). An organization holds many accounts — 1, 3 or 10
by plan — and one Instagram account is live in one organization at a time. A reconnect finishing at the
callback moves an account that changed business to this connection.

**Sources:** D24–D26, P1, P26, P41, P54, P55, P60 · routes-final § 1 MC4–MC7 · RC-1, RC-2, RC-3 ·
plan:L4528–L4604 · BRIEF AC-2

### `operations.channel-connection-list` — NEW

People who may see accounts list the organization's connections (provider, business, status, granted
permissions, who connected, the last daily check) and open one. "Disconnect business" disconnects every
account of the connection and erases its token. "Reconnect" starts a new login bound to that connection and
asks for any permission the feature check found missing.

**Sources:** P41, P50, P58 · routes-final § 1 MC8, MC17 · RC-4, RC-5, RC-112, RC-113 · plan:L4674–L4693

### `operations.channel-connection-ad-picker` — NEW

To set up an ad automation, a person lists the ad accounts the connection's login reaches, then the ads of
one ad account at a time — read live from Meta, never stored. Offered only once its Meta test passes.

**Sources:** D41, P36, P41, P52, P57 · routes-final § 1 MC13 · RC-15, RC-114 · plan:L876–L880

### `operations.channel-account` — CHANGED

People who may see accounts list the organization's channel accounts and open one (channel, display name,
status, connection, paused or suspended, plan stop, the new-account limit's end, the Instagram extension and
settings inside; never the token). A person who may manage accounts disconnects one (`revoked`, its lanes
stopped, its starter questions removed, its waiting messages left to expire; the connection's token erased
only with its last account), pauses one (every lane stops; comments and taps are still saved and sent after
resume) and resumes it.

**Sources:** D26, P1, P42, P60 · routes-final § 1B CA2, CA3, CA7, CA8 · RC-7–RC-11 · plan:L2599–L2600,
plan:L4683–L4693

### `operations.channel-account-choose-active` — NEW

After a move down leaves an account "not in your plan", a person who may manage accounts makes it active.
At the plan's account limit they must name an active account to stop in its place, in the same commit;
below the limit none is needed. Already active, or at the limit with no account named, is refused.

**Sources:** D57, P42 · routes-final § 1B CA9 · RC-60 · plan:L2631

### `operations.feature-check` — NEW

One shared check answers "can this channel account use feature X": the channel's capability list supports
X, the connection's granted permissions include X's permission, the organization's plan has X's switch on,
and X's Meta test has passed. Go-live, the account settings, saving a live automation, sending a broadcast
and the engine at run time all ask it. A refusal names its reason: channel lacks the feature, permission not
granted (reconnect to allow it), plan lacks the feature, or feature not offered yet.

**Sources:** P36, P50, P61, P83 · routes-final § 1B CA11, K11, K14 · RC-12, RC-29, RC-31, RC-52 · BRIEF AC-7

### `operations.channel-capability-list` — NEW

Which ways to start, steps, message kinds and features a channel offers is one list per channel, kept in
code; Instagram is the only entry now. An automation, broadcast or setting that uses something its channel
lacks is refused; a later channel adds its own entry.

**Sources:** P48, P50 · routes-final § 1B CA11, AU34 · RC-29, RC-31, RC-52

## Instagram account

### `operations.instagram-account-settings-v8` — CHANGED

A person who may manage Instagram changes one account's settings: the opening hour limit (up to 700) and
day limit, the fast hour limit, the per-person hour limit (5–100), the broadcast hour limit, stop words, the
automatic notice, "start on replies under comments", "once per person per post", "mark as seen" and the PRO
extra delay. An empty number means the product's default. Each feature passes the feature check; the
automation switch is still accepted here and written to the channel account. A save over a newer change is
refused.

**Sources:** D5, D11, D22, D64–D67, P36, P42, P50 · routes-final § 2.B IA12–IA14 · RC-12 ·
plan:L1075–L1097, plan:L2673–L2684

### `operations.instagram-media-pickers` — CHANGED

People who may see Instagram content list one named account's posts (with caption and kind) and stories,
read through Unified Login; "one story" is offered only once its Meta test passes.

**Sources:** D24, D26, P36, P47 · routes-final § 2.C IA15 · RC-13, RC-14

### `operations.instagram-webhook-events-list` — CHANGED

People who may see received events list them for debugging: 8 days, filterable by channel account, status
and kind, the body empty once handled, with the new skip reasons (`own_comment`, `flood`) and the next retry
time.

**Sources:** D15, P59, P99 · routes-final § 5.B WH23 · RC-19

### `operations.instagram-send-limits` — NEW

Each account sends within its own limits, all accounts at the same time: opening DMs 600 an hour by default
(owner up to 700, Meta allows 750), 150 an hour for a new account's first 7 days unless the owner sets a
value; the day limit off; fast messages 10,000 an hour, at most 20 at once per account, one per person at a
time; 60 messages an hour per person as a loop guard; broadcasts 600 an hour by default (up to 2,000).

**Sources:** D5, D11, D68 · plan:L1951–L1992 · routes-final § 6 SN3 · BRIEF AC-4

### `operations.instagram-timing-boxes` — NEW

Sends look human: an opening DM goes at a random second inside its box (3,600 ÷ hour limit seconds), at
least 1.5 s apart, missed boxes never sent together, half speed doubling the box; a fast message goes 500 to
2,000 ms after her action or its wait; public replies with "reply like a person" follow their automation's
box; broadcasts a random second in their box.

**Sources:** D6, D11, D32, D68 · plan:L2105–L2204

### `operations.instagram-extra-delay` — NEW

With the PRO extra delay set (1–20 s, min not over max), the first answer after her tap, typed answer,
story reply or DM waits an extra random pause, so the total from her message to our answer stays under 25
seconds; later list messages keep the normal delay.

**Sources:** D67, P83 · routes-final § 2.B IA12 · plan:L2182–L2195

### `operations.instagram-mark-seen` — NEW

With "mark as seen" on, after an automation message to her is sent, her chat is marked seen once per her
inbound message — not a DM, not counted — skipped when the owner typed to her by hand; a failure is ignored.
Offered only once its Meta test passes.

**Sources:** D66, P36 · plan:L2450–L2474

### `operations.instagram-dm-counting` — NEW

Every message into her chat counts as one DM toward the organization's month (an image plus text counts
two); public replies, hides, follow checks and "mark as seen" do not. Opening DMs, fast messages and
broadcasts each count against their lane's limits.

**Sources:** D29, D34, P43 · plan:L1136–L1192, plan:L1993–L2043 · BRIEF AC-6

### `operations.instagram-message-expiry` — NEW

An opening DM, public reply or hide may go up to 7 days after the comment minus 30 minutes, then it is
`expired` (with the reason `plan_limit` when it waited behind the month limit); a Live private reply only
while the Live is on (`live_ended`); a message after the hello only while her window is open.

**Sources:** D9, D40, D62 · plan:L2207–L2231 · WC-15, WC-16

### `operations.instagram-pending-estimate` — NEW

Each account's banner shows about how many waiting opening DMs will go and how many may expire, worked out
every 10 minutes from the waiting DMs, their ages, the hour limit and any known stop; with a stop that has no
end, it shows when the first and last waiting DM expire.

**Sources:** D10 · plan:L2232–L2263 · WC-24 · routes-final § 6 SN14

### `operations.instagram-starter-questions-sync` — NEW

An account's starter questions on Instagram follow its live starter-question automations (1–4 each, at most
4 live per account); go-live is refused when the account would go over 4, and every go-live, pause, delete
or question change re-sets them at Meta.

**Sources:** D42 · plan:L800–L880 · WC-31 · routes-final § 4.A AU13

### `operations.instagram-account-banners` — NEW

People who may see Instagram content read one account's sending status for its banners: per lane the
waiting count, state, reason and next send time; paused, suspended, the new-account limit; the estimate;
today's line (sent, not sure, skipped — of those "chat closed" — expired, in the organization's day); the
per-automation "chat closed" lines; and the last broadcast, past-comments and retry results — the plan's 35
banners. Read from a 10-second copy.

**Sources:** P97 (S8) · routes-final § 6 SN14 · RC-35 · plan:L2530–L2575

### `operations.instagram-message-retry-failed` — NEW

A person retries the failed messages of one automation or of one contact: each `failed` message of about
the last 30 days that is allowed now goes back to waiting once (an opening private reply before its 7-day
end, any other DM only while her window is open, never when the error is final for her); `unknown`,
skipped, expired, cancelled and broadcast messages never. A summary first says how many can go.

**Sources:** D72, P13 · routes-final § 6 SN18, § 3 CT15, § 4.A AU18 · RC-37–RC-40 · WC-42

## Organization usage and notices

### `operations.organization-usage-meter` — NEW

Every team member reads the organization's meter: messages used this month against the plan's limit, when
it resets (the 1st, in the organization's time zone), the state (`ok`, `nearly` at 80 %, `reached` at
100 %), and channel accounts used against the plan's limit.

**Sources:** D34, P14, P47 · routes-final § 6 SN15 · RC-56 · plan:L2576–L2592

### `operations.organization-notices` — NEW

The same read carries the organization notices to show — limit nearly reached, reached, payment failed,
plan ended, trial ends soon, being set up, paused; the browser remembers a dismissed one.

**Sources:** P14, P27 · routes-final § 6 SN15 · RC-56 · plan:L2576–L2592

## Contacts

### `operations.shared-product-routes` — CHANGED

Contacts, contact tags, automations, broadcasts and segments are product resources shared by every
channel: each belongs to one channel account, named in the create and as a required filter on every list.
The launch's contact and automation paths are kept.

**Sources:** P48, P65, P67 · routes-final K15 · RC-20–RC-34, RC-36–RC-55

### `operations.contact-list` — CHANGED

People who may see contacts list one account's contacts: search by name, username, email, phone or tag
(at least 3 characters), filter (opted out, paused, how she came in, the automation she came through), sort,
with comment numbers.

**Sources:** D46, P65, P97 (S6) · routes-final § 3.A CT12 · RC-20

### `operations.contact-detail` — NEW

A person opens one contact: her profile, email and phone, tags, note, opted out, paused, how she came in
and her activity.

**Sources:** D46 · routes-final § 3.A CT13 · RC-21

### `operations.contact-note` — NEW

A person who may update contacts writes a private note on her (up to 2,000 characters).

**Sources:** D46, P20 · routes-final § 3.A CT5 · RC-22

### `operations.contact-tags` — NEW

A person who may update contacts adds and removes her tags (each change writes a tag event); people who
may see contacts read one account's tag list with counts.

**Sources:** D45, P64, P67, P97 (S7) · routes-final § 3.A CT5, CT8 · RC-22, RC-24

### `operations.contact-tag-events` — NEW

A tag added or removed — by an automation's tag step or by the owner — is recorded in the same commit and
can start the account's tag automations, only while her window is open, never in a chain over 3.

**Sources:** D45 · routes-final § 3.B CT16, § 5 WH15 · WC-4, WC-27 · plan:L1029–L1045, plan:L1611–L1638

### `operations.contact-bulk-actions` — NEW

A person who may update contacts adds or removes one tag, or pauses or resumes automations, for the
contacts they picked (1–500 ids) or every match of a filter (up to 100,000), worked in pieces of 500, each
change as on one contact.

**Sources:** D45, D71, P66 · routes-final § 3.A CT7 · RC-23 · WC-36

### `operations.contact-pause-automations` — NEW

The owner may pause automations for one person: no automation starts for her, her waiting messages are
skipped, her open runs cancelled, broadcasts leave her out, her comments get no DM, public reply or hide,
and no "mark as seen"; her events are still saved. Turning it off resumes nothing that was skipped.

**Sources:** D71 · routes-final § 3.A CT5 · RC-22, RC-23 · plan:L2475–L2511

### `operations.contact-stop-words` — NEW

When she sends one of the account's stop words, she is opted out on that account: nothing automatic goes to
her, waiting messages are skipped and open runs cancelled. Only her own new action that matches a keyword
comment, a keyword DM, a starter question tap or an ig.me link opts her back in.

**Sources:** D49 · routes-final § 3 CT6 · plan:L2416–L2440 · BRIEF AC-8

### `operations.contact-email-phone-answers` — CHANGED

Her typed email is taken when it is valid — plus addresses accepted — and asked again up to 3 times with
the automation's wordings; her phone is taken as 10–15 digits. An email or phone is taken only while a run
waits for it, and never asked for again once known.

**Sources:** D31, P19 (A19) · plan:L2378–L2389, plan:L2441–L2449

### `operations.contact-timeline` — NEW

A person reads "What happened" with one contact: our messages to her of about the last 30 days and her
runs' history of 90 days, newest first; never her own free text, never the email or phone values.

**Sources:** D46, D50, P13 · routes-final § 3.A CT14 · RC-36

### `operations.contact-delete` — CHANGED

A person who may delete contacts deletes one: her personal data is wiped and the row kept, her open runs and
now her waiting messages cancelled (see [`data.erasure`](data.md)).

**Sources:** P48 · routes-final § 3 CT11 · RC-25 · plan:L2628

## Automations

### `operations.automation-create-draft` — CHANGED

A person creates a draft with a name and its way to start (required at create; later changes stay in its
group) on one channel account; nothing else is checked. They read one automation in its new shape and save
its content; while live or paused a save runs the content checks only, each problem named with its step.

**Sources:** D28, P8, P69, P70 · routes-final § 4.A AU11, AU12, AU17 · RC-27–RC-29

### `operations.automation-status-draft-live-paused` — CHANGED

An automation is `draft`, `live` or `paused`, moved by actions only. Pause asks "Keep" (people in the middle
finish) or "Cancel" (their waiting messages cancelled). An automation stops itself on a final error and says
why.

**Sources:** D28, P8 · routes-final § 4.A AU3, AU14 · RC-31, RC-32 · plan:L649–L711 · BRIEF AC-3

### `operations.automation-go-live-check` — NEW

Go-live from draft or paused runs every check and answers all problems together, each with its step: name;
the account connected and its connection healthy; plan not ended and organization not suspended; the month
limit not reached; every part it uses through the feature check; the way to start complete; keywords where
needed; starter questions within 4 per account; the ref code unique; messages and files usable; a hello with
a "next step" button when later steps exist; at least 3 public reply lines with "reply like a person".

**Sources:** D28, D42, D52, P2, P36, P50, P68 · routes-final § 4.A AU13 · RC-31 · plan:L690–L707,
plan:L2635–L2654 · BRIEF AC-7

### `operations.automation-duplicate` — NEW

A person copies an automation as a new draft.

**Sources:** P8 · routes-final § 4.A AU15 · RC-33

### `operations.automation-delete` — CHANGED

A person who may delete automations deletes one with an optional reason (`other` needs a note); its open
runs and waiting messages are cancelled and its starter questions removed; it is purged later
(`background.retention-hourly-budget`).

**Sources:** P11 · routes-final § 4.A AU16 · RC-30 · WC-47

### `operations.automation-trigger-types` — CHANGED

An automation starts one of 15 ways: post or reel comment, Live comment, ad comment, story reply, story
mention, DM keyword, first message, your post shared to you, starter question, link or QR, ad "Send
message", tag added or removed, "no other automation answered", and story repost (offered only if its Meta
test passes). Repost, ad and Live starts are built and refused at go-live until their test passes.

**Sources:** D37, P36 · routes-final § 4.A AU8 · plan:L452–L472 · BRIEF AC-3

### `operations.automation-targeting` — NEW

A comment automation targets any post, my next post, posts between two dates, or one post; a story
automation any story or one story; keywords match "contains"; two live automations of one account sharing a
word get a warning, never a refusal.

**Sources:** D39 · plan:L798–L880

### `operations.automation-next-post` — CHANGED

"My next post" links to the account's first post published after go-live, once; it never expires.

**Sources:** P12 · routes-final § 4.A AU20 · WC-43 · plan:L805

### `operations.automation-keyword-typo-match` — NEW

Words of 5 or more letters may have one wrong letter, also inside keywords of several words (all words
together and in order); shorter words must be exact.

**Sources:** D39, D60 · plan:L800–L880

### `operations.automation-try-it` — NEW

A person tries a text against an automation: does it start it, which word matched (exact or close
spelling), and which of the account's automations would answer first. It sends and saves nothing.

**Sources:** D39, P8 · routes-final § 4.A AU17 · RC-34

### `operations.automation-ref-link` — NEW

A link automation has a ref code (letters, digits, `-`, `_`, `=`, up to 64, unique per account); its link
is the account's ig.me address with that code; the QR is made by the frontend.

**Sources:** D43 · plan:L800–L880

### `operations.automation-also-start-from` — NEW

"Also start from", empty by default: a comment automation may also start from a story reply or DM, a story
reply automation from a DM, a DM keyword automation from a story reply; a comment is never added to others.

**Sources:** D38 · plan:L712–L796

### `operations.automation-step-order` — NEW

Steps run in one order — hello, follow, email, phone, messages, tags — with public reply and hide beside the
DM; which steps each way to start may use follows the plan's matrix.

**Sources:** D28–D33, D45 · plan:L712–L778

### `operations.automation-step-hello` — CHANGED

"Say hello first": up to 640 characters, up to 3 buttons ("opens a link" or "sends your next step"),
`{name}`, up to 3 versions (more than one version is PRO).

**Sources:** D30, P83 · plan:L882–L927

### `operations.automation-nudge` — NEW

One nudge, 60 minutes after the hello, only when she messaged first and has not tapped.

**Sources:** D30 · plan:L1671–L1697

### `operations.automation-step-follow` — CHANGED

"Ask them to follow", with versions; the follow check tries twice, and when both fail she is treated as
following; account stop errors still stop.

**Sources:** D12, D31 · plan:L928–L941, plan:L2366–L2377

### `operations.automation-step-email-ask` — CHANGED

"Ask for their email" (PRO): 1–10 wordings, one at random, never the last one she saw.

**Sources:** D31, P83 · plan:L942–L955

### `operations.automation-step-phone-ask` — NEW

"Ask for their phone" (PRO), after email: 1–10 wordings, as the email ask.

**Sources:** D31, P83 · plan:L942–L955

### `operations.automation-step-messages` — CHANGED

"Send your messages": 1–10 messages of 7 kinds, each with a wait of none or 1 minute to 23 hours, text up
to 1,000 bytes; each is checked against her window just before sending — closed, that message is skipped
and the run ends.

**Sources:** D29 · plan:L956–L1008

### `operations.automation-message-attachments` — NEW

A message may carry an image, audio or a PDF uploaded as a message file
([`files.message-file-upload`](files.md)); go-live checks each file is usable.

**Sources:** D29, P25, P34 · routes-final § 6.C SN20, SN21 · plan:L956–L1008

### `operations.automation-step-tags` — NEW

"Tag them" adds the automation's tags when she finishes.

**Sources:** D45 · plan:L1029–L1045

### `operations.automation-step-public-reply` — NEW

"Reply under their comment": on or off per automation, 1–20 lines (more than one is PRO), `@username` first
unless turned off.

**Sources:** D32, D52, D63, P83 · plan:L1010–L1028

### `operations.automation-public-reply-per-automation` — CHANGED

Public reply pacing is per automation. Off (the only choice on Free): right after the DM, every comment.
"Reply like a person" on (PRO): an hour limit of 10–100, its own box, 20 s after the account's last such
reply, about 80 %, newest first, at most 500 waiting, never the last line again.

**Sources:** D14, D32, D59 · routes-final § 4.A AU19 · plan:L2267–L2352

### `operations.automation-reply-like-person-default` — NEW

"Reply like a person" is on by default for new automations on Creator and Studio; Free has it off only.

**Sources:** D59 · plan:L2267–L2295

### `operations.automation-public-reply-mention` — NEW

Each automation chooses whether its public reply starts with `@username` (default on).

**Sources:** D63 · plan:L1010–L1028

### `operations.automation-hide-comment` — NEW

"Hide their comment once the DM is sent": the public reply first, then the hide; not a DM, not counted; a
failed hide stops nothing.

**Sources:** D33 · plan:L1046–L1062, plan:L2334–L2352

### `operations.automation-comment-match` — CHANGED

One comment starts at most one automation: the account's live comment automation whose keywords match,
post-linked first, then any-post; an ad comment by its ad.

**Sources:** D37 · routes-final § 5 WH13 · plan:L573–L596

### `operations.automation-comment-replies` — NEW

With "start on replies under comments" on (default), a reply under another comment can start a comment
automation and the public reply goes under the top-level comment; off, it is ignored
(`thread_reply_off`). A comment by the account itself never starts anything (`own_comment`).

**Sources:** D64, P24 · plan:L1374–L1399

### `operations.automation-comment-flow` — CHANGED

A comment start: her window open, the opening goes at once as a normal DM in the fast lane; closed, as a
private reply in the slow lane, one per person per 24 hours; the public reply and the hide follow after the
DM went. Two automations on one post share one unanswered opening; her one tap moves both.

**Sources:** D8, D32, D33 · plan:L1195–L1301, plan:L1887–L1906

### `operations.automation-live-ended` — NEW

A Live comment gets a private reply in the fast lane only while the Live is on; when the Live ends, its
waiting replies expire (`live_ended`). No public reply, no hide. Gated on its Meta test.

**Sources:** D40, P36 · plan:L1302–L1341 · WC-16

### `operations.automation-ad-comment` — NEW

An ad comment works like a comment, matched by its ad; an ad "Send message" starts the ad's automation in
the fast lane, with a 24-hour window unless 7 days is confirmed. Gated on its Meta test.

**Sources:** D41, P36 · plan:L1342–L1365

### `operations.automation-message-match-order` — CHANGED

One message starts or answers at most one automation, in this order: her own waiting run, the exact source
(a button, starter question, link or ad), kind and keyword, first message, then "no other automation
answered" (once a day per person by default, or every time).

**Sources:** D37, D44 · routes-final § 5 WH13 · plan:L517–L571 · BRIEF AC-3

### `operations.automation-message-start-flow` — NEW

The message starts — story reply, DM keyword, first message, shared post, story mention, starter question,
link, ad message and tag — each follow the one message-start picture of the plan.

**Sources:** D44 · plan:L1445–L1704

### `operations.automation-answer-table` — NEW

What counts as her answer follows the plan's table: text answers a waiting email or phone question, moves a
run waiting for `any` and counts as a tap for the hello; a button tap moves only its own run and step; a
reaction, photo or voice only refreshes her window; an edit is never a new answer; the owner typing by hand
quiets automatic asks to her for 6 hours.

**Sources:** D17, D61 · plan:L2390–L2415

### `operations.automation-window-rule` — NEW

Her window opens with her message, tap, story reply or mention, shared post, starter tap, link open or ad
message in the last 24 hours, minus 15 minutes; a comment, Live comment or tag change never opens it; a tag
start needs it open.

**Sources:** D8 · plan:L499–L505, plan:L1887–L1906

### `operations.automation-window-table` — NEW

Each message is checked against her window when the event comes and again just before sending; a change
between the two moves the same row to the other lane. Window open or closed decides the lane, limit, timing
and age as the plan's table says.

**Sources:** D8 · plan:L1820–L1949

### `operations.automation-once-key` — NEW

Each way to start has its once key — the post, the Live, the story, the DM day, first message, the shared
post, the starter or link day, the ad, the tag event — the organization's day where a day applies.

**Sources:** D13 · routes-final § 4.B AU22 · plan:L478–L515 · BRIEF AC-3

### `operations.automation-once-rule` — CHANGED

One run per automation, person and once key; a second start with the same key is ignored (`once_per_post`).
The rule frees itself when the old run is cleaned up, about 90 days after it ended; "first message" is once
ever. At most one run of an automation is open for a person: a comment that may start a new run (another
post, or "every time") replaces her open run (`replaced`); every other start is ignored while it is open
(`run_in_progress`).

**Sources:** D13, P35, P100 · routes-final § 4.B AU22, AU23, § 5 WH14 · plan:L1820–L1886 · BRIEF AC-5

### `operations.automation-every-time-mode` — NEW

With the account's "once per person per post" off, every new comment or keyword DM starts a new run — the
once key becomes the event's own id — still at most one open run per automation and person.

**Sources:** D65, P35 · plan:L1917–L1949

### `operations.automation-unknown-outcome` — CHANGED

When we cannot know whether Instagram took a message (a timeout, a 502 or 504), it is `unknown` and never
sent again by itself; only her next message or tap may send that step once more, and the run waits for
`any`. A tap proves only the message that carries that button.

**Sources:** D17 · routes-final § 4.B AU25 · plan:L2390–L2415 · BRIEF AC-8

### `operations.automation-follow-check` — NEW

The follow check asks Instagram twice; two failures treat her as following and go on.

**Sources:** D12 · plan:L2366–L2377

### `operations.automation-list-counters` — CHANGED

People list one account's automations with status `draft`, `live` or `paused`, runs and "% tapped" ((hello
taps + typed answers) ÷ runs started) from all-time counters that survive the run clean-up, per version too.

**Sources:** D36, D61, P65 · routes-final § 4.A AU10, AU19 · RC-26 · plan:L2514–L2529

### `operations.automation-past-comments` — NEW

On a comment or ad-comment automation (PRO), a person starts "also answer comments from the last N days"
(1–7): the target posts, or for any post the newest 50 with comments; each comment goes through normal
intake as an old comment, the 7-day rule per comment; one read per automation at a time; its progress can be
read.

**Sources:** D69, P83 · routes-final § 4.C AU31–AU33 · RC-54, RC-55 · WC-41 · plan:L1098–L1131

## Broadcasts and segments

### `operations.broadcast` — NEW

A person on a plan with broadcasts creates, edits, lists, reads, deletes, sends and cancels a broadcast of
one account: 1–3 messages, now, at a set time, or "when her chat opens" (1–7 days); only to people whose
chat is open, checked when the audience is built and just before each send; opted-out, paused, deleted
contacts and anyone who got a broadcast in the last 24 hours are left out. Deleted broadcasts are purged
after 90 days. Free organizations are refused.

**Sources:** D68, P9, P75, P76 · routes-final § 7.A BC9–BC11 · RC-47–RC-53 · WC-28, WC-29, WC-40

### `operations.segment` — NEW

A person on a plan with segments creates, edits, lists, reads and deletes segments (AND / OR groups, two
levels, up to 20 conditions on one account) and counts a segment's audience (how many match, how many can
get it now). Free is refused; a trial's segments stay saved after a move down, unusable until an upgrade.

**Sources:** D68, P9, P75, P76 · routes-final § 7.B BC12–BC15, BC19 · RC-41–RC-46 · WC-39

## Plans and limits (`billing.` ids)

### `billing.flowdm-plans` — CHANGED

Three plans: Free, Creator and Studio, with monthly and yearly prices (placeholders in the seed: Creator
$29 / $23 a month yearly, Studio $79 / $63); every plan has unlimited members and all four roles. The plan
list shows typed features and the yearly price per month.

**Sources:** D55, P28, P37 · routes-final § 8.A BL11, BL13 · RC-57, RC-58 · plan:L7911–L7949

### `billing.plan-feature-switches` — CHANGED

A plan carries one on / off switch per feature, beside the account and month limits and priority support.
A new or changed plan is a plan row, never a code change; the feature check reads the exact switch.

**Sources:** P83 · routes-final § 8.A BL12 · RC-57, RC-64

### `billing.plan-pro-features` — NEW

"PRO" is the set of switches Free lacks: email ask, phone ask, reply like a person, more than one public
reply line, message versions, broadcasts, segments, past comments and extra delay.

**Sources:** D35, P76, P83 · routes-final § 8.A BL12

### `billing.plan-channel-accounts-max` — CHANGED

Accounts per organization by plan — Free 1, Creator 3, Studio 10 — counted across every channel, checked
under the organization's lock at the pick.

**Sources:** D26, P47 · routes-final § 1 MC7 · RC-3 · BRIEF AC-2

### `billing.plan-message-month-limit` — NEW

Messages per organization per calendar month — Free 1,000, Creator 10,000, Studio 50,000 — counted across
every channel; at 100 % new DMs stop on the slow, fast and broadcast lanes until the 1st or an upgrade, while
public replies and hides of DMs that already went still go.

**Sources:** D34, D62, P3, P43 · routes-final § 6 SN8 · WC-56, WC-37 · BRIEF AC-6

### `billing.plan-states` — CHANGED

Free never ends. A failed payment keeps sending until the grace date (period end + 14 days); a cancelled
paid plan ends at its period end with no grace; a plan ended stops sending (`plan_ended`) and refuses
go-live. A suspended organization stops sending.

**Sources:** D35, P10, TN5 · routes-final § 8.B BL3, BL16 · WC-38, WC-59 · plan:L7951–L7985

### `billing.plan-downgrade` — CHANGED

A move up applies at once; a move down waits for the period end (a Stripe subscription schedule) with the
channel accounts the owner keeps. It never stops an automation: the switches the new plan lacks turn off
(email and phone steps skipped, "reply like a person" works as off, one public reply line, version A only,
scheduled broadcasts cancelled); nothing is deleted; accounts over the limit become "not in your plan".

**Sources:** D57, P77, P83 · routes-final § 8.B BL5, BL6, BL15 · RC-59, RC-66 · WC-38 · BRIEF AC-7

### `billing.paid-trial` — NEW

Creator and Studio offer a 7-day trial with no card: one per organization and never again for an Instagram
account that had one; notices 3 and 1 days before the end; no payment at the end moves the organization to
Free by the moving-down rule.

**Sources:** D73, P28 · routes-final § 8.B BL7, BL18 · RC-65 · WC-59

### `billing.payment-methods` — NEW

A person who may manage the subscription removes a card and sets the default card, named by Stripe's card id.

**Sources:** P78 · routes-final § 8.C BL20, BL21 · RC-68, RC-69

### `billing.retired-plans` — CHANGED

The switched-off Starter, Growth and Pro rows carry Free's features and limits, so an organization still on
one is held to Free until it picks Creator or Studio; its Stripe subscription is not touched; it is moved
down once, gets one email and sees "choose a plan" on its plan read.

**Sources:** P80, P99 · routes-final § 8 BL24 · RC-64 · WC-59

## Organization and people (`tenancy.` id and the profile)

### `tenancy.organization-logo-color` — NEW

Every organization has a tile colour — one of `sky`, `lavender`, `sage`, `peach`, `slate` — picked from its
name at create and for existing organizations, changeable by a person who may update the organization, and
returned with it.

**Sources:** P28, P81 · routes-final § 9.A TN8 · RC-89, RC-109, RC-110 · plan:L7903–L7906

### `operations.organization-slug-read-only` — CHANGED

An organization's slug is made once from its name at create and is read only afterwards; creating an
organization no longer requires one.

**Sources:** P28 · routes-final § 9.A TN7 · RC-89, RC-109

### `operations.member-invitations` — CHANGED

A person who may invite invites 1–20 emails at once with one role, getting a result per email; anyone with
the link previews an invitation; the member list shows the count per role.

**Sources:** P28, P82 · routes-final § 9.C TN9–TN11 · RC-86–RC-88

### `operations.user-profile-onboarding` — CHANGED

A person sets their Instagram handle and goal, and reduce motion; a personal organization can no longer be
the default.

**Sources:** P28 · routes-final § 11.A UN3, UN4 · RC-81, RC-82, RC-107, RC-108

### `operations.organization-chooser` — CHANGED

The organization chooser shows each organization with the person's role and counts, searchable; personal
organizations are hidden.

**Sources:** P28 · routes-final § 11.A UN5 · RC-83

### `operations.email-confirmation` — NEW

A signed-in person asks for an email confirmation link and confirms with its token.

**Sources:** P28 · routes-final § 11.B UN6, UN7 · RC-79, RC-80

## After launch

### `operations.after-launch` — NEW

Operations work done after launch, listed in KICKOFF.md's open items, not built here: backpressure on a slow
Postgres and the poison-ticket rule (S22), rate-based alerts and per-tenant views (S23), WAL and storage
measured in month one (S24), Meta usage logged per call class to set the thresholds (S27), RPO / RTO written
and a restore rehearsed once (S28).

**Sources:** P98 · [scale review](../reviews/scale-review-2026-11-24.md)

## Out of scope (P39)

Not requirements — listed so the coverage rows resolve: `billing.referral` (the referral program, plan
§48) and `billing.referral-payout` (D53's $50 minimum payout) move to a later iteration with their routes,
tables and the month-close work ([P39](../decisions.md)).

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `operations.channel-account-connect-multi` | "Connect Instagram" by Instagram Login: one code, one account per organization, committed at once | Unified Login: start, callback, then pick several accounts up to the plan limit; a reconnect at the callback | D24, D26, P41, P54 |
| `operations.channel-account` | the organization's one Instagram account read and disconnected at singular paths | many channel accounts listed, read, disconnected, paused and resumed by `{channel_account_id}` | D26, P1, P42 |
| `operations.instagram-account-settings-v8` | the automation switch and five public-reply safety settings | owner limits, stop words, notice, comment replies, once per post, mark as seen, extra delay; the feature check | D22, D64–D68, P50 |
| `operations.instagram-media-pickers` | the one account's posts and stories, Instagram Login | a named account's posts and stories, Unified Login; "one story" gated | D24, D26, P36 |
| `operations.instagram-webhook-events-list` | 30 days, masked body, no account filter, `failed` final | 8 days, body empty when done, account filter, `own_comment` and `flood`, next retry time | D15, WH23 |
| `operations.shared-product-routes` | contacts and automations of the organization's one account | shared resources, each on one channel account, a required list filter | P48, P65 |
| `operations.contact-list` | the organization's contacts with `q`, tags, sort | one account's contacts; search incl. phone and tag (≥ 3 characters); opted out, paused, how she came in | D46, P65 |
| `operations.contact-email-phone-answers` | Gmail plus addresses refused; a wrong answer gets one wrong-email message | plus addresses accepted; asked again up to 3 times with wordings | P19 |
| `operations.contact-delete` | data wiped, open runs cancelled | + her waiting messages cancelled | P48, CT11 |
| `operations.automation-create-draft` | a complete automation, fully checked on every save; the account implicit | a draft with a name and its way to start on a named account; content checks only when live or paused | D28, P69, P70 |
| `operations.automation-status-draft-live-paused` | `live` / `inactive` set by the save | `draft` · `live` · `paused` by actions; pause keep or cancel | D28, P8 |
| `operations.automation-delete` | reason required; open runs cancelled | reason optional; open runs and waiting messages cancelled; starter questions removed | P11 |
| `operations.automation-trigger-types` | comment, DM keyword, story reply | 15 ways to start; repost, ad and Live gated | D37, P36 |
| `operations.automation-next-post` | linked inside a window; a 15-minute timer expires ended windows | the first post after go-live, never expires | P12 |
| `operations.automation-step-hello` | one opening message with a button | up to 3 buttons, `{name}`, up to 3 versions | D30 |
| `operations.automation-step-follow` | one follow request | versions; the check tries twice, then treats her as following | D12, D31 |
| `operations.automation-step-email-ask` | one email question | PRO; 1–10 wordings, never the last one again | D31 |
| `operations.automation-step-messages` | one final DM with up to 3 link buttons | 1–10 messages of 7 kinds with waits, each checked against her window | D29 |
| `operations.automation-public-reply-per-automation` | account-level reply safety: chance, hour limit, gap | per automation: off (every comment) or "reply like a person" (PRO) | D14, D32 |
| `operations.automation-comment-match` | one automation, post-linked first, else any post, oldest match | keyword match with close spellings, post-linked first; ad comments by ad | D37, D39 |
| `operations.automation-comment-flow` | the opening on every trigger, skipped when we sent a DM in 24 h; else a private reply or the run fails | window open → fast DM at once; closed → private reply, one per person per 24 h; public reply and hide after the DM | D8 |
| `operations.automation-message-match-order` | any live automation with the switch starts on a DM | her waiting run → exact source → kind and keyword → first message → "no other answered" | D37, D44 |
| `operations.automation-once-rule` | once ever per person and automation (`previous_run_final`) | once per once key, freed after about 90 days; one open run, replaced by an allowed comment | D13, P35, P100 |
| `operations.automation-unknown-outcome` | an unknown outcome fails the step | `unknown`, never resent by itself; her next action may send it once more | D17 |
| `operations.automation-list-counters` | status `active` / `inactive`, a completed count | `draft` / `live` / `paused`, runs and "% tapped" from all-time counters | D36, D61 |
| `billing.flowdm-plans` | Free, Starter, Growth, Pro with seats | Free, Creator, Studio, unlimited members, placeholder prices | D55, P37 |
| `billing.plan-feature-switches` | free-form features nobody checks | typed features with one switch per feature | P83 |
| `billing.plan-channel-accounts-max` | one not-revoked Instagram account per organization | 1 / 3 / 10 channel accounts by plan | D26, P47 |
| `billing.plan-states` | a new team gets a 14-day grace then read-only; read-only refuses automation create, edit, delete | Free never ends; grace only after a failed payment; plan ended stops sending | D35, P10, BL3 |
| `billing.plan-downgrade` | every change at once, members above the seat count suspended | down at the period end by a Stripe schedule, PRO switches off, accounts kept | D57, P77 |
| `billing.retired-plans` | Starter, Growth, Pro live with loose features | off, carrying Free's features; moved down once with one email | P80 |
| `operations.organization-slug-read-only` | slug required at create and editable | made from the name, read only | P28, TN7 |
| `operations.member-invitations` | one email per invite, staff fields | 1–20 emails, one role, a result per email; a preview route | P28, P82 |
| `operations.user-profile-onboarding` | name and job title; dark mode | + Instagram handle, goal, reduce motion; personal default refused | P28 |
| `operations.organization-chooser` | a plain list including the personal organization | role, counts and search; personal hidden | P28 |
