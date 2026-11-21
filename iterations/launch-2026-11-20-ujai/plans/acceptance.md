# Acceptance — launch-2026-11-20-ujai

Filled at Close: Result is `pass` or `fail`, Evidence is a test name or a command; each Item is an acceptance criterion of its feature's `features/<feature>/story.md`, cited by Source (D29).

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-1.1 — The catalog lists the nine new permissions in the Instagram, Automations and Contacts rows | plans/decisions.md D20 | | |
| AC-1.2 — A new team's Owner and Admin hold all nine permissions | plans/decisions.md D2 | | |
| AC-1.3 — A new team's Member role holds exactly the five Member permissions | intake-files/schema-routes.md:143 | | |
| AC-1.4 — The Member role cannot be edited or deleted | plans/decisions.md D3 | | |
| AC-1.5 — Existing teams get the Member role and the nine permissions; a second run changes nothing | plans/decisions.md D3 | | |
| AC-1.6 — A team's own "Member" role is renamed "Member (custom)", people and permissions kept | plans/decisions.md D24 | | |
| AC-1.7 — A Member is refused `missing_permission` on connect, settings, disconnect, automation delete, contact delete, webhook events | intake-files/schema-routes.md:152 | | |
| AC-1.8 — The outgoing-webhook permission alone does not open the Instagram webhook-event list | plans/decisions.md D4 | | |
| AC-1.9 — A personal organization is refused every Instagram, contact, automation and webhook-event operation | intake-files/schema-routes.md:74 | | |
| AC-2.1 — A first connect creates the account `connected` with default settings, a new connection | intake-files/schema-routes.md:453 | | |
| AC-2.2 — Default settings: automation on, safety off, chance 80, 60 an hour, gap 20–60 s | intake-files/schema-routes.md:753 | | |
| AC-2.3 — Reconnecting the same account keeps its settings and is not a new connection | intake-files/schema-routes.md:454 | | |
| AC-2.4 — After connect the token ends about 60 days ahead | intake-files/schema-routes.md:450 | | |
| AC-2.5 — Another account while one is live: `organization_already_has_instagram_account`, nothing changes | intake-files/schema-routes.md:455 | | |
| AC-2.6 — An account live elsewhere: `instagram_account_connected_elsewhere`, the other organization untouched | intake-files/schema-routes.md:456 | | |
| AC-2.7 — A bad code or a personal Instagram account is refused; nothing stored | intake-files/schema-routes.md:466 | | |
| AC-2.8 — A permission left unticked on Instagram's consent screen: `instagram_scopes_missing`, nothing stored | plans/decisions.md D24 | | |
| AC-2.9 — Connect needs an idempotency key; a repeat replays the first answer | intake-files/schema-routes.md:77 | | |
| AC-2.10 — Connect subscribes the account to events; a failed subscription still connects and shows not subscribed | intake-files/schema-routes.md:457 | | |
| AC-2.11 — The account read shows profile, status, token end, subscription, settings — never the token | plans/decisions.md D5 | | |
| AC-2.12 — Settings change: values in range, min gap not above max, not empty, works when `expired` or `error` | intake-files/schema-routes.md:201 | | |
| AC-2.13 — A stale settings change is refused with `record_changed` | plans/decisions.md D24 | | |
| AC-2.14 — Disconnect: `revoked`, token erased, settings and profile kept, organization free | plans/decisions.md D5 | | |
| AC-2.15 — A disconnect cancels no run; automations stay `live`; a waiting run goes on after the same account reconnects | plans/decisions.md D24 | | |
| AC-2.16 — Meta's deauthorize revokes the account and erases the token everywhere; unknown person succeeds; bad request refused | plans/decisions.md D22 | | |
| AC-2.17 — Meta's data deletion also erases profile and stored posts, not contacts, and returns a stable confirmation code | plans/decisions.md D22 | | |
| AC-2.18 — The token is encrypted, never answered or logged, read only by the Instagram connection | intake-files/schema-routes.md:766 | | |
| AC-2.19 — Lookups before the organization is known reveal only which organization holds the account | plans/decisions.md D21 | | |
| AC-2.20 — Instagram down: `instagram_unavailable` with a retry time; no app settings: `instagram_not_configured` | intake-files/schema-routes.md:471 | | |
| AC-2.21 — Every Instagram call uses Graph API v24.0 | intake-files/PRD.md:148 | | |
| AC-2.22 — Connect, disconnect, settings, deauthorize and data deletion each leave one audit entry | intake-files/schema-routes.md:458 | | |
| AC-2.23 — Every refusal carries a stable reason and a translated message | intake-files/schema-routes.md:124 | | |
| AC-2.24 — No log line holds the token, the app secret or the code | intake-files/PRD.md:176 | | |
| AC-2.25 — A read-only plan leaves connect, settings and disconnect open | plans/decisions.md D27 | | |
| AC-3.1 — The post picker lists posts and reels live from Instagram with their details | intake-files/schema-routes.md:475 | | |
| AC-3.2 — Both pickers page 1–50 (default 25) with Instagram's cursor, no total | intake-files/schema-routes.md:480 | | |
| AC-3.3 — The story picker lists live stories, each ending 24 hours after publishing | intake-files/schema-routes.md:263 | | |
| AC-3.4 — No account: both pickers answer `instagram_not_connected` | intake-files/schema-routes.md:487 | | |
| AC-3.5 — Broken or refused token: `instagram_reconnect_required`, the account leaves `connected` | intake-files/schema-routes.md:488 | | |
| AC-3.6 — Instagram down: both pickers answer `instagram_unavailable` with a retry time | intake-files/schema-routes.md:489 | | |
| AC-3.7 — Browsing never adds or changes a stored post | intake-files/schema-routes.md:784 | | |
| AC-3.8 — Stored posts belong to one Instagram account and never mix with another account's | plans/decisions.md D24 | | |
| AC-4.1 — The contact list shows each contact's details and account, newest last message first | intake-files/schema-routes.md:646 | | |
| AC-4.2 — Search finds contacts by username, full name or email, any case | intake-files/schema-routes.md:651 | | |
| AC-4.3 — Tag, email, phone, following, first-seen and account filters narrow the list; bad values refused | intake-files/schema-routes.md:372 | | |
| AC-4.4 — The automation filter lists contacts that had a run of it; unknown gives an empty page | intake-files/schema-routes.md:378 | | |
| AC-4.5 — The three sorts work both ways across pages; no username sorts last | intake-files/schema-routes.md:381 | | |
| AC-4.6 — Pages of 1–100 (default 25) with an estimated total on the first | intake-files/schema-routes.md:83 | | |
| AC-4.7 — One person on two accounts is two contacts, one per account | plans/decisions.md D25 | | |
| AC-4.8 — A new contact's profile is read from Instagram; a failed read still saves the contact | plans/decisions.md D25 | | |
| AC-4.9 — No operation adds or edits a contact | intake-files/schema-routes.md:646 | | |
| AC-4.10 — Deleting a contact hides it and empties its personal data; the record and its runs stay | plans/decisions.md D25 | | |
| AC-4.11 — A repeat, another organization's or an unknown contact delete answers `contact_not_found` | intake-files/schema-routes.md:81 | | |
| AC-4.12 — A Member is refused when deleting a contact | plans/decisions.md D23 | | |
| AC-4.13 — After a delete the same Instagram user starts a fresh contact | plans/decisions.md D25 | | |
| AC-4.14 — A contact delete's audit entry names the contact's id only | plans/decisions.md D25 | | |
| AC-4.15 — A Member sees emails and phone numbers | intake-files/schema-routes.md:149 | | |
| AC-4.16 — A read-only plan leaves contact delete open | plans/decisions.md D27 | | |
| AC-5.1 — Create stores a complete automation on the connected account, `inactive` by default, keywords and tags cleaned | intake-files/schema-routes.md:614 | | |
| AC-5.2 — Create without a not-revoked account: `instagram_not_connected` | plans/decisions.md D26 | | |
| AC-5.3 — Create needs an idempotency key; a repeat makes no second automation | intake-files/schema-routes.md:77 | | |
| AC-5.4 — Wrong trigger and scope pairs, and "specific" without its id, are refused | intake-files/schema-routes.md:602 | | |
| AC-5.5 — A DM automation without a keyword or with the DM keyword trigger off is refused | intake-files/schema-routes.md:604 | | |
| AC-5.6 — Public replies off comments, or without 1–20 texts, are refused | intake-files/schema-routes.md:605 | | |
| AC-5.7 — A missing final message or a missing message of an enabled step is refused, one error each | intake-files/schema-routes.md:606 | | |
| AC-5.8 — A comment automation with the opening message on needs a button | plans/decisions.md D26 | | |
| AC-5.9 — Bad "next post" dates are refused, each with its own message | intake-files/schema-routes.md:607 | | |
| AC-5.10 — A started window may move later, never earlier | intake-files/schema-routes.md:610 | | |
| AC-5.11 — Overlapping "next post" windows of one account sharing a keyword: `next_post_window_overlap`; concurrent saves never both pass | intake-files/schema-routes.md:612 | | |
| AC-5.12 — An edit runs every create rule on the merged automation | intake-files/schema-routes.md:626 | | |
| AC-5.13 — An expired window change returns to `waiting`; a linked one is refused `next_post_already_linked` | intake-files/schema-routes.md:629 | | |
| AC-5.14 — System-set fields and an empty edit are refused | intake-files/schema-routes.md:631 | | |
| AC-5.15 — A stale edit is refused with `record_changed` | plans/decisions.md D26 | | |
| AC-5.16 — The list hides deleted automations and filters, searches and sorts across pages | intake-files/schema-routes.md:586 | | |
| AC-5.17 — A missing, deleted or foreign automation answers `automation_not_found` | intake-files/schema-routes.md:622 | | |
| AC-5.18 — Delete needs a reason; it cancels open runs with history and keeps runs and logs | intake-files/schema-routes.md:640 | | |
| AC-5.19 — A Member may list, read, create and edit automations, not delete them | intake-files/schema-routes.md:147 | | |
| AC-5.20 — On a read-only plan create, edit and delete are refused; reads and running go on | plans/decisions.md D27 | | |
| AC-5.21 — No plan limit on the number of automations | plans/decisions.md D12 | | |
| AC-5.22 — Create, edit and delete each leave one audit entry | intake-files/schema-routes.md:632 | | |
| AC-5.23 — Duplicate copies onto the account connected now; a linked copy arrives `waiting` | intake-files/schema-routes.md:616 | | |
| AC-5.24 — Edits reach open runs from their next step; `inactive` lets open runs finish | plans/decisions.md D26 | | |
| AC-5.25 — After an account switch the old account's automations stay listed but never run | plans/decisions.md D26 | | |
| AC-6.1 — The webhook-event list shows each event and its outcome, newest first | intake-files/schema-routes.md:575 | | |
| AC-6.2 — Status, kind and time filters narrow the list; bad values and reused page tokens are refused | intake-files/schema-routes.md:267 | | |
| AC-6.3 — Payloads are masked: text cut to 40 characters, emails, phones and links hidden | plans/decisions.md D28 | | |
| AC-6.4 — A Member is refused the list; Owner and Admin see it | intake-files/schema-routes.md:150 | | |
| AC-6.5 — Only the organization's own events appear; unknown accounts' events never do | intake-files/schema-routes.md:582 | | |
| AC-7.1 — The subscription check echoes the challenge on a matching token, else `invalid_webhook_verify_token` | intake-files/schema-routes.md:508 | | |
| AC-7.2 — Without the verify token or app secret: `instagram_webhook_not_configured`, nothing stored | intake-files/PRD.md:17 | | |
| AC-7.3 — A missing or wrong signature: `invalid_webhook_signature`, nothing read or stored | intake-files/PRD.md:18 | | |
| AC-7.4 — A signed delivery is stored once per event, then answered; a repeat stores nothing new | intake-files/schema-routes.md:527 | | |
| AC-7.5 — A store failure is never a success answer; Meta's redelivery is not stored twice | plans/decisions.md D15 | | |
| AC-7.6 — A signed body that is not readable Instagram JSON gets `OK`, stores nothing, logs a warning | intake-files/PRD.md:22 | | |
| AC-7.7 — Unknown or revoked accounts' events get `OK` and are not stored; logged and counted | plans/decisions.md D28 | | |
| AC-7.8 — An entry without an account id is dropped with a log line | intake-files/PRD.md:28 | | |
| AC-7.9 — Echoes, read receipts, reactions, edits and unsupported items are stored skipped with their reason | intake-files/schema-routes.md:528 | | |
| AC-7.10 — Switch off or account broken: events stored skipped, never handled later | intake-files/PRD.md:78 | | |
| AC-7.11 — An event whose switch went off or account broke while it waited is skipped at its turn | plans/decisions.md D15 | | |
| AC-7.12 — One account's events one at a time, oldest first; accounts side by side | intake-files/schema-routes.md:529 | | |
| AC-7.13 — A failing event holds back its account's later events, then `failed` after five attempts | plans/decisions.md D28 | | |
| AC-7.14 — A permanent failure fails at once; an Instagram outage spends no attempt | plans/decisions.md D16 | | |
| AC-7.15 — Events stuck over 5 minutes are picked up again and handled once | intake-files/schema-routes.md:530 | | |
| AC-7.16 — Every event ends `processed`, `skipped` or `failed`; errors carry no payload text | plans/decisions.md D16 | | |
| AC-7.17 — Meta's deliveries are capped per sender well above its traffic; past the cap `rate_limited` | plans/decisions.md D21 | | |
| AC-7.18 — Intake and handling logs carry no payload, text, email or phone | intake-files/PRD.md:176 | | |
| AC-7.19 — A hand-sent DM's echo is skipped and does not reset the 24-hour rule | plans/decisions.md D28 | | |
| AC-8.1 — A matching comment updates the contact, stores the post, starts one run, logs `started` | intake-files/schema-routes.md:545 | | |
| AC-8.2 — Keywords match by lowercase contains; no keywords match every comment | intake-files/PRD.md:98 | | |
| AC-8.3 — Only the commented post's account's comment automations count; others untouched | plans/decisions.md D26 | | |
| AC-8.4 — A post-linked match beats an older "any post" match; the oldest post-linked runs | plans/decisions.md D26 | | |
| AC-8.5 — With no post-linked match, the oldest "any post" match runs | plans/decisions.md D26 | | |
| AC-8.6 — Every other match is logged `ignored` · `comment_already_answered` | plans/decisions.md D26 | | |
| AC-8.7 — A retried comment never chooses again | plans/decisions.md D26 | | |
| AC-8.8 — An existing run gives `already_waiting`, `run_in_progress` or `previous_run_final`; after `cancelled` a new run starts | intake-files/schema-routes.md:562 | | |
| AC-8.9 — Another run waiting for the email: the question again, the automation saved, `waiting_for_other_email` | intake-files/schema-routes.md:564 | | |
| AC-8.10 — On the email, saved automations start in order with their email step skipped | intake-files/schema-routes.md:555 | | |
| AC-8.11 — Reply safety skips in the order duplicate, random, hour limit, gap; off means always reply | intake-files/schema-routes.md:546 | | |
| AC-8.12 — A public reply never repeats the automation's last text | intake-files/PRD.md:162 | | |
| AC-8.13 — A comment never gets a second public reply | plans/decisions.md D17 | | |
| AC-8.14 — A failed public reply is logged and the flow goes on | intake-files/PRD.md:130 | | |
| AC-8.15 — Reply safety never holds back a DM | intake-files/PRD.md:166 | | |
| AC-8.16 — The opening message is a private reply unless a DM went out in 24 hours; a button makes the run wait | intake-files/schema-routes.md:553 | | |
| AC-8.17 — Button clicks move the run on; the follow step checks Instagram and asks again when not following | intake-files/PRD.md:114 | | |
| AC-8.18 — The email question goes with a quick reply and the run waits | intake-files/PRD.md:134 | | |
| AC-8.19 — A valid email is saved lowercased; an invalid one gets the wrong-email text and the question again | intake-files/PRD.md:142 | | |
| AC-8.20 — A 10–15 digit phone is saved normalised; anything else sends nothing and keeps waiting | intake-files/PRD.md:143 | | |
| AC-8.21 — Email and phone steps are skipped when the contact has them | intake-files/schema-routes.md:556 | | |
| AC-8.22 — The final message completes the run, counts it and tags the contact | intake-files/schema-routes.md:557 | | |
| AC-8.23 — Every status change and collected email or phone is in the run's history; last-sent time moves | intake-files/schema-routes.md:558 | | |
| AC-8.24 — A retry never sends a message twice; an unknown send outcome fails the step | plans/decisions.md D16 | | |
| AC-8.25 — Each send waits a random 200–1000 ms | intake-files/PRD.md:152 | | |
| AC-8.26 — A needed message refused for good fails the run with its error | intake-files/PRD.md:141 | | |
| AC-8.27 — A token error marks the account `error`, starts the notice and fails the run | intake-files/schema-routes.md:571 | | |
| AC-8.28 — Empty messages use the English default texts; a refused quick reply goes as plain text | intake-files/schema-routes.md:569 | | |
| AC-9.1 — A keyword DM starts a run of the oldest matching DM-enabled automation; one answers | intake-files/PRD.md:119 | | |
| AC-9.2 — An automation with no keywords never answers a DM | intake-files/schema-routes.md:541 | | |
| AC-9.3 — A DM answers a run waiting for an email or phone first | intake-files/schema-routes.md:537 | | |
| AC-9.4 — The email comes from a quick reply, an attachment or typed text | plans/decisions.md D18 | | |
| AC-9.5 — A `messages` change is handled as a DM | intake-files/PRD.md:80 | | |
| AC-9.6 — A story reply runs the oldest matching story automation; an expired story stops matching | intake-files/schema-routes.md:538 | | |
| AC-9.7 — DM and story triggers send the opening message as a normal DM, unless one went out in 24 hours | plans/decisions.md D26 | | |
| AC-9.8 — A click continues a run waiting for the opening button or a follow | intake-files/PRD.md:113 | | |
| AC-9.9 — Clicks on finished, cancelled, deleted-automation or other-account runs are ignored | plans/decisions.md D18 | | |
| AC-9.10 — A click while another run waits for an email asks for the email again | intake-files/PRD.md:111 | | |
| AC-9.11 — Only a follow-button click confirms a follow | intake-files/PRD.md:115 | | |
| AC-9.12 — An open or final run blocks a second run of that automation for the contact | plans/decisions.md D14 | | |
| AC-9.13 — A story reply while another run waits for an email is saved on it and the question asked again | intake-files/schema-routes.md:555 | | |
| AC-9.14 — A failed DM or story run keeps its error after the handling is undone | intake-files/PRD.md:144 | | |
| AC-10.1 — The first comment on a post inside a waiting window links the automation | intake-files/schema-routes.md:536 | | |
| AC-10.2 — A just-linked automation counts as linked for that same comment | plans/decisions.md D26 | | |
| AC-10.3 — A post another automation of the account targeted before is never taken | intake-files/schema-routes.md:536 | | |
| AC-10.4 — Two waiting automations may link one post; the older answers | plans/decisions.md D26 | | |
| AC-10.5 — Only the post's own account's live automations link | plans/decisions.md D26 | | |
| AC-10.6 — A failed link never stops the comment | intake-files/PRD.md:92 | | |
| AC-10.7 — Waiting or expired "next post" automations answer no comment | intake-files/PRD.md:93 | | |
| AC-10.8 — An ended unlinked window becomes `expired` within 15 minutes; repeats change nothing | plans/decisions.md D9 | | |
| AC-10.9 — A linked post is stored once | intake-files/schema-routes.md:784 | | |
| AC-11.1 — The daily check renews a token ending within 7 days | plans/decisions.md D9 | | |
| AC-11.2 — The daily check refreshes the profile | plans/decisions.md D9 | | |
| AC-11.3 — The daily check subscribes an unsubscribed account again | plans/decisions.md D24 | | |
| AC-11.4 — Instagram down with a valid token: stays `connected`, error kept, retried next day | plans/decisions.md D24 | | |
| AC-11.5 — A refused token gives `error` or `expired`; an ended token `expired` without a call | plans/decisions.md D24 | | |
| AC-11.6 — The check is safe to repeat and never overwrites a newer token | plans/decisions.md D24 | | |
| AC-11.7 — A break notifies every account manager once, in-app and by email | plans/decisions.md D10 | | |
| AC-11.8 — One notice per break; a new break after a reconnect is told again | plans/decisions.md D24 | | |
| AC-11.9 — Members without manage rights get no notice | plans/decisions.md D10 | | |
| AC-11.10 — Reconnecting a broken account makes it `connected` | intake-files/schema-routes.md:454 | | |
| AC-12.1 — A run waiting over 7 days is cancelled with history; its saved automations never start | plans/decisions.md D8 | | |
| AC-12.2 — A just-answered run is not cancelled; a repeat check changes nothing | plans/decisions.md D8 | | |
| AC-12.3 — Runs ended over 180 days ago go with their history; open runs never | plans/decisions.md D8 | | |
| AC-12.4 — Comment logs over 180 days old go | intake-files/schema-routes.md:953 | | |
| AC-12.5 — Webhook events over 30 days old go, any status | intake-files/schema-routes.md:808 | | |
| AC-12.6 — A deleted automation is purged 180 days later once nothing points at it | plans/decisions.md D26 | | |
| AC-12.7 — Contacts and stored posts have no time-based removal | plans/decisions.md D8 | | |
| AC-12.8 — A contact delete cancels its open runs and clears every personal copy on runs and comment logs | plans/decisions.md D25 | | |
| AC-12.9 — A contact delete is all or nothing | plans/decisions.md D25 | | |
| AC-12.10 — A deleted contact's webhook events stay, masked, until the 30-day clean-up | plans/decisions.md D25 | | |
| AC-12.11 — A run whose contact is deleted mid-run sends nothing more | plans/decisions.md D25 | | |
| AC-12.12 — Deleting the organization removes all its app data | intake-files/schema-routes.md:684 | | |
| AC-12.13 — Logs carry no contact email, phone, name, username, picture or message text | intake-files/PRD.md:176 | | |
