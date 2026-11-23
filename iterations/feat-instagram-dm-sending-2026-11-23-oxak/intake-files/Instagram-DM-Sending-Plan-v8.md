# Instagram DM Sending: Full Plan (version 8)

**Status: FULL plan, version 8 (final for the build), 23 November 2026. Not built yet.**
It includes everything in version 7, plus the Flowdm v4 product (15 ways to start, message lists, message kinds, hello buttons and versions, nudge, hiding comments, tags, contacts, many accounts, DMs per month), Unified Login only (no Instagram Login), what Meta's docs say we must handle, and the product around sending (sign-in, team, roles, plans, settings, notices, refer, later features).
All speed and size numbers are estimates. Nothing was load-tested.

## Contents

**Part A. Start here**

- 1. How to read this plan
- 2. All decisions in one table
- 3. The whole system in one picture

**Part B. What people and owners see**

- 4. Ways to start
- 5. Automation steps and messages
- 6. Message types and lanes
- 7. Comment flow
- 8. Story reply, DM and other message flows
- 9. Once rule, 24 hours and the chat window
- 10. Limits
- 11. Timing that looks human
- 12. 7 days, expired, and the estimate
- 13. Public replies (ON and OFF) and hiding comments
- 14. Follow check, email, phone, her answers, stop words
- 15. What the owner sees and can do
- 16. Riya examples

**Part C. Data in meepzo-be**

- 17. Table map: plan to meepzo-be
- 18. Existing meepzo-be tables: what changes
- 19. New tables
- 20. Statuses and state pictures
- 21. Partitions and how long rows stay
- 22. Row security, roles and the organization context
- 23. Redis keys

**Part D. The sending engine**

- 24. Queues, workers and places
- 25. Meta login and connect
- 26. Webhook
- 27. Intake
- 28. Slow lane turn (opening DMs)
- 29. Reply lane turn (public replies ON and OFF, hides)
- 30. Fast messages (many at once)
- 31. The gates (+ month count), and Redis down or empty
- 32. Every wait in one table
- 33. Instagram errors, stops and tests
- 34. Helper (every minute)
- 35. Locks, transactions and timeouts

**Part E. Running it**

- 36. Settings file (every number)
- 37. Neon (Postgres) setup
- 38. Deploy, restart and many servers
- 39. Backup, restore and test copies
- 40. Health checks and alerts
- 41. Security and privacy
- 42. Size for 1,000 accounts (speed and storage)
- 43. Tests to run with Meta before building

**Part F. The product around sending**

- 44. Sign-in and security
- 45. Workspaces, members and roles
- 46. Plans, billing and limits
- 47. Profile, settings, notifications and notices
- 48. Refer
- 49. Later features (moved to their own file)

**Part G. Build and track**

- 50. Build steps in meepzo-be
- 51. Review items: where each one is fixed
- 52. Decision history
- 53. Open items

---

# Part A. Start here

## 1. How to read this plan

**Status: FULL plan, version 8, 23 November 2026, not yet built.** No code is written. Nothing in meepzo-be is changed yet. All speed and size numbers are estimates. Nothing was load-tested.

**Who it is for**

1. The owner of the project: to check every rule before the build.
2. Senior developers: to review the design.
3. A developer or an AI coding agent: to build the backend inside meepzo-be, and to know what meepzo-fe (the frontend) can ask the backend for.

**How it is split**

| Part | Sections | What is inside |
|---|---|---|
| A. Start here | 1 to 3 | Words, all decisions, the whole system in one picture |
| B. What people and owners see | 4 to 16 | Ways to start, steps and messages, flows, limits, timing, replies, banners, examples |
| C. Data in meepzo-be | 17 to 23 | Tables, columns, statuses, partitions, row security, Redis keys |
| D. The sending engine | 24 to 35 | Queues, Meta login, webhook, intake, lanes, gates, errors, helper, locks |
| E. Running it | 36 to 43 | Settings, Neon, deploy, restore, alerts, security, size, tests with Meta |
| F. The product around sending | 44 to 49 | Sign-in, workspaces and roles, plans, settings and notices, refer, later items |
| G. Build and track | 50 to 53 | Build steps, review fixes, decision history, open items |

**Signs used in the text**

| Sign | Meaning |
|---|---|
| `NUDGE_AFTER_MINUTES` 60 | A setting in the settings file (section 36) and its value. The code uses the name, never the number. |
| estimate | A number we worked out, not measured. |
| test needed (section 43) | Meta's pages do not confirm it. We test it with a real account before we build on it. |
| PRO | Only on the paid plans Creator and Studio (D35). |
| D30 | Decision 30 in section 2. |
| Riya | The person who writes to an account. The owners of account A and account B run the shops. |

### 1.1 What is new in version 8

1. **Flowdm v4 is the product** (D23). This plan designs its backend in meepzo-be. Screens belong to meepzo-fe.
2. **15 ways to start** (section 4): comments, Live comments, story replies and mentions, DMs, first messages, shared posts, starter questions, links and QR codes, "no other automation answered", ads, and tags.
3. **Message list and kinds** (section 5.9): 1 to 10 messages, 7 kinds (text, image, cards, quick replies, audio, file, post), a wait of up to 23 hours before each one.
4. **Hello buttons and versions** (section 5.6): up to 3 buttons, `{name}`, up to 3 versions picked at random.
5. **Nudge** (section 5.6): the hello goes once more after 1 hour without a tap, only when she messaged first.
6. **Hide their comment** (section 5.13): after the DM and the public reply.
7. **Public replies per automation** (section 13): "Reply like a person" ON (PRO, human pace, the default on Creator and Studio) or OFF (right after the DM, the only choice on Free). `@username` first can be turned off per automation.
8. **Tags** (section 5.12): a tag step, a tag list with counts, and "tag added" or "tag removed" as a way to start.
9. **Contacts** (section 15): "via" automation, private note, tags for many at once, "what happened".
10. **Many Instagram accounts per workspace** (D26): 1, 3 or 10 by plan.
11. **DMs per month** (section 10): one month count per workspace, checked in the send commit, notices at 80% and 100%. At the limit only new DMs stop; public replies and hides of DMs that already went still go.
12. **Stop words** (section 14): after a stop word she starts again only by her own new keyword comment, keyword DM, starter question tap or ig.me link (D49).
13. **Unified Login only** (section 25): Meta's login for businesses. One token covers all accounts of one business portfolio. Instagram Login is not used: its code is removed from meepzo-be, and nothing is moved (a new app, no customers). A test with 2 creators shows how hard the business-portfolio step is, so we design help screens for it.
14. **Draft, live, paused** and a go-live check (section 5.1). All-time counters "1.3k runs · 51% tapped" (D36).
15. **Part F, the product around sending** (sections 44 to 49): sign-in, workspaces, roles, plans, settings, notices, refer.
16. **Account settings** (section 5.15): replies under comments can start automations (or not), "once per person per post" can be switched to "every time", "mark as seen" after our reply, and an extra delay before each answer (PRO).
17. **Broadcasts** (section 8, PRO): messages to an audience made of conditions (tags, automations, activity, details), only to people whose chat is open: now, at a set time, or when her chat opens. They go in a 4th lane, `broadcast`.
18. **Run on past comments** (section 5.16, PRO): a comment automation can also answer comments from the last 1 to 7 days.
19. **Pause automations for one person** (section 15): the owner can switch off every automation and broadcast for one contact, and switch it on again (D71).
20. **Retry failed messages** (section 15): `failed` messages of the last 30 days go once more, only if Meta's rules still allow it now (D72).
21. **7-day free trial** of Creator and Studio, no card (D73, section 46).
22. **Later items** (section 49): not part of this build. They are listed in `Instagram-DM-Later-Features-v8.md`.

### 1.2 Words used in this plan

| Word | What it means | Real-life example |
|---|---|---|
| Queue | A waiting line of small jobs. All accounts share it. | One line at a bank counter for all customers. |
| Ticket (job) | One small note in a queue: "go and look at this lane" or "send this message". It holds ids only, never a text or a person. | A token number. The token is not the parcel. |
| Delayed ticket | A ticket that becomes visible only at a set time. | An alarm on your phone. You do other work until it rings. |
| Worker | A program that takes one ticket, does the work, and takes the next one. | A delivery rider who takes any parcel of any shop. |
| Place | How many tickets one worker type handles at the same moment on one server. Not a DM limit. | 50 riders on duty at once. |
| Lane | One sending line of one account: `slow`, `reply`, `fast` or `broadcast` (D4). | One counter of one shop. |
| Turn | One go of the slow lane or the reply lane: pick one message, send it, plan the next one. Each turn has a number (`turn_no`). | "Now serving number 41." |
| Lease | A short time (2 minutes) in which a worker owns a lane. If it dies, the lease ends and the helper repairs the lane. | A meeting room booked for 2 minutes. |
| Lock | Postgres lets only one worker change a row at a time. | One key for one room. |
| Transaction, commit | A group of database changes that are saved all together, or not at all. "Commit" is the moment they are saved. | A bank transfer: money leaves one account and arrives in the other, or nothing happens. |
| Gate | A check before sending: "is there room under the limit?" Gate 1 is fast (Redis). Gate 2 is exact (Postgres). The month count is checked in the same commit as gate 2 (D18). | A guard at the door (gate 1) and the cashier who counts again (gate 2). |
| Partition | A big table split into parts by time (a day, a week, a month). Old parts are dropped in one step. | One notebook per month. Throw away old notebooks instead of erasing pages. |
| Row security | Postgres shows a row only to its own organization. meepzo-be uses it on every table. | A locker: each team opens only its own. |
| Organization (workspace) | A team in meepzo-be. Flowdm calls it a workspace. It owns its connected Instagram accounts (1, 3 or 10 by plan), its members and its plan. | A shop company with up to 10 counters. |
| Redis | Fast memory. It holds the queues, the tickets, fast counts and short notes. It can be rebuilt. | A whiteboard. |
| Postgres | The main database (on Neon). It holds the truth. | The account book. |
| BullMQ | The queue library meepzo-be uses on top of Redis. | The bank's token machine. |
| Webhook | Meta calls our server when something happens: a comment, a tap, a DM. | A doorbell. |
| Private reply | An opening DM sent as an answer to her comment. Meta allows one per comment, up to 7 days after it (on a Live: only while it is on). | A note slipped under her door. |
| Public reply | Our reply under her comment, visible to all. | Answering her in front of everyone. |
| Chat window | 24 hours after her last message or tap. Inside it we may send normal DMs. A comment does not open it. | Shop opening hours. |
| Run | One automation working for one person: steps, what it waits for, its status (`app.automation_runs`). | One customer order. |
| Contact | One person who talked to one account (`app.contacts`). | A customer card. |
| Message | One thing we want to send, waiting or sent (`app.instagram_messages`). | One parcel. |
| Attempt | One call to Instagram and its result (`app.instagram_send_attempts`). | One delivery try. |
| Box | A small piece of time. One message goes at a random second inside it. | A 6-second slot. |
| Automation | One set-up that starts on a way to start and answers for one account (`app.automations`). | A recipe card the shop follows for one kind of order. |
| Step | One part of an automation, for example "Say hello first". Steps run in a fixed order (section 5.2). | One line of the recipe. |
| Way to start | What starts an automation (its `trigger_type`). There are 15 (section 4). | The door bell, the phone or the counter bell. |
| Once key | `post_key` on the run. One run per automation, person and key (D13, section 4.2). | A stamp on her card: "served for this post". |
| Hello | The first message of a run, with up to 3 buttons (type `opening_message`). | "Welcome! Tap here for the menu." |
| Version | One of up to 3 texts of the hello or the follow ask. One is picked at random for each run and saved (`version_no`). | Two posters for one sale. Half the people see each. |
| Nudge | The hello sent once more after 1 hour without a tap, only when she messaged first (type `nudge`). | The shopkeeper asks once more: "Did you see the menu?" |
| Message list | The messages of the step "Send your messages": 1 to 10, each with a wait before it (type `message`, `message_no` 1 to 10). | Parcels sent one after another. |
| Message kind | What one message of the list is: `text`, `image`, `cards`, `quick_replies`, `audio`, `file`, `post` (`message_kind`). | A letter, a photo, a catalogue, a voice note. |
| Wait | Time before one message of the list: none, or 1 minute to 23 hours. It is a delayed ticket. | "Send the second parcel tomorrow morning." |
| Draft | A saved automation that does not answer yet. It needs only a name. | A recipe still being written. |
| Go live | The full check (section 5.1), then status `live`: the automation answers. | Opening the shop after the inspection. |
| PRO | A feature only on the paid plans Creator and Studio. | The members-only counter. |
| Plan | Free, Creator or Studio. Its row holds DMs a month, accounts and PRO features (`billing.plans`, section 46). | The rent contract: how much space you get. |
| Month DM count | DMs sent into chats by one workspace this calendar month (`app.dm_month_counts`, D34). | A meter that counts every parcel this month. |
| Starter question | One of up to 4 questions Instagram shows when someone opens the chat. Meta calls it an "ice breaker". A tap starts an automation. | Buttons at the shop door: "Prices?", "Timings?". |
| Ref link | `https://ig.me/m/<username>?ref=<ref_code>`. It opens her chat with the account and tells us which automation (D43). Also printed as a QR code. | A coupon with a code that says which poster she saw. |
| Tag | A label on a contact, like "vip" (`app.contacts.tags`). | A coloured sticker on a customer card. |
| Unified Login | Meta's login for businesses ("Instagram API with Unified Login"), the only login we use. She logs in with Instagram or Facebook, picks a business portfolio and accounts. We get one system user token (D24). | One master key from the mall office for all your shops in that mall. |
| Business portfolio | Meta's folder for one business: its Instagram accounts, Pages, ad accounts and people. Its id is `client_business_id`. | The company file at the mall office. |
| Login configuration (`config_id`) | A set-up inside our Meta app that says what the login asks for. Its id goes in the login link. It is not secret. | The form the mall office hands out. |
| System user token | The token Unified Login gives. It belongs to her business portfolio, not to a person. By default it never expires. | A company key card, not a person's own key. |
| Meta connection | One login of a workspace to one business portfolio (`app.meta_connections`). Its token covers all accounts it connected. | The contract between your shop company and the mall office. |
| Broadcast | One message set the owner sends to many people at once, only to those whose chat window is open (D68, PRO). Not an automation. | A shop announcement, said only to customers who are in the shop now. |
| Segment (audience) | A saved list of conditions on one account, like "has tag vip AND wrote in the last 7 days" (`app.segments`). | A filter on the customer cards. |
| Paused person | A contact for whom the owner switched off all automations and broadcasts (`automations_off_at`, D71). The owner can switch it on again. Not the same as her stop word. | A "do not disturb" note the shop puts on one customer card. |
| Past comments run | A one-time job that lets a comment automation also answer comments of the last 1 to 7 days (`app.automation_backfills`, D69). | Calling back the customers who rang while the shop was closed. |
| Advanced Access | Meta's approval to use a permission with customers who have no role on our app. Given after App Review (section 41). | A trade licence. Without it you may sell only to your family. |

---

## 2. All decisions in one table

"User" = the user decided. "User (Flowdm v4)" = it comes from the user's Flowdm v4 requirements. "User (Claude's suggestion, approved)" = Claude suggested it and the user approved it on 23 Nov 2026. "Claude" = Claude proposed it. Rows from version 7 were approved by the user. New Claude rows are approved with this plan. Long values point to their section.

| # | Decision | Value | Decided by | Date |
|---|---|---|---|---|
| D1 | Where it is built | Inside meepzo-be, schema `app`, branch `feat/instagram-automation`. The `app` migrations are changed in place. Other domains get new migrations only (D48). meepzo-be's design-iteration process is followed (section 50) | User | 23 Nov 2026 |
| D2 | Database | Postgres on Neon. The app uses Neon's pooler link. Migrations and partition work use the direct link. No connection pooler of our own (section 37) | User (Neon), Claude (details) | 22 and 23 Nov 2026 |
| D3 | Queues | 3 common queues for all accounts: intake (`instagram-webhook`), slow (`instagram-send-slow`, also the broadcast lane's tickets), fast (`instagram-send-fast`). Never one queue per account. Jobs around sending (account set-up, starter questions, file uploads, token check, bulk tags, month wake, plan changes, segment counts, broadcast audiences, past comments, retry failed messages) use a 4th queue, `instagram-tasks`, which sends no DM (section 24) | User (3 queues), Claude (`instagram-tasks`) | 22 and 23 Nov 2026 |
| D4 | Lanes per account | `slow`: opening DMs as private replies, one at a time. `reply`: public replies and hide-comment calls (D33), one at a time. `fast`: all other DMs, Live-comment private replies (D40), nudges (D30) and "mark as seen" calls (D66), many at once. `broadcast`: broadcast messages, one at a time, lowest priority (D68) (section 6) | Claude, User (broadcast lane: Claude's design, approved) | 23 Nov 2026 |
| D5 | Opening DM limit | 600 per hour (`OPENING_HOUR_LIMIT_DEFAULT`), owner up to 700 (`OPENING_HOUR_LIMIT_MAX`), Meta allows 750. New account: 150 per hour (`NEW_ACCOUNT_HOUR_LIMIT`) for 7 days (`NEW_ACCOUNT_DAYS`); any owner value replaces it. Day limit OFF (`DAY_LIMIT_ENABLED`) (section 10) | User (600, day limit), Claude (review: new account) | 22 and 23 Nov 2026 |
| D6 | Opening DM timing | Box = 3600 / hour limit. One DM at a random second in each box, at least 1,500 ms apart (`OPENING_MIN_GAP_MS`). Missed boxes are never sent together. Half speed = box 2 times bigger (section 11) | User (box), Claude (half speed) | 22 Nov 2026 |
| D7 | Opening DM pick | New (under 60 minutes, newest first) and old (oldest first). Mix 4 new : 1 old. Under 12 hours left: 3 new : 2 old (section 28) | Claude | 22 Nov 2026 |
| D8 | 24-hour rule | Window closed: one opening DM (private reply) per person per 24 hours. Window open: the opening message goes at once as a normal DM in the fast lane, no 24-hour wait (section 9) | User | 23 Nov 2026 |
| D9 | 7 days | Opening DM and public reply: up to 7 days after the comment (`trigger_occurred_at`), minus 30 minutes (`EXPIRY_SAFETY_MINUTES`). Then `expired` (section 12) | User (7 days), Claude (30 min) | 23 Nov 2026 |
| D10 | Estimate | Banner "will go / may expire" per account, every 10 minutes (`PENDING_ESTIMATE_EVERY_MINUTES`) (section 12) | User asked, Claude formula | 23 Nov 2026 |
| D11 | Fast lane | Own ticket per message, random 500 to 2,000 ms (`FAST_DELAY_MIN_MS`, `FAST_DELAY_MAX_MS`), at most 20 at once per account (`FAST_MAX_PARALLEL_PER_ACCOUNT`), one person at a time, 10,000 per hour (`FAST_HOUR_LIMIT_DEFAULT`). Person limit 60 per hour (`PERSON_HOUR_LIMIT_DEFAULT`, Postgres only, a loop guard). Answers well under Meta's 30 seconds (section 30) | User (parallel, 10,000, person limit), Claude (safety rules) | 22 and 23 Nov 2026 |
| D12 | Follow check | 2 tries (`FOLLOW_CHECK_TRIES`). Both fail: treat her as following and go on. Account stop errors still stop (section 14) | User | 23 Nov 2026 |
| D13 | Once rule | One run per automation, person and once key (`post_key`). The key of each way to start is in section 4.2. The old run is deleted about 90 days after it ended (`RUN_KEEP_DAYS`; parts drop by month, so the day is approximate), so she may get it again then; "first message" is once ever. The account switch `once_per_person_per_post` OFF makes the key the event's own id (D65) (section 9) | User (once per automation per post), Claude (keys of the new starts) | 23 Nov 2026 |
| D14 | Public replies | Replaced by D32: ON or OFF per automation, "Reply like a person" ON or OFF. The 5 public reply columns of `app.instagram_account_settings` are removed (section 13) | User | 23 Nov 2026 |
| D15 | Events kept | Webhook events 8 days (`WEBHOOK_EVENT_KEEP_DAYS`). Body cleared when done. Read receipts and our own "sent" notices are not saved (section 26) | Claude (user: "think best") | 23 Nov 2026 |
| D16 | History kept | Runs, run history, comment logs: 90 days. Messages: 30 days (D50). Send attempts: 8 days (section 21) | User | 23 Nov 2026 |
| D17 | Result not clear | `unknown`, for every message kind: never sent again by itself. Only her next message or tap may send that step once more (the same row back to `waiting`). Her run waits for `any`. A tap proves only the message that carries that button (section 14) | User | 22 Nov 2026 |
| D18 | Gates | Gate 1: Redis count, asked before the Postgres transaction. Gate 2: Postgres minute counts, +1 in the same commit that sets `sending`. A third check in that same commit: the month DM count (D34). Redis is never called inside a transaction (section 31) | User (two gates), Claude (minute counts, month check) | 22 and 23 Nov 2026 |
| D19 | Errors | Sending starts again by itself after an Instagram error. Code 4 is "app limit" only without a subcode and from 2 accounts within 5 minutes. Code 4 with a subcode stops only that account's lane (section 33) | User (start again), Claude (review: code 4) | 22 and 23 Nov 2026 |
| D20 | Restore and copies | A Neon copy or restore can never send: environment id check, and the global switch `SENDING_ENABLED` outside the database (section 39) | Claude (review) | 23 Nov 2026 |
| D21 | Deploy | Rolling restart. A server finishes its sends on the way (30 seconds, `SHUTDOWN_SECONDS`). A newer settings version may start, an older one may not (section 38) | Claude (review) | 22 and 23 Nov 2026 |
| D22 | Settings | Every number in one settings file. Owner values in `app.instagram_account_settings`, empty = file value. No secrets in the file. Values per plan (DMs a month, accounts) live in the billing plan row (section 36) | User | 22 Nov 2026 |
| D23 | Product | Flowdm v4 (prototype Version 181) is what we build. This plan designs its backend in meepzo-be. Screens are meepzo-fe's, named only where the backend serves them | User | 23 Nov 2026 |
| D24 | Meta login | Unified Login only: `config_id`, `graph.facebook.com`, `META_GRAPH_VERSION` v27.0, a system user token that never expires by default, a business portfolio needed, no Facebook Page. Instagram Login is not used and is removed from meepzo-be; nothing is migrated (no customers yet). A test with 2 creator accounts without a business portfolio shows how hard that step is, so we design help screens (section 43). Gaps: no handover, no login through the Instagram app, no personal-to-professional switch during login. Permissions now: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `ads_read`. 6 webhook fields (section 4.5) | User (Unified Login only), Claude (details) | 23 Nov 2026 |
| D25 | Connect | Login, business id, assigned accounts, the owner picks accounts (up to the plan limit), lanes in the same commit, then an `account-setup` job per account: profile read, `subscribed_apps`. One token per connection. A daily `token-check` job (`TOKEN_CHECK_EVERY_HOURS` 24), no renewal; a token error = login stop + "Reconnect" (section 25) | Claude | 23 Nov 2026 |
| D26 | Many accounts | Accounts per workspace: Free 1, Creator 3, Studio 10 (`instagram_accounts_max` in the plan row). One workspace per Instagram account stays. Plan check at connect under a lock. Account routes get `:instagram_account_id` (section 25) | User (Flowdm v4), Claude (details) | 23 Nov 2026 |
| D27 | Room for later | `channel` column (`instagram` only for now) on `app.automations` and `app.contacts`. New `app.meta_connections`. Facebook Pages later = a second login configuration in the same Meta app (section 49) | User (Messenger later), Claude (columns) | 23 Nov 2026 |
| D28 | Automation status | `draft`, `live`, `paused`. A draft needs only a name. The full check runs at "Go live" and at every save of a live or paused automation. Pause: Keep (people in the middle finish) or Cancel (section 5.1) | User (Flowdm v4), Claude (details) | 23 Nov 2026 |
| D29 | Message list | 1 to 10 messages (`AUTOMATION_MESSAGES_MAX` 10), 7 kinds, a wait of none or 1 minute to 23 hours (`MESSAGE_WAIT_MAX_HOURS` 23), condition "Always" only. Text up to 1,000 bytes (`MESSAGE_TEXT_MAX_BYTES` 1000), with buttons up to 640 characters. Each call into her chat = 1 DM; an image + text = 2 rows with the same `message_no`. Window check before each; closed = that message `skipped` `window_closed`, no rows for the rest, run `cancelled` (`window_closed`) (sections 5.9, 5.10) | User (Flowdm v4), Claude (details) | 23 Nov 2026 |
| D30 | Hello | Up to 640 characters, up to 3 buttons ("opens a link" or "sends your next step"), `{name}`, up to 3 versions. Later steps need a "next step" button. Nudge after 1 hour (`NUDGE_AFTER_MINUTES` 60), once, only when she messaged first (section 5.6) | User (Flowdm v4), Claude (nudge rules) | 23 Nov 2026 |
| D31 | Follow, email, phone | Follow ask has versions. Email and phone: 1 to 10 wordings (`QUESTION_WORDINGS_MAX` 10), one at random, never the same as the last one to her. Phone after email. Email and phone are PRO (sections 5.7, 5.8) | User (Flowdm v4), Claude (details) | 23 Nov 2026 |
| D32 | Public replies | ON or OFF per automation, 1 to 20 lines (at least 3 with "Reply like a person" ON, D52), `@username` first unless turned off (D63). "Reply like a person" ON is the default for new automations on Creator and Studio (D59). OFF, the only choice on Free: right after the DM, every comment, no pace, no hour cap. ON (PRO): hour limit 10, 20, 30, 60 or 100 (`REPLY_LIKE_PERSON_LIMITS`, default 60), box, 20 s after the account's last ON reply, about 80%, newest first, 500 waiting per automation. Both: 7 days, then `expired` (section 13) | User (OFF = no pace, ON default on paid plans), Claude (ON details) | 23 Nov 2026 |
| D33 | Hide comment | Option "Hide their comment once the DM is sent". Public reply first, then hide. Reply lane, type `hide_comment`, not a DM, not counted. A failed hide stops nothing (sections 5.13, 13) | User (Flowdm v4), Claude (order, lane) | 23 Nov 2026 |
| D34 | DMs per month | Per workspace, calendar month in its time zone. Free 1,000, Creator 10,000, Studio 50,000 (`dm_month_limit`). Every message into her chat counts; public replies, hides and follow checks do not. At 80% (`DM_MONTH_NOTICE_PERCENT`) and at 100%: a notice and one email each, once per month. 100%: only new DMs stop: stop `plan_limit` on the `slow`, `fast` and `broadcast` lanes; the `reply` lane goes on, so public replies and hides of DMs that already went still go (D62); a DM whose 7 days end while it waits becomes `expired` (`plan_limit`) (her window or a Live that ends gives `window_closed` or `live_ended` as usual); the 1st of the month or an upgrade wakes the lanes (section 10) | User (what counts), Claude (count design) | 23 Nov 2026 |
| D35 | Plan states | Free never ends. Payment failed: send until the grace date (14 days). A cancelled paid plan ends at the period end: stop `plan_ended` (no grace; grace only after a failed payment). Plan ended: stop `plan_ended`, no go-live. A move to a smaller plan starts at the period end and never stops an automation: the PRO parts the new plan lacks are switched off by the plan (D57). Workspace `SUSPENDED`: like the team suspend. PRO (Creator and Studio): email and phone, "Reply like a person", more than 1 reply line, versions, broadcasts (D68), past comments (D69), delay before each message (D67). Studio also: priority support. Creator and Studio: a 7-day free trial with no card, once per workspace and Instagram account (D73). Team members and all 4 roles: every plan (D55) (section 46) | User (Flowdm v4), Claude (details) | 23 Nov 2026 |
| D36 | Counters | All-time `runs_started`, `taps`, `typed_answers`, and per version `runs_by_version`, `taps_by_version`, `typed_by_version`, in `app.automation_counts` (16 slots, slot = run id mod 16, `AUTOMATION_COUNT_SLOTS`), saved in the same commit as the event. Shown as "1.3k runs · 51% tapped" (D61). They survive the 90-day run delete (section 15) | Claude, User (typed answers, D61) | 23 Nov 2026 |
| D37 | Ways to start | All 15. Story repost: test needed, built only if Meta sends it. "They follow you": not offered. Match order: her own run, exact source, keyword, first message, "no other answered". One automation per message; one per comment (section 4) | User (all 12 new starts), Claude (match order) | 23 Nov 2026 |
| D38 | Also start from | `also_start_from`, empty by default. Comment: + story reply, DM. Story reply: + DM. DM keyword: + story reply. A comment is never added to the others (section 5.4) | User (Flowdm v4), Claude (off by default) | 23 Nov 2026 |
| D39 | Targeting and keywords | Posts: any, my next post, between two dates, one post. Stories: any or one. Keywords: "contains" + one wrong letter in words of 5+ letters, also inside keywords of several words (D60). Same meaning: later. Warning when 2 live automations share a word. A "try it" route (section 5.5) | User (Flowdm v4), Claude (typo rule) | 23 Nov 2026 |
| D40 | Live comments | `live_comments` field. Private reply only while the Live is on: fast lane, one per comment, in the fast limit and the month count. Live over: `expired` `live_ended`. No public reply, no hide (section 7) | User (all new starts), Claude (lane) | 23 Nov 2026 |
| D41 | Ads | Ad comment: like a comment; the comment webhook carries `media.ad_id`; offered once our test passes (reply, hide, ads that are not boosted posts: test needed). Ad "Send message": referral source ADS + `ad_id`, fast lane. Ad picker with `ads_read`. Window after the ad: 24 hours unless 7 days is confirmed (sections 4, 5.5) | User (all new starts), Claude (details) | 23 Nov 2026 |
| D42 | Starter questions | `starter_questions TEXT[]`: 1 to 4 per automation; at most 4 live per account (`STARTER_QUESTIONS_MAX` 4, Meta). Go-live refused when the account total would go over 4. A `starter-questions` job (queue `instagram-tasks`) sets the account's ice breakers when one goes live, pauses or changes (section 5.5) | User (Flowdm v4: 4 in one automation), Claude | 23 Nov 2026 |
| D43 | Link or QR | `ref_code` per link automation (letters, digits, `-`, `_`, `=`; up to 64 characters, `REF_CODE_MAX_CHARS` 64, Meta allows 2,083; unique per account). Link `https://ig.me/m/<username>?ref=<ref_code>`. QR made by the frontend (section 5.5) | Claude | 23 Nov 2026 |
| D44 | Message starts | First message: a person we never heard from in DMs. Your post sent to you: any or one post. Story mention. "No other automation answered": once a day per person (default) or every time (section 4) | Claude | 23 Nov 2026 |
| D45 | Tags | `app.contacts.tags` stays. Tag list with counts (cached 60 s). Tag step adds tags when she finishes. A tag added or removed = a row in `app.contact_tag_events`, written in the same commit as the tag change (kept 8 days), then queued into intake; the helper queues rows that were not queued. Tag starts need an open window. Bulk in pieces of 500 (`TAG_BULK_PIECE`). Never starts itself (section 5.12) | Claude | 23 Nov 2026 |
| D46 | Contacts | `first_automation_id` ("via"), private `note` (`CONTACT_NOTE_MAX_CHARS` 2000), phone search, sorts, tags for many at once, a detail route. "What happened": our messages of the last 30 days (D50) and her saved answers; her own free text is never kept (section 15) | User (Flowdm v4), Claude (details) | 23 Nov 2026 |
| D47 | Later | Not part of this build. All later features are listed in `Instagram-DM-Later-Features-v8.md` (section 49). Each permission is asked only when its feature is built | User (Messenger, Facebook, ads later), Claude (list) | 23 Nov 2026 |
| D48 | Product around sending | Built on meepzo-be's domains. Changes in Part F. Merged domains (auth, tenancy, billing, user, notify, upload, audit) get new migrations only (sections 44 to 50) | Claude | 23 Nov 2026 |
| D49 | Stop word | `opted_out_at` set: nothing automatic goes to her on that account (waiting messages `skipped` `opted_out`, open runs `cancelled` `opted_out`). She starts again only by her own new action that matches a keyword comment (post, reel, Live or ad comment), a keyword DM (also through "also start from" DM), a starter question tap or an ig.me link: that clears `opted_out_at` and the run starts normally. "No other automation answered", tag starts, nudges, story replies, mentions and shared posts never restart her. The owner cannot restart her by hand. A new stop word stops her again (sections 4.3, 14) | User | 23 Nov 2026 |
| D50 | Messages kept | `app.instagram_messages` rows 30 days (`MESSAGE_KEEP_DAYS` 30; weekly parts dropped after 30 days). "What happened" shows the last 30 days of our messages. Runs, run events and comment logs stay 90 days (section 21) | User | 23 Nov 2026 |
| D51 | Contacts kept | No clean-up by age. A contact stays until the owner deletes it, Meta asks to delete the data, or the workspace is deleted (section 15) | User | 23 Nov 2026 |
| D52 | Public reply lines | "Reply like a person" ON needs at least 3 lines (`PUBLIC_REPLY_LINES_MIN_ON` 3, a go-live check). OFF: 1 line is enough. Free: OFF only (sections 5.11, 13) | User | 23 Nov 2026 |
| D53 | Referral payout | Minimum payout $50 (`REFERRAL_MIN_PAYOUT_USD` 50); a smaller amount rolls over to the next month. Still open: how money is paid, and for how long a friend earns (section 48) | User | 23 Nov 2026 |
| D54 | Email defaults | Email ON by default: automation stopped or error, DM limit nearly reached (80%) and reached (100%), team changes, billing, weekly summary. Email OFF by default (in-app only): "new contact left details", and "a broadcast or a past-comments run is done" (types `broadcast.done`, `automation.backfill_done`). Security and billing emails cannot be turned off. Push and AI: later (section 47) | User (Claude's suggestion, approved) | 23 Nov 2026 |
| D55 | Team and Editor | Unlimited team members on every plan, no seat limit. All 4 roles (Owner, Admin, Editor, Viewer) on every plan; the plan feature `team_roles` is removed (Studio keeps `priority_support`). Editors may create, edit, go live, pause and delete automations (section 45) | User | 23 Nov 2026 |
| D56 | Trusted device | "Trust this device for 30 days" skips the 2FA code only in a workspace that does not require 2FA. If the workspace requires 2FA, the code is always asked (section 44) | User | 23 Nov 2026 |
| D57 | Moving down a plan | Allowed. It starts at the end of the billing period. It never stops an automation: the PRO parts the new plan lacks are switched off by the plan and the automation keeps running (email and phone steps skipped, a run waiting for her email or phone moves on; "Reply like a person" works as OFF; only the first public reply line; only version A of the hello and the follow ask). Nothing is deleted: the PRO settings stay saved, the engine reads the plan's features at run time, and after a move up they work again by themselves. A notice and an email go once. Turning a PRO step on still needs PRO; PRO steps already on before the move down stay saved and are ignored. Instagram accounts: the active accounts must fit the plan's limit (1, 3 or 10); at the period end the accounts not kept get lane stop `plan_downgrade` on all 4 lanes (the owner's pick, else the oldest-connected stay). At any time the owner may swap with "choose active accounts" inside the app: making a stopped account active stops another one. A disconnect never starts a stopped account by itself. Scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`); drafts and saved segments stay. An unfinished past-comments run ends `failed` (`plan_feature_off`); DMs it already queued still go. Moving up clears all `plan_downgrade` stops (sections 10.4, 46)| User (Claude's suggestion, approved) | 23 Nov 2026 |
| D58 | File safety | meepzo-be's upload domain scans every uploaded file. A file that is not scanned clean can't be used in a message (sections 5.9, 41) | User | 23 Nov 2026 |
| D59 | "Reply like a person" default | ON by default for new automations on Creator and Studio (`REPLY_LIKE_PERSON_DEFAULT_PAID` true). Free: OFF only = no pace (reply right after each DM, no hour cap); the risk that Meta flags a Free account is accepted (section 13) | User | 23 Nov 2026 |
| D60 | Close spellings in phrases | Also inside keywords of several words: each word of 5 or more letters may have 1 wrong letter; words under 5 letters must be exact; all the words must come together and in the same order (section 5.5) | User (Claude's suggestion, approved) | 23 Nov 2026 |
| D61 | "% tapped" | = (button taps on the hello + typed answers to the hello) / runs started. A typed answer = her first text while the run waits for `opening_message_button`. Saved apart in `app.automation_counts`: `taps`, `typed_answers`, `runs_by_version`, `taps_by_version`, `typed_by_version` (sections 5.6, 15) | User (Claude's suggestion, approved) | 23 Nov 2026 |
| D62 | Month limit reached | Only new DMs stop: stop `plan_limit` on the `slow`, `fast` and `broadcast` lanes. The `reply` lane keeps going: public replies and hides of DMs that already went still go (they are not DMs). A DM whose 7 days end behind the limit is `expired` `plan_limit` (section 10) | User (Claude's suggestion, approved) | 23 Nov 2026 |
| D63 | `@username` setting | Per automation: `public_reply_mention` BOOLEAN, default true (`PUBLIC_REPLY_MENTION_DEFAULT` true). Off = the reply line without `@username` (sections 5.11, 13) | User | 23 Nov 2026 |
| D64 | Replies under comments | Account setting `trigger_on_comment_replies`, default ON. ON: a reply under another comment (`parent_id`) can start comment automations like any comment on that post; the public reply goes under the top-level comment. OFF: it never starts anything (logged `ignored`, `thread_reply_off`). Always: a comment by the connected account itself never starts anything (`own_comment`), so our own public replies never trigger. The missed-comment check reads replies only when ON (test needed: `replies` field) (sections 5.15, 7) | User (Claude's design, approved) | 23 Nov 2026 |
| D65 | Once per person per post | Account setting `once_per_person_per_post`, default ON = the once rule of D13. OFF ("every time"): every new comment or keyword DM starts a new run; the once key becomes the event's own id (`<media id>:<comment id>`, `dm:<message id>`, `story:<story id>:<message id>`, `starter:<event id>`, `ref:<event id>`, `ad:<event id>`, and so on). Still only one open run per automation and person: a new comment, keyword DM or any other start while her run of the same automation is still open is `ignored` (`run_in_progress`); after that run ends, the next one starts a new run. Still true when OFF: one private reply per comment (Meta); one opening private reply per person per 24 hours while her window is closed (`OPENING_PERSON_GAP_HOURS`); the person limit 60 per hour; two automations on one post share one unanswered opening message; "first message" once ever; "no other automation answered" keeps its own choice; tag starts are per event (sections 5.15, 9) | User (Claude's design, approved) | 23 Nov 2026 |
| D66 | Mark as seen | Account setting `mark_seen_after_reply`, default OFF. ON: after an automation message to her is `sent`, one `mark_seen` sender action for her chat: fast lane, `count_group` `none` (not a DM, not in the month count or the fast limit). At most once per her inbound message (Redis note `seenmark:{account}:{contact}`, 24 hours). Skipped if the owner typed to her by hand after her message. A failure is ignored (no retry, no stop), except account-stop errors. Test needed on Unified Login (sections 5.15, 14) | User (Claude's design, approved) | 23 Nov 2026 |
| D67 | Delay before each message (PRO) | Account settings `extra_delay_seconds_min`, `extra_delay_seconds_max` (both empty = off), 1 to `EXTRA_DELAY_MAX_SECONDS` 20, min not over max. An extra random pause, added once per her event (tap, typed answer, story reply or DM) to the first answer message we send after it: min + (max - min) x (r1 + r2) / 2, added to the 500 to 2,000 ms. Later list messages with no wait follow the normal 500 to 2,000 ms. The total wait from her message to our first answer is at most 25 seconds (`BOT_ANSWER_MAX_SECONDS` 30 - `BOT_ANSWER_SAFETY_SECONDS` 5). Never after a follow check, never for slow-lane private replies, public replies, nudges, list waits or broadcasts. Free: not available; off after a move down. A delayed ticket (sections 5.15, 11) | User (Claude's design, approved) | 23 Nov 2026 |
| D68 | Broadcasts (PRO) | Only to people whose chat window is open, checked when the audience is built and again just before each send. Audience: conditions on one account in AND / OR groups (2 levels, at most `SEGMENT_CONDITIONS_MAX` 20), saved as `app.segments`. Always left out: opted-out, paused (D71) and deleted contacts, and anyone who got a broadcast in the last 24 hours (`BROADCAST_MIN_GAP_HOURS`). 1 to 3 messages (`BROADCAST_MESSAGES_MAX`). Modes: now, at a set time, when her chat opens (1 to 7 days, `BROADCAST_OPEN_WAIT_DAYS_MAX`). A 4th lane `broadcast` per account: box timing, 600 per hour (`BROADCAST_HOUR_LIMIT_DEFAULT`; owner column `broadcast_hour_limit`, 1 to `BROADCAST_HOUR_LIMIT_MAX` 2,000), lowest priority. In the month DM count and the person limit. Cancel: waiting recipients `skipped` and their waiting messages `cancelled` (`broadcast_cancelled`). Permissions: the automation codes (`automation:create`, `automation:update`, `automation:read`). Not an automation (sections 8, 19, 30) | User (Claude's design, approved) | 23 Nov 2026 |
| D69 | Run on past comments (PRO) | Comment and ad-comment automations (not Live): "Also answer comments from the last N days", N = 1 to `PAST_COMMENTS_MAX_DAYS` 7. Posts: the target post(s); "any post": the newest `PAST_COMMENTS_POSTS_MAX` 50 posts with comments in those days. Each comment goes through normal intake as an "old" comment; the 7-day rule per comment. A `past-comments` job (queue `instagram-tasks`), table `app.automation_backfills`, one running per automation. Permissions: the automation codes (section 5.16) | User (Claude's design, approved) | 23 Nov 2026 |
| D70 | Later list | Booking, link tracking, AI FAQ, forms, integrations, ads sync, the InstantDM items and the ideas: listed in `Instagram-DM-Later-Features-v8.md` (section 49) | User (Claude's design, approved) | 23 Nov 2026 |
| D71 | Pause automations for one person | An owner switch on the contact (and in the bulk bar): "Pause automations for this person", `app.contacts.automations_off_at` (+ `automations_off_by_user_id`). While set: no automation starts for her; her waiting messages `skipped` (`contact_excluded`); her open runs `cancelled` (`contact_excluded`); broadcasts leave her out; her comments get no DM, no public reply and no hide; no "mark as seen". Her events are still saved. The owner can turn it off at any time; nothing restarts by itself, her next own action starts normally. A stop word is her choice and the owner can't undo it; this is the owner's choice and can be undone. Owner, Admin, Editor; audit log (sections 4.3, 15) | User (Claude's design, approved) | 23 Nov 2026 |
| D72 | Retry failed messages | A button on an automation and on a contact: a `retry-failed` job (queue `instagram-tasks`, pieces of `RETRY_FAILED_PIECE` 500). Only `failed` messages of the last 30 days; never `unknown`, `skipped`, `expired`, `cancelled` or broadcast messages. One goes back to `waiting` only if it is allowed now: an opening private reply before its 7-day end (comment time + 7 days - `EXPIRY_SAFETY_MINUTES`); any other DM only while her window is open; not when the error is final for her (she blocked us, user not found, no consent, opted out, paused) or the text is still refused. At most `RETRY_FAILED_MAX` 1 owner retry per message (`owner_retry_at`). The owner sees the count first. Normal lanes, gates, limits and month count. Audit log (section 15) | User (Claude's design, approved) | 23 Nov 2026 |
| D73 | Free trial | Creator and Studio: 7 days, no card (`PAID_TRIAL_DAYS` 7). One trial per workspace, and never again for an Instagram account that had one (by `instagram_user_id`). The plan's full features and limits. Notices and emails 3 and 1 days before the end (`TRIAL_NOTICE_DAYS` 3, 1). No payment at the end: the workspace moves to Free by the moving-down rule (D57). With payment: the plan goes on. Stripe: a subscription with a trial and no payment method, cancelled at the end; our Stripe webhook moves the workspace to Free. meepzo-be's read-only trial (`NEW_ORGANIZATION_TRIAL_DAYS`) is not used (section 46) | User (Claude's design, approved) | 23 Nov 2026 |

### 2.1 More rules from version 7 (still true)

These were decided with version 7. They have no D number, but they stay.

| Rule | Value | Decided by | Date | Section |
|---|---|---|---|---|
| Size | 20 to 200 accounts now, built for 1,000 | User | 22 Nov 2026 | 42 |
| Limits per account | Each account has its own limits. The owner sets them, under Meta's limits. All accounts send at the same time | User | 22 Nov 2026 | 10 |
| Message types | `opening_message`, `nudge`, `public_reply`, `hide_comment`, `follow_check`, `follow_request`, `email_question`, `invalid_email`, `phone_question`, `message`, `broadcast` | User (first list), Claude (new types) | 22 and 23 Nov 2026 | 6 |
| Two automations, one post | They share one opening message while it is not answered. Her one tap moves both | User | 22 Nov 2026 | 9 |
| Ask once | Never ask again for a follow, email or phone we already have. Never the same question twice at once | User | 22 Nov 2026 | 14 |
| Pause an account | Comments and taps are saved and sent later | User | 22 Nov 2026 | 15 |
| Pause an automation | Popup: "DMs are waiting. Cancel or keep?" People in the middle of a chat finish | User | 22 Nov 2026 | 15 |
| Half speed | After "too fast": half speed for 1 hour. After a block: 24 hours | Claude | 22 Nov 2026 | 33 |
| Owner sees | Banner in the app and email. Team alerts by email and a second channel | User | 22 Nov 2026 | 15, 40 |
| A worker never waits | Every wait is a delayed ticket in the queue. No pause and no timer inside a worker | User | 22 Nov 2026 | 24 |
| Redis | Holds tickets, fast counts, short notes and copies. Never the last check. Never called inside a Postgres transaction | User | 22 Nov 2026 | 23 |
| Missed comments | Checked every 30 minutes. The webhook subscription every 10 minutes | Claude | 22 Nov 2026 | 34 |
| Places | Start: 5 intake, 40 fast, 40 slow per server. At 1,000 accounts: 20 / 100 / 50 per server | Claude | 22 Nov 2026 | 24 |
| Review fixes | All 45 review items are in | User ("everything") | 23 Nov 2026 | 51 |

---

## 3. The whole system in one picture

```text
  Owner: "Connect Instagram" (section 25)                   Meta Graph API
  Unified Login -> pick accounts -> token -> subscribe      graph.facebook.com
                                                                  ^
  Instagram sends 6 webhook fields (section 4.5): comment,        | one call
  Live comment, DM, story reply, mention, shared post, tap,       |
  starter question, link, ad, reaction                            |
                    |                                             |
                    v                                             |
  +------------------------------------+                          |
  | 1. Webhook (meepzo-be)             |                          |
  |    check signature, drop repeats   |                          |
  +-----------------+------------------+                          |
                    | save first                                  |
                    v                                             |
  +------------------------------------+   +----------------------+------+
  | Postgres on Neon (the truth)       |<--| 6. Save the result: sent,   |
  | events, contacts, tags, automations|   |    unknown, failed, skipped;|
  | runs, messages, lanes, counts,     |   |    make the next message    |
  | month counts, attempts, plans      |   +----------------------+------+
  +-----------------+------------------+                          ^
                    | job        tag added or removed             |
                    v            (`contact_tag_events`)           |
  +------------------------------------+      |                   |
  | 2. Intake queue                    |<-----+                   |
  |    match order (section 4.3),      |                          |
  |    once key, makes the run and     |                          |
  |    its waiting messages            |                          |
  +-----+-------------+--------------+-+                          |
        |             |              |         Owner sends a      |
    comment,     first DM      window open:    broadcast (PRO,    |
    window       went:         hello, nudge,   section 8): now,   |
    closed       public        follow, email,  at a set time,     |
                 reply, hide   phone,          or when her        |
                               messages, Live  chat opens         |
                               reply                              |
        v             v              v                v           |
  +-----------+ +-----------+ +-------------+ +---------------+   |
  | 3a. slow  | | 3b. reply | | 3c. fast    | | 3d. broadcast |   |
  | lane: one | | lane: one | | one ticket  | | lane: one at a|   |
  | at a time | | at a time | | per message,| | time, lowest  |   |
  | (slow     | | (slow     | | many at once| | priority      |   |
  |  queue)   | |  queue)   | | (fast queue)| | (slow queue)  |   |
  +-----+-----+ +-----+-----+ +------+------+ +-------+-------+   |
        +-------------+--------------+----------------+           |
                      v                                           |
  +------------------------------------+                          |
  | 4. Worker: pause, stops, plan,     |                          |
  |    window, age; gate 1 (Redis);    |                          |
  |    one commit: gate 2 + month      |                          |
  |    count + `sending`               |                          |
  +-----------------+------------------+                          |
                    v                                             |
  +------------------------------------+                          |
  | 5. Call Instagram (max 15 s),      |--------------------------+
  |    no transaction is open          |
  +------------------------------------+

  Helper (every minute): lost tickets, stuck sends, expired messages, missed
  comments, estimates, partitions, emails, tag events not queued. No DM.
  Queue `instagram-tasks`: account set-up, starter questions, file uploads,
  token check, bulk tags, month wake, plan change, segment counts, broadcast
  audiences, past comments, retry failed. No DM.
  Redis: the 4 queues, tickets, fast and broadcast counts (gate 1), month
  count copy, tag lists, login state, short notes, copies.
```

The save of a result (box 6) makes the next message: the public reply, the hide, the next step, the next message of the list, or the nudge (section 30).

**The product around sending (Part F)**

```text
  +---------------+   +------------------+   +-----------------------------+
  | Sign-in, 2FA, |-->| Workspace,       |-->| Plan row (`billing.plans`): |
  | sessions (44) |   | members, roles   |   | DMs a month, accounts, PRO  |
  +---------------+   | (45)             |   | features (46)               |
                      +------------------+   +--------------+--------------+
                                                            | read by
          +--------------------------+----------------------+
          v                          v                      v
   connect: account limit     go-live: PRO, plan     send commit: month count
   (D26)                      ended, month (D35)     (D34) -> notices at 80%
                                                     and 100% (section 47)
```

**Connect in short** (full steps in section 25)

```text
 "Connect Instagram" -> facebook.com/dialog/oauth (client_id, config_id,
   state, prompt=login)
   -> she logs in (Instagram or Facebook), picks a business portfolio, then
      accounts (ad accounts: she may skip)
   -> code exchange (server only) -> system user token
   -> GET /me?fields=client_business_id -> GET /me/assigned_instagram_accounts
   -> owner picks accounts (up to the plan's limit, D26)
   -> one commit: the accounts and their 4 lane rows
   -> `account-setup` job per account: profile read, subscribed_apps (6 fields)
```

Unified Login is the only login (D24). Points to design for:

1. Every creator needs a business portfolio. The test with 2 creators (section 43) shows how hard that step is. Help screens guide her through it (section 25).
2. Unified Login has no handover (passing a chat to another app), no login through the Instagram app, and no switch from a personal to a professional account during login.
3. Some messaging features are documented by Meta only for its other login (quick replies, cards, button messages, starter questions, profile read, file upload). We test them on Unified Login (section 43).

### 3.1 Where it lives in meepzo-be

| Part | Place in meepzo-be | Today | What changes |
|---|---|---|---|
| Meta login and connect | New sub-domain `src/domains/app/sub-domains/meta-connection/` (name to confirm with the team) | Instagram Login inside `instagram-account/` (not used: removed from meepzo-be), routes for a single account | Built new: Unified Login, `app.meta_connections`, `app.meta_connection_tokens`, many accounts, `token-check` job (section 25) |
| Instagram account, settings, Meta's deauthorize and data deletion | `src/domains/app/sub-domains/instagram-account/` | Exists, routes for one account | Routes get `:instagram_account_id`. Settings keep the limit columns, lose the 5 public reply columns (section 18) |
| Meta calls | `src/infrastructure/social/instagram.client.ts` | 3 webhook fields, send, private reply, follow read | `graph.facebook.com` `v27.0`, 6 fields, hide, ice breakers, attachments, ad read (sections 25, 30) |
| Webhook, stored events, intake queue | `src/domains/app/sub-domains/instagram-webhook/` | Exists | New event kinds, match order, tag events (sections 26, 27) |
| Contacts and tags | `src/domains/app/sub-domains/contact/` | List, search, delete | `channel`, `first_automation_id`, `note`, `first_message_at`, tag list, tags for many, detail (section 18) |
| Automations | `src/domains/app/sub-domains/automation/` | 3 ways to start, fixed steps, every save complete | Draft, live, paused; 15 ways to start; `steps JSONB`; go-live check; duplicate; counters (sections 5, 18) |
| Broadcasts and segments | New sub-domain `src/domains/app/sub-domains/broadcast/` (name to confirm with the team) | New | `app.segments`, `app.broadcasts`, `app.broadcast_recipients`, the `broadcast` lane (sections 8, 19, 30) |
| Runs, run history, comment logs, run engine | `src/domains/app/sub-domains/automation/automation-run/` | Exists, sends inside the webhook job | "Send" becomes "save a waiting message". Message list, versions, nudge, tag events |
| Sending engine: messages, lanes, tickets, gates, workers, helper, month count | `src/domains/app/sub-domains/instagram-sending/` | New | Sections 24 to 35 |
| Files sent in messages | `src/domains/upload/` + `app.meta_attachments` | Upload domain exists | Each file is uploaded to Meta once per account (D29) |
| Partition worker | `instagram-partition-maintenance` (worker family `retention`) | New | Section 21 |
| Settings file | `src/shared/config/instagram-sending.config.ts` | New | Section 36 |
| Sign-in, two-factor, sessions | `src/domains/auth/` | Exists | New migrations only (section 44) |
| Workspaces, members, roles | `src/domains/tenancy/` | Exists | New migrations only (section 45) |
| Plans, subscriptions, refer | `src/domains/billing/` | Exists (other plan names), no refer | New migrations only (sections 46, 48) |
| Profile, settings, notification choices | `src/domains/user/` | Exists | New migrations only (section 47) |
| Notices, emails, audit log, dead-letter jobs | `src/domains/notify/`, `src/domains/audit/`, meepzo-be infrastructure | Exists | New notice kinds (section 47). Audit log used as it is |

**Migration rule (D1, D48):**

1. The `app` migrations (`migrations/20261121*.sql`) are not in `main`. They are changed in place. The development database is reset once.
2. Every other domain (auth, tenancy, billing, user, notify, upload, audit) is in `main`. It gets NEW migration files only. A merged migration is never edited.
3. New `app` tables (section 19): `app.meta_connections` (one login per business portfolio), `app.meta_connection_tokens` (the encrypted token, own table), `app.automation_counts` (all-time runs and taps), `app.automation_reply_state` ("Reply like a person" box), `app.meta_attachments` (Meta's file ids), `app.dm_month_counts` (DMs this month), `app.contact_tag_events` (tag added or removed, kept 8 days), `app.segments` (saved audiences), `app.broadcasts`, `app.broadcast_recipients` (kept 90 days), `app.automation_backfills` (past comments runs). All other tables keep their names (section 17).
4. New product tables (trusted devices, plan rows, referral tables) are new migrations in merged domains (sections 44 to 48, list in section 50).
5. Instagram Login is not used. Its code, its own token table, its renewal worker, its scope names and its host are removed from meepzo-be: "remove and replace" in the `app` migrations (changed in place), never "migrate". It is a new app with no customers (section 50).

---

# Part B. What people and owners see

## 4. Ways to start

An automation starts when one of 15 things happens. Each has its own `trigger_type`. Flowdm shows them in 5 groups.

### 4.1 The 15 ways, with Riya

| # | Way to start (`trigger_type`) | Flowdm group | What Riya does (account A) |
|---|---|---|---|
| 1 | Post or reel comment (`comment`) | When they comment | Comments "GUIDE" under A's reel. |
| 2 | Live comment (`live_comment`) | When they comment | Comments "LINK" while A is live. |
| 3 | Story reply (`story_reply`) | When they reply to or mention your story | Replies "price?" to A's story. |
| 4 | Story mention (`story_mention`) | When they reply to or mention your story | Posts a story that mentions @A. |
| 5 | Story repost (`story_repost`) | When they reply to or mention your story | Reposts A's story to her own story. Test needed. |
| 6 | DM keyword (`dm_keyword`) | When they message you | Sends A the DM "PRICE". |
| 7 | Their first ever message (`first_message`) | When they message you | Writes "hi" to A for the first time. |
| 8 | Your post sent to you (`shared_post`) | When they message you | Shares A's own reel back to A in a DM. |
| 9 | Starter question (`starter_question`) | When they message you | Opens A's chat and taps "How do I join?". |
| 10 | Link or QR code (`ref_link`) | When they message you | Scans A's QR at an event. A's chat opens. |
| 11 | No other automation answered (`default_reply`) | When they message you | Writes "do you ship to Pune?". No automation matches. |
| 12 | Ad comment (`ad_comment`) | When they respond to your ad | Comments "INFO" under A's ad. Test needed. |
| 13 | Ad "Send message" (`ad_message`) | When they respond to your ad | Taps "Send message" on A's ad. |
| 14 | Tag added (`tag_added`) | When a tag is added or removed | The owner of A, or an automation, adds the tag "vip" to Riya. |
| 15 | Tag removed (`tag_removed`) | When a tag is added or removed | The tag "waitlist" is removed from Riya. |

"They follow you" is not a way to start. Meta sends no webhook for it. The chooser shows it as "Waiting on Meta" (D37, D47).

### 4.2 What Meta sends, her window, the lane and the once key

| # | Way to start | Meta sends (webhook field) | Her window | First message goes | Once key (`post_key`) |
|---|---|---|---|---|---|
| 1 | Post or reel comment | `comments` | Closed (open if she wrote in the last 24 h) | Slow lane private reply (window open: fast DM) | media id |
| 2 | Live comment | `live_comments` | Closed (open if she wrote in the last 24 h) | Fast lane private reply, only while live (window open: fast DM) | `live:<media id>` |
| 3 | Story reply | `messages` (reply to a story) | Open | Fast | `story:<story id>` |
| 4 | Story mention | `messages` (story mention) | Open | Fast | `mention:<story id>` |
| 5 | Story repost | Test needed | — | — | — |
| 6 | DM keyword | `messages` | Open | Fast | `dm:<date>` |
| 7 | Their first ever message | `messages`, her first DM | Open | Fast | `first` |
| 8 | Your post sent to you | `messages` with a shared post | Open | Fast | `share:<media id>` |
| 9 | Starter question | `messaging_postbacks` (ice breaker) | Open | Fast | `starter:<date>` |
| 10 | Link or QR code | `messaging_referral` (ref) | Open | Fast | `ref:<date>` |
| 11 | No other automation answered | `messages`, no match | Open | Fast | `default:<date>`, or `default:<her message id>` if "every time" |
| 12 | Ad comment | `comments` with `media.ad_id` | Closed (open if she wrote in the last 24 h) | Slow lane private reply (window open: fast DM) | media id |
| 13 | Ad "Send message" | `messaging_referral` source ADS + `ad_id` | Open | Fast | `ad:<ad id>` |
| 14 | Tag added | Inside meepzo-be | Must be open | Fast | `tag:<tag>:<event id>` |
| 15 | Tag removed | Inside meepzo-be | Must be open | Fast | `untag:<tag>:<event id>` |

Rules:

1. `<date>` = the day in the workspace's time zone. So a DM keyword, a starter question or a link answers her once per automation per day.
2. Her window = her last message or tap + 24 hours (`MESSAGING_WINDOW_HOURS`) - 15 minutes (`WINDOW_SAFETY_MINUTES`) (section 9).
3. A comment never opens her window. When she wrote in the last 24 hours, the hello of a comment goes as a normal DM in the fast lane (D8).
4. Live comment: the private reply can go only while the Live is on. When the Live is over, or Meta says "Live ended", the message is `expired` with reason `live_ended` (D40). Window open: a normal DM in the fast lane. The 24-hour person rule does not apply to Live comments.
5. Ad "Send message": the plan uses a 24-hour window. Meta's overview page says a click-to-message ad can open a window of up to 7 days. We use 7 days only after a test confirms it (D41, test needed (section 43)).
6. Tag starts: her window must be open. Closed when the tag event comes: no run starts and nothing is sent (the start is skipped, `window_closed`, one count in the logs). Closed later, just before the first message goes: that message is `skipped` (`window_closed`) (D45, section 27.9). `<event id>` is the row id in `app.contact_tag_events`.
7. The person limit, 60 automatic messages per hour (`PERSON_HOUR_LIMIT_DEFAULT`), still guards "every time" and tag starts.
8. **"Every time" for the whole account** (`once_per_person_per_post` OFF, D65): the once key of a comment or a keyword DM becomes the event's own id: `<media id>:<comment id>`, `dm:<message id>`, `story:<story id>:<message id>`, `starter:<event id>`, `ref:<event id>`, `ad:<event id>`, and so on. Still only one open run per automation and person: a new comment, keyword DM or any other start while her run of the same automation is still open is `ignored` (`run_in_progress`); after that run ends, the next one starts a new run. "First message" stays once ever. "No other automation answered" keeps its own choice. Tag keys are already per event.

Once-key examples with Riya:

| Riya does | Result |
|---|---|
| Monday "PRICE" in a DM, then "PRICE" again on Monday | First: runs. Second: nothing (same `dm:<date>`). |
| Tuesday "PRICE" again | Runs again (new day). |
| Replies to story S1 twice | Once. A reply to story S2: runs again. |
| Taps "Send message" on ad 77 twice in one week | Once (same `ad:77`). After 90 days the old run is deleted, so it may run again. |
| Tag "vip" removed and added again | Each add is a new event, so each add can start the automation. The person limit stops a loop. |

### 4.3 One message, many matches (D37)

One message from Riya can fit many automations. **Only one automation answers one message.** Intake walks down this order and stops at the first match.

```text
 One event from Riya to account A
 (DM, story reply, mention, shared post, postback, referral)
    |
    v
 1. Does one of her runs wait for this? (a tap on our
    button, her answer, any text for a run that waits) --yes--> move that run. Done.
    | no
    v
 2. Exact source: a starter question, a link ref or an
    ad id that names a live automation?               --yes--> it starts. Done.
    | no
    v
 3. Keyword or kind: DM keyword, story reply, story
    mention, your post sent to you, "also start from" --yes--> it starts. Done.
    | no
    v
 4. Her first ever DM to A, and a live
    "first message" automation?                       --yes--> it starts. Done.
    | no
    v
 5. A live "no other automation answered"?            --yes--> it starts, if its
    | no                                                      once key is new
    v
 Nothing starts. Her message times are still saved (her window).
```

Rules:

1. **Inside one level**, the first that fits wins: an exact target first (one story or one post before "any"), then an automation whose own way to start this is (before one that has it only in "also start from"), then the oldest (`created_at`, then `id`, meepzo-be's rule).
2. **A match stopped by its once key still ends the search.** Riya sends "PRICE" twice on Monday: the second time the PRICE automation is found, its key `dm:<date>` is used, so nothing is sent (logged `ignored`). "No other automation answered" does not answer it.
3. **"First ever DM"** means `first_message_at` on her contact was empty. A person who only commented before still counts as new in DMs.
4. **Not a start:** reactions, read receipts, deleted or edited messages (`message_edit`), our own "sent" notices and echoes (`is_echo`, `is_self`) never start an automation. A photo, voice note or sticker can start only levels 4 and 5 (it has no words).
5. **Starter question of a paused automation:** Meta may still show it for a short time. Its tap is not an exact source then. It goes on to level 3 as a message with the question's text.
6. Each run of a message start goes in the fast lane (D4). Her window is open, because she just wrote or tapped.
7. **Owner chatting by hand:** level 5 does not answer while the owner typed to her by hand in the last 6 hours (`OWNER_CHAT_QUIET_HOURS` 6). This quiet time is per contact: other people are not affected.
8. **She sent a stop word** (`opted_out_at` set, D49): nothing starts for her. Only her own new action restarts her, when it matches a keyword DM (level 3; also a DM that matches a comment automation's keywords through "also start from" DM) or a starter question or an ig.me link (level 2), or a keyword comment (section 4.4). That clears `opted_out_at` and the run starts normally. "First message", "no other automation answered", tag starts, nudges, story replies, mentions and shared posts never restart her. The owner cannot restart her by hand. A new stop word stops her again.
9. **Paused by the owner** (`automations_off_at` set, D71): nothing starts for her, by any way to start. When the owner switches it off, nothing restarts by itself: her next own action starts normally.

Stop word example: Riya wrote "STOP" to A on Monday. On Wednesday she replies to A's story: nothing starts. On Friday she DMs "GUIDE": the GUIDE keyword automation matches, `opted_out_at` is cleared, and her run starts.

Examples (account A):

| Riya sends to A | Live automations of A | Who answers | Why |
|---|---|---|---|
| "GUIDE" (her first DM ever) | DM keyword GUIDE, first message WELCOME | GUIDE | Level 3 comes before level 4 |
| "hi" (her first DM ever) | Same | WELCOME | No keyword fits. Level 4 |
| "hi" (a week later) | Same + "no other answered" HELP | HELP | Not her first DM. Level 5, once a day |
| Taps starter question "Prices?" | Starter PRICES, DM keyword PRICE | PRICES | Level 2 |
| "yes" while her GUIDE run waits for her tap | Anything | The GUIDE run moves on | Level 1. Typed text counts like a tap (section 14) |
| Replies "price?" to story S1 | Story reply ST1 (story S1), DM keyword PRICE with "also start from" story reply | ST1 | Level 3. One story is an exact target |

### 4.4 Comments: one comment, one automation

Comments (ways 1, 2 and 12) do not use the order above. They follow meepzo-be's rule (D37):

1. Post-linked first: one post, "my next post" once linked, "posts between" for a post in the range, an ad comment automation whose `ad_id` is the comment's `media.ad_id`. Else "any post". The oldest match wins. Live comments: only `live_comment` automations.
2. Every other match is logged `ignored` (`comment_already_answered`).
3. An automation with no words answers every comment of its target (meepzo-be's rule today).
4. She sent a stop word: a keyword comment (post, reel, Live or ad) that matches an automation restarts her (D49). A comment on an automation with no words does not. A paused person (D71): her comments get no DM, no public reply and no hide.
5. **Replies under comments** (`parent_id`, D64): they start automations like any comment on that post while the account setting `trigger_on_comment_replies` is ON (default). OFF: logged `ignored` (`thread_reply_off`). A comment written by the connected account itself never starts anything (`own_comment`), so our own public replies never trigger.

```text
 Riya comments "GUIDE" on post P of account A
    |
    v
 Comment automations of A (status `live`) that fit P and "GUIDE"?
    |-- post-linked ones (one post, next post, between, ad)?  -> the oldest
    |-- else "any post" ones?                                 -> the oldest
    |-- none                                                  -> nothing
    v
 Once key (media id) used for her already?  -- yes --> logged `ignored`
    | no
    v
 Run starts (section 7)
```

### 4.5 Webhook fields and permissions

We subscribe each account to 6 fields (D24) with `subscribed_apps`.

| Webhook field | Permission | Ways to start | Also used for |
|---|---|---|---|
| `comments` | `instagram_manage_comments` | 1 Post or reel comment, 12 Ad comment | — |
| `live_comments` | `instagram_manage_comments` (Advanced Access needed) | 2 Live comment | — |
| `messages` | `instagram_manage_messages` | 3 Story reply, 4 Story mention, 6 DM keyword, 7 First message, 8 Your post sent to you, 11 No other automation answered | Her answers (text, email, phone, quick replies), the owner's own typed messages |
| `messaging_postbacks` | `instagram_manage_messages` | 9 Starter question | Taps on our buttons (hello, follow ask) |
| `messaging_referral` | `instagram_manage_messages` | 10 Link or QR, 13 Ad "Send message" | — |
| `message_reactions` | `instagram_manage_messages` | None | A reaction refreshes her window time (section 14) |

Not subscribed: `mentions` (mentions in captions and comments are not a way to start), `messaging_seen` (read receipts are not saved, D15), `story_insights`.

Meta's rules we follow:

1. Comment and mention webhooks come only when the account is public. A private account gets a banner, and comment automations get a go-live warning (section 5.1).
2. "Allow access to messages" must be on in the Instagram app. Else messaging calls fail with (#200) (section 33).
3. Other customers need Advanced Access per permission (App Review) and our app in Live mode (section 41).
4. Tag starts (14, 15) need no webhook. They come from meepzo-be itself.

### 4.6 Ways that need a test, or are not offered

| Way | What is not sure | Until the test |
|---|---|---|
| 5 Story repost | Meta sends no webhook we know of | The chooser shows "Waiting on Meta". The API refuses to make a `story_repost` automation live. Built only if a test shows Meta sends it |
| "They follow you" | Meta sends nothing | Not offered (D47). No `trigger_type` |
| 12 Ad comment | Comments on boosted posts come with `media.ad_id`, `ad_title` and `original_media_id`. Comments on ads that are not boosted posts may need the Marketing API | Test needed (section 43). Built like a comment, offered once the test passes. The ad's Instagram post is saved as the target at go-live |
| 13 Ad "Send message" | Is her window 7 days after this ad? | 24 hours |
| 10 Link or QR | Meta says ice breakers must be set to get the ref on a brand-new chat. Does opening the chat from the link open her window when she types nothing? Link format: `ig.me/m/<username>` or `ig.me/<username>`? | Test needed (section 43). The match works on the ref either way |
| 8 Your post sent to you | Does the message carry the id of the shared post? | Test needed (section 43). Without an id, only "any post" works |
| 2 Live comment | Needs Advanced Access for `live_comments`. Meta's Live pages did not load: Live rules to confirm | Works only for people with a role on our app |
| Replies under comments | Does the comment webhook carry `parent_id`? Does a private reply to a reply comment work? Does the missed-comment read return replies (`replies` field)? | Test needed (section 43). Built as D64 |
| Messaging on Unified Login | Meta documents quick replies, cards, button messages, starter questions, profile read and file upload only for the old login | Test needed (section 43). Built as planned |

### 4.7 Instagram now, Messenger later

1. All 15 ways are Instagram ways. `channel` is `instagram` on every automation and contact (D27).
2. Messenger (Facebook Pages) is later (D47, section 49). It needs a second login configuration in the same Meta app and `pages_*` permissions.
3. Flowdm shows 3 ready automations for Messenger accounts: "Answer a word they message", "Welcome first-time messages", "Reply when nothing else does". They map to ways 6, 7 and 11 when Messenger is built.
4. Comments, Live, stories, starter questions on Instagram, and ad comments have their own Instagram webhooks. Messenger will need its own list.

---

## 5. Automation steps and messages

Broadcasts are not an automation. They have their own audience, messages and lane (D68, section 8, "Broadcasts").

Two owner tools work on top of automations (section 15): "Pause automations for this person" on a contact (D71), and "Retry failed messages" on an automation or a contact (D72).

### 5.1 Status: draft, live, paused

An automation is `draft`, `live` or `paused` (D28). meepzo-be's off status becomes `paused`, changed in place.

```text
                 Save draft (needs only a name)
   (new) --------------------------------------> draft
                                                   |  Go live: full check
   Duplicate --> draft "(copy)"                    v  (table below)
                                                  live <---------------+
                                                   |                   |
                              Pause: Keep / Cancel |                   | Go live
                                                   v                   | (full check)
                                                 paused ---------------+

   Delete (any status): stops at once, the setup is gone, contacts stay.
   Automatic stop (bad text, post deleted): stays `live` with `stopped_reason`
   and sends nothing until the owner fixes it (sections 15, 33).
```

| Action | Allowed from | What happens |
|---|---|---|
| Save draft | `draft` | Saved with only a name. No other check. PRO steps may be saved |
| Go live | `draft`, `paused` | The full check below. All good: `live`. Runs start from the next event |
| Save changes | `live`, `paused` | The same full check. A failed check saves nothing |
| Pause + Keep | `live` | `paused`. People in the middle finish. Waiting messages go on |
| Pause + Cancel | `live` | `paused`, `cancelled_before_at` = now. Its waiting messages become `cancelled` (section 15) |
| Duplicate | any | A new draft named "(copy)" on the account the owner is in now |
| Delete | any | Stops at once. Its waiting messages are `cancelled`. The reason is optional |

**Edits to a live or paused automation:**

1. A message reads its text from the automation when it is sent (the message row keeps no text, section 19). So waiting messages get the new text.
2. A waiting row whose step or message number no longer exists is not sent. It becomes `cancelled` with reason `cancelled_by_owner`.
3. A saved version number that no longer exists uses version 1.

**After a move down to a plan without PRO** (D57): the automation keeps running. The PRO parts are switched off by the plan, not deleted: the email and phone steps are skipped (a run waiting for her email or phone moves on to its next step), "Reply like a person" works as OFF, only the first public reply line is used, and only version A of the hello and the follow ask. The engine reads the plan's features at run time, so after a move up they work again by themselves. The editor shows those steps as "PRO, off on your plan". The owner can still edit and save the rest of the automation.
4. A change of the way to start in a saved automation stays in the same Flowdm group (section 4.1).

**Go-live check.** The API checks everything and answers with a list of problems, each with its step. The editor jumps to the first one. "Save changes" on a live or paused automation runs the same check.

| # | Check | Refused when | The owner sees |
|---|---|---|---|
| 1 | Name | Empty, or over `AUTOMATION_NAME_MAX_LENGTH` (255) | "Name your automation." |
| 2 | Account | Its Instagram account is not `connected`, or its Meta connection is `error` or `revoked` | "Reconnect @account first." |
| 3 | Plan | Plan ended (read only) or the workspace is `SUSPENDED` (D35) | "Your plan has ended. Choose a plan to go live." |
| 4 | Month limit | The month DM count reached `dm_month_limit` (D34) | "You used all 1,000 DMs this month. Upgrade, or wait until 1 Dec." |
| 5 | PRO | The plan has no PRO (D35), and a draft goes live with a PRO step on (email step, phone step, "Reply like a person", more than 1 reply line, a second version), or a save of a live or paused automation turns a PRO step on (it was off in the saved automation). PRO steps already on before a move down are not refused: they stay saved and are ignored (D57) | "Email and phone steps need Creator or Studio." |
| 6 | Way to start | Its own field is empty: one post, dates, story, question, link name, ad or tag. Or it is `story_repost` | "Pick a post." / "Story repost is waiting on Meta." |
| 7 | Words | A DM keyword automation has no word. "Also start from" DM is on with no word (it could never match) | "Add at least one keyword." |
| 8 | Starter questions | The automation has no question or more than 4, or the account's live questions would be more than 4 (`STARTER_QUESTIONS_MAX` 4) | "This account already has 4 starter questions (Instagram's limit)." |
| 9 | Link name | `ref_code` empty, longer than 64 (`REF_CODE_MAX_CHARS`), has other signs, or another automation of the account uses it | "This link name is used by (name)." |
| 10 | One catch-all | Another live "first message" or "no other automation answered" automation exists on the account (only one could ever answer) | "(name) already answers here. Pause it first." |
| 11 | Hello | Text empty or over 640; a button without a title or with a link that is not `https://`; more than 3 buttons; no "sends your next step" button | "Add a 'sends your next step' button, so they can reach your messages." |
| 12 | Comment kinds without hello | Comment, Live comment or ad comment with hello off and no follow, email or phone step: 2 or more messages, or message 1 is not a `text` message, or it has a picture (a private reply is one call) | "Turn on 'Say hello first'. Instagram allows one message until they answer." |
| 13 | Follow | Text or a button title empty | "Write the follow message." |
| 14 | Email, phone | No wording | "Add at least one way to ask." |
| 15 | Messages | No message; a message empty or broken for its kind (section 5.9); a wait over 23 hours; a file not uploaded or not scanned clean (D58) | "Message 2: add a picture or remove it." |
| 16 | Public reply | ON with no line; "Reply like a person" ON with fewer than 3 lines (`PUBLIC_REPLY_LINES_MIN_ON` 3, D52) | "Add a reply line." / "Add at least 3 reply lines, so replies don't repeat." |
| 17 | Tags | Tag step on with no tag | "Add a tag or turn the step off." |
| — | Shared word | Not refused. Only a warning | "guide is also used by GUIDE 2." |
| — | Private account | Not refused. A warning on comment kinds: a private account gets no comment webhooks | "@account is private. Comment automations can't work until it is public." |

### 5.2 Step order

Steps run top to bottom in a fixed order (Flowdm "How steps behave"). A step that is off is skipped. A step a way to start cannot use is not shown (section 5.3).

**Editor order:** starts when (+ "also start from"), which post or story, words + option row, reply under their comment (+ hide), say hello first, ask to follow, email (PRO), phone (PRO), send your messages (always on), tag them.

**Send order for one run:**

```text
 Event matched (section 4.3 or 4.4), once key new (D13)
    |
    v
 Run starts. Hello (`opening_message`)
    |  comment or ad comment, window closed: private reply, slow lane
    |  Live comment: private reply, fast lane, only while live
    |    (her window open: normal DM, fast lane)
    |  all others: normal DM, fast lane
    |
    +--> comment and ad comment, after the first DM went:
    |       public reply (if ON), then hide (if ON); no reply: hide at once
    v
 Wait for her tap ("sends your next step") or any text
    |  she messaged first and no tap in 60 min: nudge, once
    v
 Follow check --> not following: follow ask --> wait for "I'm following"
    v
 Email question --> wait for a valid email (asks again, section 14)
    v
 Phone question --> wait for a valid phone
    v
 Message 1 --wait--> message 2 --wait--> ... message N
    |  (window check just before each one)
    v
 Tags added. Run `completed`.
```

1. Hello off: the first needed step goes first. For a comment with her window closed, that step is the private reply.
2. A step is skipped when it is not needed: she follows already, we have her email, we have her phone (ask once, section 14).
3. The public reply and the hide never hold back the DM steps. They run in the reply lane (D4).

### 5.3 Which steps each way to start can use

Every way can use: ask to follow, email (PRO), phone (PRO), messages (always on), tags.

| Way to start | Target picker | Words | Public reply + hide | Hello | Nudge | Also start from |
|---|---|---|---|---|---|---|
| Post or reel comment | Any post, my next post, posts between, one post | Optional (none = every comment) | Yes | Yes | No | Story reply, DM |
| Live comment | Any Live | Optional | No (Meta) | Yes | No | — |
| Story reply | Any story or one story | Optional (none = every story reply) | No | Yes | Yes | DM |
| Story mention | — | No | No | Yes | Yes | — |
| Story repost | Waiting on Meta | — | — | — | — | — |
| DM keyword | — | Required | No | Yes | Yes | Story reply |
| First message | — | No | No | Yes | Yes | — |
| Your post sent to you | Any post or one post | No | No | Yes | Yes | — |
| Starter question | 1 to 4 questions (section 5.5) | No | No | Yes | Yes | — |
| Link or QR | The link name (`ref_code`) | No | No | Yes | Yes | — |
| No other automation answered | "Once a day per person" or "Every time" | No | No | Yes | Yes | — |
| Ad comment | One ad | Optional | Yes | Yes | No | — |
| Ad "Send message" | One ad | No | No | Yes | Yes | — |
| Tag added | One tag | No | No | Yes | Yes (window open) | — |
| Tag removed | One tag | No | No | Yes | Yes (window open) | — |

Why:

1. Public reply and hide need a comment. A Live comment cannot get a public reply (Meta), so it gets neither (D40).
2. The nudge is allowed only when she messaged first, because her window is open (D30). Comments open no window: Instagram allows one message until she answers.

### 5.4 Step: This automation starts when

| Field | Values and limits | PRO | Flowdm name |
|---|---|---|---|
| `trigger_type` | One of the 15 (section 4.1). In a saved automation, "Change" stays in the same group | No | "This automation starts when", "Change" |
| `also_start_from` | `TEXT[]`, empty by default. Comment: `story_reply`, `dm`. Story reply: `dm`. DM keyword: `story_reply`. All others: always empty | No | "Also start from" chips |
| `channel` | `instagram` (the only value now) | — | Pill "New automation for @account" |
| Account | Fixed when made. Duplicate goes to the current account (meepzo-be's rule) | — | Account menu |

**Also start from (D38):**

1. It replaces meepzo-be's "also from a DM keyword" switch, which is on for every automation today. In version 8 it is off until the owner turns it on.
2. The other place uses the automation's own words. A DM never matches an automation without words (meepzo-be's rule), so "also start from" DM needs a word (go-live check 7).
3. A comment can never be added to a story or DM automation.
4. A start from the other place uses that place's once key: `story:<story id>` or `dm:<date>` (section 4.2).
5. It uses the steps that fit the other place. A story reply start of a comment automation sends no public reply and no hide.

Example: comment automation GUIDE has words "guide" and "also start from" DM. Riya DMs "send the guide". GUIDE starts in the fast lane with key `dm:<date>`. No public reply.

### 5.5 Target, words and the option row

**Which post (comment automations, D39)**

| Choice | `target_scope` | What counts | Example |
|---|---|---|---|
| Any post | `any` | Every post and reel of the account | Riya comments on any reel of A |
| My next post | `next` | The first post published after go-live. Meta sends no webhook for a new post, so a timer job reads `/media` with `since` (meepzo-be's 15-minute job) and links it once (`target_instagram_media_id`). No dates | A goes live on Monday and posts on Tuesday: Tuesday's post |
| Posts between | `between` | Every post published between `target_starts_at` and `target_ends_at` (`/media` with `since` and `until`) | 1 Dec 00:00 to 7 Dec 23:59: all 5 posts of that week |
| One post | `specific` | One post picked from recent posts | The "Free guide" reel |

Stories: any story (`any`) or one story (`specific`, `target_instagram_story_id`). Your post sent to you: any post or one post (D44). Live comment: any Live. Ads: one ad (`ad_id`).

Picker: posts come from `GET /<account>/media` (the newest 10,000). `media_url` may be missing: show `thumbnail_url` or `permalink`. Reel or post (`media_product_type`), captions, and `GET /<account>/stories` on Unified Login: test needed (section 43).

**Words (keywords)**

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| `keywords` | 0 to 50 words (`AUTOMATION_KEYWORDS_MAX_COUNT` 50), each up to 100 characters (`AUTOMATION_KEYWORD_MAX_LENGTH` 100), meepzo-be's limits | No | "Their comment says" / "Words that start it" |
| Close spellings | Always on. Words of 5 or more letters (`KEYWORD_TYPO_MIN_LETTERS` 5), one change per word (`KEYWORD_TYPO_MAX_EDITS` 1), also inside keywords of several words (D60) | No | The line under the words |
| Same meaning | Later (D47) | — | Same line |

How a text matches:

1. Lower case both. **Contains:** her text contains the keyword anywhere (as today). Done.
2. Else **close spelling**: a keyword word of 5 or more letters also matches a word of her text that is one change away. One change = one letter changed, added or removed, or two letters next to each other swapped.
3. A keyword of several words: all its words must come together and in the same order. Each word of 5 or more letters may be one change away. Words under 5 letters must be exact (section 27.8).
4. Words under 5 letters never use close spelling.
5. Punctuation and emoji are ignored for close spelling.

| Keyword | She writes | Match? | Why |
|---|---|---|---|
| guide | "GUIDE pls" | Yes | Contains, any case |
| guide | "guied" | Yes | Two letters swapped = one change |
| guide | "gude" | Yes | One letter missing |
| guide | "glade" | No | Two letters changed |
| price | "prize" | Yes | One letter changed. Honest point: a real other word can match. "Try it" shows this |
| cat | "cta" | No | Under 5 letters: never fuzzy |
| cat | "category" | Yes | Contains (as today). Short words catch more |
| free guide | "send the free guied" | Yes | "guied" is one change; "free" is exact |
| free guide | "fre guide" | No | "free" has 4 letters: it must be exact |
| free guide | "guide free" | No | The words must come in the same order |

**Warning and "try it":**

1. When 2 live automations of one account share a word, the editor and the save answer show a warning: "(word) is also used by (name)." It is not refused.
2. A "try it" route takes a text and answers: does it start this automation, which word matched (exact or close spelling), and which automation of the account would answer first by the match order (section 4.3). It sends nothing and saves nothing.

**Option row (by way to start)**

| Way to start | Option | Field | Limits | Flowdm name |
|---|---|---|---|---|
| Comment, ad comment | Hide their comment once the DM is sent | `hide_comment_after_dm` | On or off, off by default | "Hide their comment once the DM is sent" (section 5.13) |
| No other automation answered | Send it | `default_reply_mode` | `once_a_day` (default) or `every_time` | "Once a day per person" / "Every time" |
| Starter question | The questions | `starter_questions` (`TEXT[]`) | 1 to 4 per automation, each up to 80 characters (`STARTER_QUESTION_MAX_CHARS` 80, test needed (section 43)); at most 4 live per account | Up to four question fields |
| Link or QR | Link name | `ref_code` | Letters, digits, `-`, `_`, `=`; 1 to 64 characters (`REF_CODE_MAX_CHARS` 64; Meta allows 2,083); unique per account | Link name field, "Copy link" |
| Ad comment, ad "Send message" | Which ad | `ad_id` | One ad from the ad picker | Ad picker |
| Tag added, tag removed | Which tag | `trigger_tag` | One tag, up to 50 characters (`AUTOMATION_TAG_MAX_LENGTH` 50) | Tag picker |

**Starter questions (D42):**

1. Meta allows up to 4 per account. They are set with the `messenger_profile` endpoint for the account. One automation may hold 1 to 4 questions; the account's live total is at most 4.
2. When a starter-question automation goes live, pauses, or changes its questions, a `starter-questions` job (queue `instagram-tasks`) sets the account's whole list again: every live question, each with a payload that names its automation.
3. A tap comes as a `messaging_postbacks` event. Intake finds the automation by the payload (level 2, section 4.3).
4. Starter questions do not show on desktop Instagram. On Unified Login: test needed (section 43).

Example: account A has PRICES ("Prices?") and JOIN ("How do I join?", "Where are you?") live. The owner makes HOURS ("Timings?") live: 4 in all. The job sends all 4 to Meta. A fifth question would be refused at go-live.

**Link or QR (D43):**

1. Link: `https://ig.me/m/<username>?ref=<ref_code>`. The frontend makes the QR code from it. Meta's pages show both `ig.me/m/<username>` and `ig.me/<username>`: test needed (section 43).
2. Opening the link sends a `messaging_referral` event with the ref (source SHORTLINK, type OPEN_THREAD). The ref names the automation (level 2).
3. If the account's username changes, the link changes. The ref stays.
4. A ref on a brand-new chat may need ice breakers set (test needed (section 43)).

Example: A prints a QR with `ref=diwali-stall`. Riya scans it at the stall. Her chat with A opens, and the DIWALI automation sends its hello.

**Ad picker (D41):**

1. The picker reads the ads of her connected ad accounts with `ads_read`. If she skipped the ad account step at login, the picker is empty and says "Connect an ad account" (a new login, section 25).
2. Ad "Send message": the referral carries source ADS and the `ad_id`. The automation for that ad answers (level 2). Two live automations on one ad: the oldest answers, and the editor warns.
3. Ad comment: the comment webhook carries `media.ad_id` (with `ad_title` and `original_media_id`), so the automation whose `ad_id` matches answers (section 4.4). The ad's Instagram post is also saved as the target at go-live. Comments on ads that are not boosted posts: test needed (section 43).

### 5.6 Step: Say hello first (D30)

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| Text | 1 to 640 characters (`BUTTON_TEXT_MAX_CHARS` 640, Meta's limit for a message with buttons) | No | "Message" |
| `{name}` | Puts in her name. No name: her username. Neither: the word is left out | No | Name icon |
| Buttons | 1 to 3 (`HELLO_BUTTONS_MAX` 3). Title 1 to 20 characters (`BUTTON_TITLE_MAX_CHARS` 20) | No | "Buttons they can tap", "+ Add another button" |
| Button kind | "opens a link" (`https://`, up to 2,048 characters, `AUTOMATION_LINK_URL_MAX_LENGTH`) or "sends your next step" | No | Two-way switch on each row |
| Versions | 1 to 3 (`MESSAGE_VERSIONS_MAX` 3). A second or third version is PRO | Yes (from version 2) | Version tabs "A +" |
| Nudge | On or off. Shown only for ways where she messaged first (section 5.3) | No | "Nudge once if they don't tap" |

Rules:

1. The messages step is always on. So a hello always needs at least one "sends your next step" button. A link button sends us no tap, so nothing more could go (go-live check 11).
2. Instagram adds a link to the post she commented on, under a private reply. We do not control it.
3. A private reply must go within 7 days of the comment (D9).
4. When the hello goes is decided inside the product: the box of the slow lane, or the random delay of the fast lane (section 11).
5. A private reply with buttons (button message): Meta's example shows text only, so test needed (section 43).

**Versions:**

1. Each run picks one version at random. It is saved on the message row (`version_no`) and on the run (`version_nos`).
2. The nudge uses the same version as her hello.
3. Runs, taps and typed answers are counted per version (`runs_by_version`, `taps_by_version`, `typed_by_version`, D36).
4. "% tapped" = (button taps on the hello + typed answers to the hello) / runs started (D61). A typed answer = her first text while the run waits for `opening_message_button`. Example: 200 runs, 80 taps, 22 typed answers: "51% tapped".

Example: version A "Hey {name}! Want the free guide?" and version B "Hi {name}, tap below and the guide is yours." Riya gets B: "Hi Riya, tap below and the guide is yours." [Send me the guide]

**Nudge:**

1. Only when she messaged first: story reply, story mention, DM, first message, shared post, starter question, link, ad message, tag start with an open window. Never for comments or Live comments.
2. When the hello is `sent`, a `nudge` message is made: fast lane, `not_before` = sent time + 60 minutes (`NUDGE_AFTER_MINUTES` 60). It waits as a delayed ticket.
3. Her tap or any message from her before that time cancels it: `cancelled` with reason `answered`. A reaction (heart) does not cancel it.
4. Just before sending, her window is checked. Closed: `skipped` `window_closed`.
5. It goes once. It counts as 1 DM (D34) and in the fast limit.
6. A tap on the button of the hello or of the nudge moves the run.

```text
 10:00:00  Riya replies "price?" to A's story (window open until 09:45 next day)
 10:00:01  hello sent, version B, button [Send me prices]
           nudge made: waiting, not_before 11:00:01
 11:00:01  no tap yet -> nudge sent (the same hello again, 1 DM)
 11:20:00  Riya taps -> follow check, then the messages
 (If she had tapped at 10:30, the nudge would be `cancelled`, reason `answered`.)
```

### 5.7 Step: Ask them to follow

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| Text | 1 to 640 characters (`BUTTON_TEXT_MAX_CHARS` 640) | No | "Message asking them to follow" |
| "Visit profile" button | Title 1 to 20 characters (`BUTTON_TITLE_MAX_CHARS` 20). Opens the account's profile | No | "Visit profile" |
| "I'm following" button | Title 1 to 20 characters. Sends a tap | No | "I'm following" |
| Versions | 1 to 3 (`MESSAGE_VERSIONS_MAX` 3), picked at random, saved (`version_no`) | Yes (from version 2) | Version tabs |

1. After her tap, the follow check runs: 2 tries, both fail = "following" (D12, section 14).
2. Not following: the follow ask goes. Her tap on "I'm following" starts a new check for the same run.
3. The next step goes only once she follows.
4. Meta lets us read her profile only after her consent: she sent a message or tapped a starter question. Test that a tap on our button counts (section 43).

### 5.8 Steps: Ask for their email and phone (PRO)

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| Email wordings | 1 to 10 (`QUESTION_WORDINGS_MAX` 10), each up to 1,000 bytes (`MESSAGE_TEXT_MAX_BYTES` 1000). The last one cannot be removed | Yes | "Email question" lines |
| Phone wordings | Same | Yes | "Phone question" lines |

1. One wording is picked at random each time. With 2 or more, it is never the same as the last one sent to her. It is saved on the row (`wording_no`).
2. When both steps are on, phone is asked after email.
3. Her answer is saved on the contact. What counts as a valid answer, asks again (`ASK_AGAIN_MAX` 3) and stop words: section 14.
4. Never asked when we already have it (ask once).

Example: email wordings "What's your email? I'll send the guide there." and "Drop your email and the guide is yours." Riya gets the second one. She writes "riya at gmail". The ask again uses the first wording.

### 5.9 Step: Send your messages (D29)

This step is always on. It is the list of messages that go after the steps before it.

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| Number of messages | 1 to 10 (`AUTOMATION_MESSAGES_MAX` 10) | No | "+ Add message N" |
| Kind | One of the 7 below | No | Menu of kinds |
| Wait before | None, or 1 minute (`MESSAGE_WAIT_MIN_MINUTES` 1) to 23 hours (`MESSAGE_WAIT_MAX_HOURS` 23). Message 1's wait counts from the step before it | No | Wait chip "After 1 min" |
| Condition | "Always" only. Others later (D47) | No | Condition chip "Always" |
| Order | Move up, move down, remove | No | Arrows and remove |

**Kinds:**

| Kind (`message_kind`) | The owner gives | Meta's limits | Calls | Counts as DMs |
|---|---|---|---|---|
| `text` | Text up to 1,000 bytes (`MESSAGE_TEXT_MAX_BYTES` 1000). Up to 3 link buttons (`LINK_BUTTONS_MAX` 3), title up to 20 characters | 1,000 bytes, not letters: an emoji or a Gujarati letter uses 2 to 4 bytes. With buttons: up to 640 characters (`BUTTON_TEXT_MAX_CHARS` 640) | 1 | 1 |
| `image` | One picture (upload or library), optional text with link buttons | png or jpeg, up to 8 MB (`MESSAGE_IMAGE_MAX_MB` 8) | 2 with text (picture first, 2 rows with the same `message_no`), 1 without | 2 or 1 |
| `cards` | 1 to 10 cards (`CARDS_MAX` 10). Each: picture, title, line, one link | Generic template: each card needs a title and at least one more part. Title and line (subtitle) up to 80 characters (`CARD_TITLE_MAX_CHARS` 80, `CARD_SUBTITLE_MAX_CHARS` 80). Meta allows 3 buttons per card; we use 1. Not shown on desktop | 1 | 1 |
| `quick_replies` | Text + 1 to 13 choices (`QUICK_REPLIES_MAX` 13), each up to 20 characters (`QUICK_REPLY_MAX_CHARS` 20) | Text only. A title over 20 characters is cut. Not shown on desktop | 1 | 1 |
| `audio` | A voice note file (name and size kept) | aac, m4a, wav or mp4, up to 25 MB (`MESSAGE_AUDIO_MAX_MB` 25). Meta: 10 audio calls per second per account | 1 | 1 |
| `file` | A PDF (name and size kept) | PDF, up to 25 MB (`MESSAGE_FILE_MAX_MB` 25) | 1 | 1 |
| `post` | One of the account's posts, or "Newest" (the newest post when it is sent) | `MEDIA_SHARE`: works only for the account's own posts | 1 | 1 |

Rules:

1. Each call into her chat = 1 DM in every count: the month count (D34), the fast limit and the person limit.
2. A quick reply tap is an answer like text (section 14). It does not change which message comes next: the condition is "Always".
3. **Files:** kept by meepzo-be's upload domain, which scans every uploaded file. A file that is not scanned clean can't be used in a message (D58). Uploaded to Meta once per account by an `attachment-upload` job (queue `instagram-tasks`), and the attachment id is used again (`app.meta_attachments`). After an attachment error the file is uploaded again, up to 3 tries (`ATTACHMENT_UPLOAD_TRIES` 3). All tries failed: the message is `failed` (reason `attachment_failed`) and not counted (section 30).
4. Templates ("Freebie", "Guide link", ...), "Start with" sets and AI wording fill the editor only. The backend sees normal messages.
5. Each call is one row: type `message`, `message_no` 1 to 10, `message_kind`. An image with text = 2 rows with the same `message_no` (section 19).
6. Quick replies, cards, button messages and file upload on Unified Login: test needed (section 43). Video is not a kind now.

### 5.10 Waits and the window

1. Message N+1 is made when message N is `sent`.
2. If message N is `unknown`, the list waits for her next message (D17). Then N may go once more, and the list goes on.
3. Its `not_before` = the sent time of N + its wait. It waits as a delayed ticket. No worker waits.
4. Just before sending: the window check. Her last message + 24 hours - 15 minutes.
5. Window closed: that message is `skipped` with reason `window_closed`. No rows are made for the later ones. The run ends `cancelled` with `cancel_reason` `window_closed`.
6. If she writes again before that time, her window moves on and the messages go.
7. 23 hours is the longest wait, because Instagram allows sending for 24 hours after she last wrote.

```text
 Riya taps at 10:00 (her window is open until 09:45 next day)
   Message 1, no wait     -> 10:00:01           sent
   Message 2, wait 23 h   -> 09:00:01 next day  sent (still inside)
   Message 3, wait 2 h    -> 11:00:01 next day  skipped window_closed (closed 09:45)
                                                 run `cancelled` (window_closed)

 Same list, but Riya writes "thanks!" at 20:00 the first day:
   her window now ends 19:45 next day -> message 3 goes at 11:00:01
```

### 5.11 Step: Reply under their comment (D32)

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| On or off | `public_reply_enabled` | No | "Reply under their comment" |
| Lines | 1 line on Free. 1 to 20 on PRO (`PUBLIC_REPLY_TEXTS_MAX` 20); at least 3 when "Reply like a person" is ON (`PUBLIC_REPLY_LINES_MIN_ON` 3, D52). Each up to 300 characters (`AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH` 300) | Yes (from line 2) | Lines box |
| `@username` first | `public_reply_mention`, true by default (`PUBLIC_REPLY_MENTION_DEFAULT` true). Off = the line without `@username` (D63) | No | — |
| Reply like a person | `reply_like_person`. ON by default for new automations on Creator and Studio (`REPLY_LIKE_PERSON_DEFAULT_PAID` true). Free: OFF only (D59) | Yes | "Reply like a person" |
| Hour limit | `public_reply_hour_limit`: 10, 20, 30, 60 or 100 (`REPLY_LIKE_PERSON_LIMITS`), default 60 (`REPLY_LIKE_PERSON_LIMIT_DEFAULT`) | Yes | "Reply to at most [ ] comments an hour" |

| | "Reply like a person" OFF (the only choice on Free) | "Reply like a person" ON (PRO, the default on Creator and Studio) |
|---|---|---|
| When | Right after the DM went. No hour cap | Random second in the automation's box (3600 / limit), at least 20 s after the account's last ON reply (`PUBLIC_REPLY_GAP_MIN_SECONDS` 20); OFF replies do not count for this gap |
| Who gets one | Every comment | About 80% (`PUBLIC_REPLY_CHANCE_PERCENT` 80), newest first, at most 500 waiting per automation (`PUBLIC_REPLY_MAX_WAITING` 500) |
| Lane | Reply lane, one at a time, no gap | Reply lane, one at a time |
| Both | 7 days, then `expired`. "Too fast" stops only replies. Never on a deleted, hidden or Live comment. The line is random, never the same as the last. At 100% of the month limit, replies of DMs that already went still go: they are not DMs (D62) | |

Full rules: section 13. Everyone still gets the DM. Free accounts reply to every comment with no pace; the risk that Meta flags such an account is accepted (D59).

### 5.12 Step: Tag them (D45)

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| Tags | 0 to 20 per automation (`AUTOMATION_TAGS_MAX_COUNT` 20), each up to 50 characters (`AUTOMATION_TAG_MAX_LENGTH` 50) | No | "Tag them" |
| "Your tags" | The account's tags with how many contacts carry each. A query cached 60 seconds in Redis (`TAG_LIST_CACHE_SECONDS` 60, key `tags:{account}`) | No | "Your tags" |

1. The tags are added when she finishes the automation (run `completed`).
2. An automation with no tags adds no tags.
3. A tag that is new on her makes a "tag added" row in `app.contact_tag_events`, in the same commit as the tag change. A removed tag makes a "tag removed" row. A tag she already has makes no row. Each row holds the contact, the tag, the kind (`added`, `removed`), the source (an automation or the owner), the chain number (`chain_no`) and its times (`created_at`, `queued_at`, `done_at`). After the commit it goes into the intake queue; the helper queues rows that were not queued, so no tag event is lost. Rows are kept 8 days.
4. The owner can add or remove a tag for many contacts at once. It goes in pieces of 500 (`TAG_BULK_PIECE` 500) as `tag-bulk` jobs (queue `instagram-tasks`), so one click never makes one huge transaction.
5. An automation never starts itself by its own tag.
6. One tag event starts one automation: the oldest live one for that tag (like "one automation answers one message"). The editor shows a note when another automation starts from the same tag.
7. A loop between automations (A tags "x", B starts on "x" and tags "y", A starts on "y"): each tag event has a `chain_no`. It is 0 when the owner or a run that did not start from a tag made it, and + 1 when a run started by a tag makes it. At `chain_no` 3 (`TAG_CHAIN_MAX` 3) no automation starts (section 27.9). The person limit, 60 per hour (`PERSON_HOUR_LIMIT_DEFAULT`), also stops a loop.

Example: automation GUIDE tags "lead". Automation NURTURE starts on "lead" added. Riya finishes GUIDE at 10:05. The tag is added. NURTURE starts, her window is open (she tapped at 10:00), and its hello goes.

### 5.13 Hide their comment (D33)

1. Option on comment and ad comment automations: "Hide their comment once the DM is sent". Off by default.
2. Order: public reply first, then hide. A hidden comment cannot get a public reply.
3. No public reply (the reply step is off, or the 80% draw said no): hide right after the DM went. A reply pushed out of the 500 (`skipped` `hour_limit`): hide right then (section 29.2).
4. Type `hide_comment`, reply lane, channel `comment_hide`. It goes right after, with no box.
5. It is not a DM. It is not counted in any limit or in the month count.
6. A failed hide never stops the DM or the reply. A deleted comment: the hide is `skipped`. A hide not done within 7 days of the comment is `expired`. At 100% of the month limit, hides still go: they are not DMs (D62).
7. Only her first comment on each post counts (the once rule). Her second comment gets no DM, so it is not hidden.

```text
 10:00:00  Riya comments "GUIDE" on A's reel (hide ON, reply ON, like a person OFF)
 10:00:04  hello sent as a private reply
 10:00:05  public reply "@riya Sent you a DM!"
 10:00:06  her comment is hidden (others no longer see it)
```

### 5.14 What is decided inside the product, not settings

The owner does not set these. Flowdm shows no setting for them.

1. How keywords match: contains + close spelling (section 5.5).
2. When the hello goes: the box of the slow lane, or the random delay of the fast lane (sections 9, 11). On PRO the owner may add an extra delay for the whole account (D67, section 5.15).
3. The pace of public replies, apart from the hour limit (section 13).
4. Which version and which wording each person gets: random.
5. The nudge time: 60 minutes (`NUDGE_AFTER_MINUTES`).

All of these numbers are in the settings file (section 36). The team can change them. The owner cannot.

### 5.15 Account settings (D64 to D67)

These four settings are per Instagram account, not per automation. They live in `app.instagram_account_settings`.

| Setting (column) | Values and default | PRO | What it does |
|---|---|---|---|
| Replies under comments start automations (`trigger_on_comment_replies`) | ON or OFF, default ON | No | ON: a reply under another comment can start comment automations; our public reply goes under the top-level comment. OFF: such replies start nothing (D64) |
| Once per person per post (`once_per_person_per_post`) | ON or OFF, default ON | No | ON: the once rule (D13). OFF ("every time"): each new comment or keyword DM starts a new run (D65) |
| Mark as seen after our reply (`mark_seen_after_reply`) | ON or OFF, default OFF | No | ON: one "seen" call for her chat after our message went. Not a DM, not counted (D66). Test needed (section 43) |
| Delay before each message (`extra_delay_seconds_min`, `extra_delay_seconds_max`) | Both empty = off. 1 to 20 seconds (`EXTRA_DELAY_MAX_SECONDS` 20), min not over max | Yes | An extra random pause before the first answer we send after each tap, typed answer, story reply or DM of hers. Her wait for that answer stays at most 25 seconds (D67) |

Rules:

1. A comment written by the account itself never starts anything, whatever the settings say (`own_comment`).
2. "Every time" still allows only one open run per automation and person: a new comment, keyword DM or any other start while her run of that automation is open is `ignored` (`run_in_progress`). It never breaks Meta's rules: one private reply per comment, and one opening private reply per person per 24 hours while her window is closed (`OPENING_PERSON_GAP_HOURS`). The person limit (60 per hour) still holds.
3. "Mark as seen" goes at most once per message she sent, and not when the owner typed to her by hand after her message.
4. The extra delay is added once per her event, to the first answer only. Later list messages with no wait follow the normal 500 to 2,000 ms. Never after a follow check, never for slow-lane private replies, public replies, nudges, list waits or broadcasts. On Free it cannot be set; after a move down it is off (D57).
5. Every change is written to the audit log.

Example (account A): Riya comments "GUIDE" on reel R on Monday at 10:00, taps, and gets the guide. On Wednesday at 10:00 she comments "GUIDE" on R again. "Once per person per post" ON: nothing (the once rule). OFF ("every time"): a new run starts. Her window is closed and her last opening private reply was 2 days ago, so a new private reply goes in the slow lane.

Example (extra delay 3 to 8 seconds): Riya taps at 10:03:00. The fast delay picks 1.2 s and the extra delay 5.4 s. Message 1 goes at 10:03:06.6. Message 2 (no wait) goes about 1 s after message 1 is sent, with no extra delay.

### 5.16 Run on past comments (D69, PRO)

A live comment or ad-comment automation can also answer comments that came before it went live. Not for Live comments: a Live private reply works only during the Live.

```text
 Owner taps "Also answer comments from the last N days" (N = 1 to 7)
    |
    v
 `past-comments` job (queue `instagram-tasks`), one at a time per account
    |  reads /comments of each post, newest first, 50 per page,
    |  until older than N days (replies only if D64 is ON)
    v
 Each comment -> normal intake as an "old" comment
    |  match, once rule (D65), stop words, own comments, already answered
    v
 Opening DMs wait in the slow lane (opening limit; "old" in the 4 new : 1 old mix)
    |
    v
 Owner sees: "Found 340 comments. 290 match. About 250 will go, about 40 may
 expire."
```

| Field | Limits | PRO | Flowdm name |
|---|---|---|---|
| Days back | 1 to 7 (`PAST_COMMENTS_MAX_DAYS` 7), minus `EXPIRY_SAFETY_MINUTES` | Yes | "Also answer comments from the last N days" |
| Posts read | The automation's target post or posts. "Any post": the newest 50 posts with comments in those days (`PAST_COMMENTS_POSTS_MAX` 50) | Yes | — |

Rules:

1. The button shows only after go-live. One running past-comments run per automation (`app.automation_backfills`: `queued`, `reading`, `done`, `failed`, with `found`, `matched`, `queued_count`).
2. Each comment keeps its own 7-day clock. The oldest ones may expire before their turn; the estimate shows how many.
3. The reads count in Meta's non-messaging limit (4,800 x impressions per 24 hours). A failed read is tried again (`META_TASK_RETRY_MINUTES`).
4. Comments already answered, her own second comment on a post (when "once per person per post" is ON), stop words, paused people and the account's own comments are handled exactly as for a new comment.
5. After a move down to a plan without PRO, an unfinished run ends `failed` (`plan_feature_off`). DMs it already queued still go.


---

## 6. Message types and lanes

Every message we want to send (a picture with its text is 2), and every other call we make on her comment, is one row in `app.instagram_messages` (section 19). Each account has 4 lanes: `slow`, `reply`, `fast` and `broadcast`. This table says which lane sends each type.

| Message type | When it is made | Lane | Channel | Limit it uses | Counts as a DM (D34) | Delay | Made by |
|---|---|---|---|---|---|---|---|
| `opening_message` | She commented on a post, reel or ad, window closed | `slow` | `private_reply` (to her comment) | Opening limit (600 per hour) | Yes | Random second in its box | Intake |
| `opening_message` | She commented, window open; or any start from a message or a tag | `fast` | `direct` (normal DM) | Fast limit (10,000 per hour) | Yes | 500 to 2,000 ms | Intake |
| `opening_message` | She commented on a Live video while it is on, window closed | `fast` | `private_reply` (to her Live comment) | Fast limit | Yes | 500 to 2,000 ms | Intake |
| `nudge` | The hello went, she messaged first, no tap for 1 hour | `fast` | `direct` | Fast limit | Yes | 60 minutes after the hello was sent (`NUDGE_AFTER_MINUTES` 60) | Result save of the hello |
| `public_reply` | The DM of that comment went, and the automation's "Reply under their comment" step is ON | `reply` | `comment_reply` (under her comment) | "Reply like a person" OFF: none. ON: the automation's hour limit (10 to 100) | No | OFF: right after. ON: random second in the automation's box, at least 20 s after the account's last ON reply | Result save of the DM |
| `hide_comment` | "Hide their comment" is on, and the public reply went (or the DM went, when no reply comes) | `reply` | `comment_hide` | None | No | Right after | Result save of the reply or the DM |
| `follow_check` | She tapped, the automation needs a follow | `fast` | none (it only reads) | Not counted | No | 500 to 2,000 ms after her tap | Intake |
| `follow_request` | The check says "not following" | `fast` | `direct` | Fast limit | Yes | None (right after the check) | Result save of the check |
| `email_question` | Email needed and we have none | `fast` | `direct` | Fast limit | Yes | 500 to 2,000 ms after her message, none after a check | Intake or result save |
| `invalid_email` | Her email was not correct | `fast` | `direct` | Fast limit | Yes | 500 to 2,000 ms | Intake |
| `phone_question` | Phone needed and we have none, or her phone was not correct | `fast` | `direct` | Fast limit | Yes | 500 to 2,000 ms | Intake or result save |
| `message` (`message_no` 1 to 10) | Message 1: the steps before it are done. Message N+1: message N is `sent` | `fast` | `direct` | Fast limit (each call) | Yes, each call | Message 1: 500 to 2,000 ms (none after a check). Message N+1: N's sent time + its wait; no wait: 500 to 2,000 ms | Intake or result save |
| `broadcast` (with `broadcast_id`) | The owner's broadcast reaches her while her window is open (section 8.10) | `broadcast` | `direct` | Broadcast limit (600 per hour) | Yes, each call | Random second in its box | The broadcast job (section 30) |

Words used here:

- **Hello**: the opening message (step "Say hello first"), type `opening_message`.
- **Nudge**: the hello sent once more, 1 hour later, when she did not tap (section 8.8).
- **Hide**: we hide her comment from other people with one call (section 13.6).
- **Message list**: the automation's 1 to 10 messages, type `message` (section 8.7).
- **Broadcast**: 1 to 3 messages the owner sends to many contacts of one account, only to people whose chat is open (section 8.10).

Rules for all of them:

1. The first message to a comment when her window is closed is always a private reply: in the slow lane for a post, reel or ad comment; in the fast lane for a Live comment (section 7.3). If the automation has no hello, its first needed step goes that way: the follow request, a question, or message 1 (section 7.5).
2. A private reply is one call. Meta allows one message per comment until she answers.
3. Every fast message and every broadcast message counts in the person limit (60 per hour), except the follow check.
4. Opening DMs in the slow lane, public replies, hides and broadcast messages never count in the fast limit.
5. **One call into her chat = one DM** in every count: the fast limit, the person limit and the month count (section 10.2). A message with a picture and a text is 2 calls (the picture first) and 2 rows with the same `message_no`, so it counts 2. Each row keeps `counts_as_dm`.
6. Public replies, hides and follow checks never count as DMs.
7. The text is read from the automation when the message goes. The row keeps only which version (`version_no`), which wording (`wording_no`), which message (`message_no`) and which kind (`message_kind`) (section 5).
8. A "mark seen" call (D66) is not a message to her: fast lane, group `none`, never counted (section 14.6).

### 6.1 How each message kind is sent

The owner picks the kind of each message in the list (section 5). This is what goes to Instagram.

| `message_kind` | Calls into her chat | Counts as DMs | Notes |
|---|---|---|---|
| `text` | 1 | 1 | Up to 1,000 bytes (`MESSAGE_TEXT_MAX_BYTES` 1000): an emoji or a Gujarati letter uses 2 to 4 bytes. With link buttons (up to 3, `LINK_BUTTONS_MAX` 3) it is a button message: up to 640 characters (`BUTTON_TEXT_MAX_CHARS` 640) |
| `image` | 1, or 2 with a text (the picture first; 2 rows, same `message_no`) | 1 or 2 | png or jpeg, up to 8 MB (`MESSAGE_IMAGE_MAX_MB` 8). Uploaded to Meta once per account; the attachment id is used again (`app.meta_attachments`) |
| `cards` | 1 | 1 | Up to 10 product cards (`CARDS_MAX` 10), Meta's "generic template". Title and line up to 80 characters each (`CARD_TITLE_MAX_CHARS` 80, `CARD_SUBTITLE_MAX_CHARS` 80), up to 3 buttons per card. Not shown on desktop (Meta) |
| `quick_replies` | 1 | 1 | Up to 13 choices (`QUICK_REPLIES_MAX` 13), 20 characters each (`QUICK_REPLY_MAX_CHARS` 20). Not shown on desktop (Meta) |
| `audio` | 1 | 1 | Voice note: aac, m4a, wav or mp4, up to 25 MB (`MESSAGE_AUDIO_MAX_MB` 25). Meta allows 10 audio or video calls per second per account |
| `file` | 1 | 1 | PDF, up to 25 MB (`MESSAGE_FILE_MAX_MB` 25) |
| `post` | 1 | 1 | One of the account's own posts, or the newest one (`MEDIA_SHARE`; Meta allows only the account's own posts) |

1. An attachment error: the file is uploaded again, up to 3 tries in all (`ATTACHMENT_UPLOAD_TRIES` 3). All tries failed: the message is `failed` (`attachment_failed`) and is not counted (section 30).
2. meepzo-be's upload domain scans every uploaded file. A file that is not scanned clean cannot be used in a message.
3. The hello is one call: a text up to 640 characters (`BUTTON_TEXT_MAX_CHARS` 640) with up to 3 buttons (`HELLO_BUTTONS_MAX` 3).

---

## 7. Comment flow

### 7.1 Post or reel comment

```text
Riya comments "GUIDE" on post P of account A
        |
        v
Webhook saves the event. Intake job.
        |
        v
A `live` comment automation for post P with this keyword?  -- no --> nothing
        | yes (one automation per comment: post-linked first, then the oldest)
        v
Already done: automation GUIDE + post P + Riya?  -- yes --> nothing
        | no                                      (comment log: ignored)
        v
Run starts (runs + 1 on GUIDE). Is her chat window open?
        |                                     |
     closed                                  open
        v                                     v
opening_message, slow lane             opening_message, fast lane
private reply to her comment           normal DM, 500 to 2,000 ms
 - one per person per 24 hours          - no 24-hour wait
 - random second in its box             - counts in the fast limit
 - up to 7 days, then `expired`
        |                                     |
        +------------------+------------------+
                           v
                      DM `sent`? ---- `unknown` --> never sent again by itself;
                           | yes                   run waits for `any` (her next
                           |                       message or tap may send it once more)
                           +--> "Reply under their comment" ON? --> public reply
                           +--> "Hide their comment" on? --> hide after the reply
                           v                                   (section 7.2)
             Run waits for her tap (`opening_message_button`)
                           |
             she taps a "next step" button, or writes any text
                           v
    Fast lane, 500 to 2,000 ms after her action, one message at a time to her:
                           |
       follow needed? --> follow_check (2 tries; both fail = "following")
                           |     not following --> follow_request --> wait
                           v
       email missing? --> email_question --> wait for her email
                           v
       phone missing? --> phone_question --> wait for her phone
                           v
       message 1 --> wait --> message 2 --> ... --> message N  (section 8.7)
                           v
                 tag step adds its tags --> run `completed`
```

Steps in words:

1. The webhook saves the comment (section 26). The intake job reads it (section 27).
2. Intake finds one live automation for this post and keyword. Post-linked automations come first (one post, my next post, posts between), then the oldest "any post" one. One automation answers one comment (meepzo-be's rule). Keywords match by "contains" and close spellings (section 5).
3. Done before for this automation + post + person: nothing is sent (section 9).
4. She sent a stop word before: this keyword comment starts her again (`opted_out_at` cleared, section 14.4). The owner paused automations for her (section 14.7): nothing starts, and her comment gets no DM, no public reply and no hide.
5. A run starts. In the same commit the automation's `runs_started` counter goes up (section 15.1). Intake checks her window.
6. Window closed: the first message waits in the slow lane as a private reply. Window open: it goes in the fast lane as a normal DM.
7. When the DM is `sent`: the public reply is made, if the step is ON (section 13). Then the hide, if the option is on (section 7.2).
8. The run waits for her tap on a "next step" button. A typed text counts like a tap (section 14). A tap on a link button sends us nothing.
9. After her tap: follow check, email, phone, then the message list, each only if needed. A comment never gets a nudge (section 8.8).
10. Every question waits for her answer. The run waits at most 7 days (`RUN_WAIT_MAX_DAYS`). Then it is cancelled.
11. After the last message went, the tag step adds its tags. The run is `completed`.

Meta sends comment webhooks only for **public** accounts. On a private account, comment, Live-comment and ad-comment automations never start. The owner sees a banner and a go-live warning (section 15).

Replies under other comments and the account's own comments: section 7.6. Comments from before go-live: section 7.7.

### 7.2 After the DM: public reply and hide

```text
DM of her comment is `sent` (private reply, or normal DM when her window was open)
        |
        v
"Reply under their comment" ON?
   |                       |
   no                     yes
   |                       v
   |           "Reply like a person"?
   |             OFF                           ON (PRO)
   |              v                             v
   |       public_reply now,              draw: about 80% get one
   |       reply lane                        | chosen            | not chosen
   |              |                          v                   v
   |              |                   waits for a random     no row; comment log
   |              |                   second in the          `skipped` (`random`)
   |              |                   automation's box            |
   |              v                          v                    |
   |       reply `sent`, `failed`, `skipped` or `expired`         |
   |              |                                               |
   +--------------+-----------------------------------------------+
                  v
       "Hide their comment once the DM is sent" on? -- no --> done
                  | yes
                  v
       hide_comment now: reply lane, channel `comment_hide`
       (not a DM, no limit; a failed hide changes nothing else)
```

1. A hidden comment cannot get a public reply. So the hide always goes last.
2. A DM that is `unknown` makes no reply and no hide, unless it is later proven `sent`.
3. A Live comment gets neither (section 7.3).
4. All rules for replies and hides: section 13.

### 7.3 Live comments

Meta sends a `live_comments` event when someone comments on the account's Live video. This field needs Advanced Access (section 25). Meta allows a private reply to a Live comment **only while the Live is on**, up to 100 per second per account.

```text
Riya comments "LINK" on account A's Live video at 20:05 (the Live is on)
        |
        v
Webhook saves the `live_comments` event. Intake job.
        |
        v
A `live` Live-comment automation of account A with this keyword? -- no --> nothing
        | yes
        v
Already done: automation + this Live (`live:<media id>`) + Riya? -- yes --> nothing
        | no
        v
Run starts. Her window open? -- yes --> normal DM, fast lane (as 7.1)
        | no
        v
opening_message: private reply to her Live comment,
fast lane, 500 to 2,000 ms, fast limit + month count
        |
        v
Instagram answers:
   OK -------------> `sent`; the run waits for her tap (as 7.1)
   "Live ended" ---> `expired` (reason `live_ended`); the run is cancelled (`expired`)
```

Rules:

1. One private reply per Live comment. Once per automation, per Live, per person (`live:<media id>`).
2. **Fast lane**, never the slow lane: it must go while the Live is on. The 24-hour person rule of the slow lane does not apply.
3. It counts in the fast limit, the person limit and the month count. Meta's 100 per second (`LIVE_PRIVATE_REPLY_PER_SECOND`, fixed) is far above our 20 at once.
4. The Live is over before it goes: `expired`, reason `live_ended`. We know it from Instagram's "Live ended" answer (`CODES_LIVE_ENDED`), or when `GET /<account>/live_media` (it lists only the Lives on air now) no longer shows that Live. Live comment webhooks stop when the Live ends. When the first "Live ended" answer comes, every other waiting private reply of that Live becomes `expired` (`live_ended`) at once, with no call. A Live private reply still waiting after 240 minutes (`LIVE_REPLY_MAX_AGE_MINUTES` 240, estimate: a Live lasts at most 4 hours) is `expired` (`live_ended`) too.
5. No public reply and no hide on a Live comment.
6. After her tap, everything goes as for a post comment (her window is open now).
7. Two keywords from her on one Live: as for a post (section 9.3).
8. Meta's Live pages did not load when we read the docs: the Live rules need a test (section 43).

### 7.4 Ad comments

A comment under the account's ad works like a post comment.

```text
Riya comments "PRICE" under account B's ad (ad 1203)
        |
        v
`comments` event with `media.ad_id` 1203 (also `ad_title`, `original_media_id`)
        |
        v
A `live` ad-comment automation for ad 1203 with this keyword? -- no --> other
        | yes                                          comment automations (7.1)
        v
Same as 7.1: once rule (media id), window check, slow lane private reply,
public reply and hide, then her tap and the rest
```

1. The automation names its ad (`ad_id`). The ad picker reads the account's ads with `ads_read` (section 25). At go-live the ad's Instagram post is saved as its target (test needed). An ad comment event carries `media.ad_id`, `ad_title` and `original_media_id`: intake finds the automation by `ad_id`.
2. An ad-comment automation counts as linked to that media, so it comes before "any post" automations (the one-automation rule of 7.1).
3. Window closed: slow lane private reply, 7 days, 24-hour person rule. Window open: a normal DM in the fast lane. Public reply and hide: all as for a post comment.
4. Comments on a boosted post come as comments on that post. A comment on a dark ad (an ad that is not a post) needs the ad's media from the Marketing API (`effective_instagram_media_id`).
5. **Test needed (section 43):** Meta's docs say an ad comment carries `media.ad_id`. The test checks, with our setup, that ad comments reach our `comments` webhook, that we can reply to them and hide them, and how comments on dark ads come. Until the test passes, "Ad comment" is not offered.

### 7.5 A comment start without a hello

1. The hello step can be off. Then the first needed step goes as the private reply: the follow request, the email question, the phone question, or message 1.
2. A private reply is one call, and a comment does not open her window. So a comment, Live-comment or ad-comment automation with no hello, follow, email or phone step may have **only 1 message**, and it must be a `text` message with no picture (one call). Go-live checks this (section 15.5).
3. With a follow, email or phone step first, her tap or her answer opens her window. Then the whole message list can go after it.
4. A private reply with buttons (a button message): Meta's example shows text only. Test needed (section 43).
5. The editor says it under the steps: "Without a hello, a comment automation can send only one text message."

### 7.6 Replies under comments, and our own comments

A comment can be a reply under another comment (a thread reply). Meta sends it with `parent_id` (D64).

```text
comment event on post P
        |
        v
written by account A itself? (`from.id` = A, or `self_ig_scoped_id`)
        | yes --> ignored, reason `own_comment` (so our own replies never start)
        | no
        v
has `parent_id`? (a reply under another comment)
        | yes --> `trigger_on_comment_replies` OFF? --> ignored (`thread_reply_off`)
        |         ON --> goes on like any comment on post P
        | no
        v
the comment flow of 7.1
```

1. Account setting `trigger_on_comment_replies`, ON by default.
2. **ON:** a reply under another comment can start comment automations like any comment on that post. Its public reply goes under the top-level comment (Meta puts replies to replies there). A private reply to a reply comment: test needed (section 43).
3. **OFF:** a reply under another comment never starts anything. The comment log says `ignored`, reason `thread_reply_off`.
4. **Always (ON or OFF):** a comment written by the connected account itself never starts anything (reason `own_comment`). So our own public replies never start an automation.
5. The missed-comment check also reads replies only when the setting is ON (test needed: the `replies` field, section 43).

### 7.7 Run on past comments (PRO)

After go-live, the owner can let a comment or ad-comment automation also answer comments that came before it was live (D69).

```text
Owner of account A, automation GUIDE is live:
"Also answer comments from the last 7 days" (1 to 7 days)
        |
        v
`app.automation_backfills` row `queued`; job `past-comments` in `instagram-tasks`
(one at a time per account; one running backfill per automation)
        |
        v
`reading`: for each target post, read `/comments` newest first, 50 per page,
until the comments are older than 7 days (replies too, only if
`trigger_on_comment_replies` is ON)
        |
        v
each comment goes through the normal intake as an "old" comment:
match, once rule (9.6), stop words, own comments, already answered
        |
        v
opening DMs wait in the slow lane: opening limit, "old" in the 4 new : 1 old mix;
each one expires 7 days after its own comment time
        |
        v
`done`: "Found 340 comments. 290 match. About 250 will go, about 40 may expire."
```

1. For comment and ad-comment automations only. Not for Live comments: a Live private reply works only while the Live is on.
2. N = 1 to 7 days (`PAST_COMMENTS_MAX_DAYS` 7), minus 30 minutes (`EXPIRY_SAFETY_MINUTES`).
3. Posts read: the automation's target post or posts. For "any post": the newest 50 posts that have comments in those days (`PAST_COMMENTS_POSTS_MAX` 50).
4. Meta's `/comments` has no time filter. So we read pages until a comment is older than N days.
5. Each comment brings its own `timestamp`. The 7 days count from it, so the oldest comments may expire. The estimate (section 12.3) gives "will go / may expire".
6. Window open for her (she wrote in the last 24 hours): her opening message goes as a normal DM in the fast lane, as for any comment.
7. The reads count in Meta's non-messaging limit (4,800 x impressions in 24 hours).
8. The job retries after 1, 5, 15 and 60 minutes (`META_TASK_RETRY_MINUTES`). Then the backfill is `failed`, and the owner sees it (section 15.2).
9. The backfill row keeps `found`, `matched` and `queued_count`, and its `started_at` and `done_at`.
10. PRO (Creator and Studio). Test needed: the speed and limits of reading many comments (section 43).
11. After a move down, an unfinished past-comments run ends `failed` (reason `plan_feature_off`). The DMs it already queued still go.
12. The helper watches for a backfill stuck for 30 minutes (`BACKFILL_STUCK_MINUTES` 30, section 34).
13. Who: the automation permission codes (`automation:create`, `automation:update`, `automation:read`); there are no new codes.

---

## 8. Story reply, DM and other message flows

In these flows she wrote to the account first: a story reply, a DM, a story mention, a shared post, a starter question tap, a link open or an ad message. So her window is open. There is no private reply and no public reply. The first message goes in the fast lane as a normal DM.

Tag starts are the one exception: they come from inside meepzo-be, so her window may be closed (section 8.6).

### 8.1 One picture for all message starts

```text
Riya writes to account A: a story reply, a DM, a story mention, a shared post,
a starter question tap, a link open, or an ad "Send message"
        |
        v
Webhook saves the event. Intake job. Her window is open now (24 hours).
        |
        v
Stop word? ------------------------------------------- yes --> opted out (14.4)
        | no
        v
Does a run of hers wait for this? (tap, answer, `any`) -- yes --> move that run
        | no                                                      (section 14)
        v
Match order (8.2): exact source -> place and keyword -> first message ->
no other automation answered                          -- nothing --> done
        | one automation matched
        v
She sent a stop word before? Only a keyword DM, a starter question tap
or a link starts her again (14.4); any other start ----------> nothing
        | no, or a start that restarts her (`opted_out_at` cleared)
        v
Once rule: same automation + same once key? (9.2) ---- yes --> nothing
        | no
        v
Run starts. Fast lane, 500 to 2,000 ms after her message:
  hello (normal DM with its buttons) --> waits for her tap --> nudge? (8.8)
        |
        v
  follow_check --> follow_request? --> email_question? --> phone_question?
        |
        v
  message 1 --> wait --> message 2 ... (8.7) --> tags --> run `completed`
```

A story reply or a DM has no comment. So a message whose window closed can never become a private reply.

After this, a "deliver when her chat opens" broadcast may also go to her (section 8.10).

### 8.2 Match order: one message, one automation

One message from her starts at most one automation (D37).

```text
her message or tap
   |
   1. a tap or an answer for one of her own runs ---------- yes --> that run moves
   |  no
   2. exact source: starter question, link ref, ad id ----- yes --> that automation
   |  no
   3. place and keyword: story reply, story mention, shared post, DM keyword,
   |  and automations that "also start from" this place --- yes --> that automation
   |  no
   4. her first ever message to this account -------------- yes --> that automation
   |  no
   5. "no other automation answered" ---------------------- yes --> that automation
   |  no
   nothing is sent
```

1. Inside one step: an automation for one post or one story beats an "any" one; an automation's own way to start beats "also start from"; then the oldest live one.
2. A match stopped by its once key ends the search: nothing is sent, and no later step is tried.
3. A starter question tap, a link open and an ad message are never also a keyword match. A starter question tap whose automation is no longer live counts as a normal message (it goes on to step 3).
4. A reaction never starts an automation. A photo, voice note, video or sticker can start only "first message" and "no other automation answered".
5. "No other automation answered" never runs on a reaction, a read receipt or a deleted message. It also waits while the owner talks to her by hand: not within 6 hours of the owner's own message to her (`OWNER_CHAT_QUIET_HOURS` 6). This quiet time is per contact: other people are not affected.
6. **Also start from** (D38): a comment automation may also start from a story reply or a DM; a story reply automation from a DM; a DM keyword automation from a story reply. Off by default (`also_start_from` empty). It then uses the once key of that place (`story:<story id>` or `dm:<date>`). A comment is never added to a story or DM automation.

### 8.3 Each way to start from a message or a tag

| Way to start | Meta sends | How it matches | Once key (`post_key`) | Notes |
|---|---|---|---|---|
| Story reply | `messages`, a reply to a story | Any story or one story; its keywords if it has some | `story:<story id>` | |
| Story mention | `messages` with a story mention | Any mention of the account | `mention:<story id>` | We never store the story picture (Meta gives only a link) |
| Story repost | Test needed (section 43) | — | — | Built only if Meta sends it |
| DM keyword | `messages` | Keywords: "contains" and close spellings | `dm:<date>` | |
| Their first ever message | `messages`, and `app.contacts.first_message_at` is empty | Her first direct message to this account | `first` | People who wrote before the account was connected count as new once (we cannot see older chats) |
| Your post sent to you | `messages` with a shared post | Any of the account's posts, or one post | `share:<media id>` | A share of someone else's post does not match |
| Starter question | `messaging_postbacks` (ice breaker tap) | The tapped question's payload names the automation | `starter:<date>` | 1 to 4 questions per automation (`starter_questions`); at most 4 live per account (`STARTER_QUESTIONS_MAX` 4) |
| Link or QR code | `messaging_referral` with `ref` | The automation's `ref_code` on this account | `ref:<date>` | Link `https://ig.me/m/<username>?ref=<ref_code>` (format: test needed) |
| Ad "Send message" | `messaging_referral`, source ADS, `ad_id` | The automation of that ad | `ad:<ad id>` | Window 24 hours (7 days: test needed) |
| No other automation answered | `messages`, nothing matched | Last in the match order | `default:<date>`; "every time": `default:<her message id>` | "Once a day per person" (default) or "every time" |
| Tag added | Inside meepzo-be (`app.contact_tag_events`) | The tag name; one tag event starts only the oldest live automation for that tag | `tag:<tag>:<event id>` | Only if her window is open |
| Tag removed | Inside meepzo-be (`app.contact_tag_events`) | Same as tag added | `untag:<tag>:<event id>` | Only if her window is open |

`<date>` = the day in the workspace's time zone. An ice breaker is Meta's name for a starter question. A ref is the code at the end of our link.

### 8.4 Story reply and DM keyword

1. Story reply: the automation is for any story or one story, with or without keywords.
2. DM keyword: the automation needs at least one keyword. It answers once per automation per person per day (`dm:<date>`).
3. Her text first moves a run of hers that waits for it (section 14). Only a message that moved no run can start a new automation.
4. The run and its first step go in the fast lane, channel `direct`, with the random delay.

### 8.5 Starter questions, links and ad messages

**Starter question.**

```text
Owner switches automation PRICES live (questions "What's the price?", "Do you ship?")
        |
        v
Go-live check: A's live starter questions, with these 2, at most 4? -- no --> refused
        | yes                                                          (section 15.5)
        v
A job sets account A's ice breakers (`messenger_profile`): all its live questions
        |
        v
Riya opens the chat with A on her phone and taps "What's the price?"
        |
        v
`messaging_postbacks` event, payload = the automation --> match step 2
        |
        v
Run starts, once a day per person (`starter:<date>`), fast lane
```

1. One automation has 1 to 4 questions (`starter_questions`). All live questions of one account together: at most 4 (Meta).
2. A pause, a delete or a changed question runs the same job again.
3. Starter questions do not show on desktop (Meta).

**Link or QR code.**

```text
Owner copies https://ig.me/m/account_a?ref=summer-guide (or prints its QR code)
        |
        v
Riya scans the QR code. Instagram opens her chat with A.
        |
        v
`messaging_referral` event (source SHORTLINK, ref "summer-guide") --> match step 2
        |
        v
Run starts, once a day per person (`ref:<date>`), fast lane
```

1. `ref_code`: letters, digits, `-`, `_`, `=`, up to 64 characters (`REF_CODE_MAX_CHARS` 64; Meta allows up to 2,083). Unique per account.
2. The QR code is made by the frontend from the link.
3. A brand-new chat may need the account's ice breakers to be set before Meta sends the ref (test needed, section 43).
4. Meta's pages show both `ig.me/<username>` and `ig.me/m/<username>`: test needed (section 43).

**Ad "Send message".**

```text
Riya taps "Send message" on account B's ad 1203 and sends the ready text
        |
        v
`messaging_referral` event (source ADS, ad_id 1203) with her message
        |
        v
match step 2: the automation of ad 1203
        |
        v
Run starts, once per ad per person (`ad:1203`), fast lane
```

1. Her window: 24 hours in this plan. Meta's page says a click-to-message ad may open a 7-day window; test needed (section 43).
2. We only read ads (`ads_read`). Making ads is later (section 49).

### 8.6 Tag starts

```text
Tag "vip" is added to Riya (by an automation's tag step, or by the owner)
        |
        v
A row in `app.contact_tag_events`, saved in the same commit as the tag change
        |
        v
An intake job (the helper queues any row that was not queued)
        |
        v
The oldest `live` "Tag added: vip" automation on this account? -- none --> nothing
        | yes        (never the automation whose own tag step added "vip")
        v
Her window open? -- no --> no run starts, nothing sent (start skipped, `window_closed`)
        | yes
        v
Run starts (`tag:vip:<event id>`), fast lane, as 8.1
```

1. Tag removed works the same way (`untag:<tag>:<event id>`).
2. **No tag event is lost.** Each tag change writes a row in `app.contact_tag_events` (contact, tag, `added` or `removed`, source automation or owner) in the same commit. The helper queues rows that were not queued, like webhook events. Rows are kept 8 days.
3. The owner's bulk "Add tag" or "Remove" goes in pieces of 500 (`TAG_BULK_PIECE` 500). Each contact gives one row.
4. Each tag event starts again (the key holds the event id). One tag event starts only the oldest live automation for that tag.
5. **Loops:** a run started by a tag event that adds a tag makes a new event with `chain_no` + 1 (the owner's own changes have `chain_no` 0). At `chain_no` 3 (`TAG_CHAIN_MAX` 3) no automation starts. The person limit (60 per hour) also stops a loop: X adds tag "a", Y on "a" adds tag "b", X on "b" adds "a" again.
6. An automation never starts itself by its own tag.

### 8.7 The message list, waits and the window check

Every automation sends 1 to 10 messages (`AUTOMATION_MESSAGES_MAX` 10). Each one has a kind (section 6.1) and a wait before it: none, or 1 minute to 23 hours (`MESSAGE_WAIT_MAX_HOURS` 23). The condition is "Always" (other conditions are later, section 49).

```text
Riya taps at 10:00:00. Her window is open until 09:45 next day
(her tap + 24 hours - 15 minutes).

  message 1, no wait     -> 10:00:01           sent
        |  made when 1 is sent: not_before = 10:00:01 + 23 h
        v
  message 2, wait 23 h   -> 09:00:01 next day  window check: open --> sent
        |  made when 2 is sent: not_before = 09:00:01 + 2 h
        v
  message 3, wait 2 h    -> 11:00:01 next day  window check: closed (09:45)
                                               --> `skipped` (`window_closed`)
  message 4, wait 5 min  -> never made; the run ends `cancelled` (`window_closed`)
```

Rules:

1. Message 1 is made when the steps before it are done (her tap, follow, email, phone).
2. Message N+1 is made when message N is `sent`. Its `not_before` = N's sent time + N+1's wait. It waits as a delayed ticket. A worker never waits.
3. No wait: a new random delay of 500 to 2,000 ms after N was sent.
4. Message N is `unknown`: N+1 is not made. The list waits for her next message or tap (D17). Then N goes once more, and the list goes on.
5. **Window check**, just before sending (in the claim, section 30): her last message + 24 hours - 15 minutes (`MESSAGING_WINDOW_HOURS`, `WINDOW_SAFETY_MINUTES`).
6. Closed: that message is `skipped` (reason `window_closed`). No rows are made for the rest of the list. The run ends `cancelled` (`cancel_reason` `window_closed`). The owner sees "skipped because her chat closed" (section 15.2).
7. She writes again before its time: her window moves, so the message goes.
8. Each call is one row: type `message`, `message_no` N, `message_kind`.
9. A picture with a text is 2 calls, 2 rows with the same `message_no` (the picture first) and 2 DMs (section 6.1).
10. Two runs to one person: one message at a time to her (section 11.2).

### 8.8 The nudge

The nudge is the hello sent once more, when she did not tap.

```text
Riya replies to a story. The hello goes at 10:00:01 (she messaged first).
        |
        v
Result save of the hello: nudge row made: type `nudge`, fast lane,
not_before = 11:00:01 (`NUDGE_AFTER_MINUTES` 60), delayed ticket
        |
        +-- she taps a hello button, or writes, before 11:00:01
        |      --> nudge `cancelled` (reason `answered`)
        v
11:00:01: the ticket wakes. Her window still open? -- no --> `skipped` (`window_closed`)
        | yes
        v
The same hello goes once more (same version, same buttons). 1 DM.
The run keeps waiting for her tap.
```

1. Only when she messaged first: story reply, DM, story mention, first message, shared post, starter question, link, ad message, or a tag start (her window is open).
2. Never for a comment, a Live comment or an ad comment. Meta allows one message there until she answers.
3. Only if the owner switched it on ("Nudge once if they don't tap").
4. Once only. Her tap on the nudge's button works like a tap on the hello.
5. A reaction (heart) does not cancel it. Her tap or her message does.

### 8.9 Window closes while a question waits

1. The hello, the follow request or a question (email, phone) waits and her window closes (for example during a long block): that message becomes `skipped` (`window_closed`).
2. The run waits for `any`. Her next message opens the window again and the run goes on.
3. The first message of a comment run is different: it goes back to the slow lane as a private reply, if under 7 days (section 9.4).
4. The message list is different: the message is `skipped`, nothing more is made, and the run ends `cancelled` (`window_closed`) (section 8.7).

### 8.10 Broadcasts (PRO)

A broadcast is a message the owner sends to many contacts of one account. It is not an automation: it has no way to start. PRO: Creator and Studio (D68).

**Meta's rule.** A broadcast can go only to a person whose chat window is open: she wrote to the account in the last 24 hours, minus the 15-minute safety. We check it when the audience is built, and again just before each send.

**Audience.** A segment is a set of conditions on one Instagram account, in AND / OR groups: at most 2 levels (`SEGMENT_GROUP_LEVELS_MAX` 2) and at most 20 conditions (`SEGMENT_CONDITIONS_MAX` 20). The owner can save a segment and use it again (`app.segments`).

| Condition group | Conditions |
|---|---|
| Tags | Has any, all or none of these tags |
| Automations | Started, finished, still in the middle of, or never got automation X; tapped the hello of X; got message N of X |
| How she came in | Her first automation; a ref link code; a starter question; an ad id; a story mention; first message |
| Comments | Commented on post X, or on any post, in the last N days; used keyword Y; at least N comments |
| Activity | Last active (her last message) in the last N hours or days; first seen in the last N days |
| Details | Has an email, a phone, or neither; follows the account (the last follow-check result and its date) |
| Story activity | Replied to or mentioned a story in the last N days |
| Broadcast history | Did not get a broadcast in the last N days |

1. Automation conditions read the runs, which are kept 90 days. "Got message N of X" reads the run's `last_message_no` (`app.automation_runs`), not the message rows (they are kept only 30 days).
2. **Always left out:** opted-out contacts, contacts paused by the owner (section 14.7), deleted contacts, and anyone who got a broadcast in the last 24 hours (`BROADCAST_MIN_GAP_HOURS` 24, a hard cap).
3. **Count preview:** "1,240 match. 310 can get it now (chat open)." It is counted again when sending. Hard conditions are counted by a background job (`segment-count` in `instagram-tasks`).
4. The conditions read contact columns that are updated in the same commits as the events: `first_seen_at`, `last_message_received_at`, `last_comment_at`, `comment_count`, `last_story_activity_at`, `last_broadcast_at`, `is_following_account` and `follow_checked_at` (meepzo-be's columns), `first_automation_id`, `came_in_via` and `came_in_ref` (section 18).

**Content.** 1 to 3 messages (`BROADCAST_MESSAGES_MAX` 3), the same kinds as the message list (section 6.1), with `{name}` and versions A/B. A button may "start automation X" for her: her tap starts that automation's run (a next step).

**Mode 1: send now.**

```text
Owner of account A: broadcast "Diwali sale", segment "vip", mode `now`
        |
        v
audience: 1,240 match; 310 have an open chat now (only they are added)
        |
        v
broadcast `sending`; 310 recipient rows `waiting`
        |
        v
broadcast lane: one message at a random second in each box (600/h = 6 s)
        |
        v
just before each send: chat still open? not opted out? no broadcast in 24 h?
        |  yes                                   |  no
        v                                        v
`sent`: 1 DM in the month, person limit      recipient `skipped` (`window_closed`, ...)
        |
        v
all 310 recipients done --> broadcast `done`
```

**Mode 2: send at a set time.**

```text
Owner: broadcast "Friday drop", mode `scheduled`, `scheduled_at` Fri 18:00
        |
        v
broadcast `scheduled` (nothing is counted or sent yet; the owner may cancel)
        |
        v
Fri 18:00: the helper starts it (section 34)
        |
        v
audience built now: who matches now, and whose chat is open now
        |
        v
the same as "send now": `sending` --> recipients --> `done`
```

**Mode 3: deliver when her chat opens.**

```text
Owner: broadcast "New guide", mode `when_chat_opens`, active 3 days (1 to 7)
        |
        v
broadcast `waiting_for_chats` until `ends_at`
        |
        v
a contact writes to account A. Does she match the audience now? -- no --> nothing
        | yes (and not got it yet, not opted out, no broadcast in 24 h)
        v
an automation run for her? -- yes --> wait until that run has finished
        | no run, or it finished
        v
owner typed to her in the last 6 hours? -- yes --> not now (her next message)
        | no
        v
recipient row; broadcast lane, box timing --> `sent` (once per person)
        |
        v
`ends_at` passes --> broadcast `done`
```

1. Active 1 to 7 days (`BROADCAST_OPEN_WAIT_DAYS_MAX` 7).
2. She gets it after any automation run for her has finished, or soon after her message when no run starts.
3. Not within 6 hours of the owner typing to her by hand (`OWNER_CHAT_QUIET_HOURS`). Her next message checks again. A recipient `skipped` (`owner_chat`) does not use up the broadcast for her: while the broadcast is still active, her next message after the quiet time puts the same recipient row and its message back to `waiting` (no new rows).
4. Once per person per broadcast (a row `skipped` `owner_chat` does not count, rule 3).

**Sending (all modes).**

1. Each account has a 4th lane, `broadcast` (a row in `app.instagram_send_lanes`). Its tickets go in the slow queue.
2. Box timing like the slow lane (section 11.7): 600 per hour by default (`BROADCAST_HOUR_LIMIT_DEFAULT` 600). The owner can set 1 to 2,000 (`BROADCAST_HOUR_LIMIT_MAX`) in `app.instagram_account_settings.broadcast_hour_limit` (empty = 600).
3. Lowest priority: its tickets have priority 10 (`BROADCAST_TICKET_PRIORITY` 10, the lowest), so it never slows answers or opening DMs. The audience is built in pieces of 500 (`BROADCAST_AUDIENCE_PIECE` 500).
4. Limits: minute-count group `broadcast` (gate 1 `cnt:broadcast:{account}` in Redis, gate 2 in Postgres). Each broadcast message counts in the month DM count and the person limit (section 10).
5. Each recipient is a row in `app.broadcast_recipients` (`waiting`, `sent`, `skipped`, `failed`, `unknown`). Each message is a row in `app.instagram_messages`, type `broadcast` with `broadcast_id`.
6. Her chat closed at send time: the recipient is `skipped` (reason `window_closed`).
7. **Stops:** every account stop stops this lane too. A "too fast" error stops the broadcast lane for double the time (`BROADCAST_STOP_FACTOR` 2). The month limit stops it (`plan_limit`: it is a new DM).
8. **Results** on the broadcast: `matched`, `sent`, `skipped`, `failed`, `replies` (once per recipient: `replied_at`), `taps`.
   - Recipient reasons: `recent_broadcast` (a broadcast in the last 24 hours), `owner_chat` (the owner typed to her by hand in the last 6 hours; it can come back, mode 3 rule 3), `window_closed`, `opted_out`, `contact_excluded`, `broadcast_cancelled`, `plan_feature_off`.
9. **Statuses:** `draft`, `scheduled`, `sending`, `waiting_for_chats`, `done`, `cancelled` (section 20).
10. **Who:** Owner, Admin and Editor make and send; Viewer only sees. They use the automation permission codes (`automation:create`, `automation:update`, `automation:read`); there are no new codes. Every send and cancel goes to the audit log.
11. **Cancel:** the broadcast becomes `cancelled`. Its waiting recipients become `skipped` and their waiting messages `cancelled`, reason `broadcast_cancelled`. Messages already sent stay sent.
12. **After a move down:** scheduled and "when her chat opens" broadcasts end `cancelled` (reason `plan_feature_off`). Drafts and saved segments stay.

---

## 9. Once rule, 24 hours and the chat window

### 9.1 Once rule

One run per automation, person and once key (D13). The once key is `post_key` on the run. This is the rule while the account setting `once_per_person_per_post` is ON (the default). OFF ("every time"): section 9.6.

| Automation | She does | Result |
|---|---|---|
| One post or reel | Comments on that post, first time | DM |
| One post or reel | Comments on that post again | Nothing (already done) |
| My next post | Comments on the first post after go-live, first time | DM |
| Posts between 1 and 10 Dec | Comments on post 1 in that time | DM |
| Posts between 1 and 10 Dec | Comments on post 2 in that time | DM again (another post) |
| Posts between 1 and 10 Dec | Comments on a post of 12 Dec | Nothing (no match) |
| Any post | Comments on post 1 | DM |
| Any post | Comments on post 2 | DM again (another post) |
| Any post | Comments on post 1 again | Nothing |
| Live comment | Comments again on the same Live | Nothing. Next Live: again |
| Ad comment | Comments again on the same ad | Nothing |
| Story reply | Replies to the same story again | Nothing |
| Story mention | Mentions the account in the same story again | Nothing |
| DM keyword | Same keyword, same day | Nothing. Next day: again |
| First message | Writes again, also after 90 days | Nothing, ever (`first_message_at` is kept on the contact) |
| Your post sent to you | Shares the same post again | Nothing. Another post: again |
| Starter question | Taps it again the same day | Nothing. Next day: again |
| Link or QR code | Opens it again the same day | Nothing. Next day: again |
| Ad "Send message" | Messages from the same ad again | Nothing |
| No other automation answered, "once a day" | Writes again the same day | Nothing. Next day: again |
| No other automation answered, "every time" | Writes again | Again (the person limit of 60 per hour guards) |
| Tag added or removed | The tag is added again later | Again (each tag event) |
| Any of them except first message | The same once key again, about 90 days after the old run ended | Again: the old run is deleted `RUN_KEEP_DAYS` (90) days after it ended. Runs are dropped by month part, so the day is approximate (estimate) |

So "Nothing" above means: nothing until the old run is deleted, about 90 days after it ended. Only "first message" is once ever.

How it is known: the run keeps `post_key` and `dm_sent_at`. A message that is `unknown` counts as sent for this rule. A second start with the same key is logged `ignored` (`once_per_post`) in the comment log, or `skipped` (`once_per_post`) on a message.

### 9.2 Once key for each way to start

| # | Way to start | Once key (`post_key`) | "Once" means |
|---|---|---|---|
| 1 | Post or reel comment | media id | Once per automation per post |
| 2 | Live comment | `live:<media id>` | Once per Live |
| 3 | Story reply | `story:<story id>` | Once per story |
| 4 | Story mention | `mention:<story id>` | Once per story |
| 5 | Story repost | test needed (section 43) | — |
| 6 | DM keyword | `dm:<date>` | Once a day |
| 7 | Their first ever message | `first` | Once ever |
| 8 | Your post sent to you | `share:<media id>` | Once per shared post |
| 9 | Starter question | `starter:<date>` | Once a day |
| 10 | Link or QR code | `ref:<date>` | Once a day |
| 11 | No other automation answered | `default:<date>`; "every time": `default:<her message id>` | Once a day, or once per message |
| 12 | Ad comment | media id | Once per ad |
| 13 | Ad "Send message" | `ad:<ad id>` | Once per ad |
| 14 | Tag added | `tag:<tag>:<event id>` | Once per tag event |
| 15 | Tag removed | `untag:<tag>:<event id>` | Once per tag event |

`<date>` = the day in the workspace's time zone. The person limit (60 per hour) still guards "every time" and tag starts.

### 9.3 Two automations on one post

1. Riya comments "GUIDE" and "PRICE" on post P. Both automations are live.
2. They **share one opening message** while it is not answered. The second run joins the first one's opening message (its hello and its version).
3. Her **one tap** moves both runs. Follow, email and phone are asked once. Then both message lists go, one message at a time to her.
4. If she already tapped (her window is open), a new automation on the same post sends its own opening message as a normal DM (9.4).
5. One comment with both keywords starts only one automation (meepzo-be's rule).
6. The same works for two automations on one Live or one ad.

### 9.4 Window open or closed

| | Window closed | Window open |
|---|---|---|
| What opens it | Her message, tap, story reply, story mention, shared post, starter question tap, link open or ad message in the last 24 hours (`MESSAGING_WINDOW_HOURS`), minus 15 minutes safety (`WINDOW_SAFETY_MINUTES`). A comment, a Live comment and a tag change never open it | |
| Opening message, post, reel or ad comment | Private reply to her comment, slow lane | Normal DM with its buttons, fast lane |
| Opening message, Live comment | Private reply, fast lane, only while the Live is on | Normal DM with its buttons, fast lane |
| Opening message, message start | Not possible (she just wrote, so it is open) | Normal DM, fast lane |
| Opening message, tag start | No run starts, nothing is sent (the start is skipped, `window_closed`) | Normal DM, fast lane |
| Limit | Opening limit (600 per hour); Live: fast limit | Fast limit (10,000 per hour) |
| Timing | Random second in a box; Live: 500 to 2,000 ms | 500 to 2,000 ms |
| 24-hour rule | One opening DM per person per 24 hours (`OPENING_PERSON_GAP_HOURS`). The next one waits. Not for Live | No wait |
| Age | Up to 7 days after the comment, then `expired`. Live: until the Live ends | Same 7 days for a comment |
| Public reply | After the DM went (never on Live) | After the DM went |
| Messages after the hello | Cannot go: `skipped` (`window_closed`) | Go, each checked just before sending |
| Checked when | When the event comes, and again just before sending | Same |

1. If the window changes between these two checks, a comment's first message moves to the other lane: the **same row** changes its lane and channel (one row per run, type and number). No second row is made.
2. After a click-to-message ad, Meta's page says her window may be 7 days. Until a test proves it (section 43), we use 24 hours.

### 9.5 Waits and the window: examples

The editor allows each wait up to 23 hours. But the window counts from **her last message**, not from our last message. So the waits add up.

1. **A long wait fits.** She taps at 10:00. Message 1 at 10:00:01. Message 2, wait 23 hours: 09:00:01 next day. The window is open until 09:45. It goes.
2. **Waits add up.** She taps at 10:00. Message 2 waits 12 hours (22:00:01). Message 3 waits 12 hours more (10:00:01 next day). The window closed at 09:45. Message 3 is `skipped` (`window_closed`), no later message is made, and the run ends `cancelled` (`window_closed`).
3. **She writes in between.** Same as example 2, but she writes "thanks!" at 23:00. Her window is now open until 22:45 next day. Message 3 goes at 10:00:01.
4. **Comment with a hello.** Her tap on the hello opens her window. From then on it is the same as example 1.
5. **Comment without a hello.** The follow step is on. The follow request goes as the private reply at 10:00:04. A comment does not open her window, so nothing else can go yet. At 10:20 she taps "I'm following": her window opens, and the list goes as in example 1. Without a follow, email or phone step, the automation could have only one text message (section 7.5).

### 9.6 "Every time": the once rule switched off

Account setting `once_per_person_per_post`, ON by default (D65).

1. **ON:** the once rule of 9.1 and the keys of 9.2.
2. **OFF ("every time"):** every new comment or keyword DM starts a new run once her earlier run of that automation has ended (see `run_in_progress` below). The once key becomes the event's own id:

| Way to start | Once key, ON | Once key, OFF |
|---|---|---|
| Post, reel or ad comment | media id | `<media id>:<comment id>` |
| Live comment | `live:<media id>` | `live:<media id>:<comment id>` |
| Story reply | `story:<story id>` | `story:<story id>:<message id>` |
| Story mention | `mention:<story id>` | `mention:<story id>:<message id>` |
| DM keyword | `dm:<date>` | `dm:<message id>` |
| Your post sent to you | `share:<media id>` | `share:<media id>:<message id>` |
| Starter question | `starter:<date>` | `starter:<event id>` |
| Link or QR code | `ref:<date>` | `ref:<event id>` |
| Ad "Send message" | `ad:<ad id>` | `ad:<event id>` |
| Their first ever message | `first` | `first` (still once ever) |
| No other automation answered | Its own choice: once a day, or every time | The same |
| Tag added or removed | Per tag event | The same |

3. **Still true when OFF:**
   - Meta's one private reply per comment.
   - One opening private reply per person per 24 hours while her window is closed (`OPENING_PERSON_GAP_HOURS`): the next one waits.
   - The person limit (60 per hour).
   - Two different automations on one post share one unanswered opening message (9.3).
   - **One open run per automation and person:** a new comment, keyword DM or any other start from her while her run of the SAME automation is still open is `ignored` (reason `run_in_progress`). The next one after that run ended starts a new run.
   - "First message" stays once ever.
   - "No other automation answered" keeps its own "once a day" or "every time" choice.
   - Tag starts are already per event.

---

## 10. Limits

| Limit | Default | Who can change | Bounds | What it counts | Gate 1 (Redis) | Gate 2 (Postgres) |
|---|---|---|---|---|---|---|
| Opening DMs per hour | 600 (`OPENING_HOUR_LIMIT_DEFAULT`) | Owner, per account | 1 to 700 (`OPENING_HOUR_LIMIT_MAX`) | Private replies in the slow lane, last 60 minutes | `cnt:open:{account}` | Minute counts, group `open` |
| New account | 150 per hour for 7 days (`NEW_ACCOUNT_HOUR_LIMIT`, `NEW_ACCOUNT_DAYS`) | Owner: any value in `opening_hour_limit` replaces the 150 | Up to the opening limit | Same as above | Same | Same |
| Opening DMs per day | OFF (`DAY_LIMIT_ENABLED`). If ON: hour limit x 10 (`DAY_LIMIT_DEFAULT_FACTOR`) | Owner (when ON) | From the hour limit up to the hour limit x 24 | Since midnight, workspace's time zone | No | `day_count` on the slow lane row |
| Fast messages per hour | 10,000 (`FAST_HOUR_LIMIT_DEFAULT`) | Owner can change (1 to 20,000), per account | 1 to 20,000 (`FAST_HOUR_LIMIT_MAX`) | Every fast call into her chat, also Live private replies and nudges; not follow checks; last 60 minutes | `cnt:fast:{account}` | Minute counts, group `fast` |
| Fast at the same moment | 20 (`FAST_MAX_PARALLEL_PER_ACCOUNT`) | Settings file only | | Fast messages `sending` now | No | `sending_count` on the fast lane row |
| Per person per hour | 60 (`PERSON_HOUR_LIMIT_DEFAULT`) | Owner, per account | 5 to 100 | Automatic fast calls and broadcast messages to one person | No | Messages table, only Postgres |
| Public replies per hour ("Reply like a person" ON only) | 60 per automation (`REPLY_LIKE_PERSON_LIMIT_DEFAULT`) | Owner, per automation | 10, 20, 30, 60 or 100 (`REPLY_LIKE_PERSON_LIMITS`) | That automation's replies, last 60 minutes | No | The automation's box (`app.automation_reply_state`): one reply per box (section 29). Minute counts, group `reply`, also count it (for stats, no limit) |
| Public replies waiting (ON only) | 500 per automation (`PUBLIC_REPLY_MAX_WAITING`) | Settings file only | | Waiting replies of that automation; older ones become `skipped` | No | `waiting_count` in `app.automation_reply_state` |
| Public replies, OFF | No limit | | | One at a time in the reply lane | No | Minute counts, group `reply` (for stats, no limit) |
| Hides | No limit | | | One at a time in the reply lane | No | Not counted |
| Broadcast messages per hour | 600 (`BROADCAST_HOUR_LIMIT_DEFAULT`) | Owner, per account (`broadcast_hour_limit`, empty = 600) | 1 to 2,000 (`BROADCAST_HOUR_LIMIT_MAX`) | Broadcast messages of the account, last 60 minutes | `cnt:broadcast:{account}` | Minute counts, group `broadcast` |
| Broadcasts per person | 1 in 24 hours (`BROADCAST_MIN_GAP_HOURS` 24) | Settings file only (a hard cap) | | Broadcasts she got | No | `last_broadcast_at` on the contact, checked just before each send |
| Mark seen calls | No limit | | | At most one per her message | No | Not counted (group `none`) |
| DMs per month | Plan row `dm_month_limit`: Free 1,000, Creator 10,000, Studio 50,000 | The plan (section 46) | | Every call into her chat, all accounts of the workspace, this calendar month | `cnt:month:{organization}` (a copy, early filter) | `app.dm_month_counts` (16 slots), same commit |
| Instagram accounts per workspace | Plan row `instagram_accounts_max`: Free 1, Creator 3, Studio 10 | The plan | | Connected accounts (not revoked) | No | Checked at connect (section 25) |
| Starter questions per account | 4 (`STARTER_QUESTIONS_MAX`, Meta) | Fixed | | Questions of the account's live starter-question automations (1 to 4 each) | No | Checked at go-live |

**Meta's own limits (facts, checked 23 November 2026):**

| Meta limit | Number | Our limit |
|---|---|---|
| Private replies, posts and reels | 750 per hour per account, same for all sizes | 600 (max 700) |
| Private replies, Live comments | 100 per second per account, only while the Live is on | Fast lane: 20 at once, inside the fast limit |
| Send API | 100 calls per second per account for text, links, reactions, stickers; 10 per second for audio or video | Fast: 20 at once, 10,000 per hour (about 3 per second). Broadcasts: 600 per hour (max 2,000) |
| Comment replies and hides | No hourly number. Only 4,800 x views in 24 hours | OFF: none (Meta's usage header slows us, section 13.7). ON: 10 to 100 per hour per automation |
| Starter questions (ice breakers) | 4 per account | 4 |
| Bots | Answer any input within 30 seconds | Usually 1 to 3 seconds |

### 10.1 Rules

1. Hour limits are per account. Each account has its own counts. The month count is per workspace: all its accounts share it.
2. Only the slow lane uses the opening limit. Only fast messages use the fast limit. Only the broadcast lane uses the broadcast limit. A public reply uses only its automation's limit, and only when "Reply like a person" is ON. Hides use no limit.
3. A random time never breaks a limit. Gate 2 in Postgres decides, in the same commit that marks the message `sending` (section 31). The month count is the third check in that same commit.
4. Every owner number is checked when saved (bounds above) and again when a worker reads it. A wrong value: the settings file value is used.
5. The time window of every hourly limit is 60 minutes (`LIMIT_WINDOW_MINUTES`, fixed).
6. Every call into her chat counts 1 in the fast limit, the person limit and the month count. A picture with a text counts 2.
7. Size limits of an automation (messages, buttons, cards, texts): section 5.

### 10.2 DMs per month

The plan gives each workspace a number of DMs per calendar month, in the workspace's time zone (D34).

**What counts** (each call into her chat): `opening_message`, `nudge`, `follow_request`, `email_question`, `invalid_email`, `phone_question`, `message` (a picture with a text = 2), `broadcast`.

**What does not count:** `public_reply`, `hide_comment`, `follow_check`, "mark seen" calls.

```text
a DM is ready to go (any lane, any account of the workspace)
        |
        v
BEGIN ... gate 2 (hour limits of the account) ...
        |
        v
month check: sum of the 16 slot rows in `app.dm_month_counts`
for (workspace, this month) >= the plan's `dm_month_limit`?
        |                                   |
        no                                 yes
        v                                   v
own slot + 1 (account id mod 16);        stop `plan_limit` on the `slow`,
message `sending`; COMMIT                `fast` and `broadcast` lanes of every
        |                                account; the message stays `waiting`;
        |                                the `reply` lane keeps going
        v
after the commit: Redis copy `cnt:month:{organization}` + 1
        |
        v
crossed 80%, or reached 100%? --> notice and email, each once a month
```

1. **16 slot rows** (`DM_MONTH_COUNT_SLOTS` 16) per workspace and month. The send commit reads the sum and adds 1 to its own slot (slot = account id mod 16). So many accounts do not wait for one row.
2. It may go **over by a few DMs** at the same moment (estimate: at most the number of DMs on their way). This is fine for a plan limit.
3. The Redis copy `cnt:month:{organization}` is for the meter, the banner and an early filter. When the copy says "full", the worker still asks Postgres before it stops anything. Postgres decides.
4. **80%** (`DM_MONTH_NOTICE_PERCENT` 80): a notice and an email, once a month.
5. **100%**: a notice and an email, once a month. Only new DMs stop: stop `plan_limit` on the `slow`, `fast` and `broadcast` lanes of every account of the workspace. The `reply` lane keeps going: public replies and hides of DMs that already went still go (they are not DMs). Waiting DMs stay `waiting`. The 7-day rule and the window check still apply. A message whose 7 days end while it waits behind the month limit becomes `expired` with reason `plan_limit`, so the owner sees why.
6. **The stop ends** on the 1st of the month at 00:00 (workspace's time zone), or when the owner upgrades. The lanes wake. Fast tickets come back in pieces of 500 (`RESUME_TICKET_BATCH`), spread over 5 minutes (`RELEASE_SPREAD_MINUTES`).
7. While the stop is on, "Go live" is refused (section 15.5).
8. Month rows are kept 13 months (`DM_MONTH_KEEP_MONTHS` 13).

Example (estimate):

```text
Workspace on Free: 1,000 DMs a month, account A
  25 Nov  820 sent  -> notice "820 of 1,000 DMs used this month" + email
  28 Nov 1,000 sent -> stop `plan_limit` on A's slow, fast and broadcast lanes;
                       40 DMs wait; replies and hides of sent DMs still go
  1 Dec  00:00      -> new month, count 0, lanes wake, the 40 go
                       (if under 7 days; answers whose window closed: `skipped`)
```

### 10.3 Accounts per workspace

1. A workspace may connect several Instagram accounts. The plan row `instagram_accounts_max` says how many: Free 1, Creator 3, Studio 10 (D26).
2. The check runs at connect, under a transaction lock on the workspace (`pg_advisory_xact_lock` on the organization id), so two connects at the same moment cannot both pass (sections 25, 35).
3. One Instagram account belongs to one workspace only (`idx_instagram_accounts_instagram_user_live`).
4. Disconnecting an account frees its place. No stopped account starts by itself: the owner picks with "choose active accounts" (section 10.4). After a move down, accounts the plan cannot hold stop with `plan_downgrade` (section 10.4).
5. **What a disconnect keeps:** the account's automations, contacts and history stay; sending stops; waiting DMs expire by the 7-day rule; reconnecting the same account goes on. Only Meta's data deletion, or deleting the workspace, erases the data (section 41.10).
6. Each account has its own lanes, hour limits and banners. The month count is shared.

Example: the workspace is on Creator (3 accounts). Accounts A and B are connected. The owner logs in with Meta and ticks C and D. Refused: "Your plan allows 3 Instagram accounts. Pick 1 more, or upgrade."

### 10.4 Plan states

| Plan state | Sending | Go live | Notice (section 15.3) |
|---|---|---|---|
| Free | Yes, within its limits. Free never ends | Yes, without PRO steps | Month meter |
| Creator or Studio, paid | Yes | Yes | Month meter |
| Payment failed | Yes, until the grace date: period end + 14 days (`BILLING_DUNNING_GRACE_DAYS` 14, meepzo-be) | Yes | "Payment failed", with the date |
| Trial of Creator or Studio (7 days, no card) | Yes, with that plan's features and limits (full month DM limit, accounts, PRO) | Yes | "Trial ends" 3 days and 1 day before the end |
| Paid plan cancelled | Yes, until the end of the paid period. No grace. Then plan ended | Yes | — |
| Moved down, PRO parts | Yes: automations keep running; the PRO parts the plan lacks are off by the plan | Yes (PRO steps already on stay saved and are ignored) | Notice and email once |
| Moved down, account not kept | No: lane stop `plan_downgrade` on its 4 lanes. Webhooks are still saved; the 7-day rule applies | — | Account banner |
| Plan ended (read only) | No: stop `plan_ended` on every lane of every account | No. Read only: the owner can still pause, delete, disconnect and choose a plan | "Plan ended" |
| Month limit reached | No new DMs: stop `plan_limit` on the slow, fast and broadcast lanes. Replies and hides of sent DMs still go | No | "DM limit reached" |
| Workspace `SUSPENDED` | No: like the team's suspend (`suspended_at` on every lane) | No | "Workspace paused" |

```text
billing or the month count changes the state (section 46)
        |
        +-- month count reaches the limit --> stop `plan_limit` (slow, fast, broadcast)
        +-- plan ended (read only) ---------> stop `plan_ended` on every lane
        +-- moved down, account not kept ---> stop `plan_downgrade` on its 4 lanes
        +-- workspace `SUSPENDED` ----------> `suspended_at` on every lane
        |
        v
messages stay `waiting` (the 7-day rule and the window check still apply)
        |
        +-- the 1st of the month (`plan_limit` only), an upgrade (also
        |   clears every `plan_downgrade`), a plan chosen, or the team lifts
        |   the suspend
        v
stop cleared; lanes wake; fast tickets in pieces of 500, over 5 minutes
```

1. **PRO features** (Creator and Studio): the email and phone steps, "Reply like a person", more than one public reply line, versions, broadcasts (8.10), run on past comments (7.7), and the delay before each message (11.6). Studio adds priority support. Team members are unlimited, and all 4 roles are on every plan (section 45).
2. Without PRO, a draft cannot go live with a PRO step on, and a save of a live or paused automation cannot turn a PRO step on. Saving a draft is allowed. PRO steps already on before a move down are not refused (rule 3).
3. **Moving down** is allowed. It starts at the end of the billing period (section 46). It never stops an automation (D57):
   - At the period end, the PRO features the new plan lacks are switched off by the plan, and every automation keeps running: the email and phone steps are skipped (the run goes straight to its messages; a run waiting for her email or phone at that moment moves on to its next step); "Reply like a person" works as OFF (replies right after each DM, no pace); only the first public reply line is used; only version A of the hello and the follow ask is used.
   - Nothing is deleted. The PRO settings stay saved in the automation. The engine reads the plan's features at run time and ignores the PRO parts the plan lacks. After a move up they work again by themselves.
   - The owner gets a notice and an email once, for example: "Moved to Free: email and phone steps are off in 3 automations. Upgrade to switch them on again." The editor shows those steps as "PRO, off on your plan".
   - Turning a PRO step on still needs PRO (rule 2). PRO steps that were on before the move down stay saved and are ignored; the owner can still edit and save the rest of the automation.
   - **Instagram accounts:** the active accounts must fit the plan's limit (1, 3 or 10). Above it, at the period end the accounts not kept get lane stop `plan_downgrade` on all 4 lanes (nothing is sent; webhooks are still saved; the 7-day rule applies). The owner picks which accounts stay; no pick: the oldest-connected stay.
   - **Broadcasts and past comments:** scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`); drafts and saved segments stay. An unfinished past-comments run ends `failed` (`plan_feature_off`); the DMs it already queued still go.
   - **Swap:** at any time the owner may choose which accounts are active with "choose active accounts" inside the app, as long as the number fits the limit: making a stopped account active stops another one (`plan_downgrade`). Disconnecting an active account does not start a stopped one by itself: the owner picks.
4. **Moving up** works at once. It clears every `plan_downgrade` stop, and the PRO parts that were off by the plan work again. A `plan_limit` stop is cleared when the month count is under the new limit.
5. **A cancelled paid plan** ends at the end of the period: stop `plan_ended`. There is no grace. The grace is only after a failed payment.
6. **Free trial** (D73): Creator and Studio have a 7-day trial with no card (`PAID_TRIAL_DAYS` 7). One trial per workspace, and never again for an Instagram account that already had one (checked by `instagram_user_id`). During the trial the workspace has that plan's features and limits. Notices and emails 3 days and 1 day before the end (`TRIAL_NOTICE_DAYS` 3,1). At the end with no payment: the workspace moves to Free by the moving-down rule (rule 3: PRO parts off, nothing deleted, accounts above 1 get `plan_downgrade`, the owner can swap). With payment: the plan simply continues. Stripe details: section 46.
7. The stops `plan_limit`, `plan_downgrade` and `plan_ended` are lane stops like the others (`app.instagram_send_lanes.stop_reason`). They never fail a message.

---

## 11. Timing that looks human

### 11.1 Opening DMs: a random second in each box

1. Box = 3600 / hour limit seconds. 400 per hour: one box is 9 seconds, 400 boxes in an hour.
2. Each box gets at most one DM, at a random second inside it.
3. At least 1,500 ms between two DMs of one account (`OPENING_MIN_GAP_MS`).
4. Half speed (after errors): the box is 2 times bigger (`HALF_SPEED_FACTOR`).
5. After a pause, a stop, a full limit or an empty lane, a new box starts now. Missed boxes are never sent together.

Worked example, 400 per hour, start 10:00:00:

| Box (seconds) | Random second | DM goes at |
|---|---|---|
| 0 to 9 | 2 | 10:00:02 |
| 9 to 18 | 8 | 10:00:17 |
| 18 to 27 | 1 | 10:00:19 |
| 27 to 36 | 6 | 10:00:33 |
| 36 to 45 | 3 | 10:00:39 |

The gaps are 15, 2, 14 and 6 seconds. No pattern. In an hour: 399 to 400 DMs, never over 400 in any 60 minutes (estimate from a simulation).

### 11.2 Fast messages: a random delay, many at once

1. Each fast message gets its own delay, counted from the time she wrote (Instagram's time).
2. Delay = 500 + (2,000 - 500) x (r1 + r2) / 2 milliseconds (`FAST_DELAY_MIN_MS`, `FAST_DELAY_MAX_MS`). r1 and r2 are two new random numbers from 0 to 1. A new delay for each message.
3. Most delays are in the middle: about 75% are between 875 and 1,625 ms. It is never a fixed number and has no cycle.
4. Example, 12 messages in a row (ms): 953, 1,009, 930, 1,627, 1,597, 1,266, 559, 1,409, 750, 757, 1,134, 1,268.
5. **Many at once:** up to 20 messages of one account can be on their way at the same moment. There is no gap between messages to different people.
6. **One person at a time:** her next message waits until her previous one has a result. So her messages always come in the right order. A picture with a text: the picture first, then the text.
7. After a follow check there is no extra delay: the next message goes right after the check.
8. **Live private replies** use the same delay from her Live comment's time.
9. **Waits in the message list:** message N+1 goes at N's sent time + its wait (section 8.7). With no wait, it gets a new random delay.
10. **The nudge** goes 60 minutes after the hello was sent (`NUDGE_AFTER_MINUTES`).
11. With "delay before each message" (PRO, 11.6), an extra random pause is added to our answers to her.

Example: a viral post, 50 people tap between 10:03:00 and 10:03:01.

| One message of the account at a time (not chosen) | Up to 20 at once (this plan) |
|---|---|
| 1 to 3 s gap between messages of the account | Each tap has its own 0.5 to 2 s delay |
| The 50th person waits about 2 minutes | All 50 get their answer by about 10:03:05 (20 at once, about 1 second per call) |

Honest point: a person cannot type a long answer in 0.5 seconds. The delay is quick but never fixed. Both numbers are in the settings file and can be raised. Meta's 30 seconds leave room.

### 11.3 Public replies: OFF and ON

**"Reply like a person" OFF** (the only choice on Free):

1. The reply goes right after the DM of that comment went. No box, no hour limit, no chance skip.
2. The reply lane sends one at a time, with no gap.

**"Reply like a person" ON** (PRO; ON by default for new automations on Creator and Studio):

1. Box = 3600 / the automation's hour limit. 60 per hour = 60-second boxes. One reply at a random second inside each box. Each automation has its own box (`app.automation_reply_state`).
2. At least 20 seconds after the account's last ON reply (`PUBLIC_REPLY_GAP_MIN_SECONDS` 20). OFF replies do not count for this gap.
3. About 80% of comments get a reply (`PUBLIC_REPLY_CHANCE_PERCENT` 80). People don't answer every comment.

**Both:** the text is one of the automation's lines, never the same as its last reply. It starts with `@username` when the automation's `public_reply_mention` is on (section 13).

### 11.4 Hides

A hide goes right after the public reply went, or right after the DM when no reply comes. No box, no gap, no limit. It is one call in the reply lane (section 13.6).

### 11.5 One minute of account A

```text
time      10:00:00         10:00:20         10:00:40         10:01:00
slow      .....x.......x.........x......x.........x.....x......x...   (600/h, 6 s boxes)
fast      xx..x.xxx......x.x....xxxx.........x....x..x.xx......x...   (taps, lists)
reply     ......rh....r.....r.........R.....rh......r...........R..   (replies, hides)
bcast     ...b......b.....b.......b....b......b......b.....b......b.   (600/h, 6 s boxes)
          x = message   r = OFF reply   R = ON reply   h = hide   b = broadcast
```

The four lanes run side by side. A public reply or a hide never holds back a DM or an answer. ON replies stay at least 20 seconds after the account's last ON reply.

### 11.6 Delay before each message (PRO)

An account setting adds an extra random pause before our answers, so they look less like a bot (D67).

1. Columns `extra_delay_seconds_min` and `extra_delay_seconds_max` on `app.instagram_account_settings`. Both empty = off. Each is 1 to 20 seconds (`EXTRA_DELAY_MAX_SECONDS` 20), and min <= max.
2. Extra delay = min + (max - min) x (r1 + r2) / 2 seconds, new for each message. It is added to the normal 500 to 2,000 ms.
3. It is added **once per her event**: to the first answer message we send after her tap, her typed answer, her story reply or her DM (and the other message starts). Later list messages with no wait get only the normal 500 to 2,000 ms.
4. Never on the message right after a follow check. Not used for: slow-lane private replies (box timing), public replies, hides, nudges, list waits, broadcasts.
5. **Meta's 30 seconds:** the total wait from her message to our first answer stays at most 25 seconds (`BOT_ANSWER_MAX_SECONDS` 30 minus `BOT_ANSWER_SAFETY_SECONDS` 5). A longer draw is cut to fit.
6. It is a delayed ticket. A worker never waits.
7. Free: not available. After a move down it is off (the PRO parts rule, section 10.4).

Example: min 3, max 8. Riya taps at 10:00:00. The fast delay is 1,100 ms and the extra delay is 5.4 s: her answer goes at 10:00:06.5.

### 11.7 Broadcasts: a random second in each box

1. The `broadcast` lane uses the slow lane's box timing: box = 3600 / broadcast limit. 600 per hour = 6-second boxes.
2. One broadcast message at a random second in each box, at least 1,500 ms after the last one (`OPENING_MIN_GAP_MS`).
3. It is the lowest priority: its own lane, so it never slows answers or opening DMs.
4. No extra delay (11.6) and no fast delay.

---

## 12. 7 days, expired, and the estimate

### 12.1 The 7-day rule

1. Meta allows a private reply up to 7 days after the comment.
2. We send an opening DM (private reply), a public reply and a hide up to 7 days after the comment time (`trigger_occurred_at`), minus 30 minutes safety (`PRIVATE_REPLY_MAX_AGE_HOURS` 168, `PUBLIC_REPLY_MAX_AGE_HOURS` 168, `EXPIRY_SAFETY_MINUTES` 30).
3. **The comment time.** Meta's comment webhook carries no comment time. We use `entry.time` (when Meta sent the event). If the event arrives more than 1 hour after `entry.time` (`COMMENT_TIME_CHECK_LATE_MINUTES` 60; for example a retry, Meta retries for up to 36 hours), intake reads the comment's `timestamp` from Instagram once and uses it (section 27). Whether `entry.time` is close enough: test needed (section 43).
4. After that the message becomes `expired`. It is never sent. Its comment log step shows `expired`.
5. The check is made two times: when the worker picks the message, and by the helper for waiting messages (section 34).
6. A run whose opening DM expired is cancelled (reason `expired`).
7. Ad comments follow the same 7 days. So do past comments (section 7.7): each counts from its own comment time.
8. Fast messages have no 7-day rule: they follow the chat window (24 hours).

### 12.2 Every other end

| Message | Ends when | Becomes |
|---|---|---|
| Private reply to a Live comment | The Live ends, or 240 minutes pass (`LIVE_REPLY_MAX_AGE_MINUTES`) | `expired` (`live_ended`) |
| Hello, nudge, follow request, questions, message list | Her window closes (her last message + 24 hours - 15 minutes) | `skipped` (`window_closed`) |
| A comment's first message in the fast lane | Her window closes | Goes back to the slow lane as a private reply (if under 7 days) |
| The rest of the message list after a `window_closed` | With that message | Never made; the run ends `cancelled` (`window_closed`) |
| Tag start, window closed when the tag event comes | At once | No run starts, nothing is sent (the start is skipped, `window_closed`, one count in the logs). Closed later: its first message `skipped` (`window_closed`) |
| A run that waits for her | 7 days of waiting (`RUN_WAIT_MAX_DAYS`) | Run `cancelled` (`wait_expired`) |
| Broadcast message | Her window closes before it goes | Recipient `skipped` (`window_closed`) |
| "When her chat opens" broadcast | Its `ends_at` (1 to 7 days) | Broadcast `done` |
| Any message during a stop (`plan_limit`, `plan_ended`, blocked, Meta connection stopped) | The same rules as above. A stop never makes a message live longer | As above. Its 7 days end behind the month limit: `expired` (`plan_limit`) |

### 12.3 The estimate

For one account, every 10 minutes (`PENDING_ESTIMATE_EVERY_MINUTES`):

1. W = opening DMs waiting.
2. For each hour h = 1 to 168: U(h) = waiting opening DMs that expire within h hours.
3. C = DMs per hour that can go to the old line = the larger of (hour limit x old share) and (hour limit - new comments in the last hour). Old share = 1/5, or 2/5 when the urgent mix is on (a waiting DM has under 12 hours left, section 28).
4. S = hours until a known stop ends (0 when there is no stop). A `plan_limit` stop ends on the 1st of the month; a "too fast" stop has Meta's time. Nothing goes before S: the DMs that can go by hour h are C x (h - S), at least 0.
5. May expire = the largest value of (U(h) - C x (h - S)) over all h, at least 0.
6. Will go = W - may expire.
7. A stop with no end time (Meta connection stopped, `plan_ended`, paused): the banner shows when the first and the last waiting DM expire instead.

It is an estimate. New comments and stops change it.

**Worked example.** Account A: limit 300 per hour, 300 new comments in the last hour, 3,000 opening DMs waiting, some with under 12 hours left (urgent mix on), no stop (S = 0).

1. C = larger of (300 x 2/5 = 120) and (300 - 300 = 0) = **120 per hour**.
2. Waiting DMs by the time they expire:

| h (hours) | U(h): expire within h hours | C x h | U(h) - C x h |
|---|---|---|---|
| 1 | 200 | 120 | 80 |
| 3 | 500 | 360 | **140** |
| 6 | 700 | 720 | -20 |
| 12 | 1,000 | 1,440 | -440 |
| 168 | 3,000 | 20,160 | -17,160 |

3. May expire = 140. Will go = 3,000 - 140 = 2,860.

**Banner:** "3,000 DMs waiting. About 2,860 will go. About 140 may expire. Raise the limit to send more."

With a month stop: the same account is stopped by `plan_limit` and the month starts again in 30 hours (S = 30). Every DM that expires within 30 hours may expire: the banner says "About 1,600 may expire before 1 Dec. Upgrade to send them now." (estimate).

---

## 13. Public replies (ON and OFF) and hiding comments

### 13.1 The step, per automation

1. "Reply under their comment" is a step of a comment or ad-comment automation. It is ON or OFF per automation (`public_reply_enabled`). A Live comment never gets one.
2. **Lines:** 1 to 20 (`PUBLIC_REPLY_TEXTS_MAX` 20). With "Reply like a person" OFF, 1 line is enough. With it ON, at least 3 lines (`PUBLIC_REPLY_LINES_MIN_ON` 3, a go-live check). More than one line is PRO; Free has 1 line.
3. **"Reply like a person"** (`reply_like_person`): PRO. ON by default for new automations on paid plans, Creator and Studio (`REPLY_LIKE_PERSON_DEFAULT_PAID` true). Free: OFF only. After a move down to a plan without PRO, an automation saved with it ON works as OFF, and only its first line is used (D57). When ON, the owner picks the hour limit of this automation: 10, 20, 30, 60 or 100 (`REPLY_LIKE_PERSON_LIMITS`, default `REPLY_LIKE_PERSON_LIMIT_DEFAULT` 60), saved in `public_reply_hour_limit` on the automation.
4. Each automation keeps its own reply state in `app.automation_reply_state`: `box_start` (its box), `last_text_no` (its last text), `waiting_count` (its waiting replies).
5. **`@username`:** `public_reply_mention` on the automation, on by default (`PUBLIC_REPLY_MENTION_DEFAULT` true). Off: the line alone, without `@username`.
6. There are no reply settings on the account. Each automation decides for itself.

### 13.2 OFF and ON side by side

| | "Reply like a person" OFF | "Reply like a person" ON (PRO) |
|---|---|---|
| Who can use it | Every plan (the only choice on Free) | Creator and Studio (ON by default for their new automations) |
| When the reply goes | Right after the DM of that comment went | At a random second inside the automation's box |
| Which comments get one | Every comment whose DM went | About 80% (`PUBLIC_REPLY_CHANCE_PERCENT` 80). Not chosen: no row, comment log `skipped` (`random`) |
| Hour limit | None, no cap. A reply follows every DM of a comment that went: the opening DMs of the slow lane (up to about 600 an hour) and the fast-lane DMs of comments whose window was open, so it can be more than 600 an hour per account (estimate). The risk that Meta flags a Free account is accepted | 10, 20, 30, 60 or 100 per hour for this automation |
| Box | None | 3600 / hour limit seconds, one reply per box |
| Gap | None. One at a time in the reply lane | At least 20 s after the account's last ON reply (`PUBLIC_REPLY_GAP_MIN_SECONDS` 20). OFF replies do not count |
| Order when replies pile up | Oldest first: each goes right after its DM (the reply lane's order) | Newest first |
| Waiting at most | No cap | 500 per automation (`PUBLIC_REPLY_MAX_WAITING`). A new one over 500: the oldest waiting becomes `skipped` (`hour_limit`) |
| Lane | `reply` | `reply` |
| Age | 7 days, then `expired` | 7 days, then `expired` |
| Lines | At least 1. `@username` (when `public_reply_mention` is on) + one line at random, never the same as its last | At least 3 (`PUBLIC_REPLY_LINES_MIN_ON` 3). Otherwise the same |
| "Too fast" from Instagram | Stops only replies and hides | Same |
| What the owner reads in the editor | — | "Replies are spaced out, and comments past the hourly limit get no public reply. Everyone still gets the DM." |

### 13.3 Rules for both

1. **Own lane.** The `reply` lane of the account sends one public reply or hide at a time. Its errors never stop DMs or answers.
2. **@username.** When the automation's `public_reply_mention` is on (default, `PUBLIC_REPLY_MENTION_DEFAULT` true), the text starts with `@her_username`, like Instagram's "Reply" button. Off: the line alone. Test needed (section 43).
3. **Text.** One of the automation's lines at random, never the same as its last reply (when it has 2 or more). Example lines: "Sent you a DM!", "Check your inbox", "Just messaged you".
4. **When it is made.** Only after the DM of that comment went (`sent`). Also when the window was open. Never before. A DM that is `unknown` makes no reply, unless it is later proven `sent`.
5. **One per comment.** Never two replies to one comment (`duplicate`).
6. **Age.** Up to 7 days after the comment, then `expired` (`reply_too_old`).
7. **Not possible.** No reply to a deleted, hidden or Live comment. A reply under another comment (section 7.6) gets its public reply under the top-level comment. Such a reply becomes `skipped` (`deleted_comment`).
8. **Never in the way.** A public reply never delays a DM or an answer.
9. **Settings change while replies wait.** Each waiting reply follows its automation's setting at the moment it is picked. The box starts again at the change.
10. **ON and OFF together.** Two automations of one account can differ. OFF replies need no gap and do not count for the gap. An ON reply waits for its box and for 20 seconds after the account's last ON reply. So a busy OFF automation never holds back the ON replies of the same account.
11. **Hint.** After 7 days with no reply problem (`PUBLIC_REPLY_SUGGEST_AFTER_DAYS` 7), the app suggests 100 per hour (`PUBLIC_REPLY_SUGGEST_LIMIT` 100) for an ON automation with a lower limit. The owner decides.

### 13.4 How the box of one automation works (ON)

1. Box = 3600 / its hour limit. 10 per hour = 360-second boxes; 60 per hour = 60-second boxes; 100 per hour = 36-second boxes.
2. One reply at a random second inside the box, and at least 20 seconds after the account's last ON reply.
3. Missed boxes are never sent together. After a stop or an empty line, a new box starts now.
4. Two ON automations of one account each have their own box. The 20-second gap is shared by the ON automations. Example: GUIDE at 60 per hour and PRICE at 30 per hour: together at most about 90 per hour, never two replies within 20 seconds.
5. How the reply lane picks between automations: section 29.

### 13.5 Examples

**OFF.** 10:00:00 Riya comments "GUIDE". GUIDE has "Reply like a person" OFF. Her opening DM goes at 10:00:04. The reply is made at once and goes at 10:00:05: "@riya Check your inbox". Every person who commented gets one.

**ON.** 10:00:00 Riya comments "PRICE". PRICE has "Reply like a person" ON, 60 per hour. Her opening DM goes at 10:00:04. The draw says "reply" (80%). The reply waits for PRICE's box: the box is 10:00:00 to 10:01:00, the account's last ON reply went at 09:59:55, so the earliest time is 10:00:15. The random second is 10:00:37. At 10:00:37 the comment under her post reads: "@riya Check your inbox". PRICE's next reply uses another line.

**Viral (estimate).** 2,050 opening DMs go in about 3.5 hours.

| Setting of the automation | Replies made | Sent | Skipped (line over 500) |
|---|---|---|---|
| OFF | about 2,050 (every comment) | about 2,050 | 0 |
| ON, 60 per hour | about 1,640 (80%) | about 710 | about 930 |
| ON, 100 per hour | about 1,640 (80%) | about 850 | about 790 |

With ON, newest first means the people who just got their DM also see the reply soon. Old comments lose their reply, not their DM.

### 13.6 Hiding comments

The automation option "Hide their comment once the DM is sent" (`hide_comment_after_dm`, D33) hides her comment from other people with one call (`POST /<comment_id>?hide=true`).

| Reply step of the automation | Public reply | Hide goes |
|---|---|---|
| Reply step OFF | None | Right after the DM went |
| Reply step ON, "Reply like a person" OFF | Right after the DM | Right after the reply went |
| Reply step ON, "Reply like a person" ON, chosen | In its box | Right after the reply is `sent`, `failed`, `skipped` or `expired` |
| Reply step ON, "Reply like a person" ON, not chosen (20%) | None | Right after the draw |

1. **Order:** the public reply first, then the hide. A hidden comment cannot get a public reply.
2. Type `hide_comment`, lane `reply`, channel `comment_hide`. It goes right after (no box, no gap).
3. **Not a DM.** It never counts in any limit or in the month count.
4. **A failed hide never stops the DM or the reply.** A deleted comment: `skipped` (`deleted_comment`).
5. Up to 7 days after the comment, like a reply, then `expired`.
6. Never on a Live comment. Ad comments: test needed (section 43).
7. The flow picture is in section 7.2.

### 13.7 Errors: "too fast" and Meta's usage

1. "Too fast" or "blocked" on a public reply or a hide stops **only the reply lane** (section 33). DMs and answers go on.
2. A token error (code 190: the Meta connection stopped) or message access off on a reply stops all lanes, as for a DM. A token error stops every account of that Meta connection.
3. Meta's usage header (`X-Business-Use-Case-Usage`) is read after each reply and hide:
   - 80% or more (`USAGE_SLOW_PERCENT`): ON boxes 2 times bigger (`REPLY_USAGE_FACTOR`);
   - 95% or more (`USAGE_STOP_PERCENT`): all replies and hides wait until the time Meta gives, or 15 minutes (`USAGE_WAIT_DEFAULT_MINUTES`).
4. A stop of only the reply lane is tested with one public reply. Every other stop is tested with a DM (section 33).

---

## 14. Follow check, email, phone, her answers, stop words

### 14.1 Follow check

1. Only if the automation needs a follow ("Ask them to follow").
2. After her tap, the fast lane asks Instagram "does she follow?" (500 to 2,000 ms after the tap).
3. The call fails: one more try after a random 2,000 to 5,000 ms (`FOLLOW_CHECK_RETRY_MIN_MS`, `FOLLOW_CHECK_RETRY_MAX_MS`). 2 tries in all (`FOLLOW_CHECK_TRIES`).
4. Both fail: we treat her as following (`FOLLOW_CHECK_FAIL_MEANS`) and go on to the next step.
5. Exception: an account stop error (blocked, too fast, Meta connection stopped, message access) stops the lane as usual. The check waits and goes again after the stop.
6. Follow-check failures never count for the "3 people in a row" account rule (section 33).
7. Not following: `follow_request` with two buttons, "Visit profile" and "I'm following". Her tap on "I'm following" starts a new check for the same run.
8. **Versions:** the follow request has up to 3 versions (`MESSAGE_VERSIONS_MAX` 3). One is picked at random per run and saved on the row (`version_no`).
9. Why: Meta lets us read her profile only after she gave consent (she messaged or tapped). A failed check must never leave her with nothing.

### 14.2 Email and phone

1. Both are PRO steps. When both are on, phone is asked after email. On a plan without PRO (after a move down) both steps are skipped: the run goes straight to its messages, and a run that waits for her email or phone moves on to its next step (D57).
2. **Wordings:** each question has 1 to 10 wordings (`QUESTION_WORDINGS_MAX` 10). One is picked at random each time. With 2 or more, never the same as the last one sent to her. The row keeps `wording_no`.
3. We take the **first** email-like or phone-like part out of her text. "my email is Riya@Gmail.com" gives `riya@gmail.com`.
4. We save it **only when a run of hers waits for it**. An order number in a normal chat is never saved as her phone.
5. **Correct email:** letters, digits and `. _ % + -` before the `@`; letters, digits, `.` and `-` after it; at least one dot after the `@`; at most 254 characters (`EMAIL_MAX_LENGTH`); saved in lower case.
6. **Correct phone:** 10 to 15 digits after removing spaces, `-` and brackets, with an optional `+` (`PHONE_DIGITS_MIN`, `PHONE_DIGITS_MAX`).
7. **Wrong:** any text answer without a valid email (or phone) is a wrong answer. We ask again: `invalid_email` (or `phone_question` again, with another wording). The first question plus at most 3 asks again (`ASK_AGAIN_MAX` 3). Then we stop asking, but the run still waits. A correct one later moves it.
8. We never ask for what we already have.
9. Her answer is saved on the contact. The owner sees it in the contact's "What happened" (section 15.4).

### 14.3 What counts as her answer

| She sends | What it does |
|---|---|
| Text | An answer. For a run waiting for `email` or `phone`: a valid one moves it; no valid one is a wrong answer and asks again (14.2). Moves a run waiting for `any`. Counts like a tap for a run waiting for `opening_message_button`. For a run waiting for `follow`, it starts the check again. Cancels a waiting nudge. It may start an automation (section 8.2) only if it moved no run |
| Quick reply from our `quick_replies` message | A tap on that message: her choice is saved for "What happened". Moves a run waiting for `any`. Not an email or phone answer, never a wrong answer |
| Quick reply with no payload of ours (Meta's email or phone quick reply) | Same as text |
| Button tap ("next step") | Moves only the run and the step in its payload (automation, run and message ids). A tap on an old or used button does nothing. Counts as a button tap in "% tapped" (section 15.1) |
| Link button tap | Instagram sends us nothing |
| Starter question tap | Starts its automation (match step 2). Refreshes her window time. Moves a run waiting for `any`. Not an answer to a question |
| Link open (ig.me ref) | Starts its automation (match step 2). Refreshes her window time (a brand-new chat: test needed, section 43). Not an answer |
| Ad "Send message" | Starts the ad's automation (match step 2). Refreshes her window time. Her ready text is not an answer |
| Reaction (heart) on one of our messages (`message_reactions`) | Refreshes her window time. Never an answer, never a wrong answer, not a tap. Does not cancel a nudge |
| Photo, voice, video, sticker | Refreshes her window time. Never a wrong answer |
| Story mention | Saved. Refreshes her window time. May start a story-mention automation (match step 3). Not an answer |
| Shared post | Refreshes her window time. May start a "your post sent to you" automation (match step 3). Not an answer |
| Edited message (`message_edit`) | Saved as an edit. Never a new answer, never a wrong answer, never starts an automation |
| Deleted message | Ignored |
| Owner typed to her by hand | No automatic "ask again", no "no other automation answered", no "when her chat opens" broadcast and no "mark seen" to her for 6 hours (`OWNER_CHAT_QUIET_HOURS`). The owner is talking to her. Only this contact is quiet: other people are not affected |
| Read receipt | Not saved |
| Our own messages (`is_echo`, `is_self`) and our "message was sent" notice | Not saved, never answered (section 26) |

A tap proves only the message that carries that button. It turns that message from `unknown` to `sent`, nothing else.

`unknown` is never sent again by itself. Only her next message or tap may send that step once more: the same row goes back to `waiting`. A run with an `unknown` message waits for `any`.

### 14.4 Stop words

1. Her whole message is cleaned: spaces trimmed, lower case, punctuation and emoji removed.
2. If what is left is exactly a stop word, she has opted out. Default words: "stop", "unsubscribe" (`STOP_WORDS`). Each owner can add words in their own language, for example "band karo".
3. "nonstop.riya@gmail.com" is not a stop word. "Stop!" and "STOP" are.
4. Opt-out: `opted_out_at` is saved on the contact. No automatic message goes to her on that account. All her waiting messages become `skipped` (reason `opted_out`). Her open runs are `cancelled` (`opted_out`). A waiting nudge is cancelled too.
5. The stop word is checked before the email check and before any way to start.
6. **She starts again only by her own new action** that matches a live automation of one of these kinds: a keyword comment (post, reel, Live or ad comment), a keyword DM (also a DM that matches a comment automation's keywords through "also start from" DM), a starter question tap, or an ig.me link. That clears `opted_out_at`, and the run starts normally.
7. These never start her again: "no other automation answered", tag starts, nudges, story replies, story mentions and shared posts (and so also "first message" and an ad "Send message", which are not in the list above, section 27.2). They send nothing to her while she is opted out.
8. The owner cannot start her again by hand.
9. A new stop word stops her again.

```text
Riya writes "STOP" --> `opted_out_at` set; waiting `skipped`, runs `cancelled`
        |
        v
later, a new event from her on this account
        |
        +-- keyword comment, keyword DM, starter question tap or ig.me link
        |   that matches a live automation --> `opted_out_at` cleared, run starts
        |
        +-- story reply, mention, shared post, "no other automation answered",
            tag start, nudge --> nothing is sent
```

### 14.5 Ask once

1. "Already asked" means: a message of this type for her that is `waiting`, `sending`, `unknown`, or `sent` and still waiting for her answer.
2. Then no new question is made. The new run joins the waiting one: meepzo-be's "queued automations" on the run that waits for her email.
3. Her one answer moves all runs that wait for it. Each queued automation then goes on with its own steps.
4. This is checked in intake (under the contact lock) and again just before sending.

Example: GUIDE and PRICE both need her email. She taps once. One `email_question` goes. She answers once. Both message lists go.

### 14.6 Mark as seen

Account setting `mark_seen_after_reply`, OFF by default (D66). ON: she sees "Seen" in her chat after our answer.

```text
Riya writes "PRICE" (her message m_88). Our answer to her is `sent`.
        |
        v
`mark_seen_after_reply` ON? ---------------------------- no --> nothing
        | yes
        v
already marked seen for m_88? -------------------------- yes --> nothing
        | no
        v
owner typed to her by hand after m_88? ----------------- yes --> nothing
        | no
        v
one `sender_action` `mark_seen` call for her chat (fast lane, group `none`)
```

1. At most once per her message: the Redis note `seenmark:{account}:{contact}` (24 hours) keeps her last inbound message id. Not sent to a contact paused by the owner (14.7).
2. Fast lane, `count_group` `none`: not a DM, no month count, no fast-limit count.
3. A failure is ignored: no retry, no stop. Account stop errors still stop the lane as usual.
4. Test needed on Unified Login (section 43): Meta's sender-actions page shows only Instagram Login.

### 14.7 Pause automations for one person (the owner's choice)

The owner can switch automations off for one contact: "Pause automations for this person" (D71). It is on the contact and in the bulk action bar of Contacts. Columns `app.contacts.automations_off_at` and `automations_off_by_user_id`.

```text
Owner: "Pause automations for this person" on Riya
        |
        v
`automations_off_at` set; her waiting messages `skipped` (`contact_excluded`);
her open runs `cancelled` (`contact_excluded`)
        |
        v
her new events are saved, but nothing starts: no DM, no public reply,
no hide, no broadcast, no "mark seen"
        |
        v
owner turns it off --> nothing restarts by itself; her next own action starts
```

1. While it is set, broadcasts always leave her out, and her comments get no DM, no public reply and no hide.
2. Her events are still saved (counts, "last active").
3. The owner can turn it off at any time. Nothing restarts by itself: her next own action starts normally.
4. Who: Owner, Admin, Editor. Each change goes to the audit log.

| | Stop word (14.4) | Paused by the owner (14.7) |
|---|---|---|
| Whose choice | Hers | The owner's |
| How it is set | Her message "stop" | A switch on the contact, or the bulk bar |
| Column | `opted_out_at` | `automations_off_at` |
| Waiting messages | `skipped` (`opted_out`) | `skipped` (`contact_excluded`) |
| Open runs | `cancelled` (`opted_out`) | `cancelled` (`contact_excluded`) |
| Broadcasts | Left out | Left out |
| How it ends | Only her own keyword comment, keyword DM, starter question tap or link | The owner turns it off; then her next own action starts normally |
| The owner can undo it | No | Yes |

---

## 15. What the owner sees and can do

### 15.1 Automation list and counters

1. Each automation row shows its numbers:
   - live or paused: "1.3k runs · 51% tapped";
   - draft: "0 runs · edited 1h ago".
2. **Runs** = `runs_started`. It goes up in the same commit that starts the run.
3. **% tapped** = (button taps on the hello + typed answers to the hello) / runs started.
   - A button tap = her first tap on a "next step" button of the hello or the nudge (`taps`).
   - A typed answer = her first text while the run waits for `opening_message_button` (`typed_answers`).
   - One of the two per run. Link buttons send us nothing, so they never count. An automation with no hello shows only runs.
4. **Per version:** runs, button taps and typed answers per hello version (`runs_by_version`, `taps_by_version`, `typed_by_version`), so the owner sees "% tapped" for each version.
5. The counters live in `app.automation_counts` (16 slot rows per automation, `AUTOMATION_COUNT_SLOTS` 16; slot = run id mod 16), added in the same commit as the event. They are all-time: they stay when old runs are deleted after 90 days.
6. Top bar: "3 live · 5k runs" (live automations of this account, runs of all its automations). Heading: "3 automations are answering for you. 5k runs so far."
7. The account menu switches the whole app to another connected account. Automations, counters and banners belong to one account.
8. A daily line per account: section 15.2, item 21.

### 15.2 Banners on one account

1. "Sending. 120 DMs wait. Done at about 14:20."
2. "Opening DM limit (600) is full. 320 DMs wait. Next DM at 11:42."
3. "New account: 150 DMs per hour for the first 7 days (until 30 November). You can raise it."
4. "Today's limit (6,000) is full. 2,000 DMs wait. Starts again at midnight." (Only if the day limit is ON.)
5. "Instagram asked us to slow down. 800 DMs wait. Starts again at 11:15. Answers still go out."
6. "Instagram blocked messages. 800 DMs wait. Next test: tomorrow 10:00."
7. "Your Meta connection stopped working. Our app was removed from your business portfolio, or this account moved to another portfolio. 800 DMs wait. Press Reconnect." (The token never expires by itself. It stops only in these two cases. Shown on every account of that Meta connection.)
8. "Message access is off in Instagram. Turn it on. Next test at 12:00."
9. "Instagram has problems. Your DMs are safe. Next test at 11:15."
10. "The text of automation GUIDE is refused by Instagram. Please fix it. 90 DMs wait."
11. "You paused this account. 230 DMs wait. Press Resume."
12. "3,000 DMs waiting. About 2,860 will go. About 140 may expire. Raise the limit to send more." (section 12)
13. "Fast limit (10,000) is full. 40 answers wait. Next at 11:42."
14. "Instagram asked us to slow down comment replies. 120 wait. Starts again at 11:15. DMs and answers still go out." (Hides wait too.)
15. "Instagram blocked comment replies. 120 wait. Next try: tomorrow 10:00. DMs and answers still go out."
16. "Instagram did not send us comments for a while. We connected again and found 35 missed comments."
17. "Your DMs are safe. Sending waits for a technical reason." (Redis or the database is down for over 1 minute.)
18. "Another app controls some of your chats. 5 people in a row could not get answers. Check connected apps in Instagram."
19. "This account is paused by our team. Please contact support."
20. Hint, not an alarm: "No comment reply problem for 7 days. You can raise the reply limit of PRICE to 100." (Only for ON automations under 100.)
21. Daily line: "Today: 1,250 sent, 12 not sure, 30 skipped (14 because the chat closed), 8 expired."
22. "GUIDE: 14 messages were skipped today because the person's chat closed (24 hours after her last message). Shorter waits help." (Once a day per automation that has such skips.)
23. "DM limit reached. 40 DMs wait. Sending starts again on 1 Dec, or when you upgrade. Comment replies still go." (On every account of the workspace.)
24. "Your plan has ended. Sending is off. 40 DMs wait. Choose a plan."
25. "This account is not in your plan since 1 Dec (Creator holds 3 accounts). Nothing is sent. 40 DMs wait. Upgrade, or choose it as an active account in place of another, to send again." (Lane stop `plan_downgrade`.)
26. "Moved to Free: email and phone steps are off in 3 automations. Upgrade to switch them on again." (Once, with an email, when a move down takes effect. The automations keep running; the editor shows those steps as "PRO, off on your plan", section 10.4.)
27. "Starter questions: @account_a already has 4 live (Instagram allows 4 per account). Remove a question, or pause an automation, to switch this one on." (In the editor, when go-live is refused.)
28. "The Live ended before 35 Live replies could go." (After a Live, when some private replies became `expired` (`live_ended`).)
29. "Your account is private. Comments cannot start automations. Make it public in Instagram." (When the account is private and has a live comment, Live-comment or ad-comment automation. Meta sends no comment or mention events for private accounts.)
30. "Instagram asked us to slow down broadcasts. 120 wait. Starts again at 12:15. Answers and DMs still go out." (A "too fast" on the broadcast lane stops it for double the time, `BROADCAST_STOP_FACTOR` 2.)
31. "Broadcast 'Diwali sale' is done: 296 sent, 14 skipped (chat closed), 12 replies."
32. "GUIDE: found 340 past comments. 290 match. About 250 will go, about 40 may expire." (When a past-comments read is `done`.)
33. "We could not read the past comments for GUIDE. We try again at 11:15." After the last try: "Reading past comments for GUIDE failed. Press the button to try again." (`failed`.)
34. "Broadcast 'New guide' waits for open chats until Thursday 10:00. 85 sent so far."
35. "Retry for GUIDE: 30 messages go again, 12 cannot (too old, or her chat is closed)." (When a "Retry failed messages" job is done, section 15.11.)

If the account is paused and also stopped by an error, both lines show.

How the times are made (estimates):

1. "Done at about" = now + waiting opening DMs x box size.
2. "May expire" = the formula of section 12.
3. Banner numbers come from a 10-second copy in Redis, or from Postgres if there is no copy.

### 15.3 Notices for the whole workspace

Strips at the top of the app. Up to three show at once.

| Notice | Says | Action | When |
|---|---|---|---|
| DM limit nearly reached | "820 of 1,000 DMs used this month. New DMs pause at the limit. It resets on 1 Dec." | Billing; can be dismissed | 80% of the month (`DM_MONTH_NOTICE_PERCENT`) |
| DM limit reached | "New DMs are paused until 1 Dec, or until you upgrade. Replies under comments still go." | Billing | 100%: stop `plan_limit` on the slow, fast and broadcast lanes |
| Payment failed | "Automations keep running until 27 Nov. Update your card to stay live." | Billing | Payment failed, until the grace date (period end + 14 days) |
| Plan ended | "Sending has stopped. Your automations stay as they are. Choose a plan to send again." | Choose a plan | Stop `plan_ended` |
| Trial ends soon | "Your Creator trial ends in 3 days (29 Nov). Add a card to keep Creator. Without one, the workspace moves to Free." The same 1 day before | Billing; can be dismissed | 3 days and 1 day before the trial ends (`TRIAL_NOTICE_DAYS` 3,1) |
| Workspace being set up | "Automations start replying once an admin connects an account." | None | No account connected |
| Workspace paused | A full screen: "Sending has stopped. Your automations stay as they are." | Contact support | Workspace `SUSPENDED` |

1. The account menu shows the meter "820 of 1,000 DMs used this month". It reads the Redis copy `cnt:month:{organization}`, or Postgres if there is no copy.
2. Other notices (confirm your email, previewing a role): section 47.

### 15.4 Owner actions

Every action first checks that the account belongs to the logged-in workspace (meepzo-be row security, section 22) and that the member's role allows it (section 45). Every action is written to the audit log. Account routes carry the account id (`:instagram_account_id`).

| Action | What changes | Tickets |
|---|---|---|
| Pause account | `paused_at` on its 4 lane rows. Comments and taps are still saved | None. Nothing goes |
| Resume account | `paused_at` cleared. Error stops stay | One ticket per lane with waiting messages. Fast tickets are added again in pieces of 500 |
| Save draft | Only a name is needed. Status stays `draft`. Nothing is checked, nothing is sent | None |
| Go live | The checks of 15.5. Status `live`. Starter question: the ice-breaker job runs. A paused automation's waiting DMs go on, if under 7 days | Wakes its lanes |
| Pause automation + Keep | Status `paused`. Waiting DMs stay. People in the middle of a chat finish. Starter question: the ice-breaker job removes it | None |
| Pause automation + Cancel | Status `paused`, `cancelled_before_at` = now. Its waiting messages count as cancelled. The helper marks them `cancelled` in pieces of 500 per round (`HELPER_PASS_LIMIT`) | None |
| Undo (the toast, right after a change) | The old status comes back. Messages the helper already marked `cancelled` stay `cancelled` | As for the old status |
| Save changes (a live or paused automation) | The checks of 15.5 again. New runs use the new steps. Waiting messages read the new text when they go. A waiting message whose step was removed: `cancelled` (`cancelled_by_owner`). A removed version: waiting messages use version 1 | None |
| Duplicate | A draft copy named "<name> (copy)", on the same account. A link automation gets a new `ref_code`. Counters start at 0 | None |
| Delete | The reason is optional (mistake, duplicate, not needed, other). It stops at once. Open runs `cancelled` (`automation_deleted`), waiting messages `cancelled` (`automation_deleted`). Contacts it collected stay. Starter question: the ice-breaker job runs | None |
| Fix a refused text | New text, `stopped_reason` cleared. Messages that failed for the bad text go back to `waiting` (if under 7 days) | Wakes its lanes |
| Change an account limit | Opening, day, fast, person or broadcast limit in `app.instagram_account_settings` (bounds in section 10) | Slow and reply lanes get a new turn. A lane that is working keeps going and moves the turn on at its save |
| Change an account setting | Replies under comments, once per person per post, mark as seen, delay before each message (section 15.8). New events follow the new value | None |
| Save a segment | `app.segments` row with its conditions (checked by zod) | A `segment-count` job for the preview |
| Send a broadcast (now, at a set time, or when her chat opens) | `app.broadcasts` row: `sending`, `scheduled` or `waiting_for_chats`; recipient rows as in section 8.10. PRO | Broadcast lane tickets (now); the helper starts a scheduled one |
| Cancel a broadcast | `cancelled`. Waiting recipients `skipped`, their waiting messages `cancelled`, reason `broadcast_cancelled`. Sent messages stay sent | None |
| Pause automations for a person (one or many) | `automations_off_at` and `automations_off_by_user_id` on the contact. Her waiting messages `skipped` (`contact_excluded`), her open runs `cancelled` (`contact_excluded`) (section 14.7) | None |
| Turn it off again | `automations_off_at` cleared. Nothing restarts by itself | None |
| Retry failed messages (automation or contact) | The count first, then `failed` messages still allowed now go back to `waiting`, `owner_retry_at` = now, at most once each (section 15.11) | Job `retry-failed`, then the normal lane tickets |
| Start a free trial (Creator or Studio) | 7 days, no card, once per workspace and per Instagram account (section 10.4) | None |
| Run on past comments | `app.automation_backfills` row `queued`. PRO. Refused while one runs for this automation | Job `past-comments` |
| Change the reply step of an automation | ON or OFF, "Reply like a person", its hour limit, its lines, `@username` on or off (`public_reply_mention`): on the automation row. Its box starts again now | Wakes the reply lane |
| Connect accounts | Meta login (Unified Login), the owner picks accounts, plan check (section 10.3), lanes made, webhooks subscribed (section 25) | None |
| Reconnect | New token, saved **only** if the connection's account list holds the account's `instagram_user_id`. The connection stops of its accounts are cleared | One ticket per lane with waiting messages |
| Disconnect an account (owner button or Meta deauthorize) | `connection_status` `revoked`, lanes stopped, Redis keys deleted. The token is removed when no other account uses the connection. Its automations, contacts and history stay. Waiting messages stay and expire by the 7-day rule. A reconnect of the same account goes on. No stopped account starts by itself. Only Meta's data deletion, or deleting the workspace, erases the data | None |
| Meta data deletion | meepzo-be's erase of the account's data | None |
| Add or remove a tag (one contact or many) | `app.contacts.tags`. Many: in pieces of 500 (`TAG_BULK_PIECE`). One internal event per contact and tag | Intake jobs; tag starts (section 8.6) |
| Private note on a contact | `note` (up to 2,000 characters, `CONTACT_NOTE_MAX_CHARS`). Nothing is sent | None |
| Open a contact | "What happened": our sent messages and her saved answers (email, phone, taps) of the last 30 days (messages are kept 30 days, `MESSAGE_KEEP_DAYS` 30). Her own free text is never kept | None |
| Delete a person | meepzo-be's contact erase: personal data cleared, open runs cancelled, her waiting messages `cancelled`. There is no clean-up by age: a contact stays until the owner deletes it, Meta asks to delete the data, or the workspace is deleted (D51) | None |
| Upgrade, choose a plan, update the card | Billing (section 46). Clears `plan_ended`, every `plan_downgrade` stop, and `plan_limit` when the count is under the new limit. PRO parts that were off by the plan work again | Lanes wake, fast tickets spread over 5 minutes |
| Move down to a smaller plan | Starts at the end of the billing period. Automations are never stopped: the PRO parts the new plan lacks are off by the plan, and nothing is deleted (notice and email once). The screen shows the extra Instagram accounts; the owner picks which stay. At the period end the others get lane stop `plan_downgrade`; no pick: the oldest-connected stay (section 10.4) | None |
| Choose active accounts | A switch inside the app, at any time. The owner makes a stopped account active and picks an active one to stop (`plan_downgrade` on its 4 lanes), so the number of active accounts always fits the plan's limit. A disconnect is not part of it. Runs under the workspace lock (section 35) | The new active account's lanes wake |
| Cancel the paid plan | It ends at the end of the period: stop `plan_ended`. No grace | None |
| Read the banner | Nothing changes | None |

### 15.5 Go live and "Save changes": the checks

A draft needs only a name. These checks run at "Go live" and at every save of a live or paused automation (D28):

1. A name.
2. The way to start is complete: keywords where it needs them (also when it also starts from a DM), the post or story picked, the ad picked, 1 to 4 starter questions written, the link's `ref_code` set and unique on the account.
3. At least 1 message. Each message is complete: text, buttons with `https` links, files uploaded and scanned clean.
4. The hello: when later steps exist, at least one "sends your next step" button.
5. Starter questions: the account's live questions, with this automation's, are at most 4 (`STARTER_QUESTIONS_MAX` 4).
6. A comment, Live-comment or ad-comment start with no hello, follow, email or phone step: only 1 message, and it is a `text` message with no picture (section 7.5).
7. At most one live "first message" automation and one live "no other automation answered" automation per account.
8. Turning a PRO step on needs Creator or Studio; PRO steps already on before a move down stay saved and are ignored (section 10.4). "Reply like a person" ON needs at least 3 reply lines (`PUBLIC_REPLY_LINES_MIN_ON` 3).
9. The plan has not ended and the month limit is not reached.
10. The account is connected (not revoked).
11. Warnings only (go-live still allowed):
    - another live automation of this account uses the same keyword: "guide is also used by PRICE";
    - the account is private and this is a comment, Live-comment or ad-comment automation: "Your account is private. Comments cannot start automations."

A refusal says what is missing. The editor jumps to that step.

### 15.6 Team actions

1. **Suspend an account:** `suspended_at` on its lane rows. The owner's Resume does not clear it. Only the team can.
2. **Suspend a workspace** (`SUSPENDED`): `suspended_at` on every lane of every account. The owner sees "Workspace paused".
3. **Stop all sending:** the global switch `SENDING_ENABLED` (section 39). Webhooks are still saved.
4. **Audit log:** meepzo-be's `audit.logs` keeps who did which action, on which account, old and new value, and when.
5. Support staff see counts, never emails, phones or tokens.

### 15.7 Emails

1. Owner emails: blocked, Meta connection stopped, message access off, refused text, any stop longer than 1 hour, missed comments found, DM limit at 80%, DM limit reached (100%), plan ended, payment failed, PRO parts off after a move down (once) (section 46).
2. They go through meepzo-be's mail outbox. Its `dedupe_key` (account or workspace + kind + time slot) makes sure two helpers never send the same email twice.
3. Grouped: one email of the same kind per account per 6 hours (`EMAIL_OWNER_GAP_HOURS`). The month emails: at 80% and at 100%, each once per workspace per month.
4. Each email checks the member's notification settings (section 47). Email is ON by default for: an automation stopped or has an error, DM limit nearly reached (80%) and reached (100%), team changes, billing, the weekly summary. "A new contact left details" and "A broadcast or a past-comments run is done" are OFF by default (in the app only). Security and billing emails cannot be turned off.
5. Trial: an email 3 days and 1 day before the trial ends (`TRIAL_NOTICE_DAYS` 3,1).
6. "A broadcast or a past-comments run is done" is a 7th notification kind (`broadcast.done`, `automation.backfill_done`): in the app ON, email OFF by default.
7. Team alerts: section 40.

### 15.8 Account settings screen

These 4 settings are on `app.instagram_account_settings`, per Instagram account (section 5).

| Setting | Default | Plan | What the owner reads |
|---|---|---|---|
| `trigger_on_comment_replies` | ON | All | "Replies under other comments can start automations too." (section 7.6) |
| `once_per_person_per_post` | ON | All | "Answer each person once per post. Off: answer every new comment and keyword DM." (section 9.6) |
| `mark_seen_after_reply` | OFF | All | "Show 'Seen' in their chat after we answer." (section 14.6) |
| `extra_delay_seconds_min`, `extra_delay_seconds_max` | Empty (off) | PRO | "Wait a little longer before each answer: between [3] and [8] seconds." (section 11.6) |

A change counts for new events only. Messages already waiting keep their time.

### 15.9 Broadcasts screen

1. **List** per account: name, mode, status and numbers, for example "310 sent · 14 skipped · 12 replies · 40 taps".
2. **Editor:** the audience (conditions, or a saved segment), the count preview ("1,240 match. 310 can get it now (chat open)."), 1 to 3 messages, and the mode: send now, at a set time, or when her chat opens (1 to 7 days).
3. **Cancel:** a `scheduled`, `sending` or `waiting_for_chats` broadcast becomes `cancelled`. Its waiting recipients become `skipped` and their waiting messages `cancelled`, reason `broadcast_cancelled`. Messages already sent stay sent.
4. **Who:** Owner, Admin and Editor make, send and cancel (the automation permission codes). Viewer only sees.
5. Free: the screen shows "Broadcasts are on Creator and Studio." After a move down, scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`).

### 15.10 "Also answer past comments" button

1. In a live comment or ad-comment automation (PRO): "Also answer comments from the last [N] days", N = 1 to 7.
2. While it runs, the automation shows "Reading past comments: 120 found so far." At the end, banner 32 (15.2).
3. One running backfill per automation. A second press while one runs is refused: "Past comments are already being read."

### 15.11 Retry failed messages

A button on an automation, "Retry failed messages", and the same on a contact (D72).

```text
Owner presses "Retry failed messages" on GUIDE (or on a contact)
        |
        v
count first: "42 failed: 30 can be sent again, 12 are too old or her chat is closed."
        |
        v
job `retry-failed` in `instagram-tasks`, in pieces of 500 (`RETRY_FAILED_PIECE`)
        |
        v
each `failed` message of the last 30 days: still allowed now?
        | yes                                         | no
        v                                             v
back to `waiting`, `owner_retry_at` = now          stays `failed`
(normal lanes, gates, limits; month count when sent)
        |
        v
banner 35: "Retry for GUIDE: 30 messages go again, 12 cannot."
```

1. Only status `failed`. Never `unknown`, `skipped`, `expired` or `cancelled`. Only the last 30 days (messages are kept 30 days).
2. **Still allowed now:**
   - an opening private reply: before its 7-day end (comment time + 7 days - `EXPIRY_SAFETY_MINUTES`);
   - any other DM: only if her window is open now;
   - not when the error is final for that person (she blocked us, user not found, no consent, opted out, paused by the owner);
   - not while the automation's text is still refused (fix the text first, section 15.4);
   - never broadcast messages.
3. Each message can be retried by the owner at most once (`RETRY_FAILED_MAX` 1, column `instagram_messages.owner_retry_at`). If it fails again, it stays `failed`.
4. Retried messages go through the normal lanes, gates and limits. They count in the month count when they are sent.
5. Each retry goes to the audit log.

---

## 16. Riya examples

Account A and account B belong to two different owners. Riya is a person who writes to them.

1. **Comment, window closed.** 10:00:00 Riya comments "GUIDE" on post P. Her window is closed. Her opening DM waits in A's slow lane and goes at a random second, 10:00:04, as a private reply. GUIDE has "Reply like a person" ON. At 10:00:37 the public reply "@riya Check your inbox" goes under her comment.

2. **Comment, window open.** Riya wrote to A yesterday at 18:00. Today 10:00 she comments "GUIDE". Her window is open. The opening message goes as a normal DM in the fast lane at 10:00:01.3. No 24-hour wait, and it does not use the 600. It counts 1 DM in the month.

3. **Viral post.** 10:00 2,000 people comment on A's post. All are saved. One opening DM goes in every 6-second box (600 per hour). At 10:30:00, 200 people tap within one second. Each tap gets its own 0.5 to 2 second delay, and up to 20 answers of account A go at once (about 1 second per call). The first answers arrive after about 1 second. The last one arrives about 10 to 12 seconds later: still far under Meta's 30 seconds.

4. **Tap.** 10:03:00.000 Riya taps "Send me the guide". The system picks 1,266 ms. 10:03:01.266 she gets the email question. 10:03:30 she types her email. The system picks 750 ms. 10:03:30.750 she gets message 1.

5. **Typed "yes send" instead of a tap.** Riya does not tap. She writes "yes send". Her run waits for the button, and any text counts like a tap. The next step goes 0.5 to 2 seconds later. GUIDE's counter saves it as a typed answer, so it counts in "% tapped" (section 15.1).

6. **Follow check fails twice.** GUIDE needs a follow. Riya taps. The check fails. 3.4 seconds later the second try fails too. We treat her as following. The email question goes at once. She is never left with nothing.

7. **Wrong email 3 times.** We ask for her email (wording 2 of 4). She writes "riya at gmail": wrong, ask again 1 ("Please send a correct email."). She writes "riya@gmail" (no dot after `@`): ask again 2. She writes "hello": ask again 3, the last one. She writes "ok": no more asks, the run still waits. Two days later she writes "riya@gmail.com". It is saved and message 1 goes.

8. **Stop word.** Riya writes "STOP!". It is cleaned to "stop": she opted out. Her 2 waiting messages become `skipped`. Her open runs are cancelled. Two days later she replies to A's story: nothing is sent. A week later she comments "GUIDE" on a new post: this keyword comment starts her again, `opted_out_at` is cleared, and her opening DM goes. The owner could not have started her again by hand.

9. **Expired after 7 days.** Account B was blocked for a week. Riya's comment came on Monday 10:00. Her opening DM is still waiting on the next Monday 09:30 (7 days minus 30 minutes). It becomes `expired`. It is never sent. The owner saw this coming in the banner: "About 140 may expire."

10. **Account blocked and starts again.** 11:00 A's slow lane gets "blocked". Both DM lanes of A stop. Replies and hides stop too. Other accounts go on, also A's sister account in the same workspace. 800 DMs wait. Banner and email. Next day 11:00 one test DM goes. It works: the stop ends, half speed for 24 hours (boxes 2 times bigger). Then normal.

11. **Two automations on one post.** Riya comments "GUIDE" and then "PRICE" on post P. Window closed. One opening DM goes. She taps once. Email is asked once. She answers. Both message lists go, one message at a time to her.

12. **"Any post" automation on two posts.** Automation LINK is on "any post". Monday Riya comments "LINK" on post 1: she gets the DM. Wednesday she comments "LINK" on post 2: she gets it again (another post). Thursday she comments "LINK" on post 1 again: nothing.

13. **Message list with waits and a closed window.** Automation COURSE on account A has 4 messages: message 1 (no wait), message 2 (wait 23 hours), message 3 (wait 2 hours), message 4 (wait 5 minutes). Riya taps at 10:00:00. Her window is open until 09:45 next day. Message 1 goes at 10:00:01. Message 2 goes at 09:00:01 next day: still inside. Message 3 would go at 11:00:01: the window closed at 09:45, so message 3 is `skipped` (`window_closed`), message 4 is never made, and the run ends `cancelled` (`window_closed`). The owner's daily line says "1 skipped because the chat closed". If Riya had written "thanks" at 08:00, her window would be open until 07:45 the day after, and both would go.

14. **Nudge.** Riya replies to A's story at 10:00:00. Automation STORY sends the hello at 10:00:01, version B (picked at random). Riya reads it and does nothing. At 11:00:01 the nudge goes: the same hello, version B, once more. At 11:20 she taps "Send it". The run goes on. Her tap counts for version B. Had she tapped at 10:40, the nudge would have been `cancelled`.

15. **Live comment.** Account A goes live at 20:00. At 20:05:10 Riya comments "LINK". The private reply goes at 20:05:11.4 in the fast lane: 1 fast message, 1 DM in the month. No public reply, no hide. At 20:30 the Live ends, and Live comment webhooks stop. Ten comments that came at 20:29:59 still wait; the first call gets "Live ended", and all ten become `expired` (`live_ended`). The owner sees "The Live ended before 10 Live replies could go."

16. **Link or QR code.** Account B prints a QR code on its shop counter: `https://ig.me/m/account_b?ref=counter`. Riya scans it at 14:00. Instagram opens her chat with B and sends us the ref "counter". Automation COUNTER starts: the hello goes at 14:00:01. She scans again at 16:00: nothing (once a day, `ref:<date>`). Tomorrow: again.

17. **Ad "Send message".** Account B runs ad 1203. Riya taps "Send message" and sends the ready text "Hi! Is this available?". The event carries source ADS and ad 1203. Automation AD1203 answers (match step 2), even though her text has the DM keyword "available". The hello goes in 1.1 seconds. Her window is 24 hours in this plan.

18. **Month limit reached.** Account A's workspace is on Free: 1,000 DMs a month. 25 Nov: 820 sent; the owner gets the notice and an email "820 of 1,000 DMs used this month". 28 Nov 15:00: the 1,000th DM goes. Stop `plan_limit` on A's slow, fast and broadcast lanes, and the owner gets the "DM limit reached" notice and email. The public replies and hides of DMs that already went keep going. 40 opening DMs wait. Riya taps a hello at 15:10: her answer waits too. The owner can upgrade: then the lanes wake and the 41 go within 5 minutes. Or wait: on 1 Dec 00:00 the count is 0 again. The 40 opening DMs are under 7 days old and go. Riya's next message is `skipped` (`window_closed`), because her window closed at 14:55 on 29 Nov, and her run ends `cancelled` (`window_closed`).

19. **"Reply like a person" OFF vs ON.** Account A has GUIDE ("Reply like a person" OFF) and PRICE (ON, 30 per hour), on two posts. 10:00 Riya comments "GUIDE" on post P, and another person comments "PRICE" on post Q. Riya's DM goes at 10:00:04; her reply goes at 10:00:05. The other person's DM goes at 10:00:10; the draw says "reply"; PRICE's box is 120 seconds (3600 / 30); Riya's OFF reply does not count for the 20-second gap, and no ON reply went in the last 20 seconds, so any second of PRICE's box may be picked; the random second is 10:01:12. Every GUIDE comment gets a reply; about 80% of PRICE comments do, at most 30 an hour.

20. **Hide comment.** GUIDE has "Hide their comment once the DM is sent" on, and its reply step is ON with "Reply like a person" OFF. Riya's DM goes at 10:00:04. The public reply goes at 10:00:05. The hide goes at 10:00:06: other people no longer see her comment "GUIDE". If the hide had failed, her DM and reply would stay as they are. If PRICE (ON) also hides: the other person's reply goes at 10:01:12 and the hide at 10:01:13; a PRICE comment that is not chosen by the draw is hidden right after its DM.

21. **Tag start.** Account B's automation VIP starts when the tag "vip" is added. The owner selects 1,200 contacts and taps "Add tag: vip". The tags go in 3 pieces (500, 500, 200). 1,200 rows go into `app.contact_tag_events` and on to intake. 90 people wrote to B in the last day: their windows are open, so 90 runs start and the hello goes to each. For the other 1,110 no run starts and nothing is sent: their windows are closed (the start is skipped, `window_closed`). Riya is one of the 90.

22. **"Every time" mode.** Account B turns "once per person per post" OFF. Monday 10:00 Riya comments "PRICE" on post P. The private reply goes at 10:00:04, she taps at 10:02 and gets the message list. Tuesday 09:00 she comments "PRICE" on post P again. With the setting ON, nothing would go. OFF: a new run starts (key `<media id>:<comment id>`). Her window is open until 09:47 (her tap + 24 hours - 15 minutes), so the hello goes as a normal DM at 09:00:01. Thursday 15:00 she comments again: her window is closed and her last private reply was days ago, so a new private reply goes in the slow lane.

23. **Broadcast "when her chat opens".** Account A (Creator) makes the broadcast "New guide": audience "tag vip, and no broadcast in the last 7 days", mode "when her chat opens", active 3 days (Monday 10:00 to Thursday 10:00). Tuesday 14:00 Riya, who has the tag "vip", replies to A's story. Automation STORY starts for her; its last message goes at 14:01:30 and the run is `completed`. At 14:01:36 (the next box of A's broadcast lane) she gets "New guide": 1 DM in the month. Wednesday she writes again: nothing (once per person per broadcast). Thursday 10:00 the broadcast is `done`.

24. **Past comments.** Account A's post P went up 6 days ago and has 340 comments. Today 10:00 the owner makes GUIDE live on post P and presses "Also answer comments from the last 7 days". The job reads 7 pages of 50, newest first. 290 comments match "guide" and were not answered before. Riya's comment from 6 days and 20 hours ago is one of them: it has about 3.5 hours left, so it is urgent and goes early in the old line. The banner says "Found 340 comments. 290 match. About 250 will go, about 40 may expire." (estimate). New comments still go first in the 4 new : 1 old mix.

25. **Pause automations for one person.** Riya keeps commenting "GUIDE" on every post of account A, many times a day. 12:00 the owner opens her contact and switches "Pause automations for this person". Her 2 waiting messages become `skipped` (`contact_excluded`), and her open run is `cancelled` (`contact_excluded`). 14:00 she comments "GUIDE" again: the comment is saved, but no DM, no public reply and no hide go. A week later the owner turns the switch off. Nothing is sent by itself. The next day Riya sends the DM "PRICE": the run starts normally.

26. **Retry failed messages.** Monday 11:00 Instagram has a long problem on account B: 40 opening private replies of GUIDE use up their "try later" tries and become `failed`. Tuesday 09:00 the owner presses "Retry failed messages" on GUIDE. The app says "40 failed: 34 can be sent again, 6 are too old or her chat is closed": 34 are still under 7 days after their comments; 6 came from comments that are now past their 7 days. The 34 go back to `waiting` in the slow lane. Riya's opening DM is one of them and goes at 09:00:05. If one of the 34 fails again, it stays `failed`: the owner cannot retry it a second time.


---

# Part C. Data in meepzo-be

## 17. Table map: plan to meepzo-be

meepzo-be already has 10 tables for Instagram in the schema `app`. The plan reuses 9 of them, drops 1 (`app.instagram_account_tokens`: Unified Login only, D24), and adds 20 new ones: 9 for the sending engine, and 11 for Flowdm v4, Unified Login, broadcasts and past comments. Every `app` table keeps meepzo-be's style: `organization_id` on every row, composite foreign keys `(organization_id, <parent>_id)`, row security ON and FORCE (section 22).

The product around sending (sign-in, team, plans, refer) adds a few tables and columns in other schemas. Those schemas are already in `main`, so they change only with NEW migrations (D48, Part F).

### 17.1 Plan idea and its table

| Plan idea | meepzo-be table | Same, changed or new | Why |
|---|---|---|---|
| One Meta login of a workspace (Unified Login) | `app.meta_connections` | New | One row per workspace and client business portfolio. One token covers all its accounts (D25). Facebook Pages and ad accounts can hang off it later (D27). |
| Login token (Unified Login) | `app.meta_connection_tokens` | New | The system user token, encrypted, in its own table, no sweep access (section 41). |
| Old per-account token | `app.instagram_account_tokens` | Dropped | Unified Login only (D24). The table, its daily renewal worker and its code are removed. |
| The owner's Instagram accounts | `app.instagram_accounts` | Changed | + `meta_connection_id`. Many accounts per workspace: the "one per workspace" unique index is removed (D26). |
| Owner limits and account switches | `app.instagram_account_settings` | Changed | New limit columns, empty = settings file (D22). 4 account settings: comment replies, once per person, mark seen, extra delay (D64 to D67). The 5 account-level public reply columns are removed (D32). |
| Posts and the missed-comment check | `app.instagram_media` | Changed | 3 columns for the missed-comment check (section 34), 1 for a Live that ended (D40). |
| The person (Riya) | `app.contacts` | Changed | Last opening DM time, stop word time, channel, "via" automation, how she came in, private note, first message time, comment and story activity, last broadcast. Phone is searchable. |
| Automations | `app.automations` | Changed | Draft, live, paused (D28). 15 ways to start (D37). Steps in one `steps` JSONB (D29 to D31). Public reply settings per automation (D32). Hide comment (D33). |
| All-time counters ("1.3k runs, 51% tapped") | `app.automation_counts` | New | 16 slot rows per automation. They survive the 90-day run delete (D36). |
| Public reply box of one automation | `app.automation_reply_state` | New | Box, last text and waiting count per automation (D32). |
| Files sent to Meta | `app.meta_attachments` | New | Uploaded to Meta once per account, the attachment id is used again (D29). |
| DMs per month per workspace | `app.dm_month_counts` | New | 16 slot rows per workspace and month. The third check in the send commit (D34). |
| One flow for one person | `app.automation_runs` | Changed, split by month | Comment time, "DM sent", once key of every way to start, versions used. The sending claim moves to the message row. |
| Run history | `app.automation_run_events` | Changed, split by month | Keeps a copy of the run start time. Taps are written here too. |
| What the owner sees per comment | `app.automation_comment_logs` | Changed, split by month | Step statuses `expired` and `unknown`. Hide step. Message list step. |
| Webhook events | `app.instagram_webhook_events` | Changed, split by day | Kept 8 days (D15). 5 new event kinds. "Saved once" moves to the key table. |
| "This event was already saved" | `app.instagram_webhook_event_keys` | New | A unique rule cannot cover many day parts. |
| Every DM, reply, hide, nudge, broadcast message and follow check | `app.instagram_messages` | New | The line of waiting messages and their results. One row per Instagram call. |
| Every Instagram send call | `app.instagram_send_attempts` | New | Errors, "in a row" rules, the 30% rule. |
| The final limit count (gate 2) | `app.instagram_send_minute_counts` | New | 61 small rows per check, also for 10,000 per hour (section 31). |
| Lanes, pause, stops, tests | `app.instagram_send_lanes` | New | One row per account per lane: `slow`, `reply`, `fast`, `broadcast` (D68). Plan stops too (D34, D35). |
| Stop history | `app.instagram_send_stops` | New | For the owner screen and the team. |
| "One open run per automation, person and key" | `app.automation_run_open_keys` | New | Runs are split, so this rule needs a small table. |
| Global state (stop all, copy protection) | `app.sending_state` | New | One row, no organization. |
| Helper slots | `app.sending_helper_slots` | New | 16 rows, no organization. |
| Saved audiences (segments) | `app.segments` | New | Conditions on one account, in AND / OR groups, used again by broadcasts (D68). |
| Broadcasts | `app.broadcasts` | New | One message set to a segment: now, at a set time, or when her chat opens (D68). |
| Who got a broadcast | `app.broadcast_recipients` | New, split by month | One row per person and broadcast, 90 days (D68). |
| "Also answer comments from the last N days" | `app.automation_backfills` | New | One past-comments read per automation at a time (D69). |
| Tag added or removed (a way to start) | `app.contact_tag_events` | New | One row per tag change, written in the same commit as the change, so no tag event is lost. Never saved as a webhook event (D45, section 27). |
| Tag list with counts | Query on `app.contacts.tags` | Same | Cached 60 seconds in Redis `tags:{account}` (D45). |
| Starter questions on Meta | `app.automations.starter_questions`, `app.instagram_accounts.starter_questions_set_at` | Changed | 1 to 4 questions per automation, at most 4 per account. A job sends the account's live questions to Meta (D42). |
| Uploaded files (image, voice note, PDF, card pictures) | `upload.uploads` | Same | meepzo-be's upload domain keeps the file (D29). |
| Team and owner emails | `auth.mail_outbox` (with `dedupe_key`) | Same | The same email is never sent twice. |
| Owner banners and notices | `notify.notifications` | Same | meepzo-be's notifications. New notice kinds in section 47. |
| Who did which action | `audit.logs` | Same | meepzo-be's audit log. |
| Jobs that failed for good | meepzo-be's dead-letter jobs | Same | Shown to the team, can be replayed. |
| Time zone of the workspace | `tenancy.organizations.timezone` | Same | The day limit, the `<date>` once keys (section 9) and the calendar month of the DM count (D34). |
| Plan of the workspace and its limits | `billing.plans`, `billing.subscriptions` | Changed (new migration) | DMs a month, accounts, PRO features (section 46). |

### 17.2 Product tables (Part F)

These live outside `app`. Each follows its own domain's rules (section 22.6).

| Plan idea | Table or column | Section |
|---|---|---|
| "Trust this device for 30 days" | `auth.trusted_devices` (`TRUSTED_DEVICE_DAYS` 30) | 44 |
| Onboarding: Instagram handle, goal | user columns `instagram_handle`, `goal` | 44, 47 |
| Reduce motion | user column `reduce_motion` | 47 |
| Workspace tile colour | organization column `logo_color` | 45 |
| Plans Free, Creator, Studio | `billing.plans` rows, typed `features`: `dm_month_limit`, `instagram_accounts_max`, `pro_features`, `priority_support`. Team members and the 4 roles are on every plan, with no seat limit (D55). | 46 |
| Refer | `billing.referral_links`, `billing.referrals`, `billing.referral_earnings`, `billing.referral_payouts` | 48 |
| Notice kinds and their settings | `notify` tables, user notification preferences | 47 |

Trials (D73, 7 days, no card) are billing's (section 46): one per workspace, never twice for the same Instagram account. The "had a trial" check looks across workspaces by `instagram_user_id`, so it runs through a `SECURITY DEFINER` resolver that returns yes or no only, like the "connected elsewhere" check (section 22.5). No `app` table gets a trial column.

The writers of Part F may refine these names. Section 50 lists the final ones.

### 17.3 Already solved by meepzo-be

These need no new work, only use:

1. **Meta callbacks:** deauthorize and data deletion routes exist (`instagram-account-meta-callback`), with the "which organization" resolvers. The routes stay. Which id Meta's callbacks carry with Unified Login is a test (test needed, section 43); the resolver for that id replaces the old app-user resolver (section 22.5). The Instagram-app secret is removed: callbacks are checked with the Meta app secret.
2. **Contact erase:** `app.contacts.deleted_at`, personal columns cleared, runs and logs cleared (`eraseContactRunCopies`).
3. **7-day wait end:** meepzo-be's own hourly wait worker (not the helper) cancels runs that waited 7 days (`cancel_reason` `wait_expired`).
4. **Ask once:** `queued_automations` on a run that waits for the email: other automations wait behind it.
5. **Encrypted token pattern:** `encrypted_access_token`, one row per owner of the token, own table, organization arm only (no maintenance access). `app.meta_connection_tokens` copies this pattern. `app.instagram_account_tokens` itself is dropped (section 18.2).
6. **Row security:** every `app` table, organization arm + maintenance arm (section 22).
7. **Event key per account:** the webhook key is already per account.
8. **Audit log:** `audit.logs`.
9. **Mail outbox:** `auth.mail_outbox` with `dedupe_key`.
10. **Lock order:** contact, then automation, then runs (extended in section 35).
11. **Uploads:** `upload.uploads` keeps the owner's files (images, voice notes, PDFs) and scans every uploaded file. A file that is not scanned clean can't be used in a message (D58). The plan only adds the Meta attachment id per account (`app.meta_attachments`).
12. **Plan access and grace:** `plan_access` (`active`, `grace`, `read_only`, `graceEndsAt`) in `GET /auth/me/context`, 14 days of grace after a failed payment (`BILLING_DUNNING_GRACE_DAYS`). Section 46 changes what "read only" does to sending.
13. **Workspace status and time zone:** `tenancy.organizations.status` has `SUSPENDED` (the plan makes it stop sending, D35, section 20.4), and `timezone` exists (section 17.1).

---

## 18. Existing meepzo-be tables: what changes

The `app` migrations (`migrations/20261121*.sql`) are not in `main` yet, so they are changed in place (D1). There is no data to copy. The development database is reset once.

Two rules for every check below:

1. A database check that holds a number that is also a setting (for example 10 messages, 16 slots) must match the setting. The server's start check compares them (section 36).
2. The API checks first and gives a clear error. The database check is the last guard.

### 18.1 `app.instagram_account_settings`

**Rule:** an owner value is stored here. Empty means "use the settings file" (D22). So a change in the settings file reaches every account that did not set its own value. Public reply settings are not here any more: they are per automation (D32, section 18.5).

| Column | Change | Type | Default | Check | Why |
|---|---|---|---|---|---|
| `opening_hour_limit` | Add | SMALLINT, null | empty | 1 to 750 (Meta) | Owner hour limit for opening DMs. The API also checks `OPENING_HOUR_LIMIT_MAX` (700). Any owner value here also replaces the new-account limit of 150; there is no separate column for it. D5 |
| `opening_day_limit` | Add | INTEGER, null | empty | over 0 | Used only if `DAY_LIMIT_ENABLED`. Empty = hour limit x `DAY_LIMIT_DEFAULT_FACTOR`. D5 |
| `fast_hour_limit` | Add | INTEGER, null | empty | over 0 | Owner fast limit. API checks `FAST_HOUR_LIMIT_MAX`. D11 |
| `person_hour_limit` | Add | SMALLINT, null | empty | over 0 | Loop guard per person. D11 |
| `automatic_notice_enabled` | Add | BOOLEAN | false | — | Adds "this is an automatic message" to the first DM (section 41). Review D2 |
| `extra_stop_words` | Add | TEXT[] | empty list | at most 50 words, each lower case, no empty word | The owner's own stop words in their language, added to `STOP_WORDS` (section 14). Review B7 |
| `public_reply_hour_limit` | Remove | — | — | check `chk_instagram_account_settings_hour_limit` removed | Now per automation (D32). |
| `public_reply_chance_percent` | Remove | — | — | check `chk_instagram_account_settings_chance` removed | Now the setting `PUBLIC_REPLY_CHANCE_PERCENT` (80), used only when "Reply like a person" is ON (D32). |
| `public_reply_gap_min_seconds` | Remove | — | — | check `chk_instagram_account_settings_gap_min` removed | Now the setting `PUBLIC_REPLY_GAP_MIN_SECONDS` (20), ON only (D32). |
| `public_reply_gap_max_seconds` | Remove | — | — | checks `..._gap_max` and `..._gap_order` removed | Box timing decides (D32). |
| `is_public_reply_safety_enabled` | Remove | — | — | — | "Reply like a person" per automation replaces it (D32). |
| `is_automation_enabled` | Keep | BOOLEAN | true | — | OFF = new events of this account are skipped (not saved for later). Different from Pause (section 15). |
| `trigger_on_comment_replies` | Add | BOOLEAN, not null | true | — | D64. ON: a reply under another comment (it has `parent_id`) can start comment automations like any comment on that post; the public reply goes under the top-level comment. OFF: it starts nothing (comment log `ignored`, `thread_reply_off`). Both: a comment by the account itself never starts anything (`own_comment`). |
| `once_per_person_per_post` | Add | BOOLEAN, not null | true | — | D65. ON: the once rule (D13, the once keys of section 9). OFF ("every time"): every new comment or keyword DM starts a new run; its once key is the event's own id (section 18.6). |
| `mark_seen_after_reply` | Add | BOOLEAN, not null | false | — | D66. ON: after an automation message to her is `sent`, one `mark_seen` call for her chat, at most once per her inbound message. Not a DM, not counted (`count_group` `none`). |
| `extra_delay_seconds_min` | Add | SMALLINT, null | empty | 1 to `EXTRA_DELAY_MAX_SECONDS` (20) | D67, PRO. "Delay before each message": the low end of an extra random pause, added once per her event to the FIRST answer we send after her tap, typed answer, story reply or DM. Later list messages with no wait, follow checks, private replies, public replies, nudges, list waits and broadcasts never get it. |
| `extra_delay_seconds_max` | Add | SMALLINT, null | empty | 1 to 20; `min <= max`; both empty (off) or both set | D67. The high end. The whole wait from her message to our answer stays at most 25 seconds (`BOT_ANSWER_MAX_SECONDS` 30 - `BOT_ANSWER_SAFETY_SECONDS` 5). Off after a move down to Free. |
| `broadcast_hour_limit` | Add | SMALLINT, null | empty = `BROADCAST_HOUR_LIMIT_DEFAULT` (600) | 1 to 2,000 (`BROADCAST_HOUR_LIMIT_MAX`) | D68. Owner hour limit of the account's `broadcast` lane. |

The API checks every owner number against the MIN and MAX settings. The worker checks again when it reads the row: a bad value means "use the file" (review C5).

### 18.2 `app.instagram_accounts`, and the dropped `app.instagram_account_tokens`

Unified Login is the only login (D24). There is no data to move: meepzo-be's Instagram Login code is removed and replaced, not migrated.

| Column or rule | Change | Type | Default | Check | Why |
|---|---|---|---|---|---|
| `meta_connection_id` | Add | BIGINT, not null | — | foreign key `(organization_id, meta_connection_id)` to `app.meta_connections (organization_id, id)`, RESTRICT | The login this account came from (D25). |
| `instagram_user_id` | Keep, new source | VARCHAR(64) | — | digits | The id from `GET /me/assigned_instagram_accounts`. Meta's docs say it is the same id the webhooks send, so it is used for API paths, webhook routing (section 22.5) and everything else. |
| `instagram_app_user_id` | Remove | — | — | check `chk_instagram_accounts_instagram_app_user_id` and index `idx_instagram_accounts_instagram_app_user_id` removed | An Instagram Login id. Unified Login has none. |
| `scopes` | Remove | — | — | check `chk_instagram_accounts_scopes` removed | The granted permissions live on `app.meta_connections.scopes`. |
| `token_expires_at` | Remove | — | — | — | The token lives on the connection and never ends by default (D24). |
| `connection_status` | Change check | VARCHAR(20) | `connected` | `connected`, `error`, `revoked` | `expired` is removed (it was the 60-day token's end). `error`: the connection's token stopped working (section 20.6). `revoked`: this account was disconnected, alone or with its connection. |
| `starter_questions_set_at` | Add | TIMESTAMPTZ, null | empty | — | Last time the job sent this account's starter questions to Meta (D42). Set to empty when a starter-question automation goes live, pauses or changes its questions; the helper sends again while it is empty (section 34). |
| `idx_instagram_accounts_organization_live` | Remove | — | — | — | Many accounts per workspace (D26). The plan's account limit is checked at connect instead (section 25). |
| `idx_instagram_accounts_instagram_user_live` | Keep | — | — | unique `(instagram_user_id)` where not `revoked` | One workspace per Instagram account (D26). |
| New index `idx_instagram_accounts_meta_connection` | Add | — | — | `(organization_id, meta_connection_id)` | The foreign key, and "all accounts of this connection" (token error, disconnect). |
| `app.instagram_account_tokens` | Drop the table | — | — | — | Unified Login only. Removed with it: the daily token renewal worker, the `instagram_business_*` scope names, the `graph.instagram.com` client and the Instagram-app secret. The only token path is `app.meta_connections` + `app.meta_connection_tokens` (sections 19.10, 19.11). |

Already there and used:

1. `connection_status`: "Connected" = `connected`. `error` stays connected for saving (comments are saved, sending waits). `revoked` = disconnected: nothing is saved (section 26).
2. `connected_at`: new-account slow start, `NEW_ACCOUNT_HOUR_LIMIT` (150) per hour for `NEW_ACCOUNT_DAYS` (D5), unless the owner set `opening_hour_limit`.
3. `webhook_subscribed_at`: the helper checks the webhook is still on (section 34).

### 18.3 `app.instagram_media`

| Column or rule | Change | Type | Default | Check | Why |
|---|---|---|---|---|---|
| `comments_checked_at` | Add | TIMESTAMPTZ, null | empty | — | Last time the helper read this post's comments. |
| `comments_next_check_at` | Add | TIMESTAMPTZ, null | empty | — | When to read again. Empty = not watched. |
| `last_comment_at` | Add | TIMESTAMPTZ, null | empty | — | Newest comment we know. Decides if the post is still watched. Meta lists comments newest first, 50 a page, with no time filter, so the check pages back until it passes this time (section 34). |
| `live_ended_at` | Add | TIMESTAMPTZ, null | empty | — | Set when Instagram says this Live ended (a "Live ended" error, or `GET /live_media` no longer lists it). Waiting Live private replies of this media become `expired` (`live_ended`) without a call (D40). |
| `chk_instagram_media_media_product_type` | Change | — | — | adds the value Meta gives for a Live (test needed, section 43) | Live comments are saved on their Live media (D40). |

New index: `(comments_next_check_at) WHERE comments_next_check_at IS NOT NULL` — the helper's missed-comment pass across organizations (maintenance arm, section 22). Review B16.

Already there and used: `published_at` decides "posts between two dates" and "my next post" (section 18.5). Meta sends no webhook for a new post, so a 15-minute job reads `/media` with `since` to find the next post (section 27). `media_product_type` `ad` marks an ad's post (D41).

### 18.4 `app.contacts`

| Column or rule | Change | Type | Default | Check | Why |
|---|---|---|---|---|---|
| `last_opening_message_at` | Add | TIMESTAMPTZ, null | empty | — | The 24-hour rule for private replies (D8). Saved when an opening DM is `sent` or `unknown`. |
| `opted_out_at` | Add | TIMESTAMPTZ, null | empty | — | She wrote a stop word: nothing automatic goes to her on this account (section 14). Cleared only by her own new action that matches an automation of these kinds: a keyword comment (post, reel, Live or ad comment), a keyword DM (also through "also start from" DM of a comment automation), a starter question tap, an ig.me link. That commit clears it and the run starts normally. "No other automation answered", tag starts, nudges, story replies, mentions and shared posts never clear it; the owner cannot clear it. A new stop word sets it again (D49). |
| `channel` | Add | VARCHAR(10) | `instagram` | `instagram` | Room for Messenger later (D27). |
| `first_automation_id` | Add | BIGINT, null | empty | foreign key `(organization_id, first_automation_id)` to `app.automations`, ON DELETE SET NULL (`first_automation_id`) | "via GUIDE" on the contact row: the first automation that started a run for her. Set once (D46). |
| `note` | Add | TEXT, null | empty | 1 to 2,000 characters (`CONTACT_NOTE_MAX_CHARS`) | The owner's private note (D46). Never sent to her. |
| `first_message_at` | Add | TIMESTAMPTZ, null | empty | — | Instagram's time of her first message in the chat. Set once. The "their first ever message" start reads it (section 4). |
| `automations_off_at` | Add | TIMESTAMPTZ, null | empty | — | D71, "Pause automations for this person": the OWNER's choice, and the owner can turn it off. While set: no automation starts for her, her waiting messages become `skipped` (`contact_excluded`), her open runs end `cancelled` (`contact_excluded`), broadcasts leave her out, her comments get no DM, public reply or hide, and no mark seen goes. Her events are still saved. Turning it off restarts nothing: her next own action starts normally. Different from `opted_out_at` (HER choice, the owner can't undo it). |
| `automations_off_by_user_id` | Add | BIGINT, null | empty | foreign key to `auth.users`, SET NULL; set exactly when `automations_off_at` is set | Who paused her (Owner, Admin or Editor). Each change goes to `audit.logs`. |
| `came_in_via` | Add | VARCHAR(20), null | empty | a `trigger_type` value | How she came in: the start kind of her first run. Set once, with `first_automation_id` (D68 condition "how she came in"). |
| `came_in_ref` | Add | VARCHAR(64), null | empty | — | The ref code or the ad id of that first run, when it had one. |
| `last_comment_at` | Add | TIMESTAMPTZ, null | empty | — | Instagram's time of her newest comment on the account's posts. Set in the comment's intake commit. |
| `comment_count` | Add | INTEGER, not null | 0 | at least 0 | Her comments on the account's posts. + 1 in the comment's intake commit. |
| `last_story_activity_at` | Add | TIMESTAMPTZ, null | empty | — | Her newest story reply or story mention. Set in that intake commit. |
| `last_broadcast_at` | Add | TIMESTAMPTZ, null | empty | — | When the last broadcast message to her was `sent`. Set in that send commit. The 24-hour cap (`BROADCAST_MIN_GAP_HOURS`) and the "no broadcast in N days" condition read it. |
| `chk_contacts_email` | Change | — | — | strict: `^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$`, length up to `EMAIL_MAX_LENGTH` (254) | The old check let `<`, `>`, `=`, `"` pass. Review B4 |
| `chk_contacts_phone` | Keep | — | — | `^\+?[0-9]{10,15}$` = `PHONE_DIGITS_MIN` to `PHONE_DIGITS_MAX` | |
| `chk_contacts_erased` | Change | — | — | `last_opening_message_at`, `opted_out_at` and `note` are cleared on erase too | Erase clears all personal data. |
| `idx_contacts_search_trgm` | Change | — | — | the expression adds `coalesce(phone, '')` | Search also by phone (D46). |
| The 4 sort indexes (`..._last_message_received_at_id`, `..._first_seen_at_id`, `..._username_id`, `..._username_desc_id`) | Change | — | — | lead with `(organization_id, instagram_account_id, ...)` | A contact belongs to one account (meepzo-be CT13) and the list is per account (D26). "Newest" and "A to Z" read one account. |
| New index `idx_contacts_first_automation` | Add | — | — | `(organization_id, first_automation_id) WHERE first_automation_id IS NOT NULL` | The foreign key. |
| New index `idx_contacts_chat_open` | Add | — | — | `(organization_id, instagram_account_id, last_direct_message_received_at) WHERE deleted_at IS NULL AND opted_out_at IS NULL AND automations_off_at IS NULL` | A broadcast's "can get it now (chat open)" (D68). |
| New index `idx_contacts_last_comment` | Add | — | — | `(organization_id, instagram_account_id, last_comment_at) WHERE last_comment_at IS NOT NULL AND deleted_at IS NULL` | "Commented in the last N days". |

Already there and used: `last_direct_message_received_at` (her last DM: the 24-hour chat window), `last_message_received_at` ("last active"), `first_seen_at` ("first seen"), `is_following_account` and `follow_checked_at` ("follows the account": the last follow-check result and its date), `email`, `phone`, `tags` (GIN index `idx_contacts_tags_gin`, at most 50 tags), `deleted_at` (erase).

**Segment conditions** (D68) read these columns, the tags, and her runs and run events of the last 90 days. The common ones use the indexes above. Complex ones run as a background count job (`instagram-tasks` job `segment-count`, section 24).

**Tag list with counts** (D45): one query per account, `unnest(tags)` and `count(*)` over its live contacts. Estimate: under 1 second for 100,000 contacts. It is cached 60 seconds (`TAG_LIST_CACHE_SECONDS`, Redis `tags:{account}`), so a big account runs it at most once a minute.

**Bulk tag** (D45): the owner adds or removes a tag for many contacts in pieces of 500 (`TAG_BULK_PIECE`), one short transaction per piece. Each changed contact makes one row in `app.contact_tag_events` ("tag added" or "tag removed"), in the same commit as the change (section 19.16).

### 18.5 `app.automations`

An automation is now: flat columns for how it starts and its public reply, and one `steps` JSONB for everything it sends. A draft needs only a name (D28).

**All columns:**

| Column | Change | Type | Default | Check (every save) | Why |
|---|---|---|---|---|---|
| `id`, `public_id`, `organization_id` | Keep | | | | |
| `instagram_account_id` | Keep | BIGINT | — | — | Fixed when made (meepzo-be AU27). Duplicate goes to the account on screen. |
| `name` | Keep | VARCHAR(255) | — | 1 to 255 after trim | The only field a draft needs (D28). |
| `status` | Change | VARCHAR(10) | `draft` | `draft`, `live`, `paused` | D28. meepzo-be's OFF value becomes `paused`, in place. |
| `trigger_type` | Change | VARCHAR(20) | — | `comment`, `live_comment`, `story_reply`, `story_mention`, `story_repost`, `dm_keyword`, `first_message`, `shared_post`, `starter_question`, `ref_link`, `default_reply`, `ad_comment`, `ad_message`, `tag_added`, `tag_removed` | The 15 ways to start (D37, section 4). `story_repost` goes live only if the Meta test shows the event (section 43). |
| `channel` | Add | VARCHAR(10) | `instagram` | `instagram` | Room for Messenger later (D27). |
| `also_start_from` | Add | TEXT[] | empty list | values `story_reply`, `dm`; at most 2; no empty value | D38. Replaces the DM keyword switch (below). |
| `target_scope` | Change | VARCHAR(10) | `any` | `any`, `specific`, `next`, `between` | D39. |
| `target_instagram_media_id` | Keep | VARCHAR(64), null | — | digits | One post, a shared post, or the linked "next post". |
| `target_instagram_story_id` | Keep | VARCHAR(64), null | — | digits | One story. |
| `target_starts_at` | Add | TIMESTAMPTZ, null | empty | — | `between`: the owner's start. `next`: set by the server when the automation first goes live (the first post published after it is linked). |
| `target_ends_at` | Add | TIMESTAMPTZ, null | empty | after `target_starts_at` | `between`: the owner's end. `next`: always empty (no end date). |
| `next_post_status` | Change | VARCHAR(10), null | empty | `waiting`, `linked` | No end date, so a "next post" never expires (D39). |
| `next_post_linked_at` | Keep | TIMESTAMPTZ, null | — | set exactly when `linked` | |
| `keywords` | Keep | TEXT[] | empty list | at most 50, each up to 100 characters (meepzo-be) | "Contains" + close spellings, also inside keywords of several words (D39, D60). |
| `ref_code` | Add | VARCHAR(64), null | empty | `^[A-Za-z0-9_=-]{1,64}$` (`REF_CODE_MAX_CHARS` 64) | The `?ref=` of the link or QR (D43). Meta allows up to 2,083 characters; 64 keeps links short. |
| `starter_questions` | Add | TEXT[] | empty list | at most 4 (`STARTER_QUESTIONS_MAX`), each 1 to 80 characters (`STARTER_QUESTION_MAX_CHARS`, test needed), no empty value | 1 to 4 questions in one automation (D42). The account's total over all its live automations is at most 4 too (checked at go-live). |
| `ad_id` | Add | VARCHAR(64), null | empty | digits | The ad of an ad automation (D41). |
| `trigger_tag` | Add | VARCHAR(50), null | empty | 1 to 50 characters | The tag of a tag start (D45). |
| `default_reply_mode` | Add | VARCHAR(10), null | empty | `once_a_day`, `every_time` | "No other automation answered" (D44). |
| `hide_comment_after_dm` | Add | BOOLEAN | false | — | D33. |
| `public_reply_enabled` | Rename (was `is_public_reply_enabled`) | BOOLEAN | false | — | The "Reply under their comment" step, ON or OFF (D32). |
| `public_reply_texts` | Keep | TEXT[] | empty list | at most 20 (`PUBLIC_REPLY_TEXTS_MAX`), each up to 300 characters (meepzo-be) | D32. More than 1 line is PRO (D35). With "Reply like a person" ON: 3 or more (`PUBLIC_REPLY_LINES_MIN_ON`, a go-live check, D52). |
| `public_reply_mention` | Add | BOOLEAN | true (`PUBLIC_REPLY_MENTION_DEFAULT`) | — | ON: the reply starts with `@username`. OFF: the reply text alone (D63). |
| `reply_like_person` | Add | BOOLEAN | false; the API sets ON for a new automation on a paid plan (`REPLY_LIKE_PERSON_DEFAULT_PAID` true) | — | D32, D59. PRO: Free has OFF only (no pace, no hour cap). |
| `public_reply_hour_limit` | Add | SMALLINT, null | empty = `REPLY_LIKE_PERSON_LIMIT_DEFAULT` (60) | 10, 20, 30, 60 or 100 (`REPLY_LIKE_PERSON_LIMITS`) | Used only when `reply_like_person` is ON (D32). |
| `steps` | Add | JSONB | `{}` | a JSON object; at most 64 KB (`AUTOMATION_STEPS_MAX_BYTES`) | Hello, follow, email, phone, message list, tags (shape below). |
| `stopped_reason` | Add | VARCHAR(20), null | empty | `bad_text`, `post_deleted` | Automatic stop (section 33). Review B8. A plan change never stops an automation: after a move down the PRO parts the plan lacks are only ignored (D57). |
| `stopped_at` | Add | TIMESTAMPTZ, null | empty | set exactly when `stopped_reason` is set | |
| `cancelled_before_at` | Add | TIMESTAMPTZ, null | empty | — | "Pause + Cancel": messages created before this time are not sent. The pick and the helper mark them `cancelled` in small pieces, not in one big statement. Review B21 |
| `last_triggered_at` | Keep, fewer writes | TIMESTAMPTZ, null | — | — | Updated in the run-start commit only when it is older than 60 seconds (`LAST_TRIGGERED_UPDATE_SECONDS`). A viral automation does not rewrite its row on every comment. |
| `created_by_user_id`, `updated_by_user_id`, `created_at`, `updated_at` | Keep | | | | |
| `deleted_at`, `delete_reason`, `delete_note` | Keep | | | | Soft delete. The reason becomes optional (Flowdm asks none); `other` still needs a note. |

**Removed columns:**

| Removed | Replaced by |
|---|---|
| `is_dm_keyword_trigger_enabled` (and check `chk_automations_dm_keyword_trigger`) | `also_start_from` (D38). |
| `completed_run_count` (and check `chk_automations_completed_run_count`, index `..._completed_run_count_id`) | `app.automation_counts` (D36). The list shows counts; it does not sort by them. |
| `next_post_starts_at`, `next_post_ends_at` | `target_starts_at`, `target_ends_at` (one pair for `next` and `between`). |
| `tags` | `steps.tags` (D45). |
| `is_opening_message_enabled`, `opening_message` | `steps.hello` (D30). |
| `is_follow_required`, `follow_request_message` | `steps.follow` (D31). |
| `is_email_collection_enabled`, `email_request_message` | `steps.email` (D31). |
| `is_phone_collection_enabled`, `phone_request_message` | `steps.phone` (D31). |
| `final_message` (and check `chk_automations_message_objects`) | `steps.messages`, the message list (D29). |

**The `steps` JSON.** Validated by zod (`automationStepsSchema` in `automation.dto.ts`) in two levels: the draft shape (types, lengths, counts; parts may be missing) on every save, and the full shape at "Go live". The message rows hold no text: the worker reads the content from `steps` when it sends (section 30).

A short example (automation GUIDE; its second hello version and the parts that are off are left out):

```json
{
  "hello": {
    "on": true,
    "nudge": false,
    "versions": [
      { "text": "Hi {name}! Want the free guide?",
        "buttons": [
          { "title": "Send it", "action": "next" },
          { "title": "Our shop", "action": "link", "url": "https://shop.example" } ] }
    ]
  },
  "email": { "on": true, "wordings": ["What's your email?", "Where should I send it?"] },
  "messages": [
    { "kind": "text", "wait_minutes": 0, "condition": "always",
      "text": "Here is your guide", "image_upload_id": "upl_...",
      "buttons": [ { "title": "Open guide", "url": "https://example.com/guide" } ] },
    { "kind": "file", "wait_minutes": 60, "condition": "always",
      "upload_id": "upl_..." }
  ],
  "tags": { "on": true, "list": ["guide", "lead"] }
}
```

| Part | Fields | Limits |
|---|---|---|
| `hello` | `on`, `nudge`, `versions[]`: `text`, `buttons[]` (`title`, `action` `next` or `link`, `url` for a link) | 1 to 3 versions (`MESSAGE_VERSIONS_MAX`). Text up to 640 characters (`BUTTON_TEXT_MAX_CHARS`), `{name}` allowed. 1 to 3 buttons (`HELLO_BUTTONS_MAX`), title up to 20 (`BUTTON_TITLE_MAX_CHARS`), `https://` link up to 2,048 (meepzo-be). `nudge` only for starts where she messaged first (D30). |
| `follow` | `on`, `versions[]`: `text`, `profile_button_title`, `following_button_title` | 1 to 3 versions. Text up to 640. Titles up to 20. |
| `email`, `phone` | `on`, `wordings[]` | 1 to 10 wordings (`QUESTION_WORDINGS_MAX`), each up to 1,000 bytes (`MESSAGE_TEXT_MAX_BYTES`). PRO (D35). |
| `messages[]` | `kind`, `wait_minutes`, `condition`, then the kind's fields | 1 to 10 messages (`AUTOMATION_MESSAGES_MAX`). `wait_minutes` 0, or 1 to 1,380 (`MESSAGE_WAIT_MAX_HOURS` 23 x 60). `condition` only `always` now. |
| kind `text` | `text`, `image_upload_id` (optional), `buttons[]` (`title`, `url`) | Without buttons: up to 1,000 bytes (`MESSAGE_TEXT_MAX_BYTES`; an emoji or a Gujarati letter uses 2 to 4 bytes). With buttons: up to 640 characters (`BUTTON_TEXT_MAX_CHARS`, Meta's button template). 0 to 3 link buttons (`LINK_BUTTONS_MAX`). A picture is a separate call before the text (2 calls). |
| kind `image` | `upload_id` | One png or jpeg image, up to 8 MB (`MESSAGE_IMAGE_MAX_MB`). |
| kind `cards` | `cards[]`: `image_upload_id`, `title`, `subtitle`, `url`, `button_title` | 1 to 10 cards (`CARDS_MAX`). Each card needs one field besides the title (Meta). Title and line up to 80 characters (`CARD_TITLE_MAX_CHARS`, `CARD_SUBTITLE_MAX_CHARS`, Meta). Card pictures as for `image`. |
| kind `quick_replies` | `text`, `replies[]` | Text up to 1,000 bytes. 1 to 13 replies (`QUICK_REPLIES_MAX`), each up to 20 characters (`QUICK_REPLY_MAX_CHARS`). |
| kind `audio` | `upload_id` | Voice note: aac, m4a, wav or mp4, up to 25 MB (`MESSAGE_AUDIO_MAX_MB`). |
| kind `file` | `upload_id` | PDF, up to 25 MB (`MESSAGE_FILE_MAX_MB`). |
| kind `post` | `media_id` or `"newest"` | One of the account's own posts (Meta's `MEDIA_SHARE` works only for those). |
| `tags` | `on`, `list[]` | 0 to 20 tags, each up to 50 characters (meepzo-be). Added when she finishes. Never her own `trigger_tag` (D45). |

Uploads are named by their public id (`upl_...`). The API checks each one belongs to the same workspace and is scanned clean (D58).

**Checks: every save, or only "Go live".** meepzo-be checks the whole automation on every save (AU8). Now a draft may be incomplete (D28). So there are two kinds of database checks:

1. **Every save (drafts too):** value lists, lengths, counts, number ranges, "JSON is an object". They are the "Check" column above.
2. **Go live:** rules about what fits together. Each is written `status = 'draft' OR (...)`. A `live` or `paused` row must pass them. So the API runs the full check at "Go live" and on every save of a live or paused automation. The editor keeps unsaved changes of a live automation in the browser until they are complete.

| Rule (go live) | Database check | Detail |
|---|---|---|
| Start fields | `chk_automations_live_trigger_fields` | `ref_link` needs `ref_code`; `starter_question` needs 1 to 4 `starter_questions`; `ad_comment` and `ad_message` need `ad_id`; `tag_added` and `tag_removed` need `trigger_tag`; `default_reply` needs `default_reply_mode`; `dm_keyword` needs 1 or more keywords. Other kinds leave these empty. |
| Where it listens | `chk_automations_live_target` | See the table below. |
| Also start from | `chk_automations_live_also_start_from` | `comment`: `story_reply`, `dm`. `story_reply`: `dm`. `dm_keyword`: `story_reply`. All other kinds: empty. |
| Next post | `chk_automations_live_next_post` | `target_scope = 'next'` exactly when `next_post_status` and `target_starts_at` are set; `linked` exactly when the media id is set. |
| Between | `chk_automations_live_between` | `between` has both dates. |
| Public reply | `chk_automations_live_public_reply` | Only on `comment` and `ad_comment` (never Live, D40). ON needs 1 or more texts. `reply_like_person` needs the step ON and 3 or more texts (`PUBLIC_REPLY_LINES_MIN_ON`, D52). |
| Hide | `chk_automations_live_hide` | Only on `comment` and `ad_comment` (D33). |
| Message list | `chk_automations_live_messages` | `jsonb_array_length(steps -> 'messages')` 1 to 10. |
| Hello button | `chk_automations_live_hello_next_button` | Replaces meepzo-be's `chk_automations_comment_opening_button`. When the hello is ON, every version has at least one button with `action` `next`, for every kind of start, not only comments. The message list always has 1 or more messages, so there is always a later step, and a link alone sends us no tap (D30). Written with `jsonb_path_exists`. |

Where each kind of start listens (`chk_automations_live_target`):

| `trigger_type` | Scopes allowed | Target id |
|---|---|---|
| `comment` | `any`, `specific`, `next`, `between` | `specific`: media id. `next`: media id once linked. `any`, `between`: none. |
| `story_reply` | `any`, `specific` | `specific`: story id. |
| `shared_post` | `any`, `specific` | `specific`: media id (one of the account's posts). |
| All others | `any` | None. The ad, ref code, question or tag name the source. |

Checked only by the API at "Go live" (not in the database):

1. The full zod shape of `steps` (each kind's fields, buttons, versions, wordings).
2. PRO steps without a PRO plan: email, phone, "Reply like a person" (Free: OFF only, D59), more than 1 reply line, more than 1 version (D35). A draft may hold them, but cannot go live with them. A save of a live or paused automation may not turn one on (it was off in the saved row). PRO steps that were on before a move down stay saved and are ignored by the engine, so such an automation can still be edited and saved (D57).
3. Plan ended: no go-live (D35).
4. Starter questions: the account's total over all its live automations, this one included, is at most 4 (`STARTER_QUESTIONS_MAX`), no two the same. The go-live locks the account row (`FOR UPDATE`) while it counts (D42).
5. `nudge` only on starts where she messaged first (D30). Never on `comment`, `live_comment`, `ad_comment`.
6. `trigger_tag` is not in the automation's own `steps.tags` (D45).
7. The start rules of section 4: "also start from" DM needs a keyword; one live `first_message` and one live `default_reply` per account; a comment, Live comment or ad comment start with the hello OFF and no follow, email or phone step has exactly 1 message: a `text` message with no picture (one call, the private reply).
8. The month limit is not reached (D34). A private account gets a warning for comment automations: Meta sends no comment webhooks for it (section 33).
9. Two live automations of one account share a keyword: a warning, not a block (D39).

**Indexes:**

| Index | Change | Columns | Serves |
|---|---|---|---|
| `..._completed_run_count_id` | Remove | | The column is gone. |
| `idx_automations_next_post_waiting` | Change | `(organization_id, instagram_account_id) WHERE next_post_status = 'waiting' AND status = 'live' AND deleted_at IS NULL` | The 15-minute job that reads `/media` with `since` and links the first new post (Meta has no new-post webhook). |
| `idx_automations_next_post_expiry` | Remove | | A "next post" has no end date. |
| New `idx_automations_account_ref_code` | Add, unique | `(organization_id, instagram_account_id, ref_code) WHERE ref_code IS NOT NULL AND deleted_at IS NULL` | `ref_code` is unique per account, drafts too (D43). |

All other indexes stay. `idx_automations_live_triggers` `(organization_id, instagram_account_id, trigger_type) WHERE status = 'live' AND deleted_at IS NULL` gives intake the account's live automations (a few dozen, also cached in `auto:{account}`, section 23), so the new start fields need no index of their own.

Automatic stop: `status` stays `live` and `stopped_reason` is set. The pick leaves its messages out until the owner fixes it (section 20.5).

### 18.6 `app.automation_runs`

| Column or rule | Change | Type | Why |
|---|---|---|---|
| `started_at` | Becomes the partition key | TIMESTAMPTZ | Split by month (section 21). |
| `trigger_type` | Change check | VARCHAR(20) | The 15 kinds. It is how THIS run started, so with `also_start_from` it can differ from the automation's (a comment automation started by a DM keyword has `dm_keyword`). |
| `trigger_occurred_at` | Add | TIMESTAMPTZ, not null | The 7-day clock (D9). A comment webhook has no comment time, so for a comment it is the webhook's `entry.time`; when the event arrives over 1 hour after that (a Meta retry), the comment's `timestamp` is read from the API once (section 27). A message: Meta's message time. A tag start: the time of the tag change. |
| `post_key` | Add | VARCHAR(255), not null | The once key of table "ways to start" (section 9): media id, `live:<media id>`, `story:<story id>`, `mention:<story id>`, `dm:<date>`, `first`, `share:<media id>`, `starter:<date>`, `ref:<date>`, `default:<date>`, `ad:<ad id>`, `tag:<tag>:<event id>`, `untag:<tag>:<event id>` (the id of the `app.contact_tag_events` row). "Every time" default replies use `default:<her message id>`, a key that never repeats, so the once rule never blocks them. With `once_per_person_per_post` OFF (D65), each start gets the event's own id: `<media id>:<comment id>`, `dm:<message id>`, `story:<story id>:<message id>`, `starter:<event id>`, `ref:<event id>`, `ad:<event id>`, and so on; `first` stays once ever, `default:` keeps its own choice, tag keys are already per event. Never empty. D13 |
| `dm_sent_at` | Add | TIMESTAMPTZ, null | First DM of this run `sent` or `unknown`. Stays after old messages are dropped. D13, review A9 |
| `last_message_no` | Add | SMALLINT, null | The highest list message `sent` in this run (1 to 10). The segment condition "got message N of X" reads it for 90 days, after the message rows are gone at 30 days (D68). |
| `version_nos` | Add | JSONB, not null, default `{}` | Which version each step used, for example `{"hello": 2, "follow": 1}`. Picked at random when the run starts (D30, D31). Check: a JSON object. |
| `trigger_text` | Remove | — | Her own free text is never kept (D46). A comment's text stays in the comment log (a public comment, 90 days). |
| `current_step` | Change check | — | `final_dm` becomes `messages` (the message list, D29). Full list: `keyword_match`, `comment_reply`, `follow_check`, `email_collect`, `phone_collect`, `messages`. |
| `waiting_for` | Change check | — | Adds `any`: her next tap or message goes on (D17). |
| `cancel_reason` | Change check | — | Adds `expired` (the opening DM passed 7 days, D9) and `opted_out` (she wrote a stop word, section 14). Adds `window_closed`: her window closed before the next list message, so the run ends (D29). Adds `contact_excluded`: the owner paused automations for her (D71). Full list: `automation_deleted`, `wait_expired`, `contact_deleted`, `expired`, `opted_out`, `window_closed`, `contact_excluded`. |
| `chk_automation_runs_trigger_targets` | Change | — | `comment`, `live_comment`, `ad_comment` need the media id and the comment id. `story_reply`, `story_mention` need the story id. `shared_post` needs the media id. |
| `sending_message_kind`, `sending_started_at` | Remove | — | The message row is the claim now (`app.instagram_messages.status` = `sending`). Check `chk_automation_runs_sending` removed. |
| Primary key | Change | — | `(id, started_at)`. |
| `idx_automation_runs_public_id` | Change | — | Unique `(public_id, started_at)`. |
| `idx_automation_runs_organization_id_id` | Change | — | Unique `(organization_id, id, started_at)`: the parent key for run events, comment logs, messages, open keys. |
| `idx_automation_runs_one_open` | Remove | — | Moves to `app.automation_run_open_keys` (section 19.6). |
| New index `idx_automation_runs_once` | Add | — | `(organization_id, automation_id, contact_id, post_key) WHERE dm_sent_at IS NOT NULL` — the once check. |
| `idx_automation_runs_ended` | Remove | — | Old runs go by dropping parts, not by row deletes. |

Kept as they are: `status`, `queued_automations`, `last_instagram_event_key`, `waiting_since_at`, `trigger_instagram_media_id`, `trigger_instagram_comment_id`, `trigger_instagram_story_id`, the other indexes (now one per part).

"What happened" on a contact (D46) reads her runs of the last 90 days (`idx_automation_runs_contact`), then their run events (taps, email and phone received, 90 days) and our messages, which are kept 30 days (`idx_instagram_messages_run`, D50). No new index is needed.

### 18.7 `app.automation_run_events`

| Column or rule | Change | Why |
|---|---|---|
| `automation_run_started_at` | Add, TIMESTAMPTZ not null | Copy of the run's `started_at`. Partition key. |
| `event_type` | Change check | Adds `hello_tapped` and `follow_tapped`: her taps, for "what happened" (D46). Full list: `status_changed`, `email_received`, `phone_received`, `hello_tapped`, `follow_tapped`. |
| Primary key | `(id, automation_run_started_at)` | Split table. |
| Foreign key to the run | `(organization_id, automation_run_id, automation_run_started_at)`, CASCADE | Run and history leave together. |

### 18.8 `app.automation_comment_logs`

| Column or rule | Change | Why |
|---|---|---|
| `created_at` | Becomes the partition key | Split by month. |
| `automation_run_started_at` | Add, TIMESTAMPTZ null | Copy of the run start, for the foreign key. Null when there is no run. |
| `comment_occurred_at` | Add, TIMESTAMPTZ null | Instagram's comment time, shown to the owner. |
| `final_dm_status`, `final_dm_at` | Rename to `messages_status`, `messages_at` | The message list (D29). `sent` when its last message went. |
| `hide_status` | Add, VARCHAR(10), default `off` | The hide step (D33). Same values as the other steps. |
| `hidden_at` | Add, TIMESTAMPTZ null | When the hide call went. |
| Step statuses (`public_reply_status`, `opening_dm_status`, `follow_status`, `email_status`, `phone_status`, `messages_status`, `hide_status`) | Check adds `expired`, `unknown` | D9, D17. |
| `current_step`, `failed_step` | Change check | `final_dm` becomes `messages`; adds `hide_comment`. |
| `waiting_for` | Change check | Adds `any` (D17). |
| `ignored_reason` | Change check | `previous_run_final` becomes `once_per_post`: once per automation, person and key (D13). Adds `thread_reply_off` (a reply under a comment while `trigger_on_comment_replies` is OFF) and `own_comment` (written by the account itself, D64), and `contact_excluded` (the owner paused automations for her, D71). meepzo-be's `run_in_progress` is used when "every time" is on (the setting OFF): a new start from her (a comment, a keyword DM or any other) while her run of the same automation is still open (D65). |
| `public_reply_skip_reason` | Check: `duplicate`, `random`, `hour_limit`, `deleted_comment` | `gap` removed: the reply waits for its box instead. `random` and `hour_limit` happen only with "Reply like a person" ON (D32). `random` lives only here: a reply not chosen by the chance gets no message row. The other words are the same as the message `reason` (section 19.1). |
| `idx_automation_comment_logs_automation_comment` | Unique becomes a plain index | A unique rule cannot cover many month parts. The duplicate check reads the last 2 months under the contact lock (section 21.4). |
| `idx_automation_comment_logs_public_replies`, `idx_automation_comment_logs_automation_public_replies` | Remove | The reply gap is on the reply lane row, the box and the last text are in `app.automation_reply_state` (section 19.13). |
| Primary key, `public_id` | `(id, created_at)`, unique `(public_id, created_at)` | Split table. |
| Foreign key to the run | `(organization_id, automation_run_id, automation_run_started_at)`, SET NULL on both | |
| `idx_automation_comment_logs_created` | Remove | Old logs go by dropping parts. |

Live comments and ad comments get a comment log too. A Live comment's `public_reply_status` and `hide_status` stay `off` (D40).

### 18.9 `app.instagram_webhook_events`

| Column or rule | Change | Why |
|---|---|---|
| `created_at` | Becomes the partition key | Split by day. |
| `next_attempt_at` | Add, TIMESTAMPTZ null | When a `failed` event is tried again (section 34). |
| `event_kind` | Change check | Adds `live_comment`, `story_mention`, `shared_post`, `referral`, `ice_breaker` (see below the table). `reaction` stays. `read` is removed: `messaging_seen` is not subscribed (D24) and read receipts are never saved (D15). |
| `skip_reason` | Change check | `read_receipt` removed (same reason). Adds `own_comment`: a comment written by the account itself is saved `skipped` and never starts anything (D64). |
| `payload` | Rule change | Set to `{}` when the event is `processed` or `skipped` (meepzo-be's masking helper). Kept only while `received`, `queued` or `failed`. A story mention's media link is never copied anywhere else (Meta's rule). D15, review C3 |
| Primary key, `public_id` | `(id, created_at)`, unique `(public_id, created_at)` | Split table. |
| `idx_instagram_webhook_events_organization_account_event_key` | Remove | Moves to `app.instagram_webhook_event_keys`. |
| `idx_instagram_webhook_events_created_at` | Remove | Old days go by dropping parts. |
| New index `idx_instagram_webhook_events_retry` | Add | `(next_attempt_at) WHERE status = 'failed' AND next_attempt_at IS NOT NULL` — the helper's retry pass. |
| What is saved | Rule change | Our own "message was sent" notices are not saved (D15, section 26). Echoes (`is_echo`) of messages the owner typed by hand are saved only to start the owner's quiet time for that one contact (`OWNER_CHAT_QUIET_HOURS`; other people are not affected); an echo or an `is_self` message never starts or answers anything. Tag events are never saved here (D45). |

Which Meta field gives which `event_kind`: `live_comments` gives `live_comment`; a message that replies to a story, mentions a story or shares a post gives `story_reply`, `story_mention` or `shared_post`; a starter question tap (`messaging_postbacks`) gives `ice_breaker`, any other tap `postback`; `messaging_referral` (a ref link, or source ADS) gives `referral`; `message_reactions` gives `reaction`. Section 26 has the full list.

---

## 19. New tables

All new tables are in schema `app`, owned by `meepzo_be_owner`, with grants to `meepzo_be_app` and `meepzo_be_maintenance`, like the other `app` tables. Ids are `BIGSERIAL`. Times are `TIMESTAMPTZ` and come from the Postgres clock.

**Rule:** no foreign key points INTO `app.instagram_messages` or `app.instagram_send_attempts`. Their old parts must drop freely.

Sections 19.1 to 19.9 are the sending engine. Sections 19.10 to 19.16 are new for Flowdm v4 and Unified Login. Sections 19.17 to 19.20 are for broadcasts (D68) and past comments (D69).

### 19.1 `app.instagram_messages` (split by week of the run start)

One row for every Instagram call that should go to her: a DM, a nudge, a broadcast message, a public reply, a hide, or a follow check. A text message with a picture is 2 rows (the picture first). It is the line of waiting messages and the record of what happened. The row holds no text. Rows are kept 30 days (`MESSAGE_KEEP_DAYS`, D50): "what happened" shows our messages of the last 30 days.

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `public_id` | VARCHAR(28) | no | — | Goes in the button payload with the run public id (D17). |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | Copy for the pick (no foreign key, see below). |
| `automation_id` | BIGINT | yes | — | Copy. Empty only for `broadcast`. |
| `automation_run_id` | BIGINT | yes | — | Empty only for `broadcast` (a broadcast has no run). |
| `broadcast_id` | BIGINT | yes | — | Set exactly for `broadcast` (D68). |
| `automation_run_started_at` | TIMESTAMPTZ | no | — | Partition key. Copy of the run's `started_at`; for `broadcast`, the `created_at` of its recipient row. |
| `contact_id` | BIGINT | no | — | Copy, for person checks. |
| `message_type` | VARCHAR(20) | no | — | `opening_message`, `nudge`, `public_reply`, `hide_comment`, `follow_check`, `follow_request`, `email_question`, `invalid_email`, `phone_question`, `message`, `broadcast` |
| `message_no` | SMALLINT | yes | — | 1 to 10 (`AUTOMATION_MESSAGES_MAX`) for `message` (D29); 1 to 3 (`BROADCAST_MESSAGES_MAX`) for `broadcast`. Set exactly for these 2 types. |
| `message_kind` | VARCHAR(15) | yes | — | `text`, `image`, `cards`, `quick_replies`, `audio`, `file`, `post`, set exactly for `message` and `broadcast`. The picture of a text message is its own row of kind `image` with the same `message_no`. |
| `version_no` | SMALLINT | yes | — | 1 to 3 (`MESSAGE_VERSIONS_MAX`), for `opening_message`, `nudge`, `follow_request`, `broadcast` (D30, D31, D68). |
| `wording_no` | SMALLINT | yes | — | 1 to 10 (`QUESTION_WORDINGS_MAX`), for `email_question`, `phone_question`. A new ask picks again (D31). |
| `lane` | VARCHAR(10) | no | — | `slow`, `reply`, `fast`, `broadcast` |
| `channel` | VARCHAR(15) | yes | — | `private_reply`, `direct`, `comment_reply`, `comment_hide`. Empty only for `follow_check` (a read, not a message). |
| `counts_as_dm` | BOOLEAN | no | — | True for every message into her chat: `opening_message`, `nudge`, `follow_request`, `email_question`, `invalid_email`, `phone_question`, `message`, `broadcast`. False for `public_reply`, `hide_comment`, `follow_check`. A check keeps it equal to that list. The send commit reads it for the month count (D34). |
| `status` | VARCHAR(10) | no | `waiting` | `waiting`, `sending`, `sent`, `unknown`, `failed`, `skipped`, `cancelled`, `expired` |
| `reason` | VARCHAR(30) | yes | — | Why `skipped`, `failed`, `cancelled`, `expired`, `unknown`, or `assumed_following` on a `sent` follow check (D12). |
| `not_before` | TIMESTAMPTZ | no | now | Earliest send time (random delay, try later, 24-hour rule, the wait before a message, the nudge hour). |
| `trigger_occurred_at` | TIMESTAMPTZ | no | — | Copy of the run's comment or message time. Newest first, oldest first, and the 7-day end. For `broadcast`: when its recipient row was made. |
| `tries` | SMALLINT | no | 0 | "Try later" tries used. |
| `asks` | SMALLINT | no | 0 | How often this question was asked (up to `ASK_AGAIN_MAX`). |
| `text_no` | SMALLINT | yes | — | Which reply text was picked. |
| `instagram_message_id` | VARCHAR(128) | yes | — | Instagram's id after `sent`. |
| `sending_at` | TIMESTAMPTZ | yes | — | Set in the gate 2 commit. |
| `sent_at` | TIMESTAMPTZ | yes | — | |
| `error_code`, `error_subcode` | INTEGER | yes | — | Last Instagram error. |
| `owner_retry_at` | TIMESTAMPTZ | yes | — | When the owner's "Retry failed messages" put this `failed` row back to `waiting` (D72). Set at most once (`RETRY_FAILED_MAX` 1): a row that has it is never retried again. |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | |

Checks:
1. Allowed lane and channel pairs: `slow` + `private_reply`; `reply` + `comment_reply`; `reply` + `comment_hide`; `fast` + `direct`; `fast` + `private_reply`; `fast` + empty (only `follow_check`); `broadcast` + `direct` (only `broadcast`, and `broadcast` only there).
2. `public_reply` has lane `reply` and channel `comment_reply`. `hide_comment` has lane `reply` and channel `comment_hide`.
3. Lane `slow` with channel `private_reply` is only for the FIRST message of a `comment` or `ad_comment` run whose chat window is closed, whatever its type (an automation may have no hello). Lane `fast` with channel `private_reply` is only for the first message of a `live_comment` run (D40). The intake and the lane move keep these two rules (the row does not know the trigger).
4. `message_no` and `message_kind` are set exactly when `message_type` is `message` or `broadcast`. `version_no` only on the 4 types above, `wording_no` only on the 2 types above.
5. `counts_as_dm` = (`message_type` is one of the 8 DM types).
8. `broadcast` rows: `broadcast_id` set, `automation_id` and `automation_run_id` empty. All other rows: the reverse.
6. `sent` has `sent_at`. `sending` has `sending_at`.
7. `reason` is one of the words in the table below (check in the migration).

**Moving a message between lanes:** when her window opens (slow to fast) or closes (fast to slow), the SAME row changes `lane` and `channel` in one "only if `status` = `waiting`" update. No row is closed and no new row is made. The worker locks the row it picked (`FOR UPDATE SKIP LOCKED`), and its update to `sending` also checks `lane` and `channel`, so a row that moved in between is never sent on the old lane. Review B10

**The message list** (D29, section 20.7): the row of message N+1 is made when N is `sent`, with `not_before` = sent time + its wait. Window closed at send time: only that message row is `skipped` (`window_closed`). No rows are made for the rest of the list, and the run ends `cancelled` with `cancel_reason` `window_closed`, in the same commit.

**All `reason` values (one place):**

| Reason | With status | Meaning |
|---|---|---|
| `opted_out` | `skipped` | She wrote a stop word (section 14). |
| `hour_limit` | `skipped` | "Reply like a person" ON: the public reply was older than the newest 500 waiting of its automation (`PUBLIC_REPLY_MAX_WAITING`, D32). |
| `duplicate` | `skipped` | This comment already has a public reply, or is already hidden. |
| `window_closed` | `skipped` | A direct message (a list message, a nudge, the first message of a tag start, any fast DM), but her 24-hour window closed (section 9). For a list message the run also ends (`cancel_reason` `window_closed`). A tag event that finds her window already closed starts no run, so it makes no row (section 27.9). |
| `deleted_comment` | `skipped` | The comment was deleted, hidden, or is on a Live: no public reply, no hide (section 33). |
| `person_error` | `skipped` | Instagram refused this person (section 33). |
| `wrong_permission` | `skipped` | Another app or a missing permission controls this chat (section 33). |
| `once_per_post` | `skipped` | She already got this automation for this once key (D13; every key of section 9, not only posts). |
| `broadcast_cancelled` | `cancelled` | The owner cancelled the broadcast before this message went (D68). |
| `recent_broadcast` | `skipped` | A broadcast message: she got another broadcast in the last 24 hours (`BROADCAST_MIN_GAP_HOURS`, D68). |
| `owner_chat` | `skipped` | A broadcast message in mode "when her chat opens": the owner typed to her by hand within `OWNER_CHAT_QUIET_HOURS`. While the broadcast is active, her next message after the quiet time puts it back to `waiting` (D68). |
| `plan_feature_off` | `cancelled` | After a move down, a broadcast that was scheduled or waiting for chats ends, and its waiting messages are cancelled (PRO is off). |
| `contact_excluded` | `skipped` | The owner paused automations for this person (`automations_off_at`, D71). |
| `plan_feature_off` | `skipped` | An email or phone question on a plan without PRO (after a move down): the step is off by the plan, so the run moves on to its next step (D57). |
| `automation_deleted` | `cancelled` | The automation was deleted. |
| `contact_deleted` | `cancelled` | The contact was erased. |
| `restore` | `cancelled` | Marked during a restore from backup, never sent (section 39). |
| `cancelled_by_owner` | `cancelled` | Owner chose "Pause + Cancel" (D28), or removed this step and saved the automation ("Save changes", section 15). |
| `answered` | `cancelled` | A nudge that is not needed: she tapped or wrote before it went (D30). |
| `expired` | `expired` | Opening DM passed 7 days minus the safety time (D9). |
| `reply_too_old` | `expired` | A public reply or a hide passed 7 days after the comment (D32, D33). |
| `live_ended` | `expired` | Live comment private reply: the Live ended first (D40). |
| `plan_limit` | `expired` | A DM that waited behind the month limit (its `slow`, `fast` or `broadcast` lane stopped `plan_limit`) and its 7 days ended first (D34, D62). The owner sees "not sent: month limit". A window that closes meanwhile still gives `skipped` (`window_closed`), and a Live that ends gives `expired` (`live_ended`). |
| `bad_text` | `failed` | Instagram refused the text (section 33). |
| `tries_used_up` | `failed` | "Try later" tries were used up (section 33). |
| `attachment_failed` | `failed` | The file could not be uploaded to Meta after `ATTACHMENT_UPLOAD_TRIES` (3) tries. Not counted in any limit (section 30). |
| `no_answer` | `unknown` | Timeout or no clear answer (D17). |
| `worker_lost` | `unknown` | The worker died during the send; the helper found the lease over (section 34). |
| `assumed_following` | `sent` | Follow check failed 2 times; she is treated as following (D12). |

Disconnect does not cancel messages. It follows meepzo-be's rule: waiting messages stay `waiting`, the lanes are stopped, and each message either expires by the 7-day rule or goes on if the same account reconnects (section 41). Plan stops work the same way (D34, D35).

| Key or index | Columns | Serves |
|---|---|---|
| Primary key | `(id, automation_run_started_at)` | Split table. |
| Unique `uq_instagram_messages_run_type` | `(organization_id, automation_run_id, message_type, message_no, message_kind, automation_run_started_at) NULLS NOT DISTINCT WHERE message_type <> 'broadcast'` | One row per run, type and list place. Asking again uses the same row (`asks` + 1). A real rule, because all messages of one run are in one part. `NULLS NOT DISTINCT` (Postgres 15+) makes the empty `message_no` of other types count as equal. Review A2 |
| Unique `uq_instagram_messages_public_id` | `(public_id, automation_run_started_at)` | Button payload lookup. |
| `idx_instagram_messages_slow_waiting` | `(instagram_account_id, automation_id, trigger_occurred_at) INCLUDE (not_before) WHERE status = 'waiting' AND lane = 'slow'` | Slow pick per live automation: newest first for "new", oldest first for "old" (the same index read both ways). Paused or stopped automations are left out before the limit. Review A3 |
| `idx_instagram_messages_reply_waiting` | `(instagram_account_id, automation_id, trigger_occurred_at DESC) INCLUDE (not_before) WHERE status = 'waiting' AND lane = 'reply' AND message_type = 'public_reply'` | Reply pick per automation: newest first when "Reply like a person" is ON; oldest first when OFF (read backwards). The 500 limit cuts from the old end. |
| `idx_instagram_messages_hide_waiting` | `(instagram_account_id, not_before) WHERE status = 'waiting' AND lane = 'reply' AND message_type = 'hide_comment'` | Hides go right after their reply or DM, oldest first (D33). |
| Unique `uq_instagram_messages_broadcast` | `(organization_id, broadcast_id, contact_id, message_no, message_kind, automation_run_started_at) NULLS NOT DISTINCT WHERE message_type = 'broadcast'` | One row per broadcast, person and message place. |
| `idx_instagram_messages_broadcast_waiting` | `(instagram_account_id, not_before) WHERE status = 'waiting' AND lane = 'broadcast'` | The broadcast lane pick, oldest first. |
| `idx_instagram_messages_fast_waiting` | `(instagram_account_id, not_before) WHERE status = 'waiting' AND lane = 'fast'` | The helper re-adds fast tickets after a stop, Resume, or the month limit's end. |
| `idx_instagram_messages_person_sent` | `(organization_id, contact_id, sending_at) WHERE lane IN ('fast', 'broadcast') AND sending_at IS NOT NULL AND message_type <> 'follow_check'` | Person limit (60 in the last 60 minutes, `PERSON_HOUR_LIMIT_DEFAULT`; follow checks do not count; broadcasts count, D68) and "one message at a time per person" (`status = 'sending'`). |
| `idx_instagram_messages_sending` | `(instagram_account_id, sending_at) WHERE status = 'sending'` | Helper: sends whose lease is over. Repair of the fast `sending_count`. |
| `idx_instagram_messages_run` | `(organization_id, automation_run_id, automation_run_started_at)` | The run's messages (tap steps, ask once, cancel the nudge, the next list message). Also the foreign key and the organization cascade. |
| `idx_instagram_messages_failed` | `(organization_id, automation_id, created_at) WHERE status = 'failed'` | "Retry failed messages" of an automation, last 30 days (D72). For a contact the job reads her runs, then their messages. |
| `idx_instagram_messages_instagram_message_id` | `(instagram_account_id, instagram_message_id) WHERE instagram_message_id IS NOT NULL` | "Message was sent" notice, tap proof. Plain index, not unique: the save checks first. |

Foreign keys:
- `organization_id` to `tenancy.organizations`, CASCADE.
- `(organization_id, automation_run_id, automation_run_started_at)` to `app.automation_runs (organization_id, id, started_at)`, CASCADE. A `broadcast` row has an empty run id, so this key is not checked for it (Postgres `MATCH SIMPLE`).
- Account, automation, broadcast and contact are copies. Their foreign keys are on the run. This keeps the hottest table at few indexes.

**Example: Riya's rows.** Riya comments "GUIDE" on post P of account A. Her window is closed. GUIDE has: hello ON (2 versions), email ON, message 1 = text with a picture, message 2 = PDF after 1 hour, public reply ON ("Reply like a person" OFF), hide ON.

| Row | `message_type` | `message_no`, `message_kind` | Version or wording | Lane, channel | `counts_as_dm` | Made when |
|---|---|---|---|---|---|---|
| 1 | `opening_message` | — | `version_no` 2 | `slow`, `private_reply` | true | Intake of her comment |
| 2 | `public_reply` | — | `text_no` 3 | `reply`, `comment_reply` | false | Row 1 `sent` |
| 3 | `hide_comment` | — | — | `reply`, `comment_hide` | false | Row 2 `sent` |
| 4 | `email_question` | — | `wording_no` 1 | `fast`, `direct` | true | Her tap |
| 5 | `message` | 1, `image` | — | `fast`, `direct` | true | Her email saved |
| 6 | `message` | 1, `text` | — | `fast`, `direct` | true | Row 5 `sent` |
| 7 | `message` | 2, `file` | — | `fast`, `direct` | true | Row 6 `sent`; `not_before` + 60 minutes |

Riya cost the workspace 5 DMs of its month count (rows 1, 4, 5, 6, 7).

### 19.2 `app.instagram_send_attempts` (split by day)

One row for every send call to Instagram (a message, a broadcast message, a reply, a hide, a follow check, a `mark_seen` call), also when one message is tried twice. Insert, then one update with the result. Calls that are not sends (attachment upload, starter questions, webhook subscribe, token check) are not stored here; their errors go to the log and to the team's watch numbers (section 40).

| Column | Type | Null | Note |
|---|---|---|---|
| `id` | BIGSERIAL | no | |
| `organization_id`, `instagram_account_id` | BIGINT | no | |
| `lane` | VARCHAR(10) | no | `slow`, `reply`, `fast`, `broadcast` |
| `message_id` | BIGINT | no | No foreign key. For `mark_seen`: the message that was just `sent`. |
| `automation_id` | BIGINT | yes | Copy. Empty for a broadcast. |
| `contact_id` | BIGINT | no | Copy. |
| `count_group` | VARCHAR(10) | no | `open`, `reply`, `fast`, `broadcast`, `none`. A follow check, a hide and a `mark_seen` call count as `none` (D33, D66). A Live private reply counts as `fast` (D40). `reply` is counted for the numbers only, with no limit (section 19.4). |
| `started_at` | TIMESTAMPTZ | no | Partition key. |
| `result_group` | VARCHAR(20) | yes | Empty while the call runs. Values are the error groups of section 33 plus `sent`; among them `account_not_shared` (the account left the business portfolio), `live_ended`, `attachment` and `hide_failed`. |
| `http_status` | SMALLINT | yes | |
| `error_code`, `error_subcode` | INTEGER | yes | |
| `duration_ms` | INTEGER | yes | |

| Key or index | Columns | Serves |
|---|---|---|
| Primary key | `(id, started_at)` | Split table. |
| `idx_instagram_send_attempts_account` | `(instagram_account_id, started_at DESC)` | "3 bad results in a row" on one account; the owner's last errors. |
| `idx_instagram_send_attempts_automation` | `(organization_id, automation_id, started_at DESC)` | "5 refused texts in a row" on one automation. Kept 8 days, so small automations reach 5 too. |
| `idx_instagram_send_attempts_started` | `(started_at) INCLUDE (result_group)` | The all-accounts 30% rule (`BAD_PERCENT` over `BAD_WINDOW_SECONDS`). |

Foreign key: only `organization_id` to `tenancy.organizations`, CASCADE. Gate 2 does not read this table (it reads minute counts).

### 19.3 `app.instagram_send_lanes` (not split)

One row per account per lane: `slow`, `reply`, `fast`, `broadcast`. About 4,000 rows at 1,000 accounts. The `broadcast` lane works like the slow lane: one at a time, a random second in each box, at least `OPENING_MIN_GAP_MS` between two, its own hour limit (`broadcast_hour_limit`, default 600), lowest priority (D68).

| Column | Type | Used by | Note |
|---|---|---|---|
| `id` | BIGSERIAL | all | |
| `organization_id`, `instagram_account_id` | BIGINT | all | |
| `lane` | VARCHAR(10) | all | `slow`, `reply`, `fast`, `broadcast` |
| `state` | VARCHAR(10) | all | `ready`, `working`, `sleeping`, `stopped`. The fast row uses only `ready` and `stopped`. |
| `next_run_at` | TIMESTAMPTZ | slow, reply, broadcast | When the lane's ticket wakes. |
| `wait_reason` | VARCHAR(20) | slow, reply, broadcast | `box`, `gap`, `hour_limit`, `day_limit`, `not_before`, `stop`, `test`. |
| `turn_no` | INTEGER | slow, reply, broadcast | Ticket number. A ticket with an old number is dropped. |
| `working_turn` | INTEGER | slow, reply, broadcast | The turn that holds the lane. Saved when the lane goes `working`. The result save checks this, not `turn_no`. Review A4 |
| `lease_until` | TIMESTAMPTZ | slow, reply, broadcast | `LEASE_SECONDS` after the start of a send. |
| `pick_count` | SMALLINT | slow | Place 1 to 5 in the 4 new : 1 old mix. |
| `box_start` | TIMESTAMPTZ | slow, broadcast | Start of the current random box. The reply boxes are per automation (section 19.13). |
| `last_sent_at` | TIMESTAMPTZ | slow, reply, broadcast | `OPENING_MIN_GAP_MS` (slow and broadcast). On the reply row: the time of the account's last "Reply like a person" ON reply, for the 20-second gap (`PUBLIC_REPLY_GAP_MIN_SECONDS`). OFF replies and hides do not set it. |
| `half_speed_until` | TIMESTAMPTZ | slow, reply, broadcast | Box 2 times bigger until then (`HALF_SPEED_FACTOR`). On the reply row it doubles every automation's box. |
| `day_date`, `day_count` | DATE, INTEGER | slow | Only if the day limit is ON. |
| `paused_at` | TIMESTAMPTZ | all | Owner pause. |
| `suspended_at` | TIMESTAMPTZ | all | Team suspend, and a workspace with status `SUSPENDED` (D35). The owner's Resume does not clear it. Review C6 |
| `stop_reason`, `stop_until`, `stop_count`, `stop_error_code`, `stop_error_subcode`, `stop_cleared_at` | various | all | A stop. `stop_until` empty = the owner must act. `stop_reason` adds `plan_limit`, `plan_ended` and `plan_downgrade`. `plan_limit` (`stop_until` = the 1st of next month, 00:00 in the workspace's time zone) is set only on the `slow`, `fast` and `broadcast` lanes of every account of the workspace (a broadcast message is a new DM): the `reply` lane keeps sending public replies and hides of DMs that already went (D62, D68). `plan_ended` (`stop_until` empty) is set on all 4 lanes of every account. `plan_downgrade` (`stop_until` empty) is set on all 4 lanes of each account the owner did not keep after a move down; webhooks are still saved and the 7-day rule applies; moving up clears it (D57). Plan stops end without a test (D34, D35). Account stops stop the `broadcast` lane too, and a "too fast" error stops it 2 times longer than the other lanes (`BROADCAST_STOP_FACTOR` 2, D68). |
| `testing_lane`, `testing_until` | VARCHAR(10), TIMESTAMPTZ | slow row only | The account's one test claim. One UPDATE "set where empty or over". Review B9 |
| `sending_count` | SMALLINT | fast row only | Fast messages on their way now, up to `FAST_MAX_PARALLEL_PER_ACCOUNT`. Repaired by the helper. |
| `updated_at` | TIMESTAMPTZ | all | |

| Rule | Detail |
|---|---|
| Unique | `(organization_id, instagram_account_id, lane)` |
| Foreign key | `(organization_id, instagram_account_id)` to `app.instagram_accounts`, CASCADE |
| Storage | `fillfactor = 50`, so updates stay in place (cheap). Own autovacuum values in the migration: vacuum after about 1,000 changed rows, no cost delay. Review B19 |
| No index on `next_run_at` | Every update would have to touch it. The helper reads the 4,000 rows directly. Review B19 |
| Made when | The 4 rows of an account are made at connect (D25). An account connected while its workspace is at the month limit gets its `slow`, `fast` and `broadcast` rows already stopped `plan_limit`. |
| Lock order | The `broadcast` row sits with the other lane rows: own lane row, then the others (slow, reply, fast, broadcast) (section 35). |

### 19.4 `app.instagram_send_minute_counts` (not split)

Gate 2 (section 31). One row per account, group and minute.

| Column | Type | Note |
|---|---|---|
| `organization_id`, `instagram_account_id` | BIGINT | |
| `count_group` | VARCHAR(10) | `open`, `reply`, `fast`, `broadcast`. Gate 2 checks a limit only for `open`, `fast` and `broadcast`. `reply` is counted for the numbers only: the per-automation box holds the reply limit (D32, section 19.13). |
| `minute_start` | TIMESTAMPTZ | `date_trunc('minute', now())`, Postgres clock |
| `count` | INTEGER | at least 0 |

Primary key `(instagram_account_id, count_group, minute_start)`. Index `(minute_start)` for the helper's delete of rows older than `MINUTE_COUNT_KEEP_HOURS` (2).

**How gate 2 reads it:**

```text
  minute rows of account A, group "fast"
  10:01 10:02 10:03 ... 11:00 11:01 (now = 11:01:40)
  |<------------- last 61 rows ------------->|
  sum(count) + 1 <= limit ?   yes -> +1 on 11:01, message "sending", commit
                              no  -> nothing written, ticket waits
```

1. Sum the rows from `date_trunc('minute', now()) - 60 minutes` to now: 61 rows at most.
2. 61 rows cover 60 to 61 minutes. So the count is stricter by up to 1 minute. It is never over the limit.
3. In the same commit: `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` on the current minute. The same commit also checks and adds 1 to the month count when `counts_as_dm` is true (section 19.15).
4. Result "never connected" (surely not sent): `count - 1` on the minute of its `sending_at`.
5. "When is a place free": walk the rows from the oldest. The first row whose drop makes room gives the time: its `minute_start` + 61 minutes.
6. This works the same for 60, 600 or 10,000 per hour: always at most 61 small rows.

A public reply still gets +1 in group `reply`, but no sum is checked for it. A hide has no minute count and no limit (D33).

### 19.5 `app.instagram_webhook_event_keys` (16 hash parts)

| Column | Type | Note |
|---|---|---|
| `organization_id`, `instagram_account_id` | BIGINT | |
| `event_key` | VARCHAR(512) | Same key as on the event. |
| `received_at` | TIMESTAMPTZ | |

Primary key `(instagram_account_id, event_key)`. Split by `HASH (instagram_account_id)` into 16 parts. The key includes the split column, so the rule is real. Index `(received_at)` on each part for the delete of keys older than `EVENT_KEY_KEEP_DAYS` (8), in small pieces. Foreign key `(organization_id, instagram_account_id)` to `app.instagram_accounts`, CASCADE.

Use: the webhook inserts the key with `ON CONFLICT DO NOTHING`. 0 rows inserted = the same event came twice: nothing more is saved.

### 19.6 `app.automation_run_open_keys` (not split)

"One open run per automation, person and once key" (D13).

| Column | Type | Note |
|---|---|---|
| `organization_id` | BIGINT | |
| `automation_id`, `contact_id` | BIGINT | |
| `post_key` | VARCHAR(255) | Same as `automation_runs.post_key`. With "every time" on (`once_per_person_per_post` OFF) it is the fixed key `every_time`, so one automation has at most one open run per person (D65). |
| `automation_run_id` | BIGINT | |
| `automation_run_started_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

Primary key `(organization_id, automation_id, contact_id, post_key)`. Foreign keys: automation (RESTRICT), contact (RESTRICT), run `(organization_id, automation_run_id, automation_run_started_at)` (CASCADE). Index on the run columns and on `(organization_id, contact_id)` (the contact's open runs).

The key is added when a run opens and deleted when it ends, in the same commit. Only open runs have a row, so the table stays small.

### 19.7 `app.instagram_send_stops` (not split)

| Column | Type | Note |
|---|---|---|
| `id` | BIGSERIAL | |
| `organization_id`, `instagram_account_id` | BIGINT | |
| `lane` | VARCHAR(10) | `slow`, `reply`, `fast`, `broadcast`, `all` |
| `reason` | VARCHAR(20) | A stop group of section 33, or `plan_limit`, `plan_ended`, `plan_downgrade` (D34, D35, D57) |
| `error_code`, `error_subcode` | INTEGER | |
| `started_at`, `stop_until`, `ended_at` | TIMESTAMPTZ | |
| `ended_by` | VARCHAR(10) | `time`, `test`, `owner`, `team`. A new month ends `plan_limit` by `time`; an upgrade, a payment or moving up ends a plan stop by `owner`. |

Index `(organization_id, instagram_account_id, started_at DESC)`. Kept `STOP_HISTORY_KEEP_DAYS` (90), deleted by the helper in small pieces.

### 19.8 `app.sending_state` (one row, no organization)

| Column | Type | Note |
|---|---|---|
| `id` | SMALLINT | always 1 (check) |
| `environment_id` | VARCHAR(64) | Must equal env `SENDING_ENVIRONMENT_ID`, else workers and helper do not start. D20 |
| `settings_version`, `settings_version_since` | VARCHAR(64), TIMESTAMPTZ | Newest version that started. D21 |
| `all_stop_until`, `all_stop_reason`, `all_stop_count` | | Stop for all accounts (app limit, Instagram down). |
| `testing_lane`, `testing_until` | | The one test for all accounts after a stop for all. |
| `updated_at` | TIMESTAMPTZ | |

### 19.9 `app.sending_helper_slots` (16 rows, no organization)

| Column | Type | Note |
|---|---|---|
| `slot` | SMALLINT | 0 to 15 (`HELPER_SLOTS` = 16). Rows are made at start. |
| `server_id` | VARCHAR(128) | null = free |
| `lease_until` | TIMESTAMPTZ | `HELPER_SLOT_LEASE_SECONDS`, renewed every `HELPER_SLOT_RENEW_SECONDS`. |

Each account belongs to one slot: `instagram_account_id % HELPER_SLOTS`. A server takes at most its fair share of slots (section 34).

### 19.10 `app.meta_connections` (not split)

One Meta login of a workspace: one workspace and one client business portfolio (D25, D27). It is the only token path (D24): every account hangs off one connection row.

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `public_id` | VARCHAR(28) | no | — | Unique. For the connections screen and routes. |
| `organization_id` | BIGINT | no | — | |
| `client_business_id` | VARCHAR(64) | no | — | From `GET /me?fields=client_business_id`. Digits. |
| `config_id` | VARCHAR(64) | no | — | The login configuration used (not secret). A second configuration for Facebook Pages can come later (D27). |
| `login_type` | VARCHAR(20) | no | `unified` | `unified` only now. Room for the Facebook Pages login later (D27, D47). |
| `status` | VARCHAR(10) | no | `connected` | `connected`, `error`, `revoked` (section 20.6). |
| `status_changed_at` | TIMESTAMPTZ | no | now | |
| `scopes` | TEXT[] | no | empty | The permissions Meta granted. At most 20. |
| `connected_by_user_id` | BIGINT | yes | — | Foreign key to `auth.users`, SET NULL. |
| `connected_at` | TIMESTAMPTZ | no | now | |
| `last_checked_at` | TIMESTAMPTZ | yes | — | Last daily token check (`TOKEN_CHECK_EVERY_HOURS` 24). |
| `last_check_error` | VARCHAR(500) | yes | — | Meta's error code, subcode and HTTP status from the last failed check. Never Meta's text. |
| `disconnected_at` | TIMESTAMPTZ | yes | — | Set exactly when `revoked`. |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | |

| Key or index | Columns | Serves |
|---|---|---|
| Unique `idx_meta_connections_public_id` | `(public_id)` | Routes. |
| Unique `idx_meta_connections_organization_id_id` | `(organization_id, id)` | Parent key of accounts and tokens. |
| Unique `idx_meta_connections_organization_business` | `(organization_id, client_business_id)` | One row per workspace and business. A reconnect reuses it, `revoked` included. |
| `idx_meta_connections_check_due` | `(last_checked_at) WHERE status = 'connected'` | The daily token check across organizations (maintenance arm). |
| `idx_meta_connections_connected_by_user_id` | `(connected_by_user_id) WHERE connected_by_user_id IS NOT NULL` | The user key. |

Checks: `status` and `login_type` values; `client_business_id` digits; `(status = 'revoked') = (disconnected_at IS NOT NULL)`; `cardinality(scopes) <= 20`; `updated_at >= created_at`.

- **Who writes it:** the connect flow (section 25); the daily token check (`error` on a token error); the owner's Disconnect and Meta's deauthorize (`revoked`, section 41).
- **Who reads it:** the sender (account -> connection -> token, right before the call), the daily check, the connect's plan check (D26), the owner's connections screen.
- **How long rows stay:** until the workspace is deleted. No soft delete: `revoked` stands in, like accounts.

The connect's plan check runs under a lock of the workspace's `app.meta_connections` rows (D26). Two first connects of one workspace at the same second have no row to lock yet, so the connect first takes `pg_advisory_xact_lock` on the organization id (section 35).

### 19.11 `app.meta_connection_tokens` (not split)

The system user token of one connection (Unified Login). One token covers all accounts of the connection (D25). This is the only token table: `app.instagram_account_tokens` is dropped (section 18.2).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `organization_id` | BIGINT | no | — | |
| `meta_connection_id` | BIGINT | no | — | |
| `encrypted_access_token` | TEXT | no | — | `encryptFieldSecret` ciphertext only. Not empty. |
| `token_type` | VARCHAR(20) | no | `system_user` | `system_user`. |
| `expires_at` | TIMESTAMPTZ | yes | — | Empty = never ends (Meta's default for this token). |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | |

Keys: unique `(organization_id, meta_connection_id)` (one token per connection, and the composite key's index). Foreign key `(organization_id, meta_connection_id)` to `app.meta_connections (organization_id, id)`, CASCADE.

- **Who writes it:** the connect flow (code exchange on the server only) and a reconnect. Deleted only when the connection is `revoked`: a disconnect of one account keeps the token while another account still uses that connection.
- **Who reads it:** only the token repository: the sender right before a call, the connect steps, and the daily check inside that organization's own transaction. Never in Redis, never in a log, never in a job (section 41).
- **How long rows stay:** while the connection is `connected` or `error`. Deleted on `revoked`.
- **Row security:** organization arm only. No maintenance arm, so no sweep reads a token (section 22).

### 19.12 `app.automation_counts` (not split)

All-time counters of one automation, in 16 slot rows (`AUTOMATION_COUNT_SLOTS`) so a viral automation's commits do not wait for each other (D36). "% tapped" = (`taps` + `typed_answers`) / `runs_started` (D61).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `organization_id` | BIGINT | no | — | |
| `automation_id` | BIGINT | no | — | |
| `slot` | SMALLINT | no | — | 0 to 15. Slot = `automation_run_id % AUTOMATION_COUNT_SLOTS` (the run that started, got the tap or got the typed answer). |
| `runs_started` | BIGINT | no | 0 | At least 0. |
| `taps` | BIGINT | no | 0 | Button taps on the hello ("next step" buttons). At least 0. |
| `typed_answers` | BIGINT | no | 0 | Typed answers to the hello: her first text while the run waits for `opening_message_button`. At least 0. |
| `runs_by_version` | JSONB | no | `{}` | Runs started per version, a flat object: `{"hello.1": 650, "hello.2": 650, "follow.1": 120}`. |
| `taps_by_version` | JSONB | no | `{}` | Button taps per version, same keys: `{"hello.1": 300, "hello.2": 260, "follow.1": 80}`. |
| `typed_by_version` | JSONB | no | `{}` | Typed answers per version: `{"hello.1": 60, "hello.2": 43}`. With the two above it gives "% tapped" per version. |
| `updated_at` | TIMESTAMPTZ | no | now | |

Primary key `(organization_id, automation_id, slot)`. Foreign key `(organization_id, automation_id)` to `app.automations`, CASCADE (rows leave with the automation's purge).

- **Who writes it:** the run-start commit (`runs_started` + 1, and + 1 on `runs_by_version` for each step version the run picked), the tap commit (`taps` + 1 for a hello tap, and + 1 on `taps_by_version` `hello.<v>` or `follow.<v>`), and the intake commit of a typed answer to the hello (`typed_answers` + 1, `typed_by_version` `hello.<v>` + 1). Always `INSERT ... ON CONFLICT DO UPDATE`, in the same commit as the event, last in the lock order (section 35).
- **Who reads it:** the automation list and the editor: the sum of the 16 rows (at most 400 small rows for a page of 25).
- **How long rows stay:** as long as the automation. They survive the 90-day run delete. A duplicate starts at 0.

Example: GUIDE has 1,300 runs started, 560 button taps and 103 typed answers: (560 + 103) / 1,300 = "1.3k runs · 51% tapped". Version 1: 650 runs, 300 taps + 60 typed = 360 (55%). Version 2: 650 runs, 260 taps + 43 typed = 303 (47%).

### 19.13 `app.automation_reply_state` (not split)

The public reply state of one automation (D32).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `organization_id` | BIGINT | no | — | |
| `automation_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | Copy. The reply pick reads the account's rows. |
| `box_start` | TIMESTAMPTZ | yes | — | Start of this automation's current random box ("Reply like a person" ON). Box = 3600 / `public_reply_hour_limit` seconds, 2 times bigger under half speed. |
| `last_text_no` | SMALLINT | yes | — | The last reply text used. The next one is never the same (when there are 2 or more). |
| `waiting_count` | INTEGER | no | 0 | Waiting `public_reply` rows of this automation. At least 0. The 500 cap (ON) reads it. The pick skips automations at 0. |
| `updated_at` | TIMESTAMPTZ | no | now | |

Primary key `(organization_id, automation_id)`. Index `(organization_id, instagram_account_id)`. Foreign key `(organization_id, automation_id)` to `app.automations`, CASCADE.

- **Who writes it:** the result save that makes a public reply row (`waiting_count` + 1); the reply worker (`box_start`, `last_text_no`, `waiting_count` - 1); the helper (expired or skipped replies - 1, and a repair from a real count, section 34).
- **Who reads it:** the reply lane pick (section 29).
- **How long rows stay:** made on the automation's first public reply; they leave with the automation.

The gap between two "Reply like a person" ON replies of one account (20 seconds) stays on the reply lane row (`last_sent_at`), because it is per account. OFF replies do not count for it.

### 19.14 `app.meta_attachments` (not split)

The Meta attachment id of one uploaded file, per account (D29).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | |
| `upload_id` | BIGINT | no | — | meepzo-be's upload (`upload.uploads.id`). |
| `attachment_id` | VARCHAR(128) | no | — | Meta's id from the attachment API. |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | |

Keys: unique `(instagram_account_id, upload_id)`. Index `(organization_id, instagram_account_id)` for the foreign key. Foreign keys: `(organization_id, instagram_account_id)` to `app.instagram_accounts`, CASCADE; `upload_id` to `upload.uploads (id)`, CASCADE.

- **Who writes it:** the upload task (queue `instagram-tasks`, section 24). No row: it uploads the file to Meta (no transaction open during the call), up to `ATTACHMENT_UPLOAD_TRIES` (3) tries, then inserts (`ON CONFLICT DO NOTHING`). All tries failed: the message is `failed` (`attachment_failed`), not counted. An attachment error on a send (`CODES_ATTACHMENT_GONE`): the row is deleted and the file uploaded again (D29).
- **Who reads it:** the fast worker, before it sends an image, card picture, voice note or PDF.
- **How long rows stay:** as long as the account and the upload. Does a Meta attachment id ever stop working? Test needed (section 43).

### 19.15 `app.dm_month_counts` (not split)

DMs sent this calendar month by one workspace (D34). 16 slot rows per workspace and month (`DM_MONTH_COUNT_SLOTS`).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `organization_id` | BIGINT | no | — | |
| `month_start` | DATE | no | — | The 1st of the month in the workspace's time zone. Check: day = 1. |
| `slot` | SMALLINT | no | — | 0 to 15. Slot = `instagram_account_id % DM_MONTH_COUNT_SLOTS`. |
| `count` | INTEGER | no | 0 | At least 0. |
| `updated_at` | TIMESTAMPTZ | no | now | |

Primary key `(organization_id, month_start, slot)`. Foreign key `organization_id` to `tenancy.organizations`, CASCADE.

**Why the slot is the account:** sends of one account already wait for each other on their lane row (gate 2). Sends of different accounts of one workspace then never touch the same row. So the 16 slots remove waiting between accounts, and a workspace has at most as many rows a month as it has accounts.

**The send commit** (the third check, D18, D34), for a message with `counts_as_dm` (broadcast messages too, D68):

```text
  sum(count) of the workspace's rows for this month_start
        |
        |-- sum + 1 <= dm_month_limit (billing plan row) ?
        |      yes -> +1 on its own slot (INSERT ... ON CONFLICT DO UPDATE),
        |             message "sending", commit
        |      no  -> nothing written; after the commit: stop plan_limit
        |             on the slow, fast and broadcast lanes of every account
        v
  after the commit: Redis cnt:month:{organization} + 1;
  80% (DM_MONTH_NOTICE_PERCENT) or 100% passed: notice + email,
  once each a month (dedupe key)
```

1. Commits at the same moment do not see each other's +1. So the month may go over by a few DMs (estimate: at most the number of sends in flight). Fine for a plan limit (D34).
2. Result "never connected" (surely not sent): `count - 1` on the slot of the month of its `sending_at`.
3. A new month needs no reset: its rows do not exist yet, so the sum is 0. The lanes' `stop_until` (the 1st, 00:00, section 19.3) has passed, so the helper adds one `month-wake` job, which ends the stops and wakes the lanes (section 34, rule 24).

- **Who writes it:** the send commit (+ 1) and the "never connected" result save (- 1). The retention job deletes old months.
- **Who reads it:** the send commit, the billing screen ("8,100 of 10,000 DMs used, resets 1 Dec"), the 80% and 100% notices.
- **How long rows stay:** 13 months (`DM_MONTH_KEEP_MONTHS`), then deleted by the retention job (section 21.3).

Example: workspace W (Creator, 10,000 a month, time zone Asia/Kolkata) has account A (id 17, slot 1) and account B (id 34, slot 2). On 20 November: slot 1 = 6,200, slot 2 = 1,900. Sum 8,100 = 81%: the 80% notice and email go once. At 10,000 the 100% notice and email go once, and the `slow`, `fast` and `broadcast` lanes of A and B stop `plan_limit`. Public replies and hides of DMs that already went keep going on the `reply` lanes (D62). On 1 December at 00:00 India time, the sum starts again at 0.


### 19.16 `app.contact_tag_events` (not split)

One row for every tag added to or removed from a contact. Tag starts read it (D45, table "ways to start" rows 14 and 15). It is written in the same commit as the tag change, so a tag event is never lost, even if Redis or a job is lost.

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | The `<event id>` of the once keys `tag:<tag>:<event id>`, `untag:<tag>:<event id>`. |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | Copy of the contact's account, for the intake job of that account. |
| `contact_id` | BIGINT | no | — | |
| `tag` | VARCHAR(50) | no | — | 1 to 50 characters. |
| `kind` | VARCHAR(10) | no | — | `added`, `removed`. |
| `source` | VARCHAR(10) | no | — | `automation` (a tag step), `owner` (the owner, alone or in bulk). |
| `source_automation_id` | BIGINT | yes | — | Set exactly when `source` = `automation`. An automation never starts itself by its own tag (D45). |
| `chain_no` | SMALLINT | no | 0 | How many tag starts led to this change (0 = owner or a run that did not start from a tag). Intake starts nothing at `TAG_CHAIN_MAX` (3) or more (section 27). |
| `created_at` | TIMESTAMPTZ | no | now | |
| `queued_at` | TIMESTAMPTZ | yes | — | When its intake job was added. |
| `done_at` | TIMESTAMPTZ | yes | — | When intake finished it. |

| Key or index | Columns | Serves |
|---|---|---|
| Primary key | `(id)` | |
| `idx_contact_tag_events_not_queued` | `(created_at) WHERE queued_at IS NULL` | The helper adds jobs for rows not queued, like late webhook events (section 34). |
| `idx_contact_tag_events_open` | `(instagram_account_id, created_at) WHERE queued_at IS NOT NULL AND done_at IS NULL` | Intake reads the account's open rows, oldest first. |
| `idx_contact_tag_events_contact` | `(organization_id, contact_id)` | The foreign key and the contact erase. |
| `idx_contact_tag_events_created` | `(created_at)` | The 8-day delete. |

Foreign keys: `organization_id` to `tenancy.organizations`, CASCADE; `(organization_id, contact_id)` to `app.contacts`, RESTRICT (a contact is erased in place); `(organization_id, instagram_account_id)` to `app.instagram_accounts`, CASCADE; `(organization_id, source_automation_id)` to `app.automations`, ON DELETE SET NULL (`source_automation_id`).

- **Who writes it:** the commit that changes `app.contacts.tags`: an automation's tag step, the owner's tag edit, one piece of a bulk change (500 contacts, `TAG_BULK_PIECE`). One row per contact and changed tag. After the commit the intake job is added and `queued_at` is set. Intake sets `done_at`.
- **Who reads it:** intake (section 27), and the helper for rows not queued after `EVENT_LATE_SECONDS` (60).
- **How long rows stay:** 8 days (`TAG_EVENT_KEEP_DAYS`), then deleted by the retention job in small pieces.
- **Row security:** organization arm + maintenance arm (the helper and the retention job read across organizations).

### 19.17 `app.segments` (not split)

A saved audience of one Instagram account: conditions in AND / OR groups (D68). Used again by many broadcasts.

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `public_id` | VARCHAR(28) | no | — | Unique. |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | A segment belongs to one account. |
| `name` | VARCHAR(255) | no | — | 1 to 255 after trim. |
| `conditions` | JSONB | no | — | A JSON object, validated by zod (`segmentConditionsSchema`): at most 2 levels (`SEGMENT_GROUP_LEVELS_MAX`), at most `SEGMENT_CONDITIONS_MAX` (20) conditions. |
| `created_by_user_id`, `updated_by_user_id` | BIGINT | yes | — | Foreign keys to `auth.users`, SET NULL. |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | |

Example of `conditions` ("has the tag guide, and commented in the last 7 days or replied to a story in the last 3 days"):

```json
{ "op": "and", "items": [
  { "field": "tags", "match": "any", "values": ["guide"] },
  { "op": "or", "items": [
    { "field": "commented", "post": "any", "days": 7 },
    { "field": "story_activity", "days": 3 } ] } ] }
```

Condition fields (D68): `tags` (any, all, none); `automation` (started, finished, in the middle, never, tapped the hello, got message N; runs of the last 90 days); `came_in` (first automation, ref code, starter question, ad id, story mention, first message); `commented` (post or any post, last N days, keyword, at least N comments); `active` (last message in the last N hours or days, first seen in the last N days); `details` (email, phone, neither, follows the account); `story_activity` (last N days); `no_broadcast` (no broadcast in the last N days). Opted-out, paused (`automations_off_at`) and deleted contacts, and anyone who got a broadcast in the last `BROADCAST_MIN_GAP_HOURS` (24), are always left out.

Keys: unique `(public_id)`; unique `(organization_id, id)` (parent key); index `(organization_id, instagram_account_id, name)` (the list). Foreign key `(organization_id, instagram_account_id)` to `app.instagram_accounts`, CASCADE.

- **Who writes it:** people with `automation:create` or `automation:update` (Owner, Admin, Editor; routes, section 15). `automation:read` (also Viewer) only reads. No new permission codes.
- **Who reads it:** the broadcast editor ("1,240 match. 310 can get it now"), the `segment-count` job, and a broadcast when it starts.
- **How long rows stay:** until the owner deletes the segment. A broadcast keeps its own copy of the conditions, so deleting a segment never changes a broadcast.

### 19.18 `app.broadcasts` (not split)

One message set sent to the people of one segment (D68, PRO).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `public_id` | VARCHAR(28) | no | — | Unique. Goes in the button payload of its messages. |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | |
| `name` | VARCHAR(255) | no | — | 1 to 255 after trim. The owner's label in the list. |
| `status` | VARCHAR(20) | no | `draft` | `draft`, `scheduled`, `sending`, `waiting_for_chats`, `done`, `cancelled` (section 20.9). |
| `mode` | VARCHAR(20) | no | `now` | `now`, `scheduled`, `when_chat_opens`. |
| `segment_id` | BIGINT | yes | — | The saved segment used, or empty for a one-off audience. |
| `conditions` | JSONB | yes | — | The one-off conditions, and always the copy of the conditions taken when the broadcast starts. Same shape as `app.segments.conditions`. |
| `messages` | JSONB | no | `[]` | 1 to 3 messages (`BROADCAST_MESSAGES_MAX`), the same shape and kinds as `steps.messages` (section 18.5), with versions A/B and `{name}`. A button may "start automation X" for her. At most 64 KB (`AUTOMATION_STEPS_MAX_BYTES`). |
| `scheduled_at` | TIMESTAMPTZ | yes | — | Set exactly for `mode` = `scheduled`. |
| `ends_at` | TIMESTAMPTZ | yes | — | Set exactly for `when_chat_opens`: 1 to 7 days after the start (`BROADCAST_OPEN_WAIT_DAYS_MAX`). |
| `started_at`, `finished_at`, `cancelled_at` | TIMESTAMPTZ | yes | — | |
| `cancel_reason` | VARCHAR(30) | yes | — | Set exactly when `cancelled`: `owner` (the owner cancelled it), `plan_feature_off` (after a move down, a scheduled or "when her chat opens" broadcast ends; drafts and saved segments stay). |
| `matched`, `sent`, `skipped`, `failed`, `replies`, `taps` | INTEGER | no | 0 | At least 0. `replies` counts once per recipient (her first reply sets `replied_at`). Counted in the same commit as each recipient's result, her reply or her tap. At most 2,000 sends an hour per account, so one row is enough (no slots). |
| `created_by_user_id`, `updated_by_user_id` | BIGINT | yes | — | Foreign keys to `auth.users`, SET NULL. |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | |

Checks: `status` and `mode` values; `(mode = 'scheduled') = (scheduled_at IS NOT NULL)` when not `draft`; `(mode = 'when_chat_opens') = (ends_at IS NOT NULL)` when not `draft`; out of `draft`, `conditions` is set; `messages` is a JSON array of 1 to 3 when not `draft`; counters at least 0. PRO without a PRO plan: the send is refused (an API check, D35).

| Key or index | Columns | Serves |
|---|---|---|
| Unique `idx_broadcasts_public_id` | `(public_id)` | Routes, button payloads. |
| Unique `idx_broadcasts_organization_id_id` | `(organization_id, id)` | Parent key of recipients and messages. |
| `idx_broadcasts_account_created` | `(organization_id, instagram_account_id, created_at DESC)` | The list. |
| `idx_broadcasts_due` | `(scheduled_at) WHERE status = 'scheduled'` | The helper starts due broadcasts, across organizations (section 34). |
| `idx_broadcasts_waiting_for_chats` | `(organization_id, instagram_account_id) WHERE status = 'waiting_for_chats'` | Intake: she wrote, does a "when her chat opens" broadcast match her? (section 27). |
| `idx_broadcasts_open_end` | `(ends_at) WHERE status = 'waiting_for_chats'` | The helper ends them at `ends_at`. |

Foreign keys: `(organization_id, instagram_account_id)` to `app.instagram_accounts`, CASCADE; `(organization_id, segment_id)` to `app.segments`, ON DELETE SET NULL (`segment_id`).

- **Who writes it:** people with `automation:create` or `automation:update` (draft, schedule, send, cancel; each send and cancel goes to `audit.logs`); the broadcast start job (`sending` or `waiting_for_chats`, `matched`); the broadcast lane and intake (counters, `done`); the helper (due starts, `ends_at`).
- **Who reads it:** the list and the editor, intake, the broadcast lane.
- **How long rows stay:** until the owner deletes it or the workspace is deleted. Its recipients stay 90 days.

### 19.19 `app.broadcast_recipients` (split by month of `created_at`)

One row per person and broadcast: who it went to, and what happened (D68).

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | Copy. |
| `broadcast_id` | BIGINT | no | — | |
| `contact_id` | BIGINT | no | — | |
| `status` | VARCHAR(10) | no | `waiting` | `waiting`, `sent`, `skipped`, `failed`, `unknown` (section 20.10). The result of its first message. |
| `reason` | VARCHAR(30) | yes | — | `recent_broadcast` (a broadcast in the last 24 hours, `BROADCAST_MIN_GAP_HOURS`), `owner_chat` (the owner typed to her within `OWNER_CHAT_QUIET_HOURS`; it does not use up the broadcast for her: while it is active, her next message after the quiet time puts this row and its message back to `waiting`), `window_closed`, `opted_out`, `contact_excluded` (`automations_off_at` is set), `broadcast_cancelled`, `plan_feature_off`, `contact_deleted`, or a message reason of section 19.1 (`person_error`, `wrong_permission`, `bad_text`, `tries_used_up`, `attachment_failed`, `no_answer`, `worker_lost`). |
| `version_no` | SMALLINT | yes | — | The version picked for her. |
| `created_at` | TIMESTAMPTZ | no | now | Partition key. |
| `sent_at` | TIMESTAMPTZ | yes | — | |
| `replied_at` | TIMESTAMPTZ | yes | — | Her first message after the broadcast went. Set once, in that intake commit; the broadcast's `replies` + 1 in the same commit, so a reply counts once per recipient. |
| `updated_at` | TIMESTAMPTZ | no | now | |

Keys: primary key `(id, created_at)`. "Once per person per broadcast" cannot be a unique rule across month parts, so it is checked under the contact lock in the last 2 months of parts (a broadcast lives at most 7 days). A row `skipped` (`owner_chat`) does not count: it is put back to `waiting` instead of making a new row. Indexes: `(organization_id, broadcast_id, status)` (counts and the recipient list); `(organization_id, contact_id)` (the foreign key and the contact erase). Foreign keys: `(organization_id, broadcast_id)` to `app.broadcasts`, CASCADE; `(organization_id, contact_id)` to `app.contacts`, RESTRICT (erased in place). No foreign key points into this table.

- **Who writes it:** the broadcast start job (one row per matching contact with an open chat, made in pieces of `BROADCAST_AUDIENCE_PIECE` 500); intake for "when her chat opens" (one row when she writes, after any run for her has finished, not within `OWNER_CHAT_QUIET_HOURS` of the owner typing to her); the broadcast lane (the result).
- **Who reads it:** the broadcast's recipient list, the "once per person" check.
- **How long rows stay:** 90 days (`BROADCAST_RECIPIENT_KEEP_DAYS`), by dropping the month part (section 21).

### 19.20 `app.automation_backfills` (not split)

"Also answer comments from the last N days" for one automation (D69, PRO). One running backfill per automation.

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | BIGSERIAL | no | — | |
| `public_id` | VARCHAR(28) | no | — | Unique. |
| `organization_id` | BIGINT | no | — | |
| `instagram_account_id` | BIGINT | no | — | Copy. The job runs one at a time per account. |
| `automation_id` | BIGINT | no | — | A `comment` or `ad_comment` automation that is live (never `live_comment`). |
| `days` | SMALLINT | no | — | 1 to 7 (`PAST_COMMENTS_MAX_DAYS`). |
| `status` | VARCHAR(10) | no | `queued` | `queued`, `reading`, `done`, `failed` (section 20.11). |
| `posts_read` | INTEGER | no | 0 | Posts read so far (at most `PAST_COMMENTS_POSTS_MAX` 50 for "any post"). |
| `found`, `matched`, `queued_count` | INTEGER | no | 0 | Comments found, comments that match, opening DMs queued. At least 0. |
| `fail_reason` | VARCHAR(30) | yes | — | Set exactly when `failed`: `meta_error` (retries used up), `plan_feature_off` (a move down switched PRO off; DMs it already queued still go). |
| `last_error` | VARCHAR(500) | yes | — | Meta's error code, subcode and HTTP status. Never Meta's text. |
| `requested_by_user_id` | BIGINT | yes | — | Foreign key to `auth.users`, SET NULL. |
| `created_at` | TIMESTAMPTZ | no | now | |
| `started_at`, `done_at` | TIMESTAMPTZ | yes | — | |
| `updated_at` | TIMESTAMPTZ | no | now | |

Keys: unique `(public_id)`; unique `(organization_id, automation_id) WHERE status IN ('queued', 'reading')` (one running backfill per automation); index `(status, updated_at) WHERE status IN ('queued', 'reading')` (the helper's watch across organizations: no progress for `BACKFILL_STUCK_MINUTES` 30 means stuck). Foreign key `(organization_id, automation_id)` to `app.automations`, CASCADE.

- **Who writes it:** the owner's button (`queued`); the `past-comments` job in `instagram-tasks` (`reading`, the counters, `done` or `failed`; retries `META_TASK_RETRY_MINUTES`). Each found comment goes into the normal intake as an "old" comment (section 27).
- **Who reads it:** the owner's screen ("Found 340 comments. 290 match. About 250 will go, about 40 may expire"), the helper's watch.
- **How long rows stay:** with the automation (a few rows each).

---

## 20. Statuses and state pictures

### 20.1 Message (`app.instagram_messages.status`)

```text
             made by intake, by a result save, or after message N-1 went
                                   |
                                   v
  +------------------------------ waiting -----------------------------+
  |             |                |                  |                  |
  | gate 2 and  | its end passed | owner Cancel,    | stop word,       |
  | month count | (7 days, Live  | nudge not needed | window closed,   |
  | passed      |  ended, month  | (she answered)   | comment deleted, |
  |             |  limit)        |                  | person paused    |
  v             |                v                  v                  |
sending         v            cancelled           skipped               |
  |          expired                                                   |
  |                                                                    |
  |   her window opened or closed: the SAME row changes lane and       |
  |   channel, stays waiting (only if waiting) ------------------------'
  |
  |-- Instagram OK ------------------------------------> sent
  |-- "try later", tries left ---------> waiting (not_before later)
  |-- never connected (counts - 1) ----> waiting
  |-- account stop error --------------> waiting (lane stopped)
  |-- refused text, tries used up -----> failed
  |-- person problem ------------------> skipped
  |-- "Live ended" --------------------> expired (live_ended)
  |-- no answer, worker lost ----------> unknown
  '-- follow check failed 2 times -----> sent (reason assumed_following)

unknown --- her tap on THIS message's button, or our "sent" notice ---> sent
unknown --- her next message or tap sends this step once more,
            or a late clear "not sent" ---> waiting
sent (a question) --- wrong answer, asks < ASK_AGAIN_MAX ---> waiting (asks + 1)
failed --- owner "Retry failed messages", still allowed now, owner_retry_at
           empty ---> waiting (owner_retry_at = now; a new failure stays failed)
```

Notes:
1. A message never goes from `sending` back to `waiting` because of a limit. The hour limit and the month count are checked in the same commit (gate 2 and the third check).
2. `unknown` is never sent again by itself (D17). Only her next message or tap, or a late clear "not sent", moves it back to `waiting`.
3. A lane move (slow to fast when her window opens, fast to slow when it closes) is one "only if `waiting`" update of the same row: `lane` and `channel` change, nothing else.
4. "Counts - 1" means the minute count and, for a DM, the month count.

### 20.2 Run (`app.automation_runs.status`)

```text
  a way to start (section 4): comment, Live comment, story, DM, starter
  question, link, ad, tag, ...
          |
          v
       running ---- hello with a button, follow request,
          |         email or phone question went -----------------> waiting
          |                                                           |
          |<----- her tap, her answer, any message from her ----------'
          |
          |---- message N went, N+1 waits its time: stays running
          |---- last message of the list sent ---------------------> completed
          |---- window closed before a list message -------------> cancelled
          |---- refused text, tries used up -----------------------> failed
          '---- automation deleted, contact erased ----------------> cancelled

  waiting --- 7 days of waiting (wait_expired) --------------> cancelled
  waiting --- automation deleted, contact erased ------------> cancelled
  running or waiting --- opening DM passed 7 days, or Live ended (expired) -> cancelled
  running or waiting --- she wrote a stop word (opted_out) --> cancelled
  running or waiting --- owner paused her (contact_excluded) -> cancelled
  a message of the run is unknown ---> waiting (waiting_for = any)
  account disconnected, plan stop ---> nothing changes; the run waits (7-day rule)
```

`cancel_reason`: `automation_deleted`, `wait_expired`, `contact_deleted`, `expired`, `opted_out`, `contact_excluded`, `window_closed` (that list message is `skipped`, no rows are made for the rest).

`waiting_for`: `opening_message_button`, `follow`, `email`, `phone`, `any`.

A run waits up to 23 hours for its next list message as `running`: the wait is a delayed ticket, not a `waiting` run, so the 7-day wait worker does not touch it.

### 20.3 Webhook event (`app.instagram_webhook_events.status`)

```text
  saved by the webhook
        |
        v
    received --- intake job added ---> queued
        |                                |
        |  (helper: received over        |--- intake: done ----------> processed
        |   1 minute -> job added again) |--- intake: nothing to do -> skipped
        |                                '--- intake: error, last try -> failed
        |                                                                  |
        '<---- helper: next_attempt_at due, comment under 7 days ---------'
```

Tag events are not webhook events. They live in `app.contact_tag_events` (section 19.16): `queued_at` and `done_at` play the part of `queued` and `processed`, and the helper re-adds rows not queued.

### 20.4 Lane (`app.instagram_send_lanes.state`)

```text
  slow, reply and broadcast lanes:

   ready ---- ticket taken, gate 2 passed ----> working
     ^                                            |
     |<--- result saved, next send is now ---------|
     |                                            v
     |<--- ticket wakes ------------------- sleeping (next ticket delayed)
     |
  stopped <--- error stop, or plan stop (from any state)
     |
     |---- error stop: time over + test OK, or owner fixed it ---> ready
     '---- plan stop: 1st of the month, upgrade, payment, or
           moving up, or made active (plan_downgrade) -----------> ready (no test)

  fast lane row: only ready <-> stopped (many messages at once, no turn)
  paused_at and suspended_at are flags on top of the state.
```

| Stop | Set on | Ends when | Test after? |
|---|---|---|---|
| Error stop (section 33) | One lane, or all lanes of one account (a login error, code 190: every lane of every account of that Meta connection) | Its time, or the owner fixes it (login stops: only a reconnect, never a test) | Yes, except login stops |
| `plan_limit` (D34, D62) | The `slow`, `fast` and `broadcast` lanes of every account of the workspace (the `reply` lane keeps going) | The 1st of next month in the workspace's time zone, or an upgrade | No |
| `plan_ended` (D35) | Every lane of every account of the workspace | The plan is active again (paid, or Free at once; accounts over Free's limit then get `plan_downgrade`, section 46.3) | No |
| `plan_downgrade` (D57) | Every lane of each account not kept after a move down, or of an account the owner stopped with "choose active accounts" | Moving up again, or the owner makes this account active in place of another ("choose active accounts") | No |
| Workspace `SUSPENDED` (D35) | `suspended_at` on every lane of the workspace | The team lifts it | No |

### 20.5 Automation (`app.automations.status`)

```text
  New automation (only a name)            Duplicate of any automation
          |                                          |
          v                                          v
        draft <--------------------------------- new draft "(copy)"
          |
          |-- Go live: full check, PRO check, plan not ended
          v
        live <---- Go live again (full check) ------+
          |                                          |
          |-- owner pauses: Keep or Cancel --------> paused

  live --- 5 refused texts in a row, or its post deleted ---> live + stopped_reason
  live + stopped_reason --- owner fixes it ---> live (stopped_reason cleared)
  move down ends: never a stop; PRO parts the plan lacks are ignored (D57)
  draft, live or paused --- Delete ---> deleted_at set (soft delete, purged later)
```

1. A draft never sends and never starts a run.
2. Pause + Keep: people in the middle finish. Pause + Cancel: `cancelled_before_at` = now, their waiting messages become `cancelled` (`cancelled_by_owner`) (D28).
3. Going live sets the account's starter questions again (`starter_questions_set_at` emptied, D42), and for `next` sets `target_starts_at` the first time.
4. The plan ending does not change `status`. Its lanes stop `plan_ended`, and "Go live" is refused (D35).
5. A move down never stops an automation and never changes its `status`. At the period end the PRO parts the new plan lacks are switched off by the plan: the engine reads the plan's features at run time and ignores them, and the settings stay saved. After a move up they work again by themselves (D57). Only Instagram accounts can be stopped by a move down: lane stop `plan_downgrade` on the accounts not kept (section 20.4).

### 20.6 Meta connection (`app.meta_connections.status`)

```text
  owner logs in, code exchange OK ---------------------> connected
  connected --- daily check or a call: token rejected --> error ("Reconnect" banner)
  error --- owner logs in again (same business) -------> connected (same row)
  connected or error --- owner disconnects,
                         or Meta deauthorize ----------> revoked (token deleted)
  revoked --- owner connects the same business again --> connected (same row)
```

| Connection | Its accounts' `connection_status` | Sending |
|---|---|---|
| `connected` | `connected` (unless one account was disconnected alone: `revoked`; or one account is no longer shared with the app: `error`, section 25.9) | Goes |
| `error` | `error`, in the same transaction | Waits; lanes stopped (login stop); comments are still saved |
| `revoked` | `revoked` | Nothing is saved; waiting messages stay and expire by the 7-day rule |

### 20.7 Message list and nudge

```text
  message list (D29)

  step before it done (her tap or answer)
        |
        v
  message 1: waiting, not_before = now + its wait
        |-- window open at send time ---> sent
        |-- window closed --------------> skipped (window_closed); no rows for the
        |                                  rest; run cancelled (window_closed)
        v
  message 1 sent ---> message 2 made: not_before = sent_at + its wait
  message N unknown ---> N+1 made only after her next message
  last message sent ---> run completed, tags added (D45)
```

```text
  nudge (D30): only when she messaged first and the hello has nudge ON

  hello sent
        |
        v
  nudge: waiting, fast lane, not_before = hello sent_at + 60 min (NUDGE_AFTER_MINUTES)
        |-- her tap or any message first ---> cancelled (answered)
        |-- time reached, window open ------> sending -> sent (same version as the hello)
        '-- time reached, window closed ----> skipped (window_closed)
```

### 20.8 Who changes each status

| Who | Message | Run | Event | Lane |
|---|---|---|---|---|
| Webhook (section 26) | — | — | makes `received`; `queued` when it adds the intake job | — |
| Intake (section 27) | makes `waiting`; moves a row between lanes (same row); `skipped` (`opted_out`); `unknown` to `sent` (tap, notice); `unknown` to `waiting` (her next message or tap); nudge `cancelled` (`answered`) | starts, moves `waiting` to `running`; `cancelled` (`opted_out`) | `processed`, `skipped`, `failed` | wakes a lane |
| Slow and reply workers (28, 29) | `waiting` to `sending` to a result; `expired`; `skipped` (`opted_out`, `once_per_post`, `deleted_comment`); `cancelled` (`cancelled_by_owner`, `automation_deleted`); moves a row between lanes (same row) | `waiting`, `cancelled` (expired) | — | `working`, `sleeping`, `ready`, `stopped`; the slow worker sets `plan_limit` on the slow and fast lanes of the workspace |
| Fast worker (30) | `waiting` to `sending` to a result; makes the next list message; `skipped` (`window_closed`, `opted_out`); `cancelled` (`answered`, `cancelled_by_owner`, `automation_deleted`); `expired` (`live_ended`); `failed` (`attachment_failed`); moves a row to the slow lane (same row) | `waiting`, `running`, `completed`, `failed`, `cancelled` (`window_closed`) | — | fast row `stopped`; `plan_limit` on the slow and fast lanes of the workspace |
| Helper (34) | `sending` to `unknown` (lease over); `cancelled` (`cancelled_by_owner`, Pause + Cancel); `expired` (also `plan_limit`, `live_ended`); `skipped` (`window_closed`); reply over 500 to `skipped` (`hour_limit`) | `cancelled` (`expired`, `window_closed`) | `received` again, `failed` retried | repairs lanes, adds tickets, ends plan stops at their time |
| meepzo-be's hourly wait worker | — | `cancelled` (`wait_expired`, 7 days of waiting) | — | — |
| Owner (15) | `cancelled` (Pause + Cancel) | — | — | `paused_at`, Resume, limits; "choose active accounts" sets or clears `plan_downgrade` on two accounts |
| Billing (46) | — | — | — | ends `plan_limit` on upgrade; sets and ends `plan_ended`; at the period end of a move down sets `plan_downgrade` on accounts not kept, and clears it on moving up |
| Team (15) | — | — | — | `suspended_at` |
| Broadcast lane worker (30) | `broadcast` rows `waiting` to `sending` to a result; `skipped` (`window_closed`, `opted_out`); makes the next broadcast message | — | — | broadcast row `working`, `sleeping`, `ready`, `stopped`; `plan_limit` on the slow, fast and broadcast lanes |
| Partition worker (21) | drops old parts | drops old parts | drops old parts | — |

| Who | Automation | Meta connection and account |
|---|---|---|
| Owner (15) | `draft` to `live`, `live` to `paused`, `paused` to `live`, delete, duplicate | connect, reconnect (`connected`), disconnect (`revoked`) |
| Slow and fast workers (33) | `stopped_reason` set (`bad_text`) | `error` on a login error |
| Helper (34) | `stopped_reason` set (`post_deleted`) | — |
| Billing (46) | Never a status or a `stopped_reason`: a move down only makes the engine ignore the PRO parts the plan lacks | — |
| Daily token check (25) | — | `error` |
| Meta callbacks (41) | — | `revoked` |

### 20.9 Broadcast (`app.broadcasts.status`)

```text
  owner saves --------------------------------------> draft
  draft --- "Send now" -----------------------------> sending
  draft --- "Send at a time" -----------------------> scheduled
  draft --- "Deliver when her chat opens" ----------> waiting_for_chats
  scheduled --- scheduled_at reached (helper) ------> sending
  sending --- every recipient has a result ---------> done
  waiting_for_chats --- ends_at reached (helper) ---> done
  draft, scheduled, sending, waiting_for_chats --- owner cancels ---> cancelled
  scheduled, waiting_for_chats --- move down, PRO off ---> cancelled (plan_feature_off)
```

1. When it leaves `draft`, the broadcast takes its copy of the conditions and counts `matched`. "Send now" and "scheduled" make recipient rows only for people whose chat is open at that moment (her last message + 24 hours - 15 minutes).
2. `waiting_for_chats`: a matching contact gets her recipient row when she writes, once per broadcast. A row `skipped` (`owner_chat`) goes back to `waiting` at her next message after the quiet time, while the broadcast is active.
3. Cancel: waiting recipients become `skipped` (`broadcast_cancelled`), and their waiting messages `cancelled` (`broadcast_cancelled`). Messages already sent stay `sent`. After a move down the same happens with `plan_feature_off` (`cancel_reason` `plan_feature_off`); drafts and saved segments stay.
4. Each send and each cancel is written to `audit.logs`.

### 20.10 Broadcast recipient (`app.broadcast_recipients.status`)

```text
  made by the start job or by intake --------------> waiting
  waiting --- first message sent -------------------> sent
  waiting --- her chat closed at send time ---------> skipped (window_closed)
  waiting --- a broadcast in the last 24 hours -----> skipped (recent_broadcast)
  waiting --- the owner typed to her lately --------> skipped (owner_chat)
  skipped (owner_chat) --- her next message after the quiet time,
                          broadcast still active ---> waiting (same row)
  waiting --- stop word, paused, erased ------------> skipped (opted_out,
                                         contact_excluded, contact_deleted)
  waiting --- cancel, or move down -----------------> skipped (broadcast_cancelled,
                                         plan_feature_off)
  waiting --- Instagram refused, tries used up -----> failed
  waiting --- no clear answer ----------------------> unknown
```

Her later broadcast messages (2 and 3) follow the message list rules (section 20.7), with the same window check before each one.

### 20.11 Past-comments backfill (`app.automation_backfills.status`)

```text
  owner presses "Also answer comments from the last N days" ---> queued
  queued --- the past-comments job takes it -------------------> reading
  reading --- all posts read back to N days ------------------> done
  reading --- Meta error, retries used up --------------------> failed (meta_error)
  queued or reading --- move down, PRO off -------------------> failed (plan_feature_off)
  failed --- owner presses the button again ------------------> a new row, queued
```

While `reading`, each found comment goes into intake as an "old" comment. `found`, `matched` and `queued_count` grow as it reads. DMs already queued still go after a `plan_feature_off` stop.

---

## 21. Partitions and how long rows stay

### 21.1 The rule (meepzo-be's own guide)

Split a table only when:
1. it will have over 10 million rows, and
2. it is read and cleaned by time.

Do not split small tables, or tables with many updates for a long time, or tables with no time in their questions.

### 21.2 Split tables

All row numbers are estimates for a busy day: 1,000 accounts, 30% of them at full speed for some hours.

| Table | Split by | Rows per day | Rows per part | Keep | Old rows go by |
|---|---|---|---|---|---|
| `app.instagram_webhook_events` | day of `created_at` | about 3 million | about 3 million | 8 days (`WEBHOOK_EVENT_KEEP_DAYS`) | drop the day part |
| `app.instagram_webhook_event_keys` | 16 hash parts by `instagram_account_id` | about 3 million | about 1.5 million | 8 days (`EVENT_KEY_KEEP_DAYS`) | delete in small pieces by `received_at` |
| `app.instagram_send_attempts` | day of `started_at` | about 4 million | about 4 million | 8 days (`SEND_ATTEMPT_KEEP_DAYS`) | drop the day part |
| `app.instagram_messages` | week of `automation_run_started_at` | 4 to 8 million | 30 to 55 million | 30 days (`MESSAGE_KEEP_DAYS`, D50) | drop the week part after 30 days |
| `app.automation_runs` | month of `started_at` | 1 to 2 million | 30 to 60 million | 90 days after the run ends (`RUN_KEEP_DAYS`) | drop the month part |
| `app.automation_run_events` | month of `automation_run_started_at` | 3 to 10 million | 100 to 300 million | with its runs | drop the month part |
| `app.automation_comment_logs` | month of `created_at` | 1 to 2 million | 30 to 60 million | 90 days (`COMMENT_LOG_KEEP_DAYS`) | drop the month part |
| `app.broadcast_recipients` | month of `created_at` | up to 300,000 | up to 9 million | 90 days (`BROADCAST_RECIPIENT_KEEP_DAYS`) | drop the month part |

Why these sizes:
1. Events and attempts are big but short-lived: one part per day, 8 parts live.
2. Messages are the biggest hot table: one part per week keeps each part's indexes small. The message list (up to 10 messages, a picture is one more row) makes more rows per run, so the estimate is higher. A message changes only while its run is open (about 2 weeks at most), so only the newest 2 to 3 parts get updates. With 30 days kept, about 5 week parts are live.
3. Runs, run history and comment logs change only in the first 7 days too. Month parts are enough.
4. Broadcast recipients are read by broadcast and cleaned by time. A broadcast lives at most 7 days, so only the newest 1 or 2 parts get updates. Estimate: 1,000 accounts, each sending to about 300 people a day on a busy day.

### 21.3 Not split

| Table | Rows (estimate) | Why not split | Keep |
|---|---|---|---|
| `app.instagram_accounts`, `app.instagram_account_settings` | 1,000 to 10,000 | Small. | Until the workspace is deleted |
| `app.meta_connections`, `app.meta_connection_tokens` | about 1,000 | Small. One per workspace and business. | Connections until the workspace is deleted; tokens until disconnect |
| `app.instagram_media` | hundreds of thousands | Small, read by post. | Until the workspace is deleted or Meta's data deletion |
| `app.automations` | thousands to tens of thousands | Small. | Soft delete, purged later by meepzo-be's purge |
| `app.automation_counts` | automations x 16, under 500,000 | Small rows, read by automation, never by time. | With the automation |
| `app.automation_reply_state` | one per automation with public replies | Small. | With the automation |
| `app.meta_attachments` | accounts x files, tens of thousands | Small, read by account and file. | With the account and the upload |
| `app.dm_month_counts` | workspaces x accounts x 13 months, under 200,000 | Small. A month is a few rows, so a part per month would be tiny. | 13 months (`DM_MONTH_KEEP_MONTHS`), deleted by the retention job |
| `app.contact_tag_events` | up to about 1 million (8 days, bulk tags included, estimate) | Under 10 million, short-lived. | 8 days (`TAG_EVENT_KEEP_DAYS`), deleted by the retention job |
| `app.contacts` | tens of millions over a year | One row per person, read by person, not by time. Erase is in place. | No clean-up by age: until the owner deletes the contact, Meta asks to delete the data, or the workspace is deleted (D51) |
| `app.instagram_send_lanes` | 4,000 to 40,000 | Small, very many updates. | With the account |
| `app.segments` | a few per account | Small. | Until the owner deletes it |
| `app.broadcasts` | a few hundred per account a year (estimate) | Small, read by account. | Until the owner deletes it |
| `app.automation_backfills` | a few per automation | Small. | With the automation |
| `app.instagram_send_minute_counts` | under 400,000 | Rows live 2 hours. | 2 hours (`MINUTE_COUNT_KEEP_HOURS`) |
| `app.automation_run_open_keys` | only open runs | Small. | While the run is open |
| `app.instagram_send_stops` | small | | 90 days (`STOP_HISTORY_KEEP_DAYS`) |
| `app.sending_state`, `app.sending_helper_slots` | 1 and 16 | | Always |

The retention job (family `retention`, maintenance role) deletes, once a day and in small pieces, the `app.dm_month_counts` rows whose `month_start` is older than 13 months and the `app.contact_tag_events` rows older than 8 days.

### 21.4 What splitting changes

1. **Keys include the time column.** The primary key becomes `(id, <time column>)`. Every unique rule must hold the time column too.
2. **Copies of the run start time.** Run events, comment logs, messages and open keys keep `automation_run_started_at`, so their foreign keys can point to `(organization_id, id, started_at)` of the run.
3. **"One open run" needs its own table.** A unique rule cannot cover many month parts. `app.automation_run_open_keys` holds it (section 19.6).
4. **Comment logs, "one log per comment and automation":** checked in the last 2 months of parts, while the contact row is locked (section 35). A comment is handled within hours, so 2 months is always enough.
5. **Messages, "one per run, type and list place":** a real unique rule, because a run's messages are all in the part of its start week. A message list waits at most 10 x 23 hours, and a question at most 7 days, so all of them still belong to the run's week part.
6. **No foreign key into split tables that drop often** (`app.instagram_messages`, `app.instagram_send_attempts`).
7. **Row security on every part:** each new part gets ENABLE and FORCE, with the same policy as its parent (section 22).
8. **Drop order:** comment logs first, then messages, then run events with their runs. A runs part is dropped only when it has no open run (no row in `app.automation_run_open_keys` points to it). A messages part (30 days, long before its runs at 90 days) is dropped only when it has no `waiting` or `sending` row. If one is found, the worker skips that part and emails the team.
9. **Lookups by `public_id`** search the index of each live part (about 4 to 13 parts). This is fast enough for screens and button taps.
10. **Counters are not in split tables.** `app.automation_counts` keeps "runs" and "taps" after the run parts are dropped (D36).
11. **Broadcast recipients, "once per person per broadcast":** checked in the last 2 months of parts while the contact row is locked (a broadcast lives at most 7 days). A row `skipped` (`owner_chat`) does not count: it goes back to `waiting`. A recipients part is dropped only when it has no `waiting` row; else the worker skips it and emails the team.

### 21.5 The partition worker

A new meepzo-be worker `instagram-partition-maintenance` (family `retention`, like meepzo-be's other clean-up workers). Review B20.

```text
  every day at a quiet hour, and once at server start
        |
        v
  make parts ahead:  day parts  3 days   (PARTITION_DAYS_AHEAD)
                     week parts 2 weeks  (PARTITION_WEEKS_AHEAD)
                     month parts 2 months (PARTITION_MONTHS_AHEAD)
        |
        v
  check: tomorrow's part exists for every split table?
        |-- no  -> make it now, email the team
        v
  drop parts older than their keep time (order of 21.4 point 8)
        |   uses the direct Neon link (not the pooler),
        |   SET LOCAL lock_timeout = PARTITION_LOCK_TIMEOUT_MS,
        |   on a lock timeout: try again later (PARTITION_DROP_RETRIES)
        v
  each split table also has a DEFAULT part: a row with no matching part
  still saves. A row in a default part = team email.
```

---

## 22. Row security, roles and the organization context

### 22.1 meepzo-be's pattern

Every `app` table with `organization_id` has row security ENABLE + FORCE and one policy `<table>_tenant_isolation`, for all commands:

| Part of the policy | What it allows |
|---|---|
| Organization arm (USING and WITH CHECK) | Rows whose `organization_id` is the organization of `app.current_organization_public_id`. |
| Maintenance arm (USING only) | When `app.global_retention_cleanup = 'true'` and the role is `meepzo_be_maintenance`: read and delete across organizations. Never insert or update across organizations. |

`app.meta_connection_tokens` has the organization arm only. No maintenance job reads a token.

All new tables with `organization_id` get the same policy. Split tables get it on the parent and ENABLE + FORCE on every part (section 21.4).

| New table | Organization arm | Maintenance arm | Why the maintenance arm (or not) |
|---|---|---|---|
| `app.instagram_messages`, `app.instagram_send_attempts`, `app.instagram_send_lanes`, `app.instagram_send_minute_counts`, `app.instagram_webhook_event_keys`, `app.automation_run_open_keys`, `app.instagram_send_stops` | Yes | Yes | The helper and the retention jobs read across organizations (section 22.3). |
| `app.meta_connections` | Yes | Yes | The daily token check finds due connections across organizations. |
| `app.meta_connection_tokens` | Yes | **No** | No sweep ever reads a token. The daily check reads it inside that organization's own transaction. |
| `app.automation_counts` | Yes | Yes | The automation purge deletes them across organizations. |
| `app.automation_reply_state` | Yes | Yes | The helper's repair of `waiting_count` finds rows across organizations. |
| `app.meta_attachments` | Yes | Yes | Purge with the account or the upload. |
| `app.contact_tag_events` | Yes | Yes | The helper finds rows not queued across organizations; the retention job deletes rows older than 8 days. |
| `app.dm_month_counts` | Yes | Yes, read and delete only for the 13-month delete | See the decision below. |
| `app.segments` | Yes | Yes | Purge with the account. Writes need `automation:create` or `automation:update`, reads `automation:read` (the role check is in the API). |
| `app.broadcasts` | Yes | Yes | The helper starts due broadcasts and ends `waiting_for_chats` ones across organizations. |
| `app.broadcast_recipients` | Yes, on the parent and every part | Yes | The partition worker drops old parts. |
| `app.automation_backfills` | Yes | Yes | The helper watches running backfills across organizations. |

**Decision: the month reset needs no maintenance read of `app.dm_month_counts`.** A new month has no rows, so its sum is 0 by itself. The lanes stopped `plan_limit` carry their `stop_until` (the 1st, 00:00 in the workspace's time zone). The helper already reads lane rows across organizations, and adds a `month-wake` job when that time has passed (section 34, rule 24). So the maintenance arm on `app.dm_month_counts` is used only by the retention job that deletes months older than 13. Every write (+1, -1) and every read for a limit happens in the workspace's own transaction.

### 22.2 How a worker sets the organization

1. Every job carries the organization public id (like the existing `instagram-webhook` job). This includes the new jobs: tag events, starter questions, connect steps, month notices, attachment uploads, `segment-count`, broadcast start and sends, `past-comments`.
2. Each transaction starts with `set_config('app.current_organization_public_id', <id>, true)`. The `true` means "this transaction only" (`SET LOCAL`). This works with the Neon pooler (section 37).
3. In the same first statement: `SET LOCAL statement_timeout` and `lock_timeout` (section 35).
4. One transaction never mixes two organizations. A plan stop of a workspace touches only that workspace's lanes, so it is one transaction.

### 22.3 Jobs that need the maintenance role

| Job | Why across organizations |
|---|---|
| Helper (section 34) | Finds late lanes, sends with lease over, due events, tag events not queued, missed-comment posts, expired messages, plan stops whose time is over, accounts whose starter questions must be sent again, due scheduled broadcasts, `waiting_for_chats` broadcasts past `ends_at`, stuck backfills, for all accounts in its slots. It reads across organizations, then does each change in that organization's own transaction. |
| Daily token check (section 25) | Finds connections due for a check (`idx_meta_connections_check_due`). Reads each token, calls Meta and saves the result inside that organization's own transaction. |
| Partition worker (section 21.5) | Makes and drops parts. Runs as the migration-level role on the direct link. |
| Retention (event keys, minute counts, stops, tag events older than 8 days, month counts older than 13 months) | Deletes old rows in small pieces. |
| meepzo-be's automation purge | Deletes soft-deleted automations later, with their counts and reply state. |
| meepzo-be's existing 7-day wait worker | Already uses this pattern. |

### 22.4 System tables (no organization)

`app.sending_state` and `app.sending_helper_slots` follow meepzo-be's "system tables" pattern (like `auth.mail_outbox`):

1. Row security ENABLE + FORCE.
2. A deny-all policy for everyone: `USING (false) WITH CHECK (false)`.
3. An access policy only for `meepzo_be_app` and `meepzo_be_maintenance`.
4. No owner route reads them. Owners see only their own stop and banner data.

### 22.5 Resolvers ("which organization" before it is known)

meepzo-be answers "which organization" with `SECURITY DEFINER` functions that return organization public ids only, pin `search_path`, and are run only by the two runtime roles.

| Resolver | Used by | Change |
|---|---|---|
| `app.resolve_organization_public_id_for_instagram_user` | Webhook routing (section 26), connect's "connected elsewhere" check | Keep. It looks up `instagram_user_id`, the id from `assigned_instagram_accounts`, which is the same id the webhooks send (Meta's docs). |
| `app.resolve_organization_public_ids_for_instagram_app_user` | Meta's deauthorize and data deletion callbacks | Removed with the `instagram_app_user_id` column (an Instagram Login id). |
| Trial check (billing's, section 46) | Starting a trial | "Did this `instagram_user_id` already have a trial in any workspace?" Returns yes or no only. |
| New resolver for Meta's callbacks | Meta's deauthorize and data deletion callbacks | By the id these callbacks carry with Unified Login (client business id or user id, test needed, section 43). Returns public ids only. |

### 22.6 Product tables (Part F)

Tables outside `app` follow their own domain's rules, and change only with new migrations (D48):

1. Rows of a user (for example `auth.trusted_devices`, user columns) use meepzo-be's user arm (`app.current_user_public_id`), like `auth.sessions`, with the retention arm for old rows.
2. Rows of a workspace (for example the referral tables) use the organization arm, like `billing.subscriptions`.
3. `billing.plans` is reference data, like today.
4. Sections 44 to 48 name each table and its policy.

---

## 23. Redis keys

### 23.1 Two Redis servers

| Redis | Settings | Holds | If its data is lost |
|---|---|---|---|
| **Ticket Redis** | `maxmemory-policy noeviction`, AOF on, one replica | BullMQ queues and tickets, gate 1 counts, notes, save-result jobs, webhook buffer, login state | Helper adds all due tickets again (section 34). Counts are rebuilt from Postgres after a commit, never inside a Postgres transaction, under a short Redis rebuild lock (section 31). A lost login state: the owner presses Connect again. |
| **Copy Redis** | meepzo-be's cache Redis, may throw old keys out | Copies of settings, automations, banners, Meta usage, month count, tag list | Everything still works, only slower. |

Both need a password, TLS and a private network (section 41).

### 23.2 All keys

| Key | What | Lives | Redis | Rebuilt how |
|---|---|---|---|---|
| `cnt:open:{account}` | Gate 1: opening DM tries of the last 60 minutes (sorted set, score = Postgres time) | 2 hours without use (`COUNT_KEY_HOURS`) | Ticket | From `app.instagram_send_minute_counts`, after a commit (never inside a Postgres transaction), under a short Redis rebuild lock, first use after a loss (section 31) |
| `cnt:fast:{account}` | Gate 1: fast messages (Live private replies too) | same | Ticket | same |
| `cnt:broadcast:{account}` | Gate 1: broadcast messages of the `broadcast` lane (D68) | same | Ticket | same (group `broadcast`) |
| `cnt:ready:{account}` | "The counts are rebuilt and right" | same as counts | Ticket | Set after a rebuild |
| `cnt:month:{organization}` | A small hash: `month` (the `month_start`) and `count` (the workspace's DMs this month). For the banner ("8,100 of 10,000") and an early filter before the transaction. The send commit in Postgres decides (D34). | `COPY_SECONDS` (60) | Copy | The sum of the workspace's `app.dm_month_counts` rows (16 at most). After each DM commit: `count` + 1 only if the key exists and its `month` is the current one (a missing key is never started at 1). |
| `seen:{account}:{event_key}` | "This event was saved" (fast path before Postgres) | `SEEN_NOTE_MINUTES` (10) | Ticket | Not needed: the key table decides |
| `mid:{account}:{instagram_message_id}` | Our own sent message, to drop its notice | `SENT_NOTE_MINUTES` (10) | Ticket | Not needed |
| `inbound:{account}:{contact}` | Her events in this minute (flood guard, `INBOUND_PERSON_PER_MINUTE`) | 1 minute | Ticket | Not needed |
| `seenmark:{account}:{contact}` | The id of her inbound message that already got a `mark_seen` call, so it goes at most once per her message (D66) | 24 hours | Ticket | Not needed: if lost, at most one extra `mark_seen` |
| `connect:{state}` | Login state of one connect: organization and user public ids, and the connection public id after the code exchange. **Never the token** (the token is saved in Postgres right after the exchange). | `CONNECT_STATE_MINUTES` (10) | Ticket | Not rebuilt: the owner starts again |
| `save-result` jobs | A result that could not be saved in Postgres; retried every `SAVE_RESULT_RETRY_SECONDS` | until saved | Ticket | — |
| `webhook-buffer` list | Raw events kept while Postgres is down | until moved to Postgres | Ticket | — |
| `acct:{account}` | Copy of the account settings and limits, its workspace's `dm_month_limit`, plan state (`plan_access.state`: `active`, `grace` or `read_only`), the plan's `pro_features` (the engine skips PRO parts the plan lacks, D57) and whether the workspace is `SUSPENDED`. **Never the token.** | `COPY_SECONDS` (60) | Copy | Read Postgres again |
| `auto:{account}` | Copy of the live automations' start fields: trigger, also start from, targeting, keywords, ref code, starter questions, ad id, trigger tag, live or stopped; and the account's `waiting_for_chats` broadcasts (id, `ends_at`), so intake knows at once if a "when her chat opens" broadcast may match her. Not `steps` (read from Postgres at run start). | `COPY_SECONDS` (60) | Copy | Read Postgres again |
| `tags:{account}` | Tag list with contact counts (D45) | `TAG_LIST_CACHE_SECONDS` (60) | Copy | Run the query again |
| `banner:{account}` | Numbers for the owner's screen | `BANNER_SECONDS` (10) | Copy | Read Postgres again |
| `usage:{account}` | Meta's usage header | 1 hour | Copy | Next Instagram answer |
| `estimate:{account}` | "Will go / may expire" (section 12) | `PENDING_ESTIMATE_EVERY_MINUTES` (10) | Copy | Helper computes again |

Rules:
1. A copy is deleted right after the owner's change is committed in Postgres (also after an automation goes live or pauses, a bulk tag change, an upgrade, a broadcast that starts waiting for chats or ends, a change of the 4 account settings).
2. Redis is never called inside a Postgres transaction (D18). A count gets +1 right after the commit. The month copy too.
3. On disconnect, the copies and notes of every account of that connection are deleted (section 41). Their tickets stay or are re-added by the helper on reconnect; their waiting messages stay in Postgres.


---

# Part D. The sending engine

## 24. Queues, workers and places

### 24.1 The 3 common queues

All accounts share the same 3 sending queues. There is never one queue per account. We stop **one lane of one account**, never a queue. A workspace may have many Instagram accounts (1, 3 or 10 by plan, section 46). Each account has its own 4 lanes: `slow`, `reply`, `broadcast` and `fast`. The queues stay the same 3.

```text
 Instagram (through Meta)
    |  webhook: comment, Live comment, tap, DM, story reply, story mention,
    |           shared post, starter question, link, ad message, reaction, notice
    v
 [Webhook] --save--> app.instagram_webhook_events (Postgres)
    |                                     tag added or removed: a row in
    |                                     app.contact_tag_events (same commit)
    |  add job (after the save)                |  tag event job (after the commit)
    v                                          |
 QUEUE 1: instagram-webhook (intake) <---------+
    |  intake worker: decides, saves messages as `waiting`. Sends nothing.
    +----------------+----------------+-----------------+
    v                v                v                 v
 slow lane        reply lane       broadcast lane    fast messages
 (opening DMs as  (public replies  (broadcasts,      (all other DMs, Live
  private replies) and hides)       lowest priority)  private replies, nudges)
 1 ticket / lane  1 ticket / lane  1 ticket / lane   1 ticket per message
    |                |                |                 |
    +----------------+----------------+                 |
                     v                                  v
 QUEUE 2: instagram-send-slow               QUEUE 3: instagram-send-fast
 slow worker: one at a time per lane        fast worker: up to 20 at once per account
                     |                                  |
                     +-----------------+----------------+
                                    v
     Meta API on graph.facebook.com (private reply, comment reply, hide,
     send API, follow read)
```

Broadcast messages are made by the `broadcast-audience` job (24.3) or by intake when her chat opens (27.15).

| Queue | Carries | Who adds | Who takes | Job id |
|---|---|---|---|---|
| 1. `instagram-webhook` (meepzo-be's queue, kept) | Intake jobs of stored events. Tag event jobs | The webhook, after the save. A tag change, after its commit. The helper, for stuck events and tag events not queued | Intake worker | Stored events: `intake-{kind}-{accountPublicId}`, kind = `messages`, `live` or `comments`. Tag events: `tagevt-{eventId}` |
| 2. `instagram-send-slow` | Tickets of the **slow**, **reply** and **broadcast** lanes (broadcast tickets at a lower priority, 30.14) | Intake (first ticket), the `broadcast-audience` job, the slow worker (next ticket), the helper (lost ticket), owner actions | Slow worker | `{lane}-{accountId}-{turnNo}`, e.g. `slow-812-44`, `reply-812-9`, `broadcast-812-3` |
| 3. `instagram-send-fast` | One ticket per fast message | Intake, the result save (next step, next message, nudge), the helper | Fast worker | `fast-{messageId}-{tries}`, e.g. `fast-90311-1` |

The helper (section 34), the partition worker (section 21) and the task jobs (24.3) are not sending queues. They send no DM.

### 24.2 Intake: three jobs per account, and tag events

meepzo-be today has one intake job per account and handles its events one by one, in order. We keep "in order", but split each account into three kinds:

| Intake job | Events | Priority | Why |
|---|---|---|---|
| `messages` | Taps, typed answers, DMs, story replies, story mentions, shared posts, starter questions, links, ad messages, reactions, notices | 1 (`INTAKE_MESSAGES_PRIORITY`) | A person waits for an answer. Meta wants an answer within 30 seconds |
| `live` | Live comments | 1 (`INTAKE_MESSAGES_PRIORITY`) | A private reply works only while the Live is on. Its own job, so a busy Live never holds back taps |
| `comments` | Comments and ad comments (also from the missed-comment check and the past-comments job) | 5 (`INTAKE_COMMENTS_PRIORITY`); past comments 10 (`INTAKE_LOW_PRIORITY`) | Opening DMs wait for their box anyway |

1. Each job takes the account's oldest event of its kind (a 5 minute lease, `INTAKE_EVENT_LEASE_MINUTES`), handles it, then the next.
2. After 25 events (`INTAKE_EVENTS_PER_JOB`) the job adds one follow-up job and gives its place to other accounts.
3. **Fairness:** an account with more than 500 waiting comment events (`INTAKE_ACCOUNT_SOFT_LIMIT`) gets priority 10 (`INTAKE_LOW_PRIORITY`) for its `comments` job. A viral post never slows other accounts. Its `messages` and `live` jobs stay at priority 1.
4. Adding a job that already waits does nothing (same job id, meepzo-be's deduplication).
5. **Tag events** are rows of `app.contact_tag_events`: organization, contact, tag, `added` or `removed`, the automation or the owner that made it, the chain number (`chain_no`), `created_at`, `queued_at`, `done_at`. Kept 8 days (`TAG_EVENT_KEEP_DAYS`). The row is written in the same commit as the tag change, so a tag start is never lost. After the commit: one intake job per row (`tagevt-{eventId}`), then `queued_at` is set (like the webhook's `queued`). The helper queues rows that were not queued (section 34, rule 28). Priority 5 (`INTAKE_COMMENTS_PRIORITY`) for one tag change, 10 (`INTAKE_LOW_PRIORITY`) for the rows of an owner's bulk change. They take the contact lock like every intake event, so their order does not matter.

### 24.3 Task jobs (not sending)

One new queue `instagram-tasks` holds the work around sending. None of these jobs sends a DM.

| Job | What it does | Who adds it | Job id | Calls Meta |
|---|---|---|---|---|
| `account-setup` | Subscribes the 6 webhook fields, sets `webhook_subscribed_at`, sets starter questions if the account has live ones | Connect and reconnect (after the commit). The helper, when a subscription is off | `setup-{accountPublicId}-{connectedAtMs}` | Yes |
| `starter-questions` | Sets the account's ice breakers (`messenger_profile`) from the questions of its live starter-question automations (1 to 4 each, at most 4 per account, `STARTER_QUESTIONS_MAX`), then saves `starter_questions_set_at` | Go live, pause, delete or a question change of such an automation (after the commit). The helper (retry) | `starters-{accountPublicId}` (one waiting job per account) | Yes |
| `attachment-upload` | Uploads a file of a live automation to Meta once for its account, saves the id in `app.meta_attachments` | Go live, or a file change of a live automation (after the commit) | `attach-{accountPublicId}-{uploadPublicId}` | Yes |
| `token-check` | Checks one connection's token and its account list (section 25.8). Replaces meepzo-be's `instagram-account-daily-check` | The helper, spread over the day | `token-{connectionPublicId}-{yyyymmdd}` | Yes |
| `tag-bulk` | Adds or removes one tag on 500 contacts (`TAG_BULK_PIECE`) and writes their `app.contact_tag_events` rows in the same commit | The contacts bulk route; each piece adds the next | `tagbulk-{bulkPublicId}-{pieceNo}` | No |
| `month-wake` | Ends `plan_limit` or `plan_ended` stops of a workspace and wakes its lanes | The helper (new month), billing (upgrade, plan active again) | `wake-{organizationPublicId}-{reason}-{yyyymm}` | No |
| `plan-change` | At the end of a billing period: applies a move down (lane stop `plan_downgrade` on all 4 lanes of the accounts not kept; the PRO parts the new plan lacks are off by the plan: runs waiting for her email or phone move on, their waiting questions become `skipped` (`plan_feature_off`); the notice and email once), or a cancelled plan's end (`plan_ended` on every lane). On a move down without PRO: scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`), drafts and saved segments stay; an unfinished past-comments run ends `failed` (`plan_feature_off`), the DMs it already queued still go. A move up clears every `plan_downgrade` stop and wakes the lanes; the PRO parts work again by themselves. "Choose active accounts" uses the same job to swap the stops | Billing (period end, plan change). The helper, as a backup (section 34, rule 29) | `plan-{organizationPublicId}-{changeId}` | No |
| `segment-count` | Counts a segment's matches for the preview ("1,240 match. 310 can get it now"), and makes the contact list for hard conditions | The broadcast editor; the `broadcast-audience` job | `segcount-{segmentPublicId}-{n}` | No |
| `broadcast-audience` | Makes a broadcast's recipient rows and first messages, in pieces of 500 (30.14) | Send now; the helper at `scheduled_at` (section 34, rule 30) | `bcaud-{broadcastPublicId}-{pieceNo}` | No |
| `past-comments` | Reads the old comments of one automation's posts and saves them as events (27.16). One at a time per account | The "also answer comments from the last N days" button; the helper (section 34, rule 32) | `past-{accountPublicId}-{backfillPublicId}` | Yes |
| `retry-failed` | Puts the owner's failed messages that are still allowed back to `waiting`, in pieces of 500 (`RETRY_FAILED_PIECE`, section 33.10) | The "Retry failed messages" button (an automation or a contact) | `retry-{automationOrContactPublicId}-{n}` | No |

meepzo-be's `instagram-reconnect-notice` queue stays as it is: one notice per account and break.

Rules:

1. A task job that calls Meta never holds a transaction open during the call (section 35.4).
2. A Meta call that fails (not a stop error): the job tries again after 1, 5, 15, then 60 minutes (`META_TASK_RETRY_MINUTES`). After the last one: a banner on that account and one owner email (section 15). The helper keeps trying once an hour (section 34, rule 26).
3. `instagram-tasks` is not paused by meepzo-be's `instagram` circuit, like the send queues (24.6, rule 6).
4. Job ids have no `:` and are never only a number.

### 24.4 Places on each server

A "place" is one job running at the same moment on one server. It is common for all accounts. It is **not** a DM limit.

| Worker | Places now (start) | Places for 1,000 accounts | Setting |
|---|---|---|---|
| Intake | 5 | 20 | `INTAKE_PLACES` |
| Fast | 40 | 100 | `FAST_PLACES` |
| Slow (slow + reply lanes) | 40 | 50 | `SLOW_PLACES` |
| Tasks | 2 | 5 | `TASK_PLACES` |
| Helper | 1 | 1 | — |

Example: 80 fast places on 2 servers. 20 accounts each have 3 people tapping. 60 fast tickets run at the same time on any free place. When one ends, the place takes the next ticket of **any** account.

### 24.5 What is inside a ticket

A ticket holds only ids. The DM, its text and the person are always read from Postgres at the last moment, because things change while the ticket waits (she taps again, the owner pauses, a newer comment comes, the month limit is reached).

| Ticket or job | Holds | Never holds |
|---|---|---|
| Slow, reply or broadcast lane ticket | organization public id, account id, lane, turn number | the DM, the person, the text |
| Fast ticket | organization public id, account id, message id, the run's start time (`automation_run_started_at`, so Postgres reads only one part), try number | the text, the person |
| Intake job | organization public id, account public id, kind | the event body |
| Tag event job | organization public id, account public id, tag event id (its row holds the rest) | the tag, her name, her messages |
| Task job | organization public id, account or connection public id, the ids it needs | a token, a file's bytes |
| Save-result job (section 33.9) | message id, run start time, try number, result, Instagram message id, error code and subcode | the text |

```text
Slow ticket: account A, lane slow, turn 44
   -> slow worker asks Postgres: "A's next `waiting` opening DM?"
      -> message 501 -> run 77 -> contact Riya, comment id, automation GUIDE
         -> call Meta with the token of A's connection
            (read from app.meta_connection_tokens, right before the call)
```

### 24.6 BullMQ rules

1. **A worker never waits.** No `sleep`, no `setTimeout`, no loop that waits. Every wait is the `delay` of a ticket (a delayed job), or the same ticket put back with `moveToDelayed`.
2. Tickets have 1 attempt. Our own rules decide every retry of a send.
3. `removeOnComplete` and `removeOnFail` are on for **all** jobs (tickets, intake jobs, tag events, task jobs, save-result jobs). So the same job id can be added again later (the helper needs this).
4. Never use BullMQ's rate limiter. It is global for the whole queue: one account would slow all accounts.
5. Job ids have no `:` and are never only a number (BullMQ rule).
6. The send queues and `instagram-tasks` are **not** paused by meepzo-be's `instagram` circuit. A pause of a queue stops all accounts. Our own stop rules decide (section 33).
7. Intake never calls Meta for sending, so the intake queue is never paused for a Meta outage. The only Meta calls in intake are the profile read of a new contact, and one read of a comment's time when its webhook came over 1 hour late (section 27.3). Each has a 3 second time limit (`PROFILE_READ_TIMEOUT_MS`) and fails open (the contact is saved without a profile; the comment keeps `entry.time`).
8. The ticket Redis: `maxmemory-policy noeviction`, AOF on (every second), one replica that takes over by itself, memory alarm at 75% (`REDIS_MEMORY_ALARM_PERCENT`).
9. BullMQ says a delay is quite exact but not perfect. If all places are busy, a ticket starts a little later. That is fine for random times and for message waits.

## 25. Meta login and connect

We connect Instagram accounts with **Unified Login** only: Meta's "Instagram API with Facebook Login for Business". The person logs in with Instagram **or** Facebook. No Facebook Page is needed. It is a new app with no customers, so nothing is migrated: meepzo-be's old login code is removed and replaced (section 50).

Two new words:

| Word | What it means | Real-life example |
|---|---|---|
| Business portfolio | Meta's folder of a business. It owns Instagram accounts, Facebook Pages and ad accounts. | A company file at the bank. |
| System user token | A key that belongs to her business portfolio, not to the person who logged in. | A company card, not a personal card. |

### 25.1 Why Unified Login only

1. Meta calls it "the recommended setup for new integrations".
2. Meta's migration guide: newly created Meta apps can't set up Instagram Login any more, and new Instagram API features ship only on Unified Login.
3. Ads (`ads_read` now, ads publishing later) and Facebook Pages later (section 49) need Facebook Login for Business. Instagram Login cannot do ads.
4. An app can use Facebook Login or Instagram Login, not both (Meta's App Review page).
5. So meepzo-be's Instagram Login parts are removed, never kept beside it: its API client and version, its 60-day token with its renewal worker, its token table, its own app secret and its permission names. Built new: `app.meta_connections`, `app.meta_connection_tokens` and the flow of 25.4.

### 25.2 What Unified Login does not have yet

Meta's migration guide lists what Unified Login does not support at launch:

| Missing | What it means for us |
|---|---|
| Handover protocol (pass a chat to another app or to her inbox) | We never pass chats. The owner answers by hand in the Instagram app. Our "owner typed by hand" rule still works (section 14) |
| Login through the Instagram app | She logs in on Meta's web page, with her Instagram or Facebook account |
| Switching a personal account to professional during login | She switches to Creator or Business in Instagram first. Our connect page says how. The (#10) error shows the same help (25.4) |
| Meta's "API integration helper" | Not used |

Risks we accept:

1. **Every creator needs a business portfolio.** The creator test (2 creator accounts with no business portfolio, section 43) does **not** decide the login. It shows how hard the portfolio step is, so we write a help guide and help screens for that step.
2. Meta documents some messaging features only for the other login: quick replies, product cards, the button template, starter questions, the user profile (follow check), typing dots and attachment upload. Test needed on Unified Login (section 43).

### 25.3 Unified Login in short

| Thing | Value |
|---|---|
| Login | Facebook Login for Business with our `config_id` (Meta app: Use cases > Manage messaging & content on Instagram > Customize > "API setup with Unified login" > "Create new configuration"). The `config_id` is not secret. `scope` is not sent with a `config_id` |
| Configuration label | "Instagram Login Compatible" must be on, or the Instagram option does not show on the login screen (Meta) |
| She logs in with | Instagram or Facebook |
| Needs | A business portfolio (Meta: required) |
| Host and version | `graph.facebook.com`, `META_GRAPH_VERSION` `v27.0` |
| Token | Business Integration System User token. It covers every account she shared with our app. "Defaults to never expire" (Meta). Our configuration keeps that default |
| Ids | `GET /me?fields=client_business_id` (her business). `GET /me/assigned_instagram_accounts?fields=id,username` (her Instagram accounts). `/me` alone is the system user |
| Where we keep it | `app.meta_connections` (one row per workspace and business), `app.meta_connection_tokens` (ciphertext only) |
| Our Meta app | Owned by our business portfolio. Use case "Manage messaging & content on Instagram". Product Facebook Login for Business. App id, app secret, config id, redirect address and webhook verify token are env values (section 36), never in the settings file |

### 25.4 Connect: the whole flow

```text
Owner of A and B presses "Connect Instagram" in workspace W
   |
   1 POST /meta/connect/start -> new random state
   |    Redis connect:{state} = W + user, 10 minutes -> login address
   v
   2 facebook.com/dialog/oauth?client_id&config_id&redirect_uri
   |                          &response_type=code&state&prompt=login
   |    Meta screens: log in (Instagram or Facebook) -> business portfolio
   |    -> Instagram account(s) -> ad account (may skip) -> permissions
   v
   3 back to our page with code + state (or error=access_denied: calm message)
   |    POST /meta/connect/callback {code, state}
   v
   4 state in Redis, same user and W? ---------- no --> 400, nothing saved
   5 code exchange (server, app secret) -------- refused --> 422, nothing saved
   6 GET /me?fields=client_business_id
   7 GET /me/assigned_instagram_accounts
   8 permissions check ------------------------- one missing --> 422
   9 ONE COMMIT: app.meta_connections + app.meta_connection_tokens
   v
  10 screen: her accounts, which are here already, plan room
   |
  11 owner picks accounts -> POST /meta/connections/:id/accounts
  12 profile read per picked account (no transaction open)
  13 ONE COMMIT after the workspace lock (advisory lock on W):
   |    plan check, account rows, settings rows, 4 lane rows each
   v
  14 after the commit, one account-setup job per account:
        subscribed_apps (6 fields), starter questions, webhook_subscribed_at
```

Steps in words:

1. **Start.** `POST /api/v1/app/meta/connect/start`, only for a role with `instagram-account:manage` (section 45). It makes `state`: 32 random bytes, base64url. It saves `connect:{state}` in the ticket Redis (section 23) with the workspace and the user, for 10 minutes (`CONNECT_STATE_MINUTES`). It answers the login address.
2. **Login address:** `https://www.facebook.com/dialog/oauth?client_id=<META_APP_ID>&config_id=<META_CONFIG_ID>&redirect_uri=<META_REDIRECT_URI>&response_type=code&state=<state>&prompt=login`. Optional `display=popup`. The redirect address must match the Meta app's setting exactly.
3. **Meta's screens:** she logs in, picks a business portfolio, then the Instagram account(s), may skip the ad account step, then reviews the permissions.
4. Meta sends her back to our frontend page with `code` and `state`. The page checks the state it kept (meepzo-be's frontend does this), then calls `POST /api/v1/app/meta/connect/callback` with both. She cancelled: Meta sends `error=access_denied`. The page shows a calm message ("You stopped the connection. Nothing changed.") and saves nothing.
5. **State check (server):** read and delete `connect:{state}` (one use only). Missing, too old, another user or another workspace: `400 meta_connect_state_invalid`. Nothing is saved.
6. **Code exchange**, server only: `GET https://graph.facebook.com/v27.0/oauth/access_token?client_id=…&client_secret=…&redirect_uri=…&code=…`. This address holds the app secret, so it is never logged. Meta refuses the code: `422 meta_code_invalid`. Meta down: `503 instagram_unavailable` with `Retry-After` (meepzo-be's error).
7. **Ids:** `GET /me?fields=client_business_id`, then `GET /me/assigned_instagram_accounts?fields=id,username`. The token goes only in the `Authorization` header (section 41).
8. **Permissions check:** read which permissions the token has (test needed which call shows them for a system user token, section 43). One of the 3 we must have (`instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`: `INSTAGRAM_ACCOUNT_REQUIRED_SCOPES`, section 36.16) is missing: `422 meta_permissions_missing`. Nothing is saved. `ads_read` is asked too (25.6), but not required: without it the ad picker asks her to connect again (section 41.2).
9. **One commit:**
   - `app.meta_connections`: insert, or update the row of (workspace, `client_business_id`): `status` `connected`, `config_id`, `scopes`, `connected_by_user_id`, `connected_at`, `status_changed_at`, `last_checked_at` = now;
   - `app.meta_connection_tokens`: the new token as ciphertext, `token_type` `system_user`, `expires_at` empty (never).
10. **Answer:** the list of her Instagram accounts for the picker. For each: "already connected here", "connected in another workspace" (cannot be picked) or free. Also the plan room (25.5).

| What goes wrong at connect | What she sees |
|---|---|
| She cancels on Meta's screen (`error=access_denied`) | "You stopped the connection. Nothing changed." |
| A personal account: (#10) "not business or creator" | "Switch your Instagram account to Creator or Business, then connect again." |
| (#200) "disabled access to Instagram Direct" | The account connects, with the banner of 25.14 |
| She has no business portfolio | Meta's screens ask her to make one. Our help guide shows each step (25.2) |
| State, code or permissions wrong | The 400 or 422 of steps 5, 6 and 8 |

**Support information** for every failed connect (logged, shown to support): app id, `config_id`, the time, the step that failed, Instagram or Facebook login (if known), Meta's error code, subcode and trace id. Never a token, never the app secret.

### 25.5 Picking accounts and the plan limit

1. The owner ticks accounts. The screen allows at most the plan room. Example: workspace W is on Creator (3 accounts). Account A is connected. The owner may pick 2 more, for example B.
2. `POST /api/v1/app/meta/connections/:meta_connection_id/accounts` with the picked Instagram ids.
3. **Before the transaction:** one profile read per picked account (`PROFILE_READ_TIMEOUT_MS` each). It fails open: the username from step 7 is enough to connect.
4. **One commit:**
   - first, `pg_advisory_xact_lock` on W's organization id. Two connects in W at the same moment wait for each other (section 35.1);
   - count W's accounts that are not `revoked`. That number plus the new picks is over the plan's `instagram_accounts_max` (billing plan row, section 46): `409 plan_account_limit`, nothing saved;
   - each picked account: a new row in `app.instagram_accounts`, or W's own old row of the same Instagram account again (a revoked row; its settings come back). `meta_connection_id` set, `connection_status` `connected`, `connected_at` = now (the new-account limit, section 10);
   - an account that is live in **another** workspace: refused for that account (`idx_instagram_accounts_instagram_user_live`, `409 instagram_account_connected_elsewhere`). The other picks still connect;
   - for a new row: its settings row (all owner values empty) and 4 lane rows (`slow`, `reply`, `fast`, `broadcast`, state `ready`).
5. **After the commit:** one `account-setup` job per account (24.3), and the audit entry `app.instagram_account.connect`.
6. **Why subscribe after the commit:** a webhook for an account we have not saved yet is dropped (section 26.1, step 4). So the account row must exist first.
7. **Ids.** The id from `assigned_instagram_accounts` is saved in `instagram_user_id`. It is the same id the webhooks send (Meta's migration guide), so it is used everywhere: API paths, the webhook account check, the resolver.
8. **Routes per account.** Every account route carries `:instagram_account_id` (many accounts per workspace, section 18).

### 25.6 Permissions: now and later

| Permission | Asked | What it gives us | Webhook fields it allows |
|---|---|---|---|
| `instagram_basic` | Now | Profile, posts, stories and Lives (the pickers, the missed-comment check, `live_media`) | — |
| `instagram_manage_messages` | Now | Send and receive DMs, private replies, starter questions, the follow read | `messages`, `messaging_postbacks`, `messaging_referral`, `message_reactions` (and `messaging_seen`, not used) |
| `instagram_manage_comments` | Now | Read comments, reply under a comment, hide a comment, private replies | `comments`, `live_comments` (and `mentions`, not used) |
| `ads_read` | Now | The ad picker reads her ads (D41). Ad comments find their post | — |
| `instagram_content_publish` | Later: post scheduling (section 49) | Publish posts, reels, stories | — |
| `instagram_manage_insights` | Later: analytics (section 49) | Insights | `story_insights` |
| `instagram_manage_events` | Later | Events | — |
| `ads_management` | Later: ads publishing (section 49) | Create and manage ads | — |
| `business_management` | Not asked (only the token refresh API needs it; we do not use it) | — | — |
| `pages_*` | Later: Facebook Pages, a second configuration (section 49) | Pages and Messenger | Page fields |

Rules:

1. Meta's new configuration adds `instagram_content_publish`, `ads_management` and `ads_read` by default. We remove what we do not use now: `instagram_content_publish` and `ads_management`.
2. A permission is asked only when its feature is built. App Review needs a working demo. Then connected customers log in once more (25.10).
3. Private replies need `instagram_basic`, `instagram_manage_comments` and `instagram_manage_messages` (Meta).

### 25.7 Webhook fields per account

The `account-setup` job calls, with the connection's token in the header:

`POST https://graph.facebook.com/v27.0/<instagram account id>/subscribed_apps?subscribed_fields=comments,live_comments,messages,messaging_postbacks,messaging_referral,message_reactions`

| Field | Permission | What we use it for | Event kinds (section 26.2) |
|---|---|---|---|
| `comments` | `instagram_manage_comments` | Comment starts, ad comments | `comment` |
| `live_comments` | `instagram_manage_comments` (Advanced Access) | Live comment starts | `live_comment` |
| `messages` | `instagram_manage_messages` | DMs, story replies, mentions, shared posts, quick replies, edits, our "sent" notices | `message`, `story_reply`, `story_mention`, `shared_post`, `edit`, `echo` |
| `messaging_postbacks` | `instagram_manage_messages` | Button taps, starter question taps | `postback`, `ice_breaker` |
| `messaging_referral` | `instagram_manage_messages` | Link or QR opens, ad "Send message" | `referral` |
| `message_reactions` | `instagram_manage_messages` | A heart on our message refreshes her times | `reaction` |

1. Meta: a **private** account sends no comment and no mention webhooks. The account page shows "Your account is private. Comment automations cannot work." Going live with a comment, Live comment or ad comment automation on a private account shows the same warning (section 15).
2. `live_comments` needs Advanced Access (25.13).
3. The fields cannot differ per account (Meta). Every account gets the same 6.
4. The helper checks the subscription of each connected account every 10 minutes and subscribes again if a field is missing (section 34, rule 18).
5. Not subscribed: `mentions`, `messaging_seen` (read receipts), `story_insights`.

### 25.8 The token: never expires, checked every day

1. Meta: a system user token "defaults to never expire". We do not renew it. We do not ask for `business_management`.
2. **Token check:** once per connection every 24 hours (`TOKEN_CHECK_EVERY_HOURS`), spread over the day by connection id (section 34, rule 21). One job `token-check`:
   - one call: `GET /me/assigned_instagram_accounts?fields=id,username` with the token;
   - OK: `last_checked_at` = now, `last_check_error` cleared. A connected account of this connection that is **not** in the list any more (moved to another portfolio, or no longer shared): that account `error`, its lanes stopped (login, no end time), reconnect notice;
   - 190, or another "token not valid" answer: the connection `error` (`status_changed_at`, `last_check_error`), every account of it `error`, all their lanes stopped (login, no end time), reconnect notice;
   - Meta down or "too fast": try again later (`META_TASK_RETRY_MINUTES`). Nothing changes.
3. A send that gets 190 does the same at once, for **every account of that Meta connection** (section 33.1). It never waits for the daily check.
4. In the same commit as `error`: meepzo-be's guarded change (`markConnectionBroken`). Only the winner adds the reconnect notice (meepzo-be's `instagram-reconnect-notice`).
5. The token is read only by the worker that calls Meta, decrypted right before the call, sent only in the `Authorization` header (section 41).

### 25.9 Errors that mean "connect again"

Meta's rule for these cases: "stop retrying and ask your client to connect again". We never retry them by ourselves.

| What happened | What Meta sends | What we do | Owner sees |
|---|---|---|---|
| The app was removed from her business portfolio (Business Settings > Integrations > Connected apps) | 190 on the next call (exact subcode: test needed) | Connection `error`. All its accounts `error`. All their lanes stopped, no end time. Reconnect notice | "Your Instagram connection was removed. Press Reconnect." |
| An Instagram account was moved to another business portfolio | The account is missing from `assigned_instagram_accounts`. Calls on it fail (code: test needed) | That account `error`, its lanes stopped, no end time | "@account is no longer shared with Flowdm. Press Reconnect." |
| A permission is missing | `CODES_WRONG_PERMISSION` for 3 different people in a row (section 33.1) | All lanes of the account stopped. Reconnect notice | "A permission is missing. Press Reconnect." |
| The account became personal | (#10) "not business or creator" | That account `error`, its lanes stopped | "Switch @account back to Creator or Business, then press Reconnect." |
| Meta's deauthorize callback | Route 7 (25.12) | `revoked` (disconnected) | "Disconnected from Instagram." |

`error` means broken: a reconnect fixes it. `revoked` means disconnected on purpose: the account is connected again only by a new connect.

### 25.10 Reconnect

1. The same flow as 25.4. The same business portfolio gives the same `app.meta_connections` row. The new token replaces the old one. The connection goes back to `connected`.
2. Only an account whose Instagram id equals the `instagram_user_id` of a row of this workspace goes back to `connected` (section 41). Another Instagram account never takes an old row.
3. An account that moved to another business portfolio comes with a new connection row. Its account row moves to the new connection (`meta_connection_id`). Same workspace, same Instagram id, same row.
4. In the same commit: the login stops of those accounts end (`stop_cleared_at` = now).
5. After the commit: `account-setup` job (subscribe again), one ticket per lane with waiting messages, fast tickets in pieces of 500 (`RESUME_TICKET_BATCH`) spread over 5 minutes (`RELEASE_SPREAD_MINUTES`).
6. Waiting messages under 7 days go on (section 12). Older ones are already `expired`.

### 25.11 Disconnect

The owner presses Disconnect on one account. meepzo-be's rule stays:

1. **Before the transaction:** remove its starter questions and unsubscribe (`DELETE /<account>/subscribed_apps`). Best effort: a failure is logged, never blocks.
2. **One commit:** the account `revoked`, `disconnected_at` = now; its lanes `stopped`, no ticket. The connection's token is removed only when no other account uses that Meta connection: then the connection is `revoked` (`disconnected_at`) and its token erased.
3. **After the commit:** delete the account's Redis keys (`cnt:*`, `acct:`, `auto:`, `banner:`, `estimate:`, `tags:`).
4. `waiting` messages **stay waiting**. They expire by the 7-day rule, or go on if the same account reconnects.
5. **What stays:** the account's automations, contacts and history stay. Sending stops. Only Meta's data deletion (25.12), or deleting the workspace, erases the data. A disconnect never starts an account stopped `plan_downgrade` by itself: the owner picks with "choose active accounts" (section 10.4).
6. **Disconnect business** (all accounts of one connection): the same for each account, in one commit (lock order of section 35.1).
7. Helper rules (token check, webhook check, missed comments) run only for `connected` accounts and connections.

### 25.12 Meta's deauthorize and data deletion

meepzo-be has two public callback routes: route 7 (deauthorize) and route 8 (data deletion). Meta's `signed_request` is checked first. Then, in each workspace that holds that account: `revoked`, token erased, and on data deletion the profile and stored posts erased. These routes are kept and now work with Unified Login:

1. Both addresses are set in our Meta app (Facebook Login for Business settings). The signature is checked with the Meta app secret.
2. Test needed (section 43): which `user_id` Meta signs (the person, an Instagram id, or the business), and whether removing the app from the business portfolio calls deauthorize at all.
3. Until the test answers:
   - a `user_id` that matches an account's `instagram_user_id`: meepzo-be's flow as today;
   - a `user_id` we cannot match: answer 200 with the confirmation code (Meta needs it), log it, and email the team to handle the deletion by hand;
   - the token check and the first 190 still stop sending within 24 hours at most (25.8).
4. If the test shows we must keep the person's id, a column for it is added to `app.meta_connections` (section 19).

### 25.13 Before real customers: App Review, Live mode, business verification

| # | Step | Done when |
|---|---|---|
| 1 | Our business portfolio owns the Meta app | The app dashboard shows our business |
| 2 | Business verification of our business (required for production access) | Meta says "Verified" |
| 3 | The Unified Login configuration: "Instagram Login Compatible" on, default extras removed (25.6), `config_id` and the exact redirect address in env | The login shows only our 4 permissions and the Instagram option |
| 4 | Webhooks: object `instagram`, our callback address, verify token, the 6 fields | Meta's test event reaches us |
| 5 | App settings: icon 1024 x 1024, privacy policy address, terms address, category, business email, deauthorize and data deletion addresses | Every field is filled and every address answers |
| 6 | Development mode tests: up to 50 Instagram testers (people with a role on our app). Meta's test users do not work. Test accounts must be public | Each tester connects |
| 7 | **Creator test** (it does not decide the login): 2 creator accounts with no business portfolio connect. We note every screen of the portfolio step | The help guide and the help screens are written (25.2) |
| 8 | At least 1 successful call per permission before the review | Meta's dashboard shows the calls |
| 9 | App Review for Advanced Access, per permission: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `ads_read`, and Advanced Access for `live_comments` webhooks. One screen recording per permission (English screens, with captions) and step-by-step test steps | Meta approves each one |
| 10 | Live mode on | Customers without a role on our app can connect |
| 11 | Meta's "Required actions" (for example the Data Use Checkup) done on time, or access stops. A team reminder for each due date | No open required action |
| 12 | We never ask for the `human_agent` tag (Meta: only for a real person answering, never for automation) | — |
| 13 | Each later feature asks its own permission and goes through App Review again (section 49) | — |

### 25.14 "Allow access to messages"

1. Each Instagram account must have "Allow access to messages" ON in the Instagram app (settings of messages, connected tools). Otherwise messaging calls fail with "(#200) … disabled access to Instagram Direct" (Meta).
2. The `account-setup` job makes one read-only messaging call after connect (which call shows it: test needed, section 43). Off: a banner on that account before any DM is lost: "Turn on 'Allow access to messages' in the Instagram app."
3. A send that gets it: "message access off" (section 33.1). All lanes of the account stop. A test every hour (`ACCESS_TEST_MINUTES`). Owner email.
4. The exact subcode with Unified Login: test needed. Until then `CODES_ACCESS_OFF` keeps 200/2534041 and 10/2534077, plus the (#200) above.

## 26. Webhook

The webhook only saves. It decides nothing and sends nothing. It must answer Meta within 5 seconds.

```text
POST /social/instagram/webhook
   |
   1 signature over the raw bytes (Meta app secret) -- wrong or missing --> 400
   2 split into single events, give each its kind and key
   3 drop: read receipts, our own notices (Redis mid: note)
   4 account known and not revoked? ------ no --> 200, save nothing, log line
   5 Instagram time older than 8 days? --- yes --> drop (replay guard)
   6 Redis seen: note? ------------------- yes --> skip this event
   7 save events + event keys (one commit, own small pool, max 3 s)
   |        |
   |        +-- Postgres down or slow --> raw events to Redis `webhook-buffer`
   8 write seen: notes
   9 answer 200
  10 add intake jobs (messages / live / comments), events become `queued`
```

### 26.1 Steps, in this exact order

1. **Signature first** (meepzo-be's ingress plugin, kept): `X-Hub-Signature-256` over the raw bytes, timing-safe compare, before anything is parsed. The key is the Meta app secret (env): Meta signs every POST with it. No header: refused before the body is read. Wrong: 400. Body over 5 MB (`WEBHOOK_MAX_BODY_MB`): 413.
2. **Split** the delivery into single events and give each its kind and key (meepzo-be's classifier, with the new kinds of 26.2). Keys are per account (`read:<mid>` is never `message:<mid>`). One delivery may hold entries of several of our accounts, even of different workspaces: each entry is checked and saved in its own workspace scope. One bad entry never costs the others theirs (meepzo-be's rule). Meta may put up to 1,000 changes in one POST: each change is its own event.
3. **Drop without saving:**
   - read receipts;
   - "message was sent" notices of **our own** messages: the Redis note `mid:{account}:{instagram_message_id}` is there (10 minutes, `SENT_NOTE_MINUTES`). This check comes **before** any save.
   - A notice **without** that note is saved. It may be our own message whose note was not written yet, or the owner typing by hand. Intake decides (section 27.13).
4. **Account check.** The account is found with meepzo-be's resolver (`app.resolve_organization_public_id_for_instagram_user`) by the id in the event. Not found, or `connection_status` = `revoked`: answer 200, save nothing, one log line and a metric. An account with `connection_status` `error` is still saved: its comments wait until the owner reconnects. Paused or stopped accounts are saved too. Accounts of a workspace whose month limit is full or whose plan ended are saved too (section 27.1, rule 6).
5. **Replay guard.** An event whose Instagram time is older than 8 days (`EVENT_KEY_KEEP_DAYS`) is dropped. Its key may already be deleted, so it would look new.
6. **Fast repeat check.** The Redis note `seen:{account}:{event_key}` is there: this event was saved before. Skip it.
7. **Save**, in one short transaction on the webhook's own small pool (`WEBHOOK_DB_POOL_SIZE` 5), at most 3 seconds (`WEBHOOK_SAVE_TIMEOUT_MS`):
   - insert the keys into `app.instagram_webhook_event_keys` with "on conflict do nothing";
   - only the keys that were new: insert their rows into `app.instagram_webhook_events` (status `received`), all events of one request in one insert;
   - commit.
8. **After the commit:** write `seen:` notes (10 minutes, `SEEN_NOTE_MINUTES`). Never before the commit, or a failed save would hide the event.
9. **Answer 200.**
10. **Add the intake jobs:** one `messages`, `live` and/or `comments` job per account. When it adds the job, the webhook sets the saved rows to `queued`. A failed add is only logged: the helper picks up events that are `received` for over 1 minute (section 34, rule 4).

### 26.2 Event kinds and keys

| Kind | Meta field | How the classifier knows it | Event key | Intake job |
|---|---|---|---|---|
| `comment` | `comments` | `changes[]` item of field `comments`. The comment id is `comment_id` (we also read `id`). Ad comments carry `media.ad_id`, `ad_title` and `original_media_id`. `media_product_type` says feed, reel, story or ad. A reply under another comment carries `parent_id` (test needed, section 43). A comment by the account itself (`from.id` = the account, or `self_ig_scoped_id`): saved `skipped` (`own_comment`), never a start | `comment:<comment id>` | `comments` |
| `live_comment` | `live_comments` | `changes[]` item of field `live_comments` | `live_comment:<comment id>` | `live` |
| `message` | `messages` | A message with text, a quick reply, or media that is not one of the kinds below | `message:<mid>` | `messages` |
| `story_reply` | `messages` | `reply_to.story.id` is there (a link sticker adds `reply_to.story.link_sticker_url`; never stored) | `message:<mid>` | `messages` |
| `story_mention` | `messages` | An attachment of type `story_mention` | `message:<mid>` | `messages` |
| `shared_post` | `messages` | An attachment that shares a post (type `share` or `ig_post`: test needed) | `message:<mid>` | `messages` |
| `postback` | `messaging_postbacks` | A tap whose payload is ours: `<aut_…>::<run_…>::<msg_…>` | `postback:<mid>`, or without `mid`: `postback:<sender>:<time>:<SHA-256 of payload>` | `messages` |
| `ice_breaker` | `messaging_postbacks` | A tap whose payload starts with `starter:` (we set it, section 30.3) | as `postback` | `messages` |
| `referral` | `messaging_referral` (also a `referral` inside her message: test needed) | `referral.ref`, `source` SHORTLINK(S) or ADS, `ad_id` | `referral:<sender>:<time>:<SHA-256 of ref and source>` | `messages` |
| `reaction` | `message_reactions` | A reaction on a message | `reaction:<mid>:<action>:<time>` | `messages` |
| `echo` | `messages` | `is_echo` or `is_self`, or sent by the account. Never a start, never her message | `echo:<mid>` | `messages` (only the notice rule, 27.13) |
| `edit` | `messages` (`message_edit`) | She edited a message | `edit:<mid>:<num_edit>` | saved `skipped` (`edit`): never an answer, never a start |
| (read receipt) | — | A read receipt | — | dropped, never saved |
| `unknown` | any | A deleted message, anything else | as meepzo-be | saved `skipped` `unsupported` |

Rules:

1. A story mention carries a link to her story on Meta's servers. We never copy that media. The event body is cleared when the event is done (section 18).
2. "Story repost": test needed whether Meta sends anything (section 43). Until then such items stay `unknown`.
3. A quick reply tap is a `message` with `quick_reply.payload` (section 30.8).
4. The event key list keeps meepzo-be's rule: a longer key than 512 characters is saved as `<prefix>:sha256:<64 hex>`.
5. **Comment time:** the comment webhook carries no comment time. `entry.time` is when Meta sent it, and it is our `trigger_occurred_at`. If it is over 1 hour older than our clock when it arrives (a retry, `COMMENT_TIME_CHECK_LATE_MINUTES` 60), intake reads the comment's `timestamp` once (section 27.3). Live comments the same.

### 26.3 When Postgres is down or slow

| Postgres | Ticket Redis | What the webhook does |
|---|---|---|
| OK | any | Normal steps |
| Down, or the save takes over 3 seconds | OK | Push the verified raw events to the Redis list `webhook-buffer` (AOF, so it survives a restart). Answer 200. The helper moves them into Postgres later with the same keys, so a repeat is dropped (section 34, rule 3) |
| Down | Down | Answer 500. Meta tries again a few times. Comments come back later with the missed-comment check. Taps that Meta does not send again are lost (Meta's messaging page says it retries only "a few more times") |

Why: Meta's messaging webhook page says failed deliveries are tried again only a few times at once. Taps and typed answers cannot be read again later, so we must not lose them.

### 26.4 Other webhook rules

1. The webhook has its own pool, so busy workers never make Meta wait.
2. 1,200 requests a minute per IP (meepzo-be's limit), then 429.
3. The GET check (`hub.challenge`) uses the verify token from env, never from the settings file.
4. Logs carry ids, kinds, keys and counts. Never a message text, email, phone, story link or token.
5. **Inbound flood:** each saved message event adds 1 to `inbound:{account}:{contact}` (1 minute). The webhook only counts. Intake uses it (section 27.6).
6. Webhook fields are set per account at connect (section 25.7). The helper repairs a missing field (section 34, rule 18).
7. Meta retries a failed delivery for up to 36 hours. Every event is de-duplicated by its key, kept 8 days (`EVENT_KEY_KEEP_DAYS`).
8. mTLS is optional. If we turn it on, we use Meta's new CA file (the old DigiCert CA expired on 15 April 2026).

## 27. Intake

Intake turns one event into rows: contact, run, messages, comment log, counters. It sends nothing.

### 27.1 Rules for every intake event

1. The job runs in the organization's scope (meepzo-be: `app.current_organization_public_id` set inside each transaction).
2. **First statement** of the transaction: mark the event `processed` **only if** it is `received` or `queued`. 0 rows changed: it was done already, stop. If the transaction fails later, this mark is rolled back too. (A tag event: the first statement sets `done_at` only if it is empty, 27.9.)
3. Locks follow the one order (section 35): contact, automation, run, message, then the `automation_counts` slot row last.
4. Lanes are woken and fast tickets are added **after** the commit, never inside it.
5. Delay of a fast message: `not_before` = her event time (Instagram's time) + a random delay from 500 to 2,000 ms (`FAST_DELAY_MIN_MS`, `FAST_DELAY_MAX_MS`). delay = min + (max - min) x (r1 + r2) / 2, two new random numbers for each message, whole milliseconds. If that time is already over, it may go now. The account's extra delay is added once, to the first answer after her event, when it is on (section 30.12).
6. **Intake never blocks on the month limit or the plan.** Runs and `waiting` messages are saved also when the workspace's month count is full or its plan ended. The send claim decides (section 31.3). So a DM waits and is never lost; the 7-day rule and the window still apply. The owner sees "Limit reached. 40 DMs wait." (section 15).
7. **One automation answers one message** (27.2). **One comment starts one automation** (27.3).
8. Contacts are per account. A person who writes to accounts A and B of one workspace is two contacts.
9. Any event in her chat (a message, a story reply, a mention, a shared post, a tap, a starter question, a link) sets `first_message_at` on her contact if it is empty.
10. **Account switches** (section 5), read from the copy `acct:{account}`: `trigger_on_comment_replies` (27.3), `once_per_person_per_post` (27.7, rule 12), `mark_seen_after_reply` (30.13), and the extra delay (30.12).

### 27.2 One message, many matches: the order

```text
event from Riya in A's chat: message, story reply, story mention, shared post,
button tap, starter question tap, link opened, ad message
   |
   1 her own runs: a tap on our button, or text a waiting run needs?
   |       yes --> move those runs (27.5, 27.6). Nothing new starts. Done
   v no
   2 exact source: starter question payload, link ref_code, ad_id?
   |       yes --> that automation
   v no
   3 her message's kind or keyword:
   |       story reply  -> story reply automations, then "also start from"
   |       mention      -> story mention automations
   |       shared post  -> shared post automations (this post, or any post)
   |       DM text      -> DM keyword automations, then "also start from"
   |       a match --> the oldest match of the first group that has one
   v no
   4 her first message to A (first_message_at was empty)?
   |       yes --> the "first message" automation
   v no
   5 the "no other automation answered" automation (once a day or every time)
   |       yes --> start it
   v no
   nothing starts (her times are still saved)
```

Rules:

1. Only live automations of this account take part. One automation answers one message. The first step with a match wins.
2. Inside one step: an automation of one post or one story beats an "any" one; then automations of the event's own kind beat the ones that "also start from" it (`also_start_from`, section 5); then the oldest (meepzo-be's rule: `created_at`, then id).
3. **A match blocked by its once rule still counts as the answer.** Example: Riya sends "PRICE" twice in one day. The second time, PRICE's once key `dm:<date>` blocks it. Nothing starts, and step 5 does not run either.
4. Step 1 keeps the rules of 27.5 and 27.6. A run that moved uses up the event.
5. **Opted out** (`opted_out_at` set, section 14): nothing automatic goes to her on this account. Only her own new action that matches one of these starts her again:

| Her new action | Restarts her? |
|---|---|
| A comment (post, reel, Live or ad comment) that matches an automation's keyword | Yes |
| A DM that matches a DM keyword, or the keywords of a comment automation that "also starts from" DMs (it counts as a keyword DM) | Yes |
| A tap on a starter question | Yes |
| Opening an ig.me link of a link automation | Yes |
| "No other automation answered", first message, an ad "Send message", a tag start, a nudge, a story reply, a story mention, a shared post, a reaction, a tap on an old button, a match of an automation with no keywords | Never |

   A "Yes" match clears `opted_out_at` in the same commit, and the run starts normally (its once rule and open-run key still apply). The owner cannot restart her by hand. A new stop word stops her again at once (27.6, step 4).
6. Flood guard over `INBOUND_PERSON_PER_MINUTE`: steps 1 to 5 are skipped (27.6, step 3).
7. Comment and Live comment events have their own rule (27.3, 27.4). Tag events too (27.9).
8. A reaction never starts anything. A plain media message (a photo, a voice note) can start only "first message" and "no other automation answered".
9. A starter question tap whose automation is no longer live, or no longer has that question, is treated as a normal message (steps 3 to 5).
10. **Excluded by the owner** (`automations_off_at`, 27.17): nothing starts for her, and her taps and texts move no run. Only her times are saved.

Example: Riya's first DM ever to A is "price?". A has a DM keyword automation PRICE, a first-message automation HELLO and a "no other automation answered" automation HELP. Step 3 finds PRICE. HELLO and HELP do not run. Her `first_message_at` is now set, so HELLO never runs for her later.

### 27.3 Comment (and ad comment)

```text
comment "GUIDE" on post P
   |
   +-- excluded by the owner (27.17)? --------------- yes --> no run
   +-- opted out and no keyword match? -------------- yes --> no run
   +-- own comment, or a reply under a comment (switch OFF)? -- yes --> no run
   +-- which automation? (post-linked first) -------- none --> done
   +-- run of this automation for her with post_key P
   |   already has a DM (dm_sent_at)? --------------- yes --> logged `ignored`
   +-- open run of this automation for her on P? ---- yes --> logged `ignored`
   |
   +-- run starts: runs_started +1, versions picked
   +-- her chat window open? ----- yes --> first step as a normal DM, fast lane
   |                                        (no 24-hour rule, fast limit)
   +-- no --> opening DM of this post already waiting / unknown / not tapped?
                 yes --> attach this run to it (no second opening DM)
                 no  --> new opening DM, slow lane (private reply)
                         she got one in the last 24 h --> not_before = last + 24 h
```

1. Mark the event `processed` (only if not done).
2. Lock the contact. Save her if new (meepzo-be's upsert). Then two checks: a comment by the account itself never starts anything (`own_comment`), so our own public replies never start a run. A reply under another comment (`parent_id`) starts nothing when the account's `trigger_on_comment_replies` is OFF (logged `ignored`, `thread_reply_off`). ON (default): it counts like any comment on that post; its public reply goes under the top-level comment (Meta).
3. Excluded by the owner (`automations_off_at`, 27.17): no run, no DM, no public reply, no hide. Done. `opted_out_at` is set: go on to step 4 only to look for a keyword match. A keyword match restarts her: `opted_out_at` is cleared in this commit (27.2, rule 5). No keyword match: no run. Done.
4. **Find the automation** (meepzo-be's rule): only live comment and ad comment automations of this account whose keywords match (27.8). Post-linked first: "one post", "my next post" (linked to the first post after go-live; Meta sends no new-post webhook, so meepzo-be's 15-minute job reads `/media` with `since` and links it), "posts between" (the post's time is inside the two dates), and an ad comment automation (the comment's `media.ad_id` is its `ad_id`, or the post is its ad's post, read at go-live with `ads_read`). The oldest post-linked match runs. Only if none: the oldest "any post" match. Every other match is logged `ignored` (`comment_already_answered`). Read from the Redis copy `auto:{account}`; no match in the copy: look once in Postgres, so a new automation is never missed.
5. Lock the automation (live check again).
6. **The post key.** Every run has a `post_key` (table 27.7). For a comment it is the media id. With `once_per_person_per_post` OFF it is `<media id>:<comment id>`, so a new comment starts a new run once her earlier run of this automation on this post has ended (27.7, rule 12).
7. **Once rule** (once per automation per post): a run of this automation for her with the same `post_key` and `dm_sent_at` set: logged `ignored` (`once_per_post`). Done.
8. **One open run per automation, person and post:** a key in `app.automation_run_open_keys` for (organization, automation, contact, `post_key`): logged `ignored` (`already_waiting` or `run_in_progress`). Done. For an "any post" automation a comment on a **second** post has another `post_key`, so it starts its own run. With `once_per_person_per_post` OFF the open-run key is the fixed key `every_time`: one open run per automation and person, so a new comment (or any other start) while her run of the same automation is still open is logged `ignored` (`run_in_progress`). The key is added when the run opens and deleted when the run ends, in the same commit.
9. Create the run (`started_at` = now, `post_key`, `trigger_type`, `trigger_occurred_at` = `entry.time`; if that is over 1 hour old when it arrives (`COMMENT_TIME_CHECK_LATE_MINUTES`), one read of the comment's `timestamp`, 3 seconds, failing open), its open key, its first run event, its comment log. `runs_started` + 1 (27.11). Versions are picked (27.10).
10. **Window open** (`last_direct_message_received_at` within 24 hours minus 15 minutes, `WINDOW_SAFETY_MINUTES`): the first needed step (the hello, or the next needed step, 27.10) is saved in the **fast** lane, channel `direct`, with the random delay.
11. **Window closed:**
    - An opening DM of hers **on this post** is `waiting`, `unknown`, or `sent` but not tapped: attach this run to it. No second opening DM (Instagram allows one private reply per comment, and one per person is enough).
    - Else: save `opening_message` in the **slow** lane, channel `private_reply`. If `last_opening_message_at` is within 24 hours (`OPENING_PERSON_GAP_HOURS`): `not_before` = that time + 24 hours.
    - A private reply carries text with up to 3 buttons (`HELLO_BUTTONS_MAX`). Whether buttons work in a private reply: test needed (section 43).
12. The public reply and the hide are **not** made now. They are made when the DM of this comment went (section 29.2, 29.4).
13. Commit. Then wake the lane (fast: add the ticket; slow: section 28.6).

### 27.4 Live comment

1. Kind `live_comment`, intake job `live` (24.2).
2. Mark the event `processed`. Lock the contact. Save her if new.
3. Excluded by the owner (27.17): no run. Done. Opted out: only a keyword match restarts her, as for a comment (27.2, rule 5). Else no run. Done.
4. **Find the automation:** live "Live comment" automations of this account whose keywords match (27.8). One comment starts one automation: the oldest match.
5. **Post key** `live:<media id>` (the Live video's id). Once rule and open-run key as for a comment.
6. Create the run (`trigger_occurred_at` as for a comment, 27.3 step 9). `runs_started` + 1.
7. **First step:** the hello (or the first needed step) in the **fast** lane, with the random delay. Her window open: a normal DM (channel `direct`). Closed: a **private reply** to her Live comment (channel `private_reply`), only while the Live is on. No 24-hour person rule. No public reply and no hide (Meta: neither is possible on a Live).
8. Commit. Add the fast ticket.
9. It counts in the fast limit and the month count. If the Live ends before it goes: `expired`, reason `live_ended` (section 30.5).

Example: 20:00:05 Riya comments "LINK" during A's Live. Her private reply goes at 20:00:06.4. 20:01 she taps the button: her window is open now, so the next steps go as normal DMs.

### 27.5 Tap on a button

The button payload carries the automation, the run and the message: `<aut_…>::<run_…>::<msg_…>`. The hello and the nudge carry the same run (section 30.7). A link button sends us nothing (Meta). Only "sends your next step" buttons come here. A starter question tap has the payload `starter:…` and goes to 27.7.

1. Mark the event `processed` (only if not done).
2. Lock the contact. Save `last_message_received_at` and `last_direct_message_received_at` (Instagram's time, only if newer). Her window is open now.
3. Find the run and the message by the payload. An old payload (that step no longer waits) is ignored. It is never a wrong answer.
4. **Her tap proves only the message with this button.** That message is `unknown`: it becomes `sent`. No other message changes.
5. The run waits for `opening_message_button`: create the next needed step (27.10: follow check, follow request, email question, phone question, message 1) in the fast lane with the random delay.
6. **Nudge:** her `waiting` nudge of this run becomes `cancelled`, reason `answered` (section 30.7).
7. **Counter:** the run's first tap on its hello or nudge: `taps` + 1 and `taps_by_version` + 1 for the hello's version (27.11).
8. The run waits for `any` because its last message is `unknown` or was skipped: `unknown` is never sent again by itself. Only her next message or tap may send that step once more (the same row back to `waiting`). A late clear "not sent" may also move it back to `waiting` (section 33.9).
9. Her other opening DMs that still wait in the slow lane: her window is open now, so each one moves to the fast lane (section 27.12).
10. Commit. Add the fast tickets.

**Broadcast buttons:** a tap on a broadcast button adds 1 to the broadcast's `taps`. A "start automation X" button starts X for her as a new run (its once rule and open-run key apply; her window is open), first step in the fast lane.

### 27.6 Typed text, DM, story reply, reaction, media

1. Mark the event `processed` (only if not done).
2. Lock the contact. Save the message times (Instagram's time, only if newer). Set `first_message_at` if empty.
3. **Flood:** `inbound:{account}:{contact}` is over 20 this minute (`INBOUND_PERSON_PER_MINUTE`): only step 2 is done. No new run, no answer check. The event is `processed`.
4. **Stop word** (section 14): set `opted_out_at`. Her `waiting` messages become `skipped` (reason `opted_out`). Her open runs end `cancelled` (`opted_out`). Done. A stop word always wins, also right after she was restarted. Not a stop word, but she is excluded by the owner (`automations_off_at`, 27.17): only her times are saved. Done.
5. **What kind of answer** (the table in section 14): text or quick reply is an answer. A reaction only refreshes the times. Media, a story mention, a shared post, deleted or unsupported messages are never a wrong answer.
6. **Email or phone:** take the first email-like or phone-like part of the text. Save it on the contact **only if** one of her runs waits for `email` or `phone` (strict check, section 14).
7. **Typed text works like a tap:** a run that waits for `opening_message_button` moves on. Her first text while the run waits for the hello is a **typed answer**: `typed_answers` + 1 and `typed_by_version` + 1, in the same commit (27.11). A run that waits for `follow` gets a new follow check (the same row back to `waiting`).
8. **Move every run** of hers that waits for this answer, or for `any`. One answer can move many runs. When the email comes, meepzo-be's queued automations start, each as its own run.
9. **Ask once:** before a question (follow request, email question, phone question) is created, look for a row of that type for her that is `waiting`, `sending`, `unknown`, or `sent` and still waiting for her answer. Found: do not ask again; this run waits for the same answer.
10. **Nudge:** any message from her cancels her `waiting` nudges (`cancelled`, reason `answered`). A reaction does not (section 14.3).
11. Her opening DMs that still wait in the slow lane move to the fast lane (section 27.12).
12. **Nothing moved** (no run took this event): the match order, steps 2 to 5 (27.2, 27.7). Then, in the same commit, the "when her chat opens" hook (27.15).
13. Commit. Add the fast tickets.

### 27.7 New starts from her chat

`post_key` is the once key: one run per automation, person and key (section 9). `<date>` = the day in the workspace's time zone.

| Start | Event kind | How the automation is found | Once key (`post_key`) | First message |
|---|---|---|---|---|
| Story reply | `story_reply` | Story reply automations: any story or this story; keywords if set | `story:<story id>` | Fast |
| Story mention | `story_mention` | The account's story mention automations | `mention:<story id>` (no story id in the event: `mention:<mid>`, test needed) | Fast |
| DM keyword | `message` | Keyword (27.8) | `dm:<date>` | Fast |
| Their first ever message | any chat event, `first_message_at` was empty | The account's first-message automation | `first` | Fast |
| Your post sent to you | `shared_post` | The shared post's media id = the automation's post, or an "any post" automation (the post must be one of the account's posts; media id in the event: test needed) | `share:<media id>` | Fast |
| Starter question | `ice_breaker` | Payload `starter:<automation public id>:<question no>` (an automation has 1 to 4 questions) | `starter:<date>` | Fast |
| Link or QR code | `referral`, source SHORTLINK(S) | `ref` = the `ref_code` of a link automation of this account | `ref:<date>` | Fast |
| Ad "Send message" | `referral`, source ADS | `ad_id` = the automation's `ad_id` | `ad:<ad id>` | Fast |
| No other automation answered | any chat event, nothing matched | The account's "no other automation answered" automation | "Once a day per person": `default:<date>`. "Every time": no once rule (the key is `default:<her message id>`, so it never repeats) | Fast |
| Tag added, tag removed | tag event (27.9) | `trigger_tag` | `tag:<tag>:<event id>`, `untag:<tag>:<event id>` | Fast, window must be open |

Rules:

1. Her window is open (she wrote, tapped or opened the link), so the first step goes in the fast lane as a normal DM, channel `direct`, with the random delay. No private reply, no public reply, no hide.
2. A link opened with no message: test needed whether it opens her window (section 43). If Meta refuses the DM, the message is `skipped` (`window_closed`).
3. After a click-to-message ad her window may be up to 7 days (Meta, test needed). Until a test proves it, the plan uses 24 hours (`MESSAGING_WINDOW_HOURS`).
4. Starter questions and links on a brand-new chat: Meta says ice breakers must be set to get the ref (test needed). The `starter-questions` job keeps them set (24.3).
5. Every start here may get a nudge (her message came first, section 30.7).
6. The person limit (60 per hour, `PERSON_HOUR_LIMIT_DEFAULT`) guards "every time" and tag starts.
7. Once rule and open-run key work as for a comment (27.3, steps 7 and 8).
8. "Story repost" is built only if a test shows Meta sends it. "They follow you" is not offered (section 4).
9. "No other automation answered" never runs while the owner chats with her by hand (within `OWNER_CHAT_QUIET_HOURS`, 6 hours, of the owner's last hand-typed message to her). This quiet time is per contact: other people are not affected.
10. The link is `https://ig.me/m/<username>?ref=<ref_code>` (Meta's pages show `ig.me/<username>` and `ig.me/m/<username>`: test needed which one keeps the ref, section 43).
11. Opted out: only a DM keyword, a starter question or a link restarts her from this table (27.2, rule 5).
12. **Every time** (the account's `once_per_person_per_post` OFF): every new comment or message start makes a new run. The once key becomes the event's own id: `<media id>:<comment id>`, `live:<media id>:<comment id>`, `dm:<message id>`, `story:<story id>:<message id>`, `mention:<story id>:<message id>`, `share:<media id>:<message id>`, `starter:<event id>`, `ref:<event id>`, `ad:<event id>`. The open-run key is the fixed key `every_time`: one open run per automation and person. So a new comment, keyword DM or any other start while her run of the same automation is still open is logged `ignored` (`run_in_progress`); after that run ends, the next one starts a new run (27.3, step 8, D65). Not changed by the switch: "first message" (once ever), "no other automation answered" (its own once-a-day or every-time choice), tag starts (already per event). Still true when OFF: Meta's one private reply per comment, one opening private reply per person per 24 hours while her window is closed (`OPENING_PERSON_GAP_HOURS`: the next one waits), the person limit (60 per hour), and two automations on one post share one unanswered opening message (27.3, step 11).

### 27.8 Keywords and close spellings

1. Her text is cleaned: lower case, spaces trimmed.
2. **Contains** (meepzo-be): a keyword inside her text is a match.
3. **Close spelling:** each word of the keyword that has 5 or more letters (`KEYWORD_TYPO_MIN_LETTERS`) also matches a word of her text with one letter changed, added or missing, or two letters next to each other swapped (`KEYWORD_TYPO_MAX_EDITS` 1). Words under 5 letters must be exact. A keyword of several words matches only when all its words come together in her text, in the same order.

| Keyword | She writes | Match? |
|---|---|---|
| `guide` | "guied pls" | Yes (two letters swapped) |
| `guide` | "send gude" | Yes (one letter missing) |
| `price` | "prise?" | Yes (one letter changed) |
| `link` | "lnik" | No (4 letters: exact only) |
| `free guide` | "free guied please" | Yes ("free" exact, "guide" two letters swapped, together and in order) |
| `free guide` | "fre guide" | No ("free" has 4 letters: exact only) |
| `free guide` | "guide free" | No (wrong order) |

4. Same meaning (AI): later (section 49).
5. No keywords: matches every comment and story reply (meepzo-be), never a DM.
6. The same function answers the "try it" route (section 5), so the screen and intake always agree.
7. Two live automations of one account share a word: a warning at save (section 5). Intake still picks one (27.2, 27.3).

### 27.9 Tag events

```text
a tag is added to or removed from Riya (account A)
  - by an automation's tag step (her run ended `completed`), or
  - by the owner (contact page, or bulk in pieces of 500)
        |
        v
 one commit: app.contacts.tags changed + one row in app.contact_tag_events
        |
        v  after the commit: one tag event job per row (queued_at set)
 intake (tag event):
   1 done_at set only if empty; lock contact; tag still as the row says?
                                                         --- no --> nothing
   2 opted out or excluded? ------------------------------ yes --> nothing
   3 live tag automations of A for this tag and change,
     not the one that made the tag, chain_no under 3 ----- none --> nothing
   4 her window open now? ----------------------- no --> no run (start skipped)
   5 once key tag:<tag>:<event id>, open-run key
   6 run + first step in the fast lane (random delay), runs_started +1
```

1. Tag events are not webhook events. Each one is a row of `app.contact_tag_events`, written in the same commit as the tag change, then an intake job (24.2, rule 5). The helper queues rows that were not queued (section 34, rule 28).
2. Only a real change makes an event. Adding a tag she already has makes none.
3. An automation never starts itself by its own tag (the event names the automation that made it).
4. **Chains:** a run started by a tag event that adds a tag makes a new event with `chain_no` + 1 (column of `app.contact_tag_events`). At `chain_no` 3 (`TAG_CHAIN_MAX`) no automation starts. The person limit (60 per hour) also stops a loop.
5. **Window:** checked here (closed: no run starts and nothing is sent; the start counts as skipped, `window_closed`, one count in the logs) and again just before sending (section 30.6). Closed then: the message is `skipped` `window_closed`.
6. Several automations for one tag: the oldest answers (one automation answers one event).
7. **Owner bulk** (`tag-bulk` job, 24.3), in pieces of 500 contacts in id order (`TAG_BULK_PIECE`):
   - one commit: the tags change, and one `app.contact_tag_events` row for each contact that really changed;
   - after the commit: their tag event jobs (priority 10), then the next piece.
   A piece that runs again after a crash finds the tags already there, so it writes no second rows.
8. The tag list of the account (`tags:{account}`, 60 seconds, `TAG_LIST_CACHE_SECONDS`) is deleted after each tag commit.

Example: automation GUIDE tags Riya "lead" when she finishes at 10:05. Automation FOLLOWUP starts on tag "lead". Her window is open (she typed her email at 10:04). The tag event comes at 10:05:00.2. FOLLOWUP's first message goes at 10:05:01.5.

### 27.10 The first step, versions and the message list

The steps of a run, in order: hello, follow, email, phone, messages 1 to N, tags (section 5).

1. **First needed step:** the hello if it is on, else the next needed step (follow check, email question, phone question, message 1). On a plan without PRO (after a move down) the email and phone steps are skipped: the engine reads the plan's `pro_features` (the `acct:` copy) when it makes each step (D57). For a comment with her window closed, that first step goes as the private reply (27.3). A private reply is one call and a comment opens no window, so a comment, Live-comment or ad-comment automation with no hello, follow, email or phone step may have only 1 message, a `text` message with no picture; go-live refuses anything else there (section 5.1, check 12).
2. **Versions** (hello and follow ask): when the row is made, one version is picked at random (1 to the number of versions, at most 3, `MESSAGE_VERSIONS_MAX`). On a plan without PRO only version A (version 1) is used (D57). Saved on the message row (`version_no`) and on the run (`version_nos`). The nudge uses its hello's version.
3. **Wordings** (email and phone questions): one of the 1 to 10 wordings at random (`QUESTION_WORDINGS_MAX`). With 2 or more, never the one this contact got last for that question (read under her contact lock). Saved as `wording_no`. Each ask again picks again. `invalid_email` keeps its own text.
4. `{name}` is filled in at send time from the contact: her name, else her username.
5. **Message list:** message 1 (type `message`, `message_no` 1) is made when the steps before it are done. A message with a picture and a text is 2 rows with the same `message_no` (section 30.3). Message N+1 is made by the result save when message N is `sent` (section 30.6). N is `unknown`: the list waits for her next message (section 14). At most 10 messages (`AUTOMATION_MESSAGES_MAX`).
6. **End:** after the last message the tag step adds its tags in the same commit, and the run ends `completed`. Tag events after the commit (27.9).
7. Every message after the first private reply is a normal DM (fast lane, channel `direct`).

### 27.11 Counters and the month limit at intake

1. `runs_started` + 1, and `runs_by_version` + 1 for the hello's version, in the commit that makes the run. Row: `app.automation_counts`, slot = run id mod 16 (`AUTOMATION_COUNT_SLOTS`), insert or add. This row is locked last (section 35.1).
2. `taps` + 1, and `taps_by_version` + 1 for the hello's version, in the commit that handles the run's **first** tap on its hello or nudge.
3. `typed_answers` + 1, and `typed_by_version` + 1, in the commit that handles her first text while the run waits for `opening_message_button` (27.6, step 7). The run then stops waiting for the hello, so each run counts once: its first tap or its typed answer. Later taps or texts of the same run do not count.
4. **"% tapped"** = (`taps` + `typed_answers`) / `runs_started`, also per version. The screen shows the sum of the 16 slots: "1.3k runs · 51% tapped". The rows stay when runs are deleted after 90 days.
5. Counters are added only in these commits. They are never counted again from other tables (section 34).
6. **The month limit is not checked here** (27.1, rule 6).

### 27.12 Moving an opening DM from the slow lane to the fast lane

Her window opened while her opening DM waits as a private reply.

1. One update on the **same row**: lane `fast`, channel `direct`, `not_before` = now + random delay, **only if** status is `waiting` and lane is `slow`. The row keeps its type and its reason. No new row is made.
2. 1 row changed: add a fast ticket after the commit.
3. 0 rows changed: the slow worker already took it (`sending`). Nothing to do. The private reply goes, which is allowed.
4. The slow worker locks the row it picks (`for update skip locked`, section 28), and its `sending` update also checks lane `slow` and channel `private_reply`. So the two never both win.
5. The other way (her window closed while a direct message of a comment run waits): the fast worker does the same, one update on the same row back to lane `slow`, channel `private_reply`, only if `waiting` (section 30.2, step 6).
6. Live replies stay in the fast lane. Her window closes while a direct one waits: the same row changes to channel `private_reply`, if the Live is still on (section 30.2, step 6).

### 27.13 "Message was sent" notice that was saved

1. Its Instagram message id is already on a message: `processed`.
2. Else look for messages to this contact that are `sending` or `unknown`, have no Instagram message id, were tried in the last 10 minutes (`NOTICE_MATCH_MINUTES`), and have the same text (if the notice has the text).
3. Exactly one found: save the id on it. `unknown` becomes `sent` (through the shared save-result function, so its side effects run). `sending` stays `sending`; its worker finishes it.
4. None found: the owner typed by hand. Automatic "ask again" messages to her pause for 6 hours (`OWNER_CHAT_QUIET_HOURS`, section 14). Only her: other people are not affected.
5. More than one found: change nothing. We never guess.

### 27.14 Intake errors

| Error | What happens |
|---|---|
| Postgres connection or timeout error | The try is not used up. The event goes back to `queued`. The job tries again with backoff (5 seconds, growing, with jitter). The helper also re-adds it after 1 minute |
| Lock timeout or deadlock | The whole transaction once more, up to 3 times (`DB_DEADLOCK_RETRIES`), then as above |
| A logic error or a payload that cannot be read | The event becomes `failed` with a code. The runs it left `running` fail too (meepzo-be's rule, same transaction) |
| 5 failed tries (`INTAKE_MAX_ATTEMPTS`) | `failed`. The helper tries it again every hour (`FAILED_EVENT_RETRY_MINUTES` 60, saved in `next_attempt_at`) until the comment is 7 days old |
| A tag event job fails 5 times | Its row stays not done. The helper queues it again every hour (`FAILED_EVENT_RETRY_MINUTES`) while it is under 24 hours old (`MESSAGING_WINDOW_HOURS`: after that her window is closed anyway) |

So a 30 second Neon restart never makes a tap wait an hour.

### 27.15 When her chat opens: broadcasts that wait for her

A broadcast in mode "deliver when her chat opens" (section 8) has no list made in advance. It waits for each person to write.

```text
Riya writes to A (a DM, story reply, mention, shared post, starter tap, link)
   |
   1 intake handles her event as usual (27.2 to 27.7)
   2 A has a broadcast "when her chat opens", still before its ends_at?
   |        no --> done
   3 a run of hers is open now (started or moved by this event)?
   |        yes --> wait: the hook runs again when her last open run ends
   4 left out? opted out, excluded, got this broadcast, got any broadcast in the
   |   last 24 h, the owner typed to her within the quiet time --- yes --> done
   5 she matches the broadcast's conditions? -------------------- no --> done
   6 same commit: recipient row `waiting` + message 1 (type `broadcast`,
     lane `broadcast`, not_before = now); after the commit: wake the lane
```

1. **Two places**, both under her contact lock, in the same commit as the event they follow:
   - intake, after her chat event, when no run of hers is open;
   - the result save, when her last open run ends (`completed` or `cancelled`) and her window is open.
2. **What opens her chat:** a message from her (DM, story reply, story mention, shared post), a starter question tap, a link open. A reaction never does.
3. **Left out:** opted out, excluded by the owner (27.17), deleted, she already has a recipient row of this broadcast (once per person per broadcast; but a row `skipped` (`owner_chat`) is put back to `waiting` here, with its message, once the quiet time is over), she got any broadcast in the last 24 hours (`BROADCAST_MIN_GAP_HOURS`), the owner typed to her by hand within `OWNER_CHAT_QUIET_HOURS` (per contact).
4. **Conditions:** read from the broadcast (its segment, or its own snapshot), kept with the live automations in the copy `auto:{account}` (60 seconds). The check is one query on her contact row and her runs of the last 90 days.
5. Several such broadcasts match: the oldest one. The 24-hour gap stops the others for now.
6. It never holds back her automation: it is made only after her runs end, and it goes in the broadcast lane (section 30.14), where her window is checked again.
7. The broadcast ends at its `ends_at` (1 to 7 days, `BROADCAST_OPEN_WAIT_DAYS_MAX`; section 34, rule 31). Recipients made before that still go.

Example: broadcast SALE, mode "when her chat opens", 3 days, to people with tag "lead". On day 2 Riya writes "hi" to A. No automation answers. In the same commit her recipient row is made. SALE's message goes at the broadcast lane's next box second, a few seconds later.

### 27.16 Past comments

The owner of a live comment or ad comment automation presses "Also answer comments from the last N days" (N = 1 to 7, `PAST_COMMENTS_MAX_DAYS`). Not for Live comments: a Live private reply works only during the Live.

1. One row in `app.automation_backfills` (`status` `queued`), then the `past-comments` job (24.3). One running backfill per automation, and one job at a time per account.
2. **The job reads**, at most 1 call per second per account (`MISSED_CALLS_PER_SECOND`):
   - posts: the automation's target post(s); for "any post", the newest 50 posts with comments in those days (`PAST_COMMENTS_POSTS_MAX`);
   - `/comments` of each post, newest first, 50 per page (Meta has no time filter), until a comment is older than N days minus 30 minutes (`EXPIRY_SAFETY_MINUTES`);
   - replies under comments only when `trigger_on_comment_replies` is ON;
   - Meta's usage number 80% or more (`USAGE_SLOW_PERCENT`): the job waits 15 minutes (`USAGE_WAIT_DEFAULT_MINUTES`). These reads count in Meta's non-messaging limit (4,800 x impressions in 24 hours).
3. **Each comment is saved as an event:** kind `comment`, key `backfill:<backfill id>:<comment id>` (so a comment we already got by webhook still gets this one check), the backfill id on it, `trigger_occurred_at` = the comment's own `timestamp`. Intake job `comments`, priority 10 (`INTAKE_LOW_PRIORITY`), so live comments go first.
4. **Intake** works as for a comment (27.3), with these changes:
   - only the backfill's automation is checked;
   - a comment that already has a comment log of any automation (it was answered when it came): `ignored` (`comment_already_answered`);
   - own comments, replies under comments (the switch), opted-out and excluded people and the once rule (with its switch) work as usual;
   - a comment whose 7 days end within 30 minutes: no run, counted as "may expire".
5. Its opening DMs wait in the slow lane like any comment. They are over 60 minutes old, so they are in the "old" group of the 4 new : 1 old mix (section 28.2). Her window open: a normal DM in the fast lane.
6. **Counts** on the backfill row, in the same commits: `found` (saved events), `matched` (a match), `queued_count` (a run made). The owner sees the estimate (section 12): "Found 340 comments. 290 match. About 250 will go, about 40 may expire."
7. Status: `queued`, `reading`, `done`, `failed`. A failed Meta call: retries `META_TASK_RETRY_MINUTES`, then `failed`. Done or failed: notice `automation.backfill_done` (in-app, section 47). After a move down without PRO an unfinished run ends `failed` (`plan_feature_off`); the DMs it already queued still go. The helper watches it (section 34, rule 32).

### 27.17 Exclude a contact ("Pause automations for this person")

1. The owner (Owner, Admin or Editor) turns it on for one contact, or for many from the bulk bar. Column `app.contacts.automations_off_at` (+ `automations_off_by_user_id`). Audit log.
2. **In the same commit**, after her contact lock: her `waiting` messages become `skipped` (`contact_excluded`), her open runs end `cancelled` (`contact_excluded`) and their open-run keys are deleted. A bulk change runs in pieces of 500 contacts in id order, like the tag bulk job (`TAG_BULK_PIECE`).
3. **While it is set:** intake still saves her events and her times (counts, "last active"), but nothing starts and no run moves: no DM, no public reply, no hide, no tag start, no "when her chat opens" broadcast. Broadcasts always leave her out. No mark seen.
4. **Checked again before every send** (28.1 step 7, 29.5 step 4, 30.2 step 6, 30.14 step 7): `skipped` (`contact_excluded`).
5. **Turned off:** `automations_off_at` is cleared. Nothing restarts by itself: her next own action starts normally.
6. **Not the stop word:** the stop word is her choice, and the owner cannot undo it (27.2, rule 5). Excluding is the owner's choice, and the owner can undo it. A stop word from an excluded person is still saved.

## 28. Slow lane turn (opening DMs)

One account's slow lane sends **one** opening DM at a time, as a private reply to the comment, at a random second inside each box. Comments and ad comments use it. Live private replies do not (they are fast, section 30.5).

```text
ticket slow-A-44 wakes
  |
  1 gate 1 LOOK (Redis, no transaction) -- full --> ticket back at the free time
  2 BEGIN; lock lane row (skip locked) --- busy --> same ticket back, 1 s
  3 turn 44? lease? ----------------------- old turn or working --> drop
  4 pause / stop / all-stop / test -------- paused or plan stop --> no ticket
  |                                         stopped --> at stop end
  5 box second reached? ------------------- no --> ticket at that second
  6 pick (new / old / urgent), lock row --- none --> ticket at the earliest time, or idle
  7 checks again ------------------------- window open now --> move to fast, pick again
  8 GATE 2 + MONTH COUNT + `sending` + working_turn + attempt row; COMMIT
  |                                         month full --> write nothing, plan stop
  9 Redis counts +1 (after the commit)
 10 call Meta (no transaction open, max 15 s)
 11 OK --> write Redis mid: note
 12 save result (shared function); lane: only if working_turn is mine
 13 next ticket slow-A-45 at the next box second
```

### 28.1 Steps

1. **Gate 1 look** (Redis, before any transaction, section 31): is an `open` place free? No: put the same ticket back with the time when a place is free. Redis slow or not ready: skip this step.
2. **Begin.** Lock the account's `slow` row in `app.instagram_send_lanes` with `for update skip locked`. Not got (another worker holds it): put the same ticket back with a 1 second delay (`LANE_BUSY_RETRY_MS`) and leave.
3. **Turn check.** The ticket's turn is not the lane's `turn_no`: drop it. The lane is `working` and `lease_until` is not over: drop it (the worker that holds the lane adds the next ticket).
4. **Stops.** Read `app.sending_state` and the lane:
   - all accounts stopped and the time is not over: ticket at `all_stop_until`;
   - paused or suspended by the team (or the workspace is suspended): no ticket (Resume adds one);
   - stopped `plan_limit`, `plan_ended` or `plan_downgrade`: no ticket. The `month-wake` or `plan-change` job adds one (24.3);
   - lane stopped with an end time not over: ticket at `stop_until`;
   - lane stopped with no end time (login, please reconnect): no ticket;
   - the stop time is over: this turn is a **test** (section 33.4). Take the account's one test claim on the `slow` row with one update ("only if no test runs or its time is over"). Not got: ticket in 30 seconds (`TEST_DELAY_OTHER_LANES_SECONDS`).
5. **Box** (section 28.3). The random second of this box is not reached: ticket at that second. The day limit is ON and full: ticket at midnight in the organization's time zone.
6. **Pick one message** (section 28.2). It is locked with `for update skip locked`. Nothing can go now: section 28.5.
7. **Check again**, on this one message:
   - expired (comment time + 7 days - 30 minutes is over): `expired`, pick again;
   - she is opted out: `skipped` (`opted_out`), pick again;
   - she is excluded by the owner (27.17): `skipped` (`contact_excluded`), pick again;
   - another run of this automation for her with the same `post_key` already has `dm_sent_at`: `skipped` (`once_per_post`), pick again;
   - the automation is now paused with Cancel (`cancelled_by_owner`), or deleted (`automation_deleted`): `cancelled`, pick again;
   - her window is open now: move it to the fast lane (section 27.12), pick again.
   At most 5 picks in one turn (`PICK_TRIES_PER_TURN`). Then: ticket in 1 second.
   The claim transaction sets **only the message** status. It never changes the run. A run that must change (for example its opening DM `expired`) changes right after the commit, in its own short transaction in lock order (contact, automation, run), or in the result save.
8. **Gate 2 and the month count, one commit** (section 31):
   - lock the minute row of group `open` and count the last 60 minutes. Full: write nothing, ticket at the free time;
   - **month count:** add up the workspace's 16 slots of this month (section 31.3). This DM would pass `dm_month_limit`: write nothing. After the rollback the workspace's lanes stop `plan_limit` (section 31.3). No ticket;
   - room in both:
     - minute count + 1 (and `day_count` + 1 if the day limit is ON);
     - the account's month slot + 1;
     - message `waiting` to `sending`, `sending_at` = now, `tries` + 1, **only if** still `waiting`, lane `slow` and channel `private_reply`;
     - one new row in `app.instagram_send_attempts` (group `open`);
     - lane `working`, `working_turn` = this turn, `lease_until` = now + 120 seconds (`LEASE_SECONDS`), `pick_count` + 1;
     - commit.
9. **After the commit:** add this try to the Redis count (section 31.1) and 1 to `cnt:month:{organization}`.
10. **Call Meta:** private reply to the comment id. The hello is text with up to 3 buttons (a button template, text up to 640 characters, `BUTTON_TEXT_MAX_CHARS`). `{name}` is filled in. At most 15 seconds (`INSTAGRAM_TIMEOUT_MS`). No transaction is open.
11. Meta said OK: write `mid:{account}:{instagram_message_id}` (10 minutes) **first**, so the notice that follows is dropped at the webhook.
12. **Save the result** with the shared function (section 28.4).
13. Add the next ticket (after that commit).

### 28.2 How one message is picked

The pick never reads "the first rows, then filters". Rows of an automation that is paused or stopped would hide the others. Instead, one small query per group asks **each live automation** of the account for its best row, and takes the best of those.

```text
live, not stopped automations of A (a few)
   GUIDE  -> its newest waiting slow DM (index: account + automation + comment time)
   PRICE  -> its newest waiting slow DM
   OFFER  -> its newest waiting slow DM
              take the newest of the 3  --> lock it (skip locked)
```

| Group | Which rows | Order | Index (partial, only `waiting` rows of lane `slow`) |
|---|---|---|---|
| New | comment under 60 minutes old (`PICK_NEW_MINUTES`) | newest first | `(instagram_account_id, automation_id, trigger_occurred_at)` |
| Old | comment over 60 minutes old | oldest first | the same index, read the other way |

1. Only rows whose `not_before` is over.
2. Only automations that are live and not stopped, and rows made after `cancelled_before_at` (if set). These filters are inside the query, before "take 1".
3. **Mix** (`pick_count` 1 to 5): places 1 to 4 new, place 5 old (`PICK_MIX_NORMAL` 4:1). If the oldest waiting row has under 12 hours left (`URGENT_HOURS_LEFT`): places 1 to 3 new, 4 and 5 old (`PICK_MIX_URGENT` 3:2). One group empty: take the other.
4. **24-hour person rule** (window closed): she got an opening DM in the last 24 hours (`last_opening_message_at`): set `not_before` = that time + 24 hours on this row, pick again.
5. **Past comments** (27.16) are always in the old group.

### 28.3 Box: random second inside each box

1. box = 3600 / hour limit seconds (`LIMIT_WINDOW_MINUTES` 60). Example: 600 per hour = 6 second boxes. Half speed: box x 2 (`HALF_SPEED_FACTOR`). The hour limit stays the same.
2. The hour limit is the owner's value, else `OPENING_HOUR_LIMIT_DEFAULT` (600), at most `OPENING_HOUR_LIMIT_MAX` (700). A new account uses `NEW_ACCOUNT_HOUR_LIMIT` (150) for its first 7 days unless the owner raised it (section 10).
3. After a DM: the next box starts at `box_start` + box, also if the DM went late in its own box, so no box is lost. If the whole next box is already over (the lane was idle, paused, stopped or full), the new box starts now. Missed boxes are never sent together.
4. Pick a random second inside the next box, in milliseconds. `next_run_at` = that time, but at least 1,500 ms after the lane's `last_sent_at` (`OPENING_MIN_GAP_MS`).
5. Half speed is on while `half_speed_until` is in the future (set after a good test, section 33.4).
6. `box_start`, `next_run_at` and `last_sent_at` are saved in the lane row in the same commit as the result. The time is picked once. If the ticket is lost, the helper uses the same time.
7. Idle lane and a new comment: the current box is not over: a random second in the next box. It is over: a new box starts now.
8. The owner changes the hour limit: a new box starts now with the new size.

### 28.4 Save result (one shared function)

The slow worker, the reply worker, the fast worker, the helper (dead worker) and intake (notice, tap) all use **the same function**. So no path forgets a side effect.

1. Begin. Locks in the one order: contact, automation, run, message, lane, then (when needed) the `automation_reply_state` row, the minute row and the month slot (section 35.1).
2. **Message:** the result is saved if the message is `sending`, or `unknown` and Meta said OK. Status, `sent_at`, Instagram message id, error code and subcode.
3. **Attempt row:** result group, HTTP status, codes, time taken.
4. **Never connected** (surely not sent): minute count - 1 on the same minute row, `day_count` - 1 if same day, month slot - 1, the message goes back to `waiting`. An upload that failed all its tries (section 30.4) also gives its places back: nothing reached her chat.
5. **Opening message `sent` or `unknown`:** contact `last_opening_message_at`, run `dm_sent_at` (an `unknown` DM counts as sent: a new comment on that post sends nothing), comment log `opening_dm_status`. `sent`: the run waits for `opening_message_button`. `unknown`: the run waits for `any`.
6. **Public reply and hide:** the DM of a comment run went (`sent`): make the public reply (section 29.2). No reply row for this comment: make the hide (section 29.4). An `unknown` DM that becomes `sent` later gets them then (only within 7 days of the comment). Live comments get neither.
7. **Nudge:** a hello `sent` in a run that started from her message (section 30.7): make the `nudge` row, `not_before` = sent time + 60 minutes (`NUDGE_AFTER_MINUTES`).
8. **Message list:** a picture row `sent` or `failed`: make its text row right away (section 30.3). Message N `sent`: the run's `last_message_no` = N (for the condition "got message N of X", section 8), and make message N+1 with its wait (section 30.6). The last one: the tag step (with its `app.contact_tag_events` rows) and the run `completed` (section 27.10).
9. **Errors:** the stop rules of section 33 (lane stop, account stop, connection stop, automation stop).
10. **Lane** (slow and reply only): **only if** `working_turn` is this ticket's turn:
    - `working_turn` and `lease_until` cleared, state `ready` or `sleeping`;
    - `turn_no` = the lane's current `turn_no` + 1 (higher than any turn an owner action made meanwhile);
    - `next_run_at` = the next box second (section 28.3), or the stop end;
    - after the commit: add the ticket with the new turn.
    If `working_turn` is not mine (the helper took the lane over): save only steps 2 to 9. Never touch the lane.
11. **Fast:** `sending_count` - 1 on the fast row (only when the message leaves `sending` in this transaction).
12. Commit. Then add tickets, write Redis notes, give back Redis counts if step 4 ran.
13. The commit fails: section 33.9 (save-result job).

### 28.5 Nothing can go now

The worker still holds the lane row lock, so no new message can be missed.

1. Something can go later (a `not_before`, the 24 hours, the box): the lane `sleeping`, ticket at the earliest of these times.
2. Nothing at all: the lane `ready` with no ticket. Intake wakes it (section 28.6).

### 28.6 Waking a lane (intake, owner actions)

After a message is committed, look at the lane row (slow, reply or broadcast):

1. `ready` with no ticket: `turn_no` + 1, `next_run_at` = the time the message may go (its `not_before`, or the next box second), add the ticket.
2. `sleeping` and the new message may go **earlier**: the same, with the earlier time. The old sleeping ticket is removed (BullMQ remove). If that fails, its old turn drops it later.
3. `working`, sleeping until an earlier time, or `stopped`: change nothing.

### 28.7 Owner action during a send (forced new turn)

The owner changes a limit or presses Resume while a DM is on its way.

```text
turn_no 10, working_turn 10, DM on its way
owner changes the limit  --> turn_no 11, ticket slow-A-11 added
ticket 11 wakes          --> lane is `working` with a valid lease --> dropped
worker of turn 10 saves  --> working_turn 10 is mine --> turn_no = 11 + 1 = 12
                         --> ticket slow-A-12 added. Stop (if any) is saved.
```

The worker that sends always finishes the lane, because the result save checks `working_turn`, not `turn_no`. A "blocked" result in that call is never lost, and the lane never waits for the helper.

### 28.8 Ad comments

1. Meta's comment webhook carries `media.ad_id`, `ad_title` and `original_media_id` on ad comments. Comments on boosted posts come with the post's comments. Comments on dark ads (not boosted posts) need the ad's post from the Marketing API (`effective_instagram_media_id`, read with `ads_read`). Test needed with our setup (section 43).
2. Then an ad comment is a comment: window closed, the same slow lane, the same box and the same 7 days; window open, a normal DM in the fast lane (27.3, step 10). The same once rule (the media id), the same public reply and hide options.
3. Only finding the automation differs: the ad comment automation matches by `media.ad_id`, or by its ad's post (27.3, step 4).
4. Ad comments use the same private reply limit as other comments (Meta: 750 per hour per account; ours 600).

## 29. Reply lane turn (public replies ON and OFF, hides)

Public replies and hides never hold back a DM. One account's reply lane sends **one** call at a time. "Reply like a person" is chosen **per automation** (section 13). On Creator and Studio a new automation starts with it ON (`REPLY_LIKE_PERSON_DEFAULT_PAID` true). Free has OFF only.

### 29.1 What goes in the reply lane

| Row | Made when | Timing | Counts |
|---|---|---|---|
| `public_reply`, "Reply like a person" **OFF** (the only choice on Free) | Right after the DM of her comment went | Right away. No chance skip, no hour limit or cap, no box, no 500 cap, no gap (the risk that Meta flags a Free account is accepted) | Group `reply` (counted, no limit). Not a DM |
| `public_reply`, "Reply like a person" **ON** (PRO; the default for new automations on Creator and Studio; on a plan without PRO it works as OFF, D57) | After the DM went, if the 80% draw says yes | A random second in the automation's box, at least 20 s after the account's last ON reply, newest first, at most 500 waiting per automation | Group `reply` (counted, no account limit). Not a DM |
| `hide_comment` | After her public reply ended, or right after the DM when there is no reply row | Right away | Group `none`. Not a DM. Not in any limit |

Both reply modes: up to 7 days after the comment, then `expired`. Never on a deleted, hidden or Live comment. "Too fast" on a reply stops only replies (section 33).

### 29.2 How a public reply is made

1. Only for comment runs (and ad comment runs) whose automation has the reply step ON (`public_reply_enabled`). Never for Live comments.
2. Made by the result save, **after** the DM of that comment went (the opening DM or the first direct message), also when her window was open.
3. **OFF** (`reply_like_person` false): always one row, `not_before` = now.
4. **ON** (`reply_like_person` true, and the plan has PRO): a random number decides now. On a plan without PRO (after a move down) the automation's replies go as OFF (rule 3) and only its first line is used (D57). Under 80% (`PUBLIC_REPLY_CHANCE_PERCENT`): the row is made. Else: no row, comment log `public_reply_status` = `skipped`, reason `random`. People do not answer every comment.
5. One reply per comment (meepzo-be's `duplicate` rule).
6. **ON: at most 500 waiting per automation** (`PUBLIC_REPLY_MAX_WAITING`): `waiting_count` + 1 in `app.automation_reply_state`. Over 500: the oldest waiting reply of this automation becomes `skipped` (`hour_limit`), `waiting_count` - 1, and its hide row is made (29.4).
7. **Text:** one of the automation's lines at random: 1 to 20 (`PUBLIC_REPLY_TEXTS_MAX`); ON needs at least 3 (`PUBLIC_REPLY_LINES_MIN_ON`, a go-live check). Never the same as the automation's last one (`last_text_no`) when it has 2 or more. It starts with `@{username}` when the automation's `public_reply_mention` is on (default true, `PUBLIC_REPLY_MENTION_DEFAULT`) and we know her username. Off: the line goes without `@username`. Example: "@riya.k Sent you a DM 💌". Test needed (section 43): the tag must show and not be refused.
8. Then wake the reply lane (section 28.6).
9. **A reply under another comment** (`parent_id`, switch ON): the public reply goes under the top-level comment (Meta puts replies to replies there). A hide hides her own reply comment.

### 29.3 Reply state per automation

`app.automation_reply_state` has one row per automation with replies ON.

| Column | Meaning |
|---|---|
| `box_start` | Start of the automation's current box (ON only) |
| `last_text_no` | The last text it used (never the same twice in a row) |
| `waiting_count` | Its waiting public replies (ON: the 500 cap) |

1. **Box** = 3600 / the automation's hour limit. The owner picks 10, 20, 30, 60 or 100 (`REPLY_LIKE_PERSON_LIMITS`), default 60 (`REPLY_LIKE_PERSON_LIMIT_DEFAULT`), saved in `app.automations.public_reply_hour_limit`. 60 per hour = 60 second boxes. 10 per hour = 360 second boxes.
2. **Random second** inside the box: worked out from the automation id and `box_start` (a hash), in milliseconds. It is the same every time it is worked out, so a lost ticket finds the same second and no extra column is needed.
3. One reply per box. Missed boxes are never sent together. After a reply: the next box starts at `box_start` + box; if that box is already over, a new box starts now.
4. **Gap:** at least 20 seconds after the account's last **ON** reply (`PUBLIC_REPLY_GAP_MIN_SECONDS`, the reply lane's `last_sent_at`, set only by ON replies; OFF replies and hides do not move it). Two ON automations of one account never reply within 20 seconds of each other.
5. Meta's usage header (`X-Business-Use-Case-Usage`) after each call, highest value kept in `usage:{account}`:
   - 80% or more (`USAGE_SLOW_PERCENT`): ON boxes x 2 (`REPLY_USAGE_FACTOR`). OFF replies do not change;
   - 95% or more (`USAGE_STOP_PERCENT`): all replies and hides wait until the time Meta gives, or 15 minutes (`USAGE_WAIT_DEFAULT_MINUTES`).
6. The owner changes the automation's limit: a new box starts now with the new size.

### 29.4 How a hide is made

1. Only if the automation has "Hide their comment once the DM is sent" (`hide_comment_after_dm`). Never for Live comments.
2. **Order:** public reply first, then hide. A hidden comment cannot get a public reply.
3. The hide row is made in the same commit as:
   - the end of her public reply (`sent`, `failed`, `skipped`, `expired`), or
   - the DM's `sent`, when this comment gets no reply row (the reply step is OFF for the automation, or ON and the draw said no).
4. Row: type `hide_comment`, lane `reply`, channel `comment_hide`, `not_before` = now.
5. Call: `POST /<comment id>?hide=true` (`instagram_manage_comments`). The comment log gets `hide_status` and `hidden_at`.
6. A failed hide never changes the DM, the reply or the run. It is `failed` and never counts "in a row" (section 33.2).
7. The comment is gone: `skipped` (`deleted_comment`). Over 7 days after the comment: `expired` (`PUBLIC_REPLY_MAX_AGE_HOURS`).

### 29.5 Steps of one reply turn

The same shape as the slow lane (section 28.1), with these changes:

1. **No gate 1.** The reply lane has no account hour limit any more. Gate 2 still adds + 1 to group `reply` for each public reply in the claim commit (for the watch numbers; the "in a row" rules read the attempt rows). Hides are group `none`. The month count is never added here, and the month limit never stops this lane: public replies and hides of DMs that already went still go (section 31.3). `plan_ended` and `plan_downgrade` do stop it.
2. **Pick**, in this order:
   - a waiting hide or OFF reply whose `not_before` is over: oldest first (they go "right after");
   - else, for each ON automation whose box second is reached and whose gap is over: its newest waiting reply (index `(instagram_account_id, trigger_occurred_at DESC)` on `waiting` rows of lane `reply`). Take the newest of those.
   Only rows of automations that still have replies (or hides) ON. Rows of an automation whose reply step was turned OFF: `cancelled` (`cancelled_by_owner`).
3. **Lock** the picked message (`skip locked`), then its automation's `automation_reply_state` row (ON only).
4. **Checks again:** expired (comment time + 7 days - 30 minutes is over) becomes `expired`. A deleted or hidden comment, or a Live comment: `skipped`. Her contact is excluded by the owner (27.17): `skipped` (`contact_excluded`).
5. **Claim commit:** message `sending`, attempt row, lane `working`, `working_turn`. ON: `box_start` moves to the next box, `last_text_no` saved, `waiting_count` - 1.
6. **Call:** a reply under her comment (Meta's comment replies endpoint), or the hide.
7. **Errors stop only replies:** "too fast", "blocked" or "flagged" on a reply or a hide stops only the `reply` lane (section 33). Answers and DMs go on. Login not valid or access off stops all lanes, as for a DM.
8. **Tests:** a stop of **only** the reply lane is tested with one public reply (or a hide, if no reply waits). Every other stop is tested with a DM, never with a reply (section 33.4).
9. **Next ticket:** the earliest of: a waiting hide or OFF reply (now), and each ON automation's next box second (at least 20 s after the last ON reply). Nothing waits: the lane `ready` with no ticket.

### 29.6 Example: OFF and ON on one account

Account A has two comment automations. GUIDE: reply OFF, hide ON. PRICE: reply ON, 10 per hour.

1. 10:00:00 Riya comments "GUIDE". Her DM goes at 10:00:04. The reply row is made at once. 10:00:04.6 "@riya.k Check your inbox" goes under her comment. 10:00:05.3 her comment is hidden.
2. 10:00:10 Aman comments "PRICE". His DM goes at 10:00:16. The draw says "reply". PRICE's box is 360 seconds (10:00:00 to 10:06:00). Its random second is 10:03:41. At 10:03:41 the reply goes.
3. 10:03:50 Sara's GUIDE reply is due. It goes at once: OFF has no gap, even 9 seconds after Aman's reply.

## 30. Fast messages (many at once)

### 30.1 Which messages are fast

Broadcast messages are not fast: they have their own lane (30.14). Mark seen calls are not messages (30.13).

Fast messages are: the hello when her window is open, Live private replies, the nudge, the follow check, the follow request, the email and phone questions, the "invalid email" message, every `message` of the list, and every direct message after a start from her chat.

Each one has its **own** ticket. Many messages of one account go at the same time, at most 20 (`FAST_MAX_PARALLEL_PER_ACCOUNT`). One person gets one message at a time. There is no gap per account.

### 30.2 Steps of one fast ticket

```text
ticket fast-90311-1 wakes
  1 gate 1 LOOK (Redis) ------------------- full --> same ticket back at the free time
  2 BEGIN; lock contact (skip locked) ---- busy --> back in 1,000 ms
  3 lock message (skip locked) ----------- not `waiting` / not fast --> drop
  4 not_before over? ---------------------- no --> back at not_before
  5 another message of hers `sending`? --- yes --> back in 1,000 ms
  6 checks: automation, opted out, window, Live, nudge, expiry
  7 person limit (60 per hour) ------------ full --> back when a place is free
  8 lock fast lane row: paused / stopped / plan stop / test / 20 at once / audio
                                           busy --> back in 500 ms
  9 GATE 2 (group fast) + MONTH COUNT ----- full --> back at the free time
                                           month full --> plan stop, no ticket
 10 `sending`, attempt row, counts + 1, sending_count + 1; COMMIT
 11 Redis counts +1; file id or upload; call Meta (max 15 s)
 12 save result (shared function), sending_count - 1
 13 next step or next message --> new row + its delay or wait + ticket
```

1. **Gate 1 look** (Redis, no transaction): a `fast` place free? No: the same ticket back at the free time.
2. **Begin.** Lock the contact row with `for update skip locked`. Not got: the same ticket back in 1,000 ms (`FAST_PERSON_BUSY_RETRY_MS`).
3. Lock the message (by id and its run start time, so Postgres reads one part) with `for update skip locked`. It is not `waiting`, or not in lane `fast`: drop the ticket (it was done, or it changed lane).
4. `not_before` is not over: the same ticket back at `not_before`.
5. **One person at a time:** another fast message of hers is `sending`: back in 1,000 ms.
6. **Checks:**
   - opted out: `skipped` (`opted_out`), drop;
   - excluded by the owner (27.17): `skipped` (`contact_excluded`), drop;
   - automation deleted: `cancelled` (`automation_deleted`), drop. Paused with Cancel (`cancelled_before_at`): `cancelled` (`cancelled_by_owner`), drop. Paused with Keep: people in a chat finish, so it goes;
   - automation stopped (refused text): it waits, no ticket (it goes after the owner fixes the text);
   - an email or phone question, and the plan has no PRO (after a move down): `skipped` (`plan_feature_off`), drop; the run moves on to its next step (D57);
   - **Live private reply:** its comment is over 240 minutes old (`LIVE_REPLY_MAX_AGE_MINUTES`): `expired` (`live_ended`), drop. No window check (a private reply needs no window);
   - **nudge:** she tapped or wrote after the hello: `cancelled` (`answered`), drop;
   - **window closed** (no message from her in the last 24 hours minus 15 minutes, `WINDOW_SAFETY_MINUTES`):
     - a direct message that came from a comment: the same row goes back to lane `slow`, channel `private_reply`, in one update "only if `waiting`" (section 27.12), if under 7 days;
     - a direct message that came from a Live comment: the same row changes to channel `private_reply` (lane stays `fast`), if the Live is still on;
     - a `message` of the list: `skipped` (`window_closed`); no later message is made; the run ends (section 30.6);
     - a nudge: `skipped` (`window_closed`); the run still waits for her tap;
     - a direct message after a start from her chat, or an answer: `skipped` (`window_closed`); the run waits for `any`.
   This claim transaction sets **only the message**. The run changes right after the commit, in its own short transaction in lock order (contact, automation, run), or in the result save.
7. **Person limit:** she got 60 automatic messages in the last 60 minutes (`PERSON_HOUR_LIMIT_DEFAULT`, counted in Postgres: her fast and broadcast message rows with `sending_at` in the last 60 minutes, except follow checks; a picture and its text are 2 rows): set `not_before` = the time a place for her is free, ticket at that time. A loop guard: two bots never talk forever.
8. **Lock the account's `fast` lane row** (a short wait is fine: this transaction is a few milliseconds):
   - paused or suspended: the message stays `waiting`, no ticket (Resume adds them);
   - stopped `plan_limit`, `plan_ended` or `plan_downgrade`: the message stays `waiting`, no ticket (the `month-wake` or `plan-change` job adds them, spread over 5 minutes);
   - stopped, time not over: the message waits, no ticket (the helper adds them when the stop ends, spread over 5 minutes);
   - stop time over: this message is the account's **test** (section 33.4): take the test claim on the `slow` row with `skip locked`. Not got: back in 30 seconds;
   - `sending_count` is 20 or more: back in 500 ms (`FAST_ACCOUNT_BUSY_RETRY_MS`);
   - an **audio** message, and 5 audio messages of the account are already `sending` (`AUDIO_MAX_PARALLEL_PER_ACCOUNT`): back in 500 ms. With about 1 second per call this is about 5 per second (estimate), under Meta's 10 per second for audio and video.
9. **Gate 2 and the month count** (section 31): the last 60 minutes of group `fast` have no room: back at the free time. The fast limit is the owner's value, else 10,000 per hour (`FAST_HOUR_LIMIT_DEFAULT`). A follow check is not a message: group `none`, it does not count anywhere. The month count has no room: write nothing; after the rollback the workspace's lanes stop `plan_limit` (section 31.3); no ticket.
10. Message `sending` (`tries` + 1, `sending_at`), **only if** still `waiting` and lane `fast`; one attempt row; minute count + 1 and month slot + 1 (neither for a follow check); `sending_count` + 1. **Commit.**
11. After the commit: Redis counts + 1. A message with a file: find its attachment id, or upload it first (30.4). **Call Meta** (the send API to her Instagram id; a Live reply to the comment id; the follow check is a read). At most 15 seconds. Meta said OK: write the `mid:` note first.
12. **Save the result** with the shared function (section 28.4). It sets `sending_count` - 1.
13. **Next step:** when the next step needs no answer from her, the result save creates the next row and the ticket is added after the commit:
    - after a **follow check**: the next message goes with **no extra delay** (the check sent nothing to her, so she is still waiting for an answer);
    - after a **picture row**: its text row goes with **no extra delay** (30.3);
    - after a `message` of the list: the next one waits its own wait (30.6);
    - after any other result: the next message gets a **new random delay** (500 to 2,000 ms) from now (no extra delay: that is only for the first answer, 30.12).
    After a `sent` automation message: the mark seen call, when it is on (30.13).
    When the step needs her answer (a button, the email), the run waits.

### 30.3 Message kinds and their calls

Every message row that goes into her chat is 1 DM in the fast hour count, the person limit and the month count (section 31.3).

| Kind (`message_kind`) | What she gets | Meta call | Limits from Meta (settings) |
|---|---|---|---|
| `text` | Text, up to 3 link buttons | Send API: text, or a button template when it has buttons | Text 1,000 **bytes** (`MESSAGE_TEXT_MAX_BYTES`; an emoji or a Gujarati letter is 2 to 4 bytes). With buttons: 640 characters (`BUTTON_TEXT_MAX_CHARS`), 1 to 3 buttons (`LINK_BUTTONS_MAX`), titles 20 characters (`BUTTON_TITLE_MAX_CHARS`) |
| `image` | One picture | Attachment (image) by its attachment id | png or jpeg, 8 MB (`MESSAGE_IMAGE_MAX_MB`) |
| `cards` | Product cards: picture, title, line, link each | Generic template | 10 cards (`CARDS_MAX`); title and line 80 characters each (`CARD_TITLE_MAX_CHARS`, `CARD_SUBTITLE_MAX_CHARS`); up to 3 buttons per card; each card needs one more field besides the title. Not shown on desktop |
| `quick_replies` | Text with tap choices | Text + `quick_replies` | 13 choices (`QUICK_REPLIES_MAX`), titles cut after 20 characters (`QUICK_REPLY_MAX_CHARS`), text only. Not shown on desktop |
| `audio` | A voice note | Attachment (audio) by its attachment id | aac, m4a, wav or mp4, 25 MB (`MESSAGE_AUDIO_MAX_MB`). Meta: 10 per second per account for audio and video (30.2, step 8) |
| `file` | A PDF | Attachment (file) by its attachment id | 25 MB (`MESSAGE_FILE_MAX_MB`) |
| `post` | One of the account's own posts ("Newest" = the newest post at send time) | Media share (`MEDIA_SHARE`) | Works only for the account's own posts (Meta) |

The hello, the nudge and the follow ask are button templates (text up to 640 characters, up to 3 buttons, `HELLO_BUTTONS_MAX`). Starter questions are not messages: the `starter-questions` job sets them with `messenger_profile` (payload `starter:<automation public id>:<question no>`; 1 to 4 per automation and at most 4 per account, `STARTER_QUESTIONS_MAX`; not shown on desktop).

Test needed on Unified Login (section 43), because Meta documents these only for the other login: quick replies, product cards, the button template, starter questions, the user profile (follow check), typing dots and attachment upload.

**A message with a picture and a text** is 2 rows with the same `message_no`: the picture row (kind `image`) and the text row (kind `text`).

1. The picture row is made first. When it is `sent`, the result save makes the text row with **no extra delay** (like after a follow check). One person gets one message at a time, so they arrive in order.
2. Each row is one call, its own claim and 1 DM in every count.
3. The picture row `failed` (for example every upload failed, 30.4): the text row still goes.
4. The picture row is `skipped` for a closed window: the list ends (30.6). `unknown`: the list waits for her next message (section 14).
5. Message N+1 is made when N's last row is `sent`.

### 30.4 Files: upload once per account

1. Files (pictures, voice notes, PDFs, card pictures) live in meepzo-be's upload domain, which scans every uploaded file. A file that is not scanned clean cannot be used in a message (go-live refuses it, and the upload job skips it).
2. Meta gets each file **once per account**. Its attachment id is saved in `app.meta_attachments` (one row per account and upload) and used again for every person.
3. **When:** the `attachment-upload` job uploads each file of an automation when it goes live, and again when a file changes (24.3). So a DM rarely waits for an upload.
4. **No id yet at send time:** the fast worker uploads it after the claim commit and before the send (one call, at most 15 seconds, group `none`, not a DM). The id is saved in its own small commit ("on conflict do nothing").
5. **Attachment error** at send (`CODES_ATTACHMENT_GONE`, the codes: test needed), or an upload that fails: the result save deletes the cached id, gives the places back, and puts the message back to `waiting` with a new random delay. The next try uploads again. After 3 tries (`ATTACHMENT_UPLOAD_TRIES`): `failed`, reason `attachment_failed`, and it is not counted (nothing reached her chat). Its text row still goes (30.3).
6. An upload error that is a stop (too fast, login, access off) works like any stop (section 33).
7. A file deleted from the upload domain: its `app.meta_attachments` rows go with it (cascade).

### 30.5 Live private replies

1. Made by intake from a Live comment (section 27.4): the first step of the run, lane `fast`. Her window closed: channel `private_reply` (a private reply to her Live comment). Open: a normal DM (channel `direct`).
2. Sent as a private reply to the Live comment id, while the Live is on (Meta). Meta allows 100 per second per account for these (`LIVE_PRIVATE_REPLY_PER_SECOND`, fixed). Our 20 at once stays far under it.
3. One per comment (one run per automation, person and Live, 27.4).
4. They count in the fast limit, the person limit and the month count.
5. **Live over:** Meta answers "Live ended" (`CODES_LIVE_ENDED`, the codes: test needed): `expired`, reason `live_ended`. It never counts "in a row".
6. A Live reply that waited (a stop, the month limit) longer than 240 minutes (`LIVE_REPLY_MAX_AGE_MINUTES`, estimate: an Instagram Live lasts at most 4 hours) is `expired` (`live_ended`) without a call (30.2, step 6, and the helper, section 34, rule 10).
7. No public reply and no hide, ever.
8. After her tap the next steps are normal DMs (her window is open).
9. **Is the Live still on?** `GET /<account>/live_media` lists only the Lives on air now (Meta). The helper asks it once a minute for each account with waiting Live private replies (section 34, rule 10). A Live not in the list has ended: its waiting private replies become `expired` (`live_ended`), and `instagram_media.live_ended_at` is saved. Meta's Live comment webhooks stop when the Live ends.

### 30.6 Waits between messages, and the window

1. Each `message` of the list has a wait before it: none, or 1 minute to 23 hours (`MESSAGE_WAIT_MAX_HOURS`).
2. Message N+1 is made by the result save when message N is `sent` (its text row, when it has a picture and a text). Its `not_before` = N's sent time + its wait. No wait: the random delay (500 to 2,000 ms). It waits as a delayed ticket. No worker ever waits.
3. N is `unknown`: N+1 is not made. The run waits for `any`. Her next message sends N once more (section 14), then the list goes on.
4. **Window check just before sending** (30.2, step 6): her last message + 24 hours - 15 minutes. Closed: this message is `skipped` (`window_closed`), no later message is made, no tags are added, and the run ends `cancelled` with reason `window_closed`.
5. She writes before the wait is over: her window moves on, so the next messages can still go.
6. A wait never moves a message to another lane. A list message is never a private reply after the first one.

### 30.7 Nudge

1. Only for runs that started from her message: story reply, DM keyword, story mention, first message, shared post, starter question, link, ad message, and a tag start (her window was open). Never for comments or Live comments.
2. Only when the automation has "Nudge once" ON and the hello has a "sends your next step" button.
3. **Made** by the result save when the hello is `sent`: type `nudge`, lane `fast`, channel `direct`, the hello's version, `not_before` = sent time + 60 minutes (`NUDGE_AFTER_MINUTES`). A delayed ticket.
4. **Cancelled** by her tap on the hello, or any message from her (intake, 27.5 and 27.6): `cancelled`, reason `answered`. The fast worker checks again before it sends (30.2, step 6).
5. **Window closed** when it is due: `skipped` (`window_closed`). The run still waits for her tap.
6. Once only: a nudge never gets a nudge. It counts as a DM (month count, fast limit, person limit).
7. Its buttons carry the same run, so a tap on the nudge moves the run like a tap on the hello (and counts as the run's first tap, 27.11).

Example: 18:00:00 Riya replies to A's story. 18:00:01.2 she gets the hello with "Send me the link". She does not tap. 19:00:01.2 the nudge goes (the same text, version B like her hello). 19:04 she taps. Message 1 goes at 19:04:01.1.

### 30.8 Hello buttons and quick replies: her tap

1. A "sends your next step" button is a postback with our payload (`<aut_…>::<run_…>::<msg_…>`). Her tap comes as a `postback` event (section 27.5).
2. An "opens a link" button sends us nothing. If the hello has later steps, the go-live check needs at least one "next step" button (section 5).
3. A quick reply tap comes as a `message` with `quick_reply.payload`. It is an answer like text (section 14). Her choice is saved on the run's history. The list does not wait for it: the next message follows its own wait.
4. Quick replies are not shown on desktop (Meta). A desktop person can still type.

### 30.9 Follow check: 2 tries, then "following"

```text
follow check, try 1 --> OK --------------------------> following? yes -> next step
        | error that is not a stop                          no  -> follow request
        v
  back to `waiting`, not_before = now + random 2,000 to 5,000 ms
        |
follow check, try 2 --> OK --> as above
        | error again
        v
  check done, reason `assumed_following` --> next step (email, phone or message 1)
```

1. Only if the automation has the follow step.
2. A stop error (blocked, too fast, login not valid, message access off, app limit): the stop rules of section 33. The check waits like any message. It is never a test.
3. Any other error (for example Meta refuses the profile read because she gave no consent): try once more after a random 2,000 to 5,000 ms (`FOLLOW_CHECK_RETRY_MIN_MS`, `FOLLOW_CHECK_RETRY_MAX_MS`). 2 tries in all (`FOLLOW_CHECK_TRIES`).
4. The second try fails too: the check is done with reason `assumed_following` (`FOLLOW_CHECK_FAIL_MEANS` = following). The contact's follow field is not changed. The next step goes.
5. Follow-check errors never count for the "3 different people in a row" rule (section 33.2, rule 3).
6. A timeout on a follow check: nothing was sent to her, so it never becomes `unknown`. It counts as a failed try.
7. When she taps "I'm following" or writes after a follow request, the same follow-check row goes back to `waiting` for a new check.
8. The follow request uses the version picked for the run (27.10).
9. Test needed (section 43): her button tap counts as consent for the profile read (Meta: consent = she sent a message, or tapped a starter question or a menu).

### 30.10 Example: 3 people tap at the same second

```text
time (ms)  0         600        1,200      1,800      2,400      3,000
Riya       tap ------[delay 1,140]--> send  --> OK 1,900
Aman       tap ---------[delay 1,610]-------> send --> OK 2,350
Sara       tap ---[delay 730]---> send --> OK 1,420
                                            all 3 answered in under 2.5 seconds
Riya taps again at 2,000 (her own 2nd message):
           waits while her 1st is `sending`; goes at its own delay after that.
```

1. 10:00:00.000: Riya, Aman and Sara tap buttons of account A.
2. Intake saves 3 fast messages, each with its own random delay: 1,140 ms, 1,610 ms and 730 ms.
3. Three fast tickets wake at those times on 3 free places. Each locks only its own contact. The `fast` row is locked for a few milliseconds each time, to count.
4. All 3 answers go in parallel. Nobody waits for the others.

### 30.11 Example: a message list with waits

Automation FREEBIE: hello, then message 1 (text with a picture, no wait), message 2 (PDF, wait 2 hours), message 3 (text, wait 23 hours).

```text
Riya taps the hello at 10:00 (her window is open until 09:45 the next day)
  message 1, picture + text, no wait -> 10:00:01  sent (2 rows = 2 DMs)
  message 2, PDF, wait 2 h           -> 12:00:01  sent
  message 3, text, wait 23 h         -> 11:00:01 next day: window closed at 09:45
                                        -> `skipped` window_closed, run `cancelled`
If Riya writes "thanks" at 15:00, her window lasts until 14:45 the next day,
so message 3 goes at 11:00:01 the next day.
```

Month count for this run: hello 1 + message 1 (2) + message 2 (1) = 4 DMs.

### 30.12 Delay before each message (PRO)

1. Account settings `extra_delay_seconds_min` and `extra_delay_seconds_max` (both empty = off). Each 1 to 20 seconds (`EXTRA_DELAY_MAX_SECONDS`), min not over max. PRO only: on a plan without PRO it is off (the plan is in the `acct:` copy).
2. **Extra delay** = min + (max - min) x (r1 + r2) / 2 seconds, two new random numbers for each message, in whole milliseconds. It is added to the normal 500 to 2,000 ms.
3. **Used once per her event:** only on the **first** answer message we send after her tap, typed answer, story reply or DM. Later messages with no wait get the normal 500 to 2,000 ms. **Never** after a follow check, and never for slow-lane private replies (box timing), public replies, hides, nudges, list waits or broadcasts.
4. **30-second rule:** her event time + the random delay + the extra delay may be at most 25 seconds after her event (`BOT_ANSWER_MAX_SECONDS` 30 minus `BOT_ANSWER_SAFETY_SECONDS` 5). Later than that: the extra delay is cut.
5. It is only a later `not_before`: a delayed ticket. No worker waits.

Example: min 3, max 8. Riya taps at 10:00:00.000. The random delay is 1,140 ms, the extra delay 5,420 ms. Her answer goes at 10:00:06.560.

### 30.13 Mark seen

1. Account setting `mark_seen_after_reply` (default off).
2. **ON:** after a fast-lane automation message to her is `sent`, the same fast ticket makes one more call: `sender_action` `mark_seen` for her chat. No message row. One attempt row with `count_group` `none`: not a DM, no month count, no fast-limit count.
3. **At most once per message of hers:** the Redis note `seenmark:{account}:{contact}` holds the id of her last inbound message we marked (as in 14.6 and section 23) (24 hours, `MESSAGING_WINDOW_HOURS`). Her last message is not newer: no call. A lost note costs at most one extra call.
4. **Skipped** when the owner typed to her by hand after her last message, when her last message is outside her window, or when she is excluded (27.17).
5. **Errors** are ignored: no retry, no stop. Only account-stop errors (blocked, login not valid, message access off, app limit) stop as usual (section 33).
6. Test needed (section 43): `mark_seen` on Unified Login (Meta's sender-actions page shows only the other login).

### 30.14 The broadcast lane

Broadcasts (section 8, PRO) go in a 4th lane per account: `broadcast`, one row in `app.instagram_send_lanes`, its tickets in the slow queue. One message at a time, at a random second in each box. **Meta's rule:** a broadcast message may go only to a person whose chat window is open. It is checked when the list is made and again just before each send.

How the recipients are made:

| Mode | Who makes the recipient rows | When |
|---|---|---|
| Send now | The `broadcast-audience` job (24.3) | At once |
| Send at a set time | The same job, started by the helper (section 34, rule 30) | At `scheduled_at` |
| Deliver when her chat opens | The intake hook (27.15) | When she writes, until `ends_at` |

**The `broadcast-audience` job:**

1. Reads the account's contacts that match the conditions (section 8), in pieces of 500 by contact id (`BROADCAST_AUDIENCE_PIECE`). Hard conditions use the list of the `segment-count` job.
2. Leaves out: opted out, excluded by the owner (27.17), deleted, got a broadcast in the last 24 hours (`BROADCAST_MIN_GAP_HOURS`), window closed now.
3. Each piece, one commit: per person a recipient row `waiting` and message 1 (type `broadcast`, `broadcast_id`, lane `broadcast`, channel `direct`, a version picked); `matched` + the count. After the commit: wake the broadcast lane (28.6), then the next piece.
4. The broadcast stays `sending` until no recipient waits (section 34, rule 31).

```text
ticket broadcast-A-7 wakes (lower priority than slow and reply tickets)
  1 gate 1 LOOK (cnt:broadcast:A) -------- full --> ticket back at the free time
  2 BEGIN; lock lane row (skip locked) --- busy --> same ticket back, 1 s
  3 turn 7? lease? ----------------------- old turn or working --> drop
  4 pause / stop / plan stop / test ------ stopped --> no ticket, or at stop end
  5 box second reached? ------------------ no --> ticket at that second
  6 pick: her window closes soonest first; lock contact + row (skip locked)
  7 checks again: opted out, window, 24 h gap, cancelled, person limit
  8 GATE 2 (group broadcast) + MONTH COUNT + `sending`; COMMIT
  9 Redis counts +1; call Meta (send API, a normal DM); OK --> mid: note
 10 save result: message, recipient, broadcast counters; turn + 1
 11 her next message of this broadcast (if any); next ticket at the next box
```

Steps in words:

1. **Gate 1 look:** `cnt:broadcast:{account}` (section 31.1).
2. **Begin.** Lock the account's `broadcast` lane row with `skip locked`. Not got: back in 1 second (`LANE_BUSY_RETRY_MS`).
3. **Turn check** as the slow lane (28.1, step 3).
4. **Stops** as the slow lane (28.1, step 4): all accounts stopped, paused, suspended, `plan_limit` (a broadcast is a new DM), `plan_ended`, `plan_downgrade`, error stops and the test.
5. **Box:** box = 3600 / the broadcast hour limit: the owner's `app.instagram_account_settings.broadcast_hour_limit` (1 to 2,000, `BROADCAST_HOUR_LIMIT_MAX`), empty = 600 (`BROADCAST_HOUR_LIMIT_DEFAULT`). A random second in each box, at least 1,500 ms after the lane's last send (`OPENING_MIN_GAP_MS`). Half speed: box x 2. Missed boxes are never sent together.
6. **Pick:** the waiting broadcast message whose `not_before` is over and whose person's window closes soonest (her oldest `last_direct_message_received_at` first), across the account's active broadcasts. So more people get it before their window closes. Her contact and the row are locked with `skip locked`: another message of hers on its way, pick the next one. At most 5 picks per turn (`PICK_TRIES_PER_TURN`).
7. **Checks again**, on this one message (the recipient row gets the same status and reason):
   - opted out: `skipped` (`opted_out`);
   - excluded by the owner (27.17): `skipped` (`contact_excluded`);
   - window closed (24 hours minus 15 minutes): `skipped` (`window_closed`);
   - she got another broadcast in the last 24 hours: `skipped` (`recent_broadcast`);
   - the broadcast was cancelled: message `cancelled`, recipient `skipped`, both with reason `broadcast_cancelled`;
   - mode "when her chat opens" and the owner typed to her within `OWNER_CHAT_QUIET_HOURS`: `skipped` (`owner_chat`); it does not use up the broadcast for her: her next message after the quiet time puts the same rows back to `waiting` (27.15);
   - person limit full (60 per hour): `not_before` = the free time, pick again.
8. **Gate 2 and the month count**, one commit: the minute row of group `broadcast`, the month slot (a broadcast is a DM), message `sending`, attempt row, lane `working`, `working_turn`, lease.
9. **After the commit:** Redis counts + 1. Call Meta: the send API to her Instagram id, a normal DM inside her window (no message tag). `mid:` note first.
10. **Save the result** (shared function, 28.4): message, recipient (`sent`, `skipped`, `failed`, `unknown`), the broadcast's counters (`sent`, `skipped`, `failed`), her `last_broadcast_at`. Lane: the next box second, turn + 1.
11. **Next message:** a broadcast has 1 to 3 messages (`BROADCAST_MESSAGES_MAX`). Her message N+1 is made when N is `sent`, in this lane, `not_before` = now + the random delay. It waits for a box like any broadcast message.
12. **Her answer:** her first message after it sets the recipient's `replied_at` and adds 1 to `replies` (once per recipient, because `replied_at` is set only once). A tap on a broadcast button adds 1 to `taps`, and a "start automation X" button starts X for her (27.5).

Rules:

1. **Lowest priority:** broadcast tickets carry BullMQ priority 10 (`BROADCAST_TICKET_PRIORITY`), so slow and reply tickets go first when places are busy. Its own minute-count group: it never takes room from the opening or fast limits.
2. **Counts:** group `broadcast`, the month count and the person limit.
3. **Errors:** "too fast" on a broadcast stops only the broadcast lane, for twice the time (`BROADCAST_STOP_FACTOR` 2). A "too fast" stop of the slow or fast lane stops the broadcast lane for the same time too. Account stops (blocked, flagged, login, access, app limit, down) stop it with the other lanes (section 33).
4. **Test:** a stop of only the broadcast lane is tested with one broadcast message (section 33.4).
5. **Audit:** every send and cancel by the owner goes to the audit log.

Example: the owner of A sends broadcast NEWDROP now to tag "lead". 1,240 match; 310 have an open chat, so 310 recipient rows are made. At 600 per hour one goes every 6 seconds: about 31 minutes for all (estimate). The people whose window closes soonest go first, so few are `skipped` (`window_closed`).

## 31. The gates (+ month count), and Redis down or empty

```text
            no transaction                one short transaction            no transaction
ticket --> GATE 1: Redis LOOK  ------>  lane row lock + GATE 2           --> Redis +1
             full -> wait                 + MONTH COUNT + `sending`        --> call Meta
             slow / not ready -> skip     full -> write nothing, wait
                                          month full -> plan stop
```

### 31.1 Gate 1: Redis (fast, early, not exact)

1. Keys per account and group: `cnt:open:{account}`, `cnt:fast:{account}`, `cnt:broadcast:{account}`. Each is a sorted set: one entry per counted call, score = its time (Postgres clock), member = the attempt id. The reply lane has no account limit, so it has no gate 1 and no Redis count.
2. **Look** (one Lua script, read only): remove entries older than 60 minutes, count, compare with the limit. Full: return the time the oldest needed entry leaves.
3. **Add** (after the Postgres commit, one Lua script): add this try. Never inside a transaction.
4. **Give back** (never connected, or an upload that failed all its tries): remove that member.
5. No DECR for the hour. Old entries leave by themselves.
6. A key ends by itself after 2 hours with no activity (`COUNT_KEY_HOURS`), so quiet accounts cost nothing.
7. `cnt:ready:{account}` = the count is rebuilt and right. Not there: gate 1 is skipped for this account.
8. **Slow Redis:** a call over 100 ms (`REDIS_TIMEOUT_MS`) is skipped. After 3 time-outs in a row (`REDIS_SKIP_AFTER_TIMEOUTS`) a server skips gate 1 for 30 seconds (`REDIS_SKIP_SECONDS`) without trying. DMs go on with gate 2 only.
9. **Month copy:** the look also reads `cnt:month:{organization}`. At or over the limit: the ticket skips the hour look and goes straight to the claim, where Postgres decides (31.3). No Meta call is ever made or refused on the Redis number alone.

### 31.2 Gate 2: Postgres minute counts (the truth)

1. Table `app.instagram_send_minute_counts`: one row per account, group and minute (`minute_start` = the Postgres time cut to the minute).
2. **Check:** add up the rows of the current minute and the 60 minutes before it. Under the limit: room. This counts up to 1 minute more than needed, so it is a little strict and **never** over.
3. **Free time:** the start of the oldest needed minute + 61 minutes.
4. In the **same commit** that makes the message `sending`: the minute row + 1 (insert or update). Two servers can never both take the last place: the lane row lock comes first (slow, reply and broadcast: one turn at a time; fast: the `fast` row is locked for the count).
5. Calls that reached Meta count, also errors and `unknown`. Two tries of one DM count two times. A picture and its text count two.
6. **Never connected** (DNS, refused), or an upload that failed all its tries: the result save gives the place back (minute row - 1).
7. **Day limit, only if ON** (`DAY_LIMIT_ENABLED`): `day_count` on the `slow` row, + 1 in the same commit, for the day in the organization's time zone. A new day: the count starts at 0. Default day limit = hour limit x 10 (`DAY_LIMIT_DEFAULT_FACTOR`) or the owner's value.
8. **Person limit** (60 per hour, `PERSON_HOUR_LIMIT_DEFAULT`): counted from `app.instagram_messages`: her fast and broadcast message rows with `sending_at` in the last 60 minutes, except follow checks (the person-limit index includes `lane = 'broadcast'` rows). Not in Redis.
9. The owner changes a limit: the next turn checks the new number (section 28.7).

| Group | What counts | Limit |
|---|---|---|
| `open` | opening messages sent as private replies (slow lane) | 600 per hour (owner up to 700; new account 150) |
| `fast` | every fast message row except the follow check: hellos as normal DMs, Live replies, nudges, questions, list messages (a picture and its text are 2) | 10,000 per hour |
| `reply` | public replies | Counted for the watch numbers only. No account limit, no Redis count. ON: one per box of each automation (section 29.3) |
| `broadcast` | broadcast messages (broadcast lane) | 600 per hour (`BROADCAST_HOUR_LIMIT_DEFAULT`, owner 1 to 2,000) |
| `none` | follow checks, hides, file uploads, mark seen calls, read-only test calls, token checks | not counted |

### 31.3 The month count (third check)

Per workspace, per calendar month in the workspace's time zone. The limit is the billing plan row's `dm_month_limit`: Free 1,000, Creator 10,000, Studio 50,000 (section 46).

1. **What counts:** every call into her chat: `opening_message`, `nudge`, `follow_request`, `email_question`, `invalid_email`, `phone_question`, `message` (each row; a picture + text = 2), `broadcast`. Live private replies go into her chat, so they count. **Not counted:** `public_reply`, `hide_comment`, `follow_check`, file uploads, mark seen calls.
2. **Table** `app.dm_month_counts`: (organization, `month_start`, slot) with 16 slots (`DM_MONTH_COUNT_SLOTS`). An account always uses slot = its id mod 16 (`instagram_account_id % 16`). Rows are kept 13 months (`DM_MONTH_KEEP_MONTHS`).
3. **In the claim commit** (slow, fast, broadcast; never the reply lane): read the sum of the workspace's 16 slots for this month. Sum + 1 over the limit: no room. Room: insert or add 1 on its own slot, in the same commit that sets `sending`.
4. **The limit number** is read before the transaction from the copy `acct:{account}` (it also holds the workspace's `dm_month_limit` and plan state, 60 seconds), or from billing's plan when the copy is missing. A limit that changed a minute ago is fine: an upgrade wakes the lanes on its own (step 7).
5. **May go over a little:** two servers may both read a sum just under the limit and both add (the other slot is not locked). So a workspace can pass its limit by a few DMs, at most the number of messages on their way at that moment (estimate). Fine for a plan limit.
6. **At 100%:** the claim writes nothing. Right after its rollback, one short transaction stops the **`slow`, `fast` and `broadcast` lanes of every account** of the workspace (only new DMs stop): `stopped`, `stop_reason` `plan_limit`, `stop_until` = the 1st of next month, 00:00 in the workspace's time zone (the `month-wake` job ends it, rule 7), no test. In lock order: accounts by id, then slow, then fast, then broadcast (section 35.1). Waiting messages stay `waiting`. The 7-day rule and the window still apply: a message whose 7 days end while it waits behind the month limit becomes `expired` with reason `plan_limit`; a window that closes gives `skipped` (`window_closed`); a Live that ends gives `expired` (`live_ended`). The `reply` lane keeps going: public replies and hides of DMs that already went still go (they are not DMs). Notice and email "Limit reached" once (section 47).
7. **Wake:** the `month-wake` job (24.3) ends the `plan_limit` stops when the month changes (the 1st, 00:00 in the workspace's time zone, section 34, rule 24) or after an upgrade with room. Slow and broadcast lanes get a ticket. Fast tickets are added in pieces of 500 (`RESUME_TICKET_BATCH`), spread over 5 minutes (`RELEASE_SPREAD_MINUTES`).
8. **Redis copy** `cnt:month:{organization}`: a small hash (month, count). + 1 after each commit, - 1 on a give-back. A copy of an older month counts as missing. Missing: rebuilt from the sum of the 16 slots (one small query). It lives in the copy Redis for `COPY_SECONDS` (60), then it is rebuilt (section 23.2). Used for the banner ("8,200 of 10,000 DMs used"), the 80% notice, the go-live check (section 15) and the early skip of 31.1.
9. **80% notice:** after the commit, the worker sees the copy cross 80% (`DM_MONTH_NOTICE_PERCENT`): one notice and one email for this workspace and month (dedupe key: workspace + month + 80). The helper checks it again every minute (section 34, rule 25).
10. **Never connected**, or an upload that failed all its tries: month slot - 1 in the result save.
11. Counts are never recounted from messages (messages are deleted after 30 days, `MESSAGE_KEEP_DAYS`).
12. **Plan states** (section 46):
    - a cancelled paid plan ends at the end of its period (no grace): the `plan-change` job stops every lane of the workspace with `plan_ended`. No go-live;
    - payment failed: sending goes on until the grace date, then `plan_ended` the same way;
    - **moving down** starts at the end of the billing period. The `plan-change` job then puts lane stop `plan_downgrade` on all 4 lanes of the accounts the owner did not keep (no pick: the oldest-connected accounts stay). Automations are never stopped: the PRO parts the plan lacks are only ignored (D57). Nothing is deleted. On stopped accounts webhooks are still saved, messages wait, and the 7-day rule still applies. "Choose active accounts" swaps a stop between two accounts at any time;
    - **broadcasts and past comments** after a move down without PRO: scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`); drafts and saved segments stay; an unfinished past-comments run ends `failed` (`plan_feature_off`), the DMs it already queued still go;
    - **a paid trial** (7 days, `PAID_TRIAL_DAYS`) that ends with no payment moves the workspace to Free by the moving-down rule (billing's Stripe webhook, section 46); with payment the plan simply goes on;
    - **moving up** clears every `plan_downgrade` stop at once and wakes the lanes (and the `plan_limit` stops if the new limit has room). The PRO parts work again by themselves.
    - workspace `SUSPENDED`: `suspended_at` on all its lanes, like the team suspend (section 15).

Example: workspace W (Free, 1,000 a month) has accounts A and B. 30 November at 16:00 the sum is 1,000. Riya taps on A: the claim finds no room, writes nothing, and stops the slow, fast and broadcast lanes of A and B (`plan_limit`). 40 messages wait. The public replies of DMs that went before 16:00 still go. 1 December 00:00 (W's time zone) the `month-wake` job ends the stops. The 40 go within 5 minutes, if their window or their 7 days are still open.

### 31.4 The 8 cases

| Case | Gate 1 (Redis) | Gate 2 and month (Postgres) | Result |
|---|---|---|---|
| All is fine | room | room | The DM goes. Redis +1 after the commit |
| The hour is full | full, gives the free time | not asked | The ticket waits until the free time. Nothing is written |
| Redis is slow | skipped (over 100 ms) | room | The DM goes. Gate 2 decides alone |
| Redis says room, Postgres says full | room | full | Nothing is written. The ticket waits. Redis is repaired by the compare (31.6) |
| Redis says full, Postgres has room | full | not asked | The DM waits a little. Safe. The compare repairs Redis within 2 minutes |
| Redis is empty after a restart | not ready, skipped | room | The DM goes at the right limit. The count is rebuilt (31.5) |
| Two servers at the same moment | both may see room | the lane row lock lets one count first | Only one takes the last hour place. The other waits |
| The month is full | the copy says full: skip to the claim | month full | Nothing is written. The workspace's slow, fast and broadcast lanes stop `plan_limit` |

### 31.5 Redis down, empty, or a new Redis

**Down:** the webhook saves to Postgres (or the buffer) and does not wait for Redis. Sending waits, because tickets live in Redis. A send on its way is finished and saved. After 1 minute (`REDIS_DOWN_EMAIL_MINUTES`): team email and a banner.

| How Redis comes back | What we do |
|---|---|
| With its data (from disk) | It may have lost about 1 second. Every count is "not ready" and is rebuilt once |
| Empty | Every count is rebuilt. The helper adds all due tickets |
| A replica took over | The Redis id is new: the same as empty |

1. Each worker remembers the Redis id it saw last. A new id: no count is trusted until it is rebuilt.
2. The helper adds the missing tickets of due lanes and messages within 1 to 2 minutes. Each lane gets its random second in its box plus up to 10 seconds more (`RESTART_JITTER_SECONDS`), so 1,000 accounts do not start together.
3. **Rebuild** (after a commit, never inside one): the first worker that finds an account "not ready" takes a short Redis rebuild lock for it, reads the account's minute rows of the last 61 minutes, writes one entry per counted call (score = the start of its minute), and sets `cnt:ready`. Other workers of that account use gate 2 alone meanwhile. The month copy is rebuilt from its 16 slots.
4. Nothing is sent twice: every message and its status live in Postgres.
5. Tag events are safe: their rows are in `app.contact_tag_events`, and the helper queues the ones not done (section 34, rule 28).

Example: Redis dies at 11:00 and comes back empty at 11:03. A sent 400 opening DMs in the last hour. The helper adds A's ticket at 11:04. The worker sees "not ready": gate 2 counts 400, so A may send 200 more. After the commit it rebuilds `cnt:open:A` with 401 entries.

### 31.6 Redis and Postgres do not agree

The helper compares each active account every 60 seconds (`COUNT_COMPARE_SECONDS`): the Redis count (one count call) against one sum of the minute rows. The lists are read only when they differ. The month copy is compared with its 16 slots the same way.

| Case | What happens |
|---|---|
| Postgres is higher | Rebuild at once |
| Redis is higher for over 2 minutes (`COUNT_REDIS_HIGHER_MINUTES`) | Rebuild |
| Until then | The higher one decides. The limit is never passed |

### 31.7 Redis is full

The ticket Redis never throws data away (`noeviction`). When it is full, every write fails. Then:
1. Gate 1 is skipped (gate 2 decides).
2. New tickets cannot be added: sending slows down, the helper keeps trying.
3. The webhook buffer cannot be used: if Postgres is also down, the webhook answers 500.
4. Tag event jobs cannot be added: their rows wait in Postgres, and the helper queues them when Redis has room.
5. Team alert at 75% memory, long before this happens.

## 32. Every wait in one table

No worker ever waits. Every wait is a delayed ticket, or no ticket at all.

| What waits | Where the time is saved | How it wakes | Setting |
|---|---|---|---|
| Random second in the box (slow lane) | lane `next_run_at`, `box_start` | Delayed ticket | `OPENING_HOUR_LIMIT_DEFAULT`, `OPENING_MIN_GAP_MS` |
| Random second in the box (broadcast lane) | lane (`broadcast`) `next_run_at`, `box_start` | Delayed ticket, lower priority | `BROADCAST_HOUR_LIMIT_DEFAULT`, `BROADCAST_TICKET_PRIORITY` |
| Extra delay before an answer (PRO) | message `not_before` | Its own delayed ticket, at most 25 s after her action | `EXTRA_DELAY_MAX_SECONDS`, `BOT_ANSWER_SAFETY_SECONDS` |
| Broadcast at a set time | `app.broadcasts.scheduled_at` | The helper starts it (section 34, rule 30) | — |
| Broadcast "when her chat opens" | `app.broadcasts.ends_at` | Her next message (the intake hook, 27.15); the helper ends it at `ends_at` | `BROADCAST_OPEN_WAIT_DAYS_MAX` |
| Past comments | `app.automation_backfills.status` | Task job, one per account at a time; Meta usage high: 15 minutes | `META_TASK_RETRY_MINUTES`, `USAGE_WAIT_DEFAULT_MINUTES` |
| Random 500 to 2,000 ms (fast message) | message `not_before` | Its own delayed ticket | `FAST_DELAY_MIN_MS`, `FAST_DELAY_MAX_MS` |
| Wait before a list message (1 minute to 23 hours) | message `not_before` = sent time of the one before + its wait | Its own delayed ticket | `MESSAGE_WAIT_MAX_HOURS` |
| Nudge (1 hour after the hello) | nudge `not_before` | Its own delayed ticket; cancelled by her tap or message | `NUDGE_AFTER_MINUTES` |
| Public reply ON: random second in the automation's box, and the 20 s gap | `automation_reply_state.box_start`, lane (`reply`) `next_run_at` | Delayed ticket | `REPLY_LIKE_PERSON_LIMIT_DEFAULT`, `PUBLIC_REPLY_GAP_MIN_SECONDS` |
| Public reply OFF, hide | message `not_before` = now | The reply lane's next ticket, at once | — |
| Opening or fast limit full | lane `next_run_at` (fast: message `not_before`) | Delayed ticket at the free time | `OPENING_HOUR_LIMIT_DEFAULT`, `FAST_HOUR_LIMIT_DEFAULT` |
| Day limit full (only if ON) | lane `next_run_at` | Delayed ticket at midnight | `DAY_LIMIT_ENABLED` |
| Person limit (60 messages to one person) | message `not_before` | Delayed ticket | `PERSON_HOUR_LIMIT_DEFAULT` |
| 24 hours between two opening DMs | message `not_before` | Delayed ticket | `OPENING_PERSON_GAP_HOURS` |
| 5 audio messages already sending | nothing | The same ticket back, 500 ms | `AUDIO_MAX_PARALLEL_PER_ACCOUNT` |
| Month limit full (`plan_limit`) | lane `stop_reason` | **No ticket** until the `month-wake` job (the 1st or an upgrade), then spread over 5 minutes | `RELEASE_SPREAD_MINUTES` |
| Plan ended (`plan_ended`) | lane `stop_reason` | **No ticket** until billing says the plan is active again | — |
| Moved down, account not kept (`plan_downgrade`) | lane `stop_reason` | **No ticket** until the owner moves up again, or makes this account active with "choose active accounts" (`plan-change` job) | — |
| Too fast, blocked, access off, down | lane `stop_until` | Delayed ticket (slow, reply); helper re-adds fast tickets, spread | section 33 |
| All accounts stopped | `app.sending_state.all_stop_until` | Delayed tickets, release spread over 5 minutes | `APP_STOP_MINUTES`, `RELEASE_SPREAD_MINUTES` |
| Another lane holds the test | nothing | Delayed ticket, 30 seconds | `TEST_DELAY_OTHER_LANES_SECONDS` |
| Never connected | lane `next_run_at` / message `not_before` | Delayed ticket, 5, 15, 60 seconds | `NEVER_CONNECTED_SECONDS` |
| Opening DM "try later" | message `not_before` | Delayed ticket, 1, 5, 15 minutes | `TRY_LATER_MINUTES` |
| Follow check second try | message `not_before` | Delayed ticket, random 2,000 to 5,000 ms | `FOLLOW_CHECK_RETRY_MIN_MS`, `FOLLOW_CHECK_RETRY_MAX_MS` |
| Attachment error: upload again | message `not_before` | Delayed ticket, random delay | `ATTACHMENT_UPLOAD_TRIES` |
| Starter questions, account setup, file upload: Meta call failed | task job | Delayed job, 1, 5, 15, 60 minutes, then the helper every hour | `META_TASK_RETRY_MINUTES` |
| Token check | connection `last_checked_at` | The helper adds the job, spread over the day | `TOKEN_CHECK_EVERY_HOURS` |
| Tag bulk, next piece of 500 | job data (the next contact id) | Added by the piece before, after its commit | `TAG_BULK_PIECE` |
| Tag event not queued (Redis down, or a crash after the commit) | `app.contact_tag_events.queued_at` empty | The helper, after 1 minute | `HELPER_EVERY_SECONDS` |
| Lane row is busy | nothing | The same ticket back, 1,000 ms | `LANE_BUSY_RETRY_MS` |
| Person is busy (her other message is sending) | nothing | The same ticket back, 1,000 ms | `FAST_PERSON_BUSY_RETRY_MS` |
| 20 fast messages already sending | nothing | The same ticket back, 500 ms | `FAST_ACCOUNT_BUSY_RETRY_MS` |
| Postgres error before `sending` | nothing | The same ticket back, 1, 2, 4, 8 seconds | `DB_ERROR_RETRY_SECONDS` |
| Result could not be saved | save-result job | Retried every 30 seconds until saved | `SAVE_RESULT_RETRY_SECONDS` |
| Intake job failed (connection) | BullMQ backoff | Delayed job, from 5 seconds, growing | `INTAKE_MAX_ATTEMPTS` |
| Failed event | event `next_attempt_at` | Helper, every hour, up to 7 days | `FAILED_EVENT_RETRY_MINUTES` |
| Paused, login not valid, suspended, automation stopped | lane flags, automation `stopped_at` | **No ticket** until the owner or team acts | — |
| Meta's answer | not a wait, real work | One place, at most 15 seconds | `INSTAGRAM_TIMEOUT_MS` |

## 33. Instagram errors, stops and tests

### 33.1 Error codes

Read the subcode first, then the code.

| Group | Codes | What happens |
|---|---|---|
| Too fast | 613 (not 2018338), 17, 32, 80002, 80006, HTTP 429 | Stop **this lane** of the account (a reply or hide: only the reply lane). Meta's time if it gives one, else 15, 30, 60, 120, 240, 360 minutes (`TOO_FAST_STOP_MINUTES`). A broadcast: only the broadcast lane, for twice the time (`BROADCAST_STOP_FACTOR`). A stop of the slow or fast lane also stops the broadcast lane for the same time |
| Blocked | 368, 10/1893063, 100/2534029, 613/2018338 | Stop **all lanes** of the account (a reply or hide: only the reply lane). Test after 24 and 48 hours, then every 72 (`BLOCKED_TEST_HOURS`). Email |
| Account flagged | 4 **with** a subcode (for example 2207051 spam) | Stop the lane that got it (a reply or hide: only the reply lane), like "blocked". It never stops other accounts |
| Login not valid | 190 (token removed: app taken out of her business portfolio, or another reason; subcodes: test needed) | Stop all lanes of **every account of that connection**, no end time. Connection and accounts `error`. Email and reconnect notice. Ends when the owner reconnects (section 25.9) |
| Account no longer shared | The account moved to another portfolio (code: test needed; the token check also finds it, section 25.8) | That account `error`, its lanes stopped, no end time. Reconnect notice |
| Not business or creator | (#10) "not business or creator" (the account became personal) | That account `error`, its lanes stopped, no end time. Notice: switch back to Creator or Business, then reconnect (section 25.9) |
| Message access off | 200/2534041, 10/2534077, and the (#200) of "Allow access to messages" (exact subcode with Unified Login: test needed) | Stop all lanes. Test every hour (`ACCESS_TEST_MINUTES` 60). Email: "Turn on 'Allow access to messages'" (section 25.14) |
| App not approved for this person | 200/2018028 | Stop all lanes of this account. Test every hour. Team alert |
| App limit | 4 **without** a subcode, 341 | Only when 2 different accounts get it within 5 minutes (`APP_LIMIT_MIN_ACCOUNTS`, `APP_LIMIT_WINDOW_MINUTES`): stop **all accounts** (section 33.6). One account alone: that lane, as "too fast" |
| Comment gone | 100/33, 100/2534025 | Read the comment once. Gone or hidden: `skipped`, never counted "in a row". Still there: "bad text" |
| Live ended | `CODES_LIVE_ENDED` (test needed) | This Live private reply `expired`, reason `live_ended`. Never counted "in a row". The helper also checks `live_media` (section 30.5) |
| Attachment error | `CODES_ATTACHMENT_GONE` (test needed) | Cached id deleted, places given back, back to `waiting`, upload again. After 3 tries (`ATTACHMENT_UPLOAD_TRIES`): `failed`, reason `attachment_failed`, not counted (section 30.4) |
| Other app controls the chat | 10/2018300, 100/2534037 | This message `skipped`. 5 different people in a row (`PERSON_ERROR_IN_A_ROW`): banner and team email "another app answers your chats" |
| Window closed | 10/2018278, 10/2534022 on a direct message | As section 30.2 step 6: a comment run goes back to a private reply in the slow lane; a list message ends the list; a broadcast message: recipient `skipped`; others `skipped`, the run waits for `any` |
| Person | 551, 1545041, 10/2018108, 100/2534014, 100/2018001 | Only this message `skipped` |
| Wrong permission (a permission is missing) | any other code 10, and codes 200 to 299 not listed above | This message `failed`. 3 different people in a row: stop **all** lanes of the account and ask the owner to reconnect. Follow-check and hide errors never count |
| Bad text | other 100 | This message `failed`. 5 in a row on one automation (`AUTOMATION_BAD_TEXT_IN_A_ROW`), only for comments that still exist: stop the automation (`stopped_reason` = `bad_text`) and tell the owner |
| Mark seen failed | any error of a `mark_seen` call that is not an account stop | Ignored: no retry, never counted "in a row" (section 30.13) |
| Hide failed | any error on a hide that is not a stop | This hide `failed`. Never counted "in a row". The DM, the reply and the run do not change |
| Starter questions refused | any error of the `starter-questions` job that is not a stop | The job tries again (`META_TASK_RETRY_MINUTES`). Then a banner on the account "Instagram refused your starter questions" and one email. The automations stay live (taps on old questions still work) |
| Check not possible | any error of the follow read that is not a stop | Section 30.9: one more try, then "following" |
| Try later | 1, 2, HTTP 5xx with an answer, any unknown code (+ team alert) | Opening DM (private reply): `waiting`, `not_before` = 1, 5, 15 minutes later (`TRY_LATER_MINUTES`), then `failed`. Others: `unknown` |
| No answer | timeout, connection cut, worker died | `unknown`. Never sent again by itself (section 27.5). A follow check: back to `waiting` (a used try) |
| Never connected | DNS, refused | Surely not sent: `waiting`, the places are given back, next try after 5, 15, 60 seconds |
| Already sent | the real code comes from test 1 (section 43) | We tried this DM before: `sent`. First try: somebody else already answered this comment: `skipped` (in restore mode: `sent`, section 39) |

### 33.2 Extra rules

1. A stop (too fast, blocked, flagged, login, access, app limit, down, plan) never fails a DM. It goes back to `waiting` and no try is used up.
2. A 190 counts only if the try used the current token of the connection.
3. **Wrong permission** (any other code 10, and codes 200 to 299 not listed in 33.1): 3 different people in a row stop all lanes and ask the owner to reconnect. Otherwise only this message `failed`. Follow-check and hide errors never count here. Any unknown code stays in "try later".
4. A lane already has a stop and a new one comes: keep the stronger one. No end time is stronger than a time. A later time is stronger than an earlier one. `plan_limit`, `plan_ended` and `plan_downgrade` are kept beside an error stop: both must end before the lane sends.
5. `stop_count` goes back to the start only after the lane has been sending for 24 hours without this error (`STOP_COUNT_RESET_HOURS`), counted from `stop_cleared_at`. The stopped time does not count, so block tests really follow `BLOCKED_TEST_HOURS` (24, 48, then every 72).
6. "In a row" and "30%" are counted from `app.instagram_send_attempts`. Nothing of this is counted in Redis.
7. An automation stopped for bad text: new comments are still saved as `waiting`. When the owner fixes the text, its `failed` messages go back to `waiting` (if not expired).
8. "Try later" for an opening DM is safe because Instagram refuses a second private reply to one comment. Test 1 must prove this (section 43). If it is not true, "try later" for opening DMs becomes `unknown` too.
9. Every stop is written to `app.instagram_send_stops` (account, lane, reason, code, from, until, ended by). A plan stop is one row per account with lane `all`.
10. **Private account:** Meta sends no comment webhooks for it. This is not a stop: comment, Live comment and ad comment automations simply get no events. Banner, and a warning at go-live (section 25.7).

### 33.3 Result groups of a send attempt

Each row of `app.instagram_send_attempts` gets exactly one `result_group`:

| `result_group` | From the group in 33.1 | Counts for "in a row" / "30% bad" |
|---|---|---|
| `sent` | OK, and "already sent" on a retry | no |
| `too_fast` | Too fast | no (it is a stop) |
| `blocked` | Blocked | no (it is a stop) |
| `account_flagged` | Code 4 with a subcode | no (it is a stop) |
| `login_expired` | 190 (login not valid) | no (it is a stop) |
| `account_not_shared` | Account no longer shared | no (it is a stop) |
| `access_off` | Message access off | no (it is a stop) |
| `app_not_approved` | 200/2018028 | no (it is a stop) |
| `app_limit` | Code 4 without a subcode, 341 | no (it is a stop) |
| `comment_gone` | 100/33, 100/2534025 with the comment gone | no |
| `live_ended` | Live ended | no |
| `attachment` | Attachment error | no |
| `other_app` | 10/2018300, 100/2534037 | "5 people in a row" only |
| `window_closed` | 10/2018278, 10/2534022 | no |
| `person` | Person codes | no |
| `wrong_permission` | Other code 10, codes 200 to 299 not listed | "3 different people in a row" (never for follow checks and hides) |
| `bad_text` | Other 100, or 100/33 with the comment still there | "5 in a row" on the automation |
| `hide_failed` | A hide error that is not a stop | never |
| `check_not_possible` | Follow-read error that is not a stop | never |
| `try_later` | 1, 2, HTTP 5xx with an answer, unknown code | yes (down rule) |
| `no_answer` | Time-out, connection cut, worker died | yes (down rule) |
| `never_connected` | DNS, refused | yes (30% rule); its count places are given back |
| `already_sent_first` | "Already sent" on a first try | no |

### 33.4 One test per account

When a stop time is over, exactly **one** DM tests the account.

1. The first lane ticket or fast ticket that finds the stop over takes the **test claim** on the account's `slow` row: one update "set `testing_lane`, `testing_until` = now + 2 minutes (`TEST_LEASE_MINUTES`), only if no test runs or its time is over". 0 rows: another lane tests; this one comes back in 30 seconds.
2. **What tests:** a stop of **only** the reply lane is tested with one public reply (or a hide). A stop of **only** the broadcast lane is tested with one broadcast message. Every other stop is tested with a DM (an opening DM, an answer or a direct message), never with a public reply and never with a follow check. A lane takes the test only if it has such a message that can go now.
3. A test ends by itself after 2 minutes (`TEST_LEASE_MINUTES`), so a dead worker never holds it.
4. While the test runs, other tickets of the account come back in 30 seconds.
5. `plan_limit`, `plan_ended`, `plan_downgrade`, pause, suspend and login stops are never tested. They end by the owner, billing, the team or the new month.

| Test result | Meaning | What happens |
|---|---|---|
| Sent, or "already sent" | Good | The stop ends (`stop_cleared_at` = now). Half speed starts: `half_speed_until` = now + 1 hour (`HALF_SPEED_HOURS`), after a block + 24 hours (`HALF_SPEED_AFTER_BLOCK_HOURS`). Slow and ON reply boxes x 2; fast: at most `HALF_SPEED_FAST_PARALLEL` (10) at once |
| The same stop or another stop | Bad | Wait the next time in the list |
| A problem with that person or that text | Says nothing about the account | Another DM tests in the next turn, up to 3 turns (`TEST_MAX_TURNS`). Then wait the same time again |
| No answer, "try later", worker died | Not clear | Wait the same time again. `stop_count` does not grow |

### 33.5 Instagram down

1. **One account:** 3 "no answer" or "try later" results in a row (`DOWN_IN_A_ROW`) stop all lanes of that account. The stop grows while the result stays unclear: 5, 10, 20, 40 minutes (`DOWN_STOP_MINUTES`).
2. **Test after a down stop:** first one read-only call that sends nothing (read the account's own profile). Only if it answers, one test DM goes. So a long outage does not use real people as tests.
3. **All accounts** stop (`app.sending_state.all_stop_until`) when either:
   - 30% or more of the calls in the last 30 seconds are bad, with at least 50 calls (`BAD_PERCENT`, `BAD_MIN_CALLS`, `BAD_WINDOW_SECONDS`), or
   - 30% or more of the active accounts are in a down stop (`DOWN_ALL_SHARE_PERCENT`). This works also with few accounts.
4. Checked every 10 seconds (`DOWN_CHECK_EVERY_SECONDS`).
5. Task jobs (token check, starter questions, uploads) that meet Meta down only try again later. They never stop a lane.

### 33.6 App limit (all accounts)

1. Stop all accounts for 15 minutes, then 30, then 60 (`APP_STOP_MINUTES`, `all_stop_count` in `app.sending_state`). Team alert.
2. The first lane that wakes after the time takes the one test (`testing_lane` in `app.sending_state`).
3. Good test: lanes are released **spread over 5 minutes** (`RELEASE_SPREAD_MINUTES`) at half speed, not all at once. So the piled-up answers do not hit the limit again at once.
4. `all_stop_count` goes back to the start after 24 hours without an app limit.

### 33.7 Deleted or fake comments

Five fake profiles comment the keyword and delete the comment 2 seconds later. Without care, 5 errors in a row would stop a good automation.

1. On 100/33 or 100/2534025, first read the comment once.
2. Gone, hidden, or over 7 days old: the message is `skipped` (or `expired`). It never counts "in a row".
3. Still there: it counts as "bad text".
4. A hide of a comment that is gone: `skipped` (`deleted_comment`).

### 33.8 Our own stops of a lane

| Stop | Set by | Lanes | Ends |
|---|---|---|---|
| Paused | Owner | The account's 4 lanes | Owner presses Resume |
| Suspended | Team | The account's 4 lanes | Team lifts it. The owner's Resume does not clear it |
| Workspace suspended (`SUSPENDED`) | Tenancy (section 45) | Every lane of the workspace (`suspended_at`) | The workspace is active again |
| Month limit (`plan_limit`) | The send claim (section 31.3) | The slow, fast and broadcast lanes of every account of the workspace (the reply lane goes on) | The 1st of the month (workspace time zone) or an upgrade with room (`month-wake`) |
| Plan ended (`plan_ended`) | The `plan-change` job at the period end of a cancelled plan, or billing after the grace date (section 46) | Every lane of the workspace | The plan is active again (`month-wake`) |
| Moved down (`plan_downgrade`) | The `plan-change` job at the period end (section 31.3, rule 12), or the owner's "choose active accounts" | All 4 lanes of each account not kept (automations are never stopped by a plan change) | A move up, or the owner makes this account active in place of another (`plan-change`) |
| Automation stopped (bad text) | Worker, after 5 in a row | That automation only | Owner fixes the text |
| Login not valid, please reconnect | Worker or token check (section 25.8) | Every lane of the connection's accounts (or of one account) | Owner reconnects with the same Instagram account |

### 33.9 A short Postgres break (Neon restart)

| When Postgres fails | What happens |
|---|---|
| Before the `sending` commit | Nothing was sent. The same ticket goes back after 1, 2, 4, 8 seconds (`DB_ERROR_RETRY_SECONDS`). The ticket is not lost |
| After Meta answered (the result save fails) | The worker writes a **save-result job** to the ticket Redis (message, try, result, Instagram id, codes). It is retried every `SAVE_RESULT_RETRY_SECONDS` (30) until saved. A clear "refused" stays a clear result; a "blocked" still stops the lane |
| The helper finds a lease over | It first looks for a save-result job of that message. Found: it lets the job save. Not found: `unknown` |
| A message is `unknown` | It is never sent again by itself. Only her next message or tap may send that step once more (the same row back to `waiting`) |
| A late clear "not sent" comes for an `unknown` message of the same try | It may also move the message back to `waiting`, and the stop it carried is set |

Example: Neon restarts for 5 seconds at 14:00:00. 80 DMs are on their way. Their results come back at 14:00:02 and cannot be saved. 80 save-result jobs are written. At 14:00:30 Postgres is back and all 80 are saved with their real results. No DM becomes `unknown` because of the restart. The month count was already added in the claim, so it stays right.

### 33.10 Retry failed messages (owner button)

A button on an automation ("Retry failed messages") and on a contact. Owner, Admin or Editor. Audit log.

```text
owner presses "Retry failed messages"
   |
   1 count first: "42 failed: 30 can go again, 12 too old or her chat is closed"
   2 owner confirms --> job retry-failed, pieces of 500 (RETRY_FAILED_PIECE)
   3 each failed message of the last 30 days, never retried before:
   |    still allowed now? ------------------------- no --> stays `failed`
   v
   4 the same row back to `waiting` (owner_retry_at = now), its run reopened
   5 after the commit: wake its lane; the normal gates and limits
```

1. **Which messages:** status `failed` only (never `unknown`, `skipped`, `expired` or `cancelled`), from the last 30 days (`MESSAGE_KEEP_DAYS`), with `owner_retry_at` empty (at most once each, `RETRY_FAILED_MAX` 1), not type `broadcast`, of this automation or this contact.
2. **Still allowed now:**
   - an opening private reply: its comment time + 7 days - 30 minutes (`EXPIRY_SAFETY_MINUTES`) is not over yet;
   - any other DM: her window is open now (24 hours minus 15 minutes);
   - not when its last error is final for her: a person error (`CODES_PERSON`: she blocked us, user not found), no consent, another app controls her chat (`CODES_OTHER_APP`), or she is opted out or excluded;
   - not while the automation is still stopped for a refused text (`stopped_reason` `bad_text`): the owner fixes the text first;
   - not when another open run of this automation for her has the same key.
3. **The same check makes the count** the owner sees before starting (one read, no change).
4. **One commit per piece**, in contact id order; each message in lock order (contact, automation, run, message): the same row back to `waiting`, `tries` = 0, `owner_retry_at` = now, `not_before` = now + the random delay. Lane and channel by the normal rule (window open: fast lane, `direct`; an opening DM with her window closed: slow lane, `private_reply`). A run that ended `failed` waits for this step again, and its open-run key is added again.
5. After the commit: wake the lanes and add the fast tickets.
6. Retried messages go through the normal lanes, gates and limits. They count in the month count when they are sent.
7. It fails again: it stays `failed`. `owner_retry_at` is set, so it is never retried again.

## 34. Helper (every minute)

The helper repairs. It never sends a DM. It runs every 60 seconds (`HELPER_EVERY_SECONDS`) on every server, each on its own part of the accounts. Every rule is safe to run twice.

### 34.1 Slots: who checks which accounts

1. Accounts are split into 16 slots by account id (`HELPER_SLOTS`, table `app.sending_helper_slots`). A connection belongs to the slot of its id the same way; a workspace (month rules) to the slot of its organization id.
2. **Fair share:** a server takes at most 16 / live servers (rounded up). With 2 servers: 8 each. It gives back extra slots.
3. A slot has a lease of 45 seconds (`HELPER_SLOT_LEASE_SECONDS`), renewed every 15 seconds (`HELPER_SLOT_RENEW_SECONDS`). On shutdown (SIGTERM) a server frees its slots at once.
4. A server dies: its slots are free after at most 45 seconds and another server takes them in its next round. Repair stays within about 2 minutes.
5. Each rule handles at most 500 rows per round (`HELPER_PASS_LIMIT`). The rest waits for the next minute.
6. The helper reads across organizations with meepzo-be's maintenance role (ids only) and makes each change in that organization's own scope. It never reads a token: the `token-check` job reads it in the organization's scope.
7. The helper does not start when the environment check fails (section 39).

### 34.2 Rules

| # | Every | Rule |
|---|---|---|
| 1 | 1 min | **Save-result jobs:** make sure each one is being tried. Done ones are removed |
| 2 | 1 min | **Lease over** on a slow, reply or broadcast lane (worker died): if a save-result job exists for its message, wait for it. Else the message `sending` becomes `unknown` through the shared save-result function (so `last_opening_message_at`, `dm_sent_at`, the public reply, the hide and the nudge are right). A follow check goes back to `waiting`. A message that already has an Instagram message id becomes `sent`. A test ends "not clear". The lane `ready`, `working_turn` cleared, `turn_no` + 1, ticket |
| 3 | 1 min | **Webhook buffer:** move events from the Redis list `webhook-buffer` into Postgres (same keys, repeats dropped), then add their intake jobs |
| 4 | 1 min | **Stuck events:** `received` or `queued` for over 1 minute and not leased: add the intake job again (a job that already waits is not added twice). `failed` events: again every hour (`next_attempt_at`) until the comment is 7 days old |
| 5 | 1 min | **Late lane tickets:** a slow, reply or broadcast lane is `ready` or `sleeping` with `next_run_at` over 1 minute late (`LATE_TICKET_MINUTES`), **and** its ticket `{lane}-{account}-{turn_no}` is not in BullMQ: add the **same** ticket again (same turn, same id). If the ticket is there but late (workers are busy), do nothing and count it for the "tickets start late" alert |
| 6 | 1 min | **Idle lane with work:** a lane `ready` with no ticket and a message that can go now (not paused, not stopped, `not_before` over, automation live and not stopped): `turn_no` + 1, ticket |
| 7 | 1 min | **Fast messages:** `waiting`, `not_before` over 1 minute ago, the ticket `fast-{id}-{tries}` is not in BullMQ, **and** the account is not paused or suspended and its fast lane is not stopped: add the ticket. This also wakes list messages and nudges whose wait is over. `sending` longer than 120 seconds: as rule 2 |
| 8 | 1 min | **Repair `sending_count`:** set it to the real number of the account's fast messages that are `sending`, if different |
| 9 | 1 min | **Stops that ended:** slow, reply and broadcast lanes: make sure there is a ticket. Fast: add tickets for the waiting fast messages, spread over 5 minutes (`RELEASE_SPREAD_MINUTES`) |
| 10 | 1 min | **Expired:** waiting opening DMs, public replies and hides whose comment time + 7 days - 30 minutes is over become `expired` (in pieces). A DM that waited behind the month limit (its slow, fast or broadcast lane stopped `plan_limit`) gets reason `plan_limit`. Waiting Live private replies: one `GET /<account>/live_media` per account that has some; a Live no longer on air, or a comment older than `LIVE_REPLY_MAX_AGE_MINUTES`: `expired` (`live_ended`), and `instagram_media.live_ended_at` is saved. A run with nothing else to do ends `cancelled` (`expired`). The comment log step shows `expired`. Each piece takes its locks in the one order (contact, automation, run, message) |
| 11 | 1 min | **Window closed:** waiting answers, list messages and nudges whose window closed become `skipped` (`window_closed`). Answers: the run waits for `any`. List messages: the run ends (section 30.6). Nudges: the run still waits for her tap |
| 12 | 1 min | **Too many waiting replies:** an ON automation with more than 500 waiting public replies: the oldest become `skipped` (`hour_limit`), `waiting_count` set right, their hides made |
| 13 | 1 min | **Counts:** compare Redis and minute counts, and each month copy with its 16 slots (section 31.6). Delete minute rows over 2 hours old |
| 14 | 1 min | **Emails** through meepzo-be's mail outbox (`auth.mail_outbox`). The `dedupe_key` = reason + account + period, so two helpers never send one email twice. Team emails are grouped (one email for one event for all accounts). Owner emails: one email of the same kind per account per `EMAIL_OWNER_GAP_HOURS` (6). The stop ended before the email was due: not sent |
| 15 | 1 min | **Clock:** compare the server clock with Postgres `now()`. Over 2 seconds apart (`CLOCK_SKEW_MAX_MS`): team alert, and this server takes no tickets until it is right. (BullMQ wakes delayed tickets by the server clock) |
| 16 | 10 s | **Down check** (section 33.5) and the app limit check |
| 17 | 10 min | **Will go / may expire** estimate for each account with waiting opening DMs (section 12). Saved in `estimate:{account}` for the banner. One grouped query per account (count by expiry hour) |
| 18 | 10 min | **Webhook subscription** of each **connected** account (spread over the 10 minutes by account id, `WEBHOOK_CHECK_MINUTES`): all 6 fields there (section 25.7)? Off or a field missing: an `account-setup` job, team email, and a full missed-comment pass for this account (rule 20) |
| 19 | 30 min | **Missed comments, normal round** (`MISSED_CHECK_MINUTES`): for each watched post (it has a live comment or ad comment automation, and the post or its last comment is under 7 days old), read its comments newest first, 50 per page (Meta has no time filter), page after page until a comment is older than `last_comment_at` minus 10 minutes, **with their replies** only when the account's `trigger_on_comment_replies` is ON (test needed: the `replies` field, section 43). At most 25 posts per account per round (`MISSED_POSTS_PER_ROUND`), the ones checked longest ago first, so every post gets its turn. Save the comments we do not have as events (key = comment id), then intake. Own comments are dropped. At most 1 call per second per account. Meta's usage number 80% or more: skip this round. Spread over the 30 minutes by account id. Live comments are not read back (a Live reply is useless after the Live) |
| 20 | after an outage | **Missed comments, full pass:** after the webhook was off, after Redis or Postgres was down, or when a server starts after downtime: for each account, every post with a live comment automation, with no age limit and no 25 cap. Spread over 10 minutes across accounts (`MISSED_FULL_PASS_SPREAD_MINUTES`) |
| 21 | 1 min | **Token check**, spread over the day: each **connected** connection whose `last_checked_at` is over `TOKEN_CHECK_EVERY_HOURS` (24) old, and whose turn has come (its id decides its minute of the day), gets one `token-check` job (section 25.8). So 1,000 connections make about 1 job a minute (estimate). `revoked` connections: nothing |
| 22 | daily | **Event keys** older than 8 days: deleted in small pieces. Month count rows older than 13 months (`DM_MONTH_KEEP_MONTHS`) and tag event rows older than 8 days (`TAG_EVENT_KEEP_DAYS`) are deleted by the daily retention job (section 21.3), not by the helper. Partition parts are made and dropped by the partition worker (section 21), not by the helper |
| 23 | 1 min | **Paused with Cancel:** the `waiting` messages of an automation paused with Cancel (made before its `cancelled_before_at`) become `cancelled` (`cancelled_by_owner`), at most `HELPER_PASS_LIMIT` (500) per round. Until then the pick already skips them |
| 24 | 1 min | **Month start:** a workspace with lanes stopped `plan_limit` whose current month (in **its** time zone) is newer than the month of the stop: one `month-wake` job. So each workspace wakes at its own midnight on the 1st |
| 25 | 1 min | **80% and 100% notices, backup:** a workspace whose month copy (or slot sum) is at 80% or more (`DM_MONTH_NOTICE_PERCENT`), or at 100%, with no such notice this month: send it (one notice and one email each; dedupe key workspace + month + 80 or 100) |
| 26 | 1 hour | **Task retries:** an account whose last `starter-questions`, `account-setup` or `attachment-upload` job failed all its tries (`META_TASK_RETRY_MINUTES`): add the job again |
| 27 | — | **Counters are never recounted.** `app.automation_counts` and `app.dm_month_counts` change only in send and intake commits (and give-backs). The helper never rebuilds them from messages or runs (messages are deleted after 30 days, `MESSAGE_KEEP_DAYS`; runs after 90). It only compares the month count with the DM rows tried this month (skipped when some of this month's rows are already dropped), every `DM_MONTH_CHECK_HOURS` (24), for the drift alert (section 40.3) |
| 28 | 1 min | **Tag events not queued:** rows of `app.contact_tag_events` with `queued_at` empty for over 1 minute: add the job, set `queued_at`. Rows queued over 1 hour ago (`FAILED_EVENT_RETRY_MINUTES`), not done, and under 24 hours old (`MESSAGING_WINDOW_HOURS`): add the job again |
| 29 | 15 min | **Plan changes, backup:** every `PLAN_STATE_CHECK_MINUTES` (15), a workspace whose plan at the end of its billing period does not match its lane stops (a move down not applied, a move up not cleared, a cancelled plan not ended): add the `plan-change` job |
| 30 | 1 min | **Broadcasts at a set time:** `scheduled` broadcasts whose `scheduled_at` is over: `sending`, add the `broadcast-audience` job |
| 31 | 1 min | **Broadcast ends:** a `sending` broadcast whose audience job is done and with no recipient `waiting`: `done`. A `waiting_for_chats` broadcast past its `ends_at`: `done` (recipients already made still go). A `cancelled` broadcast: its `waiting` messages become `cancelled` and its waiting recipients `skipped`, both with reason `broadcast_cancelled`, at most `HELPER_PASS_LIMIT` per round. Notice `broadcast.done` (in-app, section 47) |
| 32 | 10 min | **Backfill watch:** a backfill `reading` with no new page for 30 minutes (`BACKFILL_STUCK_MINUTES`): add the `past-comments` job again (it reads from the newest comment again; comments already saved are dropped by their keys). An account with `queued` backfills and none running: start the next one. `failed` after its retries: notice `automation.backfill_done` (section 47) |

Rules 18, 19, 20 and 21 run **only for connected accounts and connections**. A revoked one is never checked, subscribed or read again.

## 35. Locks, transactions and timeouts

### 35.1 One lock order

Every transaction takes its locks in this order:

```text
contact -> automation -> run -> message -> broadcast recipient row -> own lane row
        -> other lane rows (slow, then reply, then fast, then broadcast)
        -> automation_reply_state row -> minute count rows
        -> dm_month_counts slot row -> automation_counts slot row
```

Why: two transactions that take two rows in opposite order wait for each other forever (a deadlock). Postgres then kills one, and its result is lost.

Example of the old problem: the "message was sent" notice came before the worker saved. Intake held the contact and wanted the message. The worker held the message and wanted the contact. One died: a DM that Meta clearly refused became `unknown` forever. With one order, both take the contact first, so one simply waits a few milliseconds.

| Transaction | Locks, in order | Out-of-order locks |
|---|---|---|
| Intake (comment, Live comment, tap, message, tag event) | contact, automation, run, message, `automation_counts` slot | none. Lanes are woken after the commit |
| Slow send claim | own lane row, then the picked message, then the minute row, then the month slot. **Never the run** | lane row and message with `skip locked`: it never waits, so it can never be part of a deadlock |
| Broadcast send claim | own lane row, then her contact and the picked message, then her recipient row, the minute row, the month slot. **Never the run** | lane row, contact and message with `skip locked` |
| Retry failed (owner), exclude a contact | per message or contact: contact, automation, run, message, then the open-run key (insert or delete); a piece goes in contact id order | none |
| "When her chat opens" hook, broadcast audience piece | inside the intake or result-save commit (after the contact lock), or alone (audience): only inserts of recipient and message rows | none |
| Past comments | only inserts of event rows and the backfill counters | none |
| Reply send claim | own lane row, then the picked message, then its `automation_reply_state` row, then the minute row. **Never the run** | lane row and message with `skip locked` |
| Fast send claim | contact, message, fast lane row, minute row, month slot. **Never the run** | the test claim on the `slow` row: `skip locked` |
| Run change after a claim (expired, window closed, opted out, list ended) | contact, automation, run | none. Its own short transaction right after the claim commit, or inside the result save |
| Save result | contact, automation, run, message, broadcast recipient row (for a broadcast message), own lane row, `automation_reply_state` row, minute row, month slot | none |
| Plan stop of a workspace (`plan_limit`, `plan_ended`, `plan_downgrade`), the month wake and the `plan-change` job | the workspace's lane rows it changes: accounts by id, each slow, then reply, then fast, then broadcast (`plan_limit`: slow, fast and broadcast only) | none. It runs alone, after the claim's transaction ended |
| Pause, Resume, limit change | lane rows: slow, then reply, then fast, then broadcast | none |
| Tag bulk piece | the 500 contact rows in id order, then inserts its `app.contact_tag_events` rows (no lock needed) | none. Its tag events run later, each in its own transaction |
| Connect, reconnect, disconnect, "choose active accounts" | first `pg_advisory_xact_lock` on the organization id (so the connect plan check of section 25.5 and the account swap never race), then `app.meta_connections` rows (id order), account rows (id order), their lane rows | none. They never lock a contact |
| Helper repair | the same order as the save result | `skip locked` on lanes another worker holds |

**Rule:** a lock taken out of the order always uses `skip locked` (never waits). "Not got" means busy: the ticket goes back.

**`app.contact_tag_events` in this order:** its rows are only inserted (no lock) in the commit that changes the tags, after the contact row (the tag step in the result save, the owner's tag edit, a bulk piece). Intake's first statement marks its own event row (`done_at` of a tag event, like the `processed` mark of a webhook event) before it locks the contact. Only that one job and the helper's `queued_at` update touch the row, each in its own short transaction, so this can never deadlock.

### 35.2 Deadlock or lock time-out

1. Error 40P01 (deadlock) or 55P03 (lock time-out): the whole transaction once more, up to 3 times (`DB_DEADLOCK_RETRIES`), also the result save.
2. Still failing: a send claim puts its ticket back (`DB_ERROR_RETRY_SECONDS`); a result save writes a save-result job (section 33.9); a plan stop is tried again by the next claim that finds the month full.

### 35.3 Time limits

| Limit | Value | Where it is set |
|---|---|---|
| Statement time-out | 5 seconds (`DB_STATEMENT_TIMEOUT_MS`) | `SET LOCAL` at the start of every transaction (meepzo-be already does this; it works with Neon's pooler) |
| Lock time-out | 1 second (`DB_LOCK_TIMEOUT_MS`) | `SET LOCAL` at the start of every transaction |
| Idle in a transaction | 20 seconds (`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`) | On the database role, so a server that dies with an open transaction frees its locks |
| Waiting for a pool connection | 2 seconds (`DB_POOL_WAIT_TIMEOUT_MS`) | Pool setting. Over: the ticket goes back |
| Webhook save | 3 seconds (`WEBHOOK_SAVE_TIMEOUT_MS`) | Webhook. Over: Redis buffer (section 26.3) |
| Meta call | 15 seconds (`INSTAGRAM_TIMEOUT_MS`) per call | HTTP client |
| Redis call | 100 ms (`REDIS_TIMEOUT_MS`) | Redis client |
| Lease of a working lane | 120 seconds (`LEASE_SECONDS`), longer than the Meta time-out + the save. An upload and a call still fit: 2 x 15 + 5 seconds | Lane row |

TCP keepalive is on, so a dead connection is found fast.

### 35.4 Short transactions

1. **Never** call Meta inside a transaction. This also holds for connect, the token check, uploads and starter questions.
2. **Never** call Redis inside a transaction. Gate 1 looks before it; the Redis counts +1, notes, tickets and tag events come after the commit.
3. A transaction holds a lane row for a few milliseconds, never for a send.
4. The organization scope is set inside each transaction (`set_config(..., true)`), never on the session. Neon's pooler does not keep session settings.
5. One pool per server (`DB_POOL_SIZE_PER_SERVER` 20) for workers and the API. The webhook has its own small pool (`WEBHOOK_DB_POOL_SIZE` 5), so busy workers never make Meta wait.
6. A sleeping lane makes no Postgres call. A stopped lane (plan, login, pause) makes none either.

### 35.5 One clock

1. All times come from Postgres (`now()` in SQL), never from the server's own clock: `sending_at`, `minute_start`, box times, stop times, expiry, message waits, the nudge time, `month_start`.
2. A ticket's delay is worked out as "Postgres time it should wake" minus "Postgres now", so a server clock that is a little wrong changes only the wake moment, never a limit.
3. The month and the day use the workspace's time zone (`tenancy.organizations`), worked out in Postgres.
4. The helper checks the server clock every minute (section 34.2, rule 15).

### 35.6 Calls for one DM (estimate)

| Step | Postgres calls | Redis calls |
|---|---|---|
| Gate 1 look (hour count and month copy) | 0 | 1 |
| Claim: begin, locks, pick, checks, gate 2, month slots, `sending`, commit | about 3 | 0 |
| After the commit: Redis counts + 1 (hour and month) | 0 | 1 to 2 |
| Meta call | 0 | 0 |
| `mid:` note | 0 | 1 |
| Save result and next ticket | about 2 | 1 to 2 |
| **Total** | **about 5** | **about 4 to 6** |

The month check reads 16 small rows inside the claim (one more statement, no extra round trip in the estimate). A picture + text is 2 rows, so 2 claims and 2 calls.


---

# Part E. Running it

## 36. Settings file (every number)

### 36.1 The rules

1. **Every** number of sending and automations is in **one settings file** in meepzo-be: counts, limits, delays, ages, keep days, sizes, error codes, stop words. Path: `src/shared/config/instagram-sending.config.ts` (or meepzo-be's constants style, which `pnpm validate:constants` checks).
2. The code logic never holds a number. Only 0, 1 and the fixed facts in 36.22.
3. **Owner values** live in two places. An empty value means "use the settings file". So when you change a default in the file, every account or automation that has no own value follows it.
   - Per account: `app.instagram_account_settings` (limits, stop words, the "automatic" line, and the switches of 36.27).
   - Per automation: `app.automations.public_reply_hour_limit` (only a value from `REPLY_LIKE_PERSON_LIMITS`) and `app.automations.public_reply_mention`.
4. **Order:** owner value first. Empty: the settings file.
5. **Plan values** (DMs a month, accounts, PRO features) are **never** in this file. They live in the billing plan rows (36.21). The code reads them from the workspace's plan.
6. **Units are in the name:** `_MS`, `_SECONDS`, `_MINUTES`, `_HOURS`, `_DAYS`, `_MONTHS`, `_PERCENT`, `_CHARS`, `_BYTES`, `_MB`, `_USD`.
7. **No secrets in this file.** No token, no key, no password, no Redis or database link, no Meta app secret. Those are env values in the secret store (36.26, section 41).
8. The file has a number `SETTINGS_VERSION`. It goes up by 1 with every change. The deploy rule for it is in section 38.
9. At server start every setting is checked (36.24). One check fails: the server does not start and says which setting is wrong.
10. The owner screen shows only the values marked "Yes" in the "Owner" column. The owner can only pick values between the minimum and the maximum (or from the list).
11. A developer who meets a number in this plan uses its setting name, never the number. A number that is not here is added here first.
12. The product numbers (sign-in, team, billing, notices, refer: sections 44 to 48) are in the product group (36.20). meepzo-be names that already exist and change, or are used as they are, are in 36.25.

```text
  Plan value? (DMs a month, accounts, PRO) -- yes --> billing plan row (36.21)
        |
        no
        v
  Owner value? (account settings, or the automation)
        |
   yes  |  no (empty)
   v    v
 use it   use the settings file
   |          |
   +----+-----+
        v
  inside MIN and MAX, or in the list?  -- no -->  file default + team log line
        |
       yes
        v
      used
```

The worker checks the bounds again when it reads the row. A bad value in the database never breaks a lane (security review C5).

### 36.2 Opening DMs (slow lane)

| Name | Value | Owner? (min to max) | Meaning |
|---|---|---|---|
| `OPENING_HOUR_LIMIT_DEFAULT` | 600 | Yes, `OPENING_HOUR_LIMIT_MIN` to `OPENING_HOUR_LIMIT_MAX` (column `opening_hour_limit`) | Opening DMs per hour per account. |
| `OPENING_HOUR_LIMIT_MIN` | 1 | No | Lowest owner value. |
| `OPENING_HOUR_LIMIT_MAX` | 700 | No | Highest value an owner may set. Always under Meta's 750. |
| `NEW_ACCOUNT_HOUR_LIMIT` | 150 | Yes: any owner value in `opening_hour_limit` replaces the 150 | Limit in the first days after connect. |
| `NEW_ACCOUNT_DAYS` | 7 | No | Days after `connected_at` with the new-account limit. |
| `DAY_LIMIT_ENABLED` | false | No | Day limit OFF by default. |
| `DAY_LIMIT_DEFAULT_FACTOR` | 10 | No | Only if ON and the owner set no day limit: hour limit x 10. |
| (column `opening_day_limit`) | empty | Yes, from the hour limit up to the hour limit x 24 | The owner's own day limit (only if ON). |
| `OPENING_MIN_GAP_MS` | 1500 | No | At least this time between two opening DMs of one account. |
| `PICK_NEW_MINUTES` | 60 | No | A comment under this age is "new". |
| `PICK_MIX_NORMAL` | 4:1 | No | 4 new, then 1 old. |
| `PICK_MIX_URGENT` | 3:2 | No | 3 new, then 2 old, when an old one is close to its end. |
| `URGENT_HOURS_LEFT` | 12 | No | "Close to its end" = under this many hours left. |
| `OPENING_PERSON_GAP_HOURS` | 24 | No | Window closed: one opening DM per person in this time. |
| `PRIVATE_REPLY_MAX_AGE_HOURS` | 168 | No (max 168, Meta) | A private reply may go up to 7 days after the comment. |
| `EXPIRY_SAFETY_MINUTES` | 30 | No | Stop this many minutes before the 7 days end. |
| `HALF_SPEED_FACTOR` | 2 | No | Half speed = box this many times bigger. |
| `HALF_SPEED_HOURS` | 1 | No | Half speed for this long after a good test. |
| `HALF_SPEED_AFTER_BLOCK_HOURS` | 24 | No | Half speed after a "blocked" stop ends. |
| `LANE_BUSY_RETRY_MS` | 1000 | No | Lane row is locked by someone else: the ticket comes back after this. |
| `PICK_TRIES_PER_TURN` | 5 | No | Picks in one turn before the ticket comes back. |

### 36.3 Fast messages (fast lane)

| Name | Value | Owner? (min to max) | Meaning |
|---|---|---|---|
| `FAST_DELAY_MIN_MS` | 500 | No | Smallest random delay before a fast message. |
| `FAST_DELAY_MAX_MS` | 2000 | No | Largest random delay. Formula: min + (max - min) x (r1 + r2) / 2. |
| `FAST_HOUR_LIMIT_DEFAULT` | 10000 | Yes, `FAST_HOUR_LIMIT_MIN` to `FAST_HOUR_LIMIT_MAX` (column `fast_hour_limit`) | Fast messages per hour per account: answers, message lists, nudges, Live private replies. |
| `FAST_HOUR_LIMIT_MIN` | 1 | No | Lowest owner value. |
| `FAST_HOUR_LIMIT_MAX` | 20000 | No | Highest owner value. |
| `FAST_MAX_PARALLEL_PER_ACCOUNT` | 20 | No | At most this many fast messages of one account are `sending` at once. |
| `AUDIO_MAX_PARALLEL_PER_ACCOUNT` | 5 | No | At most this many audio messages of one account are `sending` at once. Meta allows 10 audio or video calls per second per account (estimate: 5 at once stays under it). Over it: the ticket comes back after `FAST_ACCOUNT_BUSY_RETRY_MS`. |
| `FAST_PERSON_BUSY_RETRY_MS` | 1000 | No | Her last message has no result yet: try again after this. |
| `FAST_ACCOUNT_BUSY_RETRY_MS` | 500 | No | 20 already sending: try again after this. |
| `HALF_SPEED_FAST_PARALLEL` | 10 | No | Fast messages of one account at once during half speed. |
| `PERSON_HOUR_LIMIT_DEFAULT` | 60 | Yes, `PERSON_HOUR_LIMIT_MIN` to `PERSON_HOUR_LIMIT_MAX` (column `person_hour_limit`) | Automatic messages to one person per hour. A loop guard. Counted only in Postgres. Also guards "every time" and tag starts (section 4). One long run can need about 24 to 30 calls (section 42), so 60 leaves room. |
| `PERSON_HOUR_LIMIT_MIN` | 5 | No | Lowest owner value. |
| `PERSON_HOUR_LIMIT_MAX` | 100 | No | Highest owner value. |
| `LIVE_PRIVATE_REPLY_PER_SECOND` | 100 | No (Meta, fixed) | Meta's cap for private replies to Live comments per account. Our fast limit is far lower (36.24). |
| `LIVE_REPLY_MAX_AGE_MINUTES` | 240 | No | A Live private reply not sent by this time after the comment is `expired` (`live_ended`), with no call. Estimate: a Live lasts at most 4 hours. |
| `BOT_ANSWER_MAX_SECONDS` | 30 | No (Meta rule) | A bot must answer within this time. Over it: alarm (section 40). |
| `BOT_ANSWER_SAFETY_SECONDS` | 5 | No | Room kept under `BOT_ANSWER_MAX_SECONDS`: from her message to our answer is at most 30 - 5 = 25 seconds, also with the extra pause. |
| `EXTRA_DELAY_MAX_SECONDS` | 20 | No | Highest owner value of "Delay before each message" (PRO, columns `extra_delay_seconds_min` and `extra_delay_seconds_max`, 36.27). The extra pause = min + (max - min) x (r1 + r2) / 2, added once per her event (tap, typed answer, story reply, DM) to the FIRST answer we send after it, on top of the fast delay, as a delayed ticket. Later list messages with no wait use only the fast delay. Never after a follow check, never for slow-lane private replies, public replies, nudges, list waits or broadcasts. |
| `ANSWER_GOOD_SECONDS` | 15 | No | Tap-to-answer under this time is "good" on the watch list. |
| `RESUME_TICKET_BATCH` | 500 | No | After Resume or a stop end, tickets of waiting fast messages are added in pieces of this size, spread over `RELEASE_SPREAD_MINUTES`. During a stop fast messages have no ticket. |

### 36.4 Follow check

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `FOLLOW_CHECK_TRIES` | 2 | No | Tries in all for one follow check. |
| `FOLLOW_CHECK_RETRY_MIN_MS` | 2000 | No | Smallest wait before the second try. |
| `FOLLOW_CHECK_RETRY_MAX_MS` | 5000 | No | Largest wait before the second try. |
| `FOLLOW_CHECK_FAIL_MEANS` | following | No | Both tries fail: treat her as following and go on. |

### 36.5 Public replies and hides (reply lane)

"Reply like a person" is ON or OFF per automation (section 13). Free: OFF only. Paid plans: ON by default for a new automation (`REPLY_LIKE_PERSON_DEFAULT_PAID`). OFF: the reply goes right after the DM went, every comment gets one, no box, no chance, no hour limit, no waiting limit. ON (PRO): the rows marked "ON" below.

| Name | Value | Owner? (min to max) | Meaning |
|---|---|---|---|
| `REPLY_LIKE_PERSON_LIMITS` | 10, 20, 30, 60, 100 | Yes, per automation: one of these (column `app.automations.public_reply_hour_limit`) | ON: public replies per hour of this automation. |
| `REPLY_LIKE_PERSON_DEFAULT_PAID` | true | No | A new automation on a paid plan (Creator, Studio) starts with "Reply like a person" ON. Free: always OFF. |
| `REPLY_LIKE_PERSON_LIMIT_DEFAULT` | 60 | No | ON: the value picked when it is turned on. |
| `PUBLIC_REPLY_SUGGEST_LIMIT` | 100 | No | ON: the screen suggests this limit ... |
| `PUBLIC_REPLY_SUGGEST_AFTER_DAYS` | 7 | No | ... after this many days without a reply error on the account. |
| `PUBLIC_REPLY_GAP_MIN_SECONDS` | 20 | No | ON: at least this time after the account's last ON reply. OFF replies do not count. |
| `PUBLIC_REPLY_CHANCE_PERCENT` | 80 | No | ON: share of comments that get a public reply. Decided when the reply is made. |
| `PUBLIC_REPLY_MAX_WAITING` | 500 | No | ON: at most this many replies wait per automation. Older ones: `skipped` `hour_limit`. |
| `PUBLIC_REPLY_MAX_AGE_HOURS` | 168 | No | ON and OFF: up to 7 days after the comment, then `expired`. |
| `PUBLIC_REPLY_MENTION_DEFAULT` | true | Yes, per automation (column `app.automations.public_reply_mention`) | Default of a new automation: the reply starts with `@username`. Off: the reply text without `@username` (test needed, section 43). |
| `PUBLIC_REPLY_TEXTS_MIN` | 1 | No | Fewest lines (meepzo check). |
| `PUBLIC_REPLY_LINES_MIN_ON` | 3 | No | ON needs at least this many lines (a go-live check). OFF: 1 line is enough. |
| `PUBLIC_REPLY_TEXTS_MAX` | 20 | No | Most lines (meepzo check). Free: 1 line, because several lines are PRO (36.21). |
| `AUTOMATION_PUBLIC_REPLY_TEXT_MAX_LENGTH` | 300 | No | Characters in one line (meepzo-be check today). |
| `USAGE_SLOW_PERCENT` | 80 | No | Meta's usage header over this: ON reply box x `REPLY_USAGE_FACTOR`, and the missed-comment round is skipped. |
| `USAGE_STOP_PERCENT` | 95 | No | Over this: all replies and hides wait (Meta's time, else `USAGE_WAIT_DEFAULT_MINUTES`). |
| `USAGE_WAIT_DEFAULT_MINUTES` | 15 | No | Replies wait this long when usage is very high and Meta gives no time. |
| `REPLY_USAGE_FACTOR` | 2 | No | ON: box this many times bigger when usage is high. |
| `USAGE_KEEP_HOURS` | 1 | No | The usage number lives this long in the copy Redis. |

Hides (`hide_comment`) have no number of their own. They go in the reply lane right after the reply (or right after the DM when there is no reply), with no box and no limit, and are not counted as DMs (section 13).

### 36.6 Windows, waits and asks

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `LIMIT_WINDOW_MINUTES` | 60 | No (fixed) | All hour limits look at the last 60 minutes. The box formula uses 3600 seconds, so this is fixed. |
| `MESSAGING_WINDOW_HOURS` | 24 | No (fixed, Meta) | Her chat window. |
| `WINDOW_SAFETY_MINUTES` | 15 | No | Her window counts as open until 24 hours minus this time. Checked just before each message of a list. |
| `MESSAGE_WAIT_MIN_MINUTES` | 1 | No | Shortest wait the owner can set before a message (or no wait). |
| `MESSAGE_WAIT_MAX_HOURS` | 23 | No | Longest wait before a message. Under the 24-hour window. |
| `NUDGE_AFTER_MINUTES` | 60 | No | No tap after the hello for this long: the hello goes once more (only when she messaged first). |
| `OWNER_CHAT_QUIET_HOURS` | 6 | No | The owner typed to her by hand: no automatic "ask again" and no "no other automation answered" to her for this long. Per contact: other people are not affected. |
| `RUN_WAIT_MAX_DAYS` | 7 | No | A run that waits longer is cancelled `wait_expired` by meepzo-be's hourly worker. |
| `ASK_AGAIN_MAX` | 3 | No | Email or phone: the first question plus at most 3 asks again. |
| `PENDING_ESTIMATE_EVERY_MINUTES` | 10 | No | How often "will go / may expire" is made again. |

### 36.7 How long rows stay, and partitions

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `WEBHOOK_EVENT_KEEP_DAYS` | 8 | No (derived) | = `PRIVATE_REPLY_MAX_AGE_HOURS` / 24 + 1. |
| `EVENT_KEY_KEEP_DAYS` | 8 | No (derived) | Same as above. |
| `SEND_ATTEMPT_KEEP_DAYS` | 8 | No | Instagram call log. |
| `MESSAGE_KEEP_DAYS` | 30 | No | `app.instagram_messages` (weekly parts are dropped after 30 days). Also the "What happened" list of a contact. Runs, run events and comment logs stay 90 days. |
| `RUN_KEEP_DAYS` | 90 | No | Runs and run history, counted from the run's end. The all-time counters (`app.automation_counts`) stay. |
| `COMMENT_LOG_KEEP_DAYS` | 90 | No | Comment logs. |
| `MINUTE_COUNT_KEEP_HOURS` | 2 | No | Rows of `app.instagram_send_minute_counts`. |
| `STOP_HISTORY_KEEP_DAYS` | 90 | No | `app.instagram_send_stops`. |
| `EVENT_KEY_DELETE_BATCH` | 5000 | No | Old event keys are deleted in pieces of this size. |
| `PARTITION_DAYS_AHEAD` | 3 | No | Daily parts made this far ahead. |
| `PARTITION_WEEKS_AHEAD` | 2 | No | Weekly parts made this far ahead. |
| `PARTITION_MONTHS_AHEAD` | 2 | No | Monthly parts made this far ahead. |
| `PARTITIONS_AHEAD_ALERT_DAYS` | 2 | No | Fewer days ready ahead: team alert. |
| `PARTITION_LOCK_TIMEOUT_MS` | 2000 | No | The partition worker waits at most this long for a table lock. |
| `PARTITION_DROP_RETRIES` | 5 | No | A drop that could not get its lock is tried again this many times, then team alert. |
| `FAILED_EVENT_RETRY_MINUTES` | 60 | No | The helper tries a `failed` event again this often, until its comment expires. |
| `TAG_EVENT_KEEP_DAYS` | 8 | No | Rows of `app.contact_tag_events` (tag added or removed) are kept this long. |
| `BROADCAST_RECIPIENT_KEEP_DAYS` | 90 | No | Rows of `app.broadcast_recipients` (split by month of `created_at`). The broadcast's own counters stay. |

Month count rows are kept `DM_MONTH_KEEP_MONTHS` (36.18).

### 36.8 Timeouts and leases

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `INSTAGRAM_TIMEOUT_MS` | 15000 | No | Longest wait for one Instagram call. |
| `LEASE_SECONDS` | 120 | No | A lane or message in `sending` without a result after this: the helper takes over. |
| `SHUTDOWN_SECONDS` | 30 | No | A stopping server waits at most this long for sends on their way. |
| `SERVER_KILL_SECONDS` | 45 | No | The platform kills the server after this. Must be over `SHUTDOWN_SECONDS`. |
| `REDIS_TIMEOUT_MS` | 100 | No | Gate 1 slower than this: skipped. |
| `REDIS_SKIP_AFTER_TIMEOUTS` | 3 | No | After this many slow answers in a row ... |
| `REDIS_SKIP_SECONDS` | 30 | No | ... gate 1 is skipped for this long without asking. |
| `DB_STATEMENT_TIMEOUT_MS` | 5000 | No | Longest single query in a sending transaction (`SET LOCAL`). |
| `DB_LOCK_TIMEOUT_MS` | 1000 | No | Longest wait for a row lock in a sending transaction (`SET LOCAL`). |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 20000 | No | Postgres ends a transaction that does nothing for this long (set on the role). |
| `DB_DEADLOCK_RETRIES` | 3 | No | A transaction that hit a deadlock or a lock timeout runs again up to this many times. |
| `WEBHOOK_SAVE_TIMEOUT_MS` | 3000 | No | The webhook save takes longer: save to the Redis buffer and answer 200; both down: answer 500. |
| `WEBHOOK_MAX_BODY_MB` | 5 | No | Largest webhook body (meepzo-be today). |
| `DB_POOL_WAIT_TIMEOUT_MS` | 2000 | No | Longest wait for a pool connection in sending work (meepzo-be's HTTP default is 10,000). |
| `DB_ERROR_RETRY_SECONDS` | 1, 2, 4, 8 | No | A Postgres error before `sending`: the ticket comes back after these times. |
| `PROFILE_READ_TIMEOUT_MS` | 3000 | No | Profile read of a new contact in intake. Too slow: go on without it. |
| `WEBHOOK_ANSWER_MAX_SECONDS` | 5 | No (fixed, Meta) | Meta wants an answer within this time. |
| `SAVE_RESULT_RETRY_SECONDS` | 30 | No | After Instagram answered but the save failed, a "save result" job in Redis is retried every this many seconds until saved. |
| `CLOCK_SKEW_MAX_MS` | 2000 | No | Server clock vs Postgres clock. Over this: alert, and the server takes no tickets. |
| `ATTACHMENT_UPLOAD_TIMEOUT_MS` | 60000 | No | Longest wait for one file upload to Meta (Meta reads the file from a short signed link). A cut upload sends nothing; it is tried again. |

### 36.9 Places and pools

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `INTAKE_PLACES` | 20 (start 5) | No | Intake jobs at once on one server. |
| `FAST_PLACES` | 100 (start 40) | No | Fast tickets at once on one server. |
| `SLOW_PLACES` | 50 (start 40) | No | Slow, reply and broadcast lane tickets at once on one server. |
| `DB_POOL_SIZE_PER_SERVER` | 20 | No | Postgres connections the sending work needs on one server (estimate), inside meepzo-be's `DATABASE_POOL_MAX`. |
| `WEBHOOK_DB_POOL_SIZE` | 5 | No | Own small pool for the webhook, so sending never blocks it. |
| `TASK_PLACES` | 5 (start 2) | No | Task jobs (`instagram-tasks`: account setup, starter questions, file uploads, token check, bulk tags, month wake, plan change, `segment-count`, `broadcast-audience`, `past-comments`, `retry-failed`) at once on one server. |
| `BULLMQ_EVENTS_MAXLEN` | 1000 | No | Length of BullMQ's event stream. |
| `RESTART_JITTER_SECONDS` | 10 | No | Random extra wait when many lanes start again together. |

### 36.10 Errors, stops and tests

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `TOO_FAST_STOP_MINUTES` | 15, 30, 60, 120, 240, 360 | No | Lane stop after "too fast" when Instagram gives no time, one step longer each time. Also for the reply lane. |
| `BLOCKED_TEST_HOURS` | 24, 48, 72 | No | Test times after "blocked" (then every 72). Also for the reply lane. |
| `ACCESS_TEST_MINUTES` | 60 | No | Test time after "message access off" and after 200/2018028. |
| `STOP_COUNT_RESET_HOURS` | 24 | No | Sending time without the error before `stop_count` starts again. |
| `APP_LIMIT_MIN_ACCOUNTS` | 2 | No | Code 4 without a subcode from this many different accounts ... |
| `APP_LIMIT_WINDOW_MINUTES` | 5 | No | ... within this time = app limit. |
| `APP_STOP_MINUTES` | 15, 30, 60 | No | Stop all accounts, one step longer each time (`all_stop_count`). |
| `DOWN_IN_A_ROW` | 3 | No | No answer or try later this many times in a row on one account: account "down" stop. |
| `DOWN_STOP_MINUTES` | 5, 10, 20, 40 | No | "Down" stop times, one step longer while results stay unclear. |
| `DOWN_ALL_SHARE_PERCENT` | 30 | No | This share of active accounts in a "down" stop: stop all accounts. |
| `BAD_PERCENT` | 30 | No | Bad results over this share ... |
| `BAD_MIN_CALLS` | 50 | No | ... over at least this many calls ... |
| `BAD_WINDOW_SECONDS` | 30 | No | ... in this time: stop all accounts. |
| `DOWN_CHECK_EVERY_SECONDS` | 10 | No | How often the down and app-limit checks run. |
| `RELEASE_SPREAD_MINUTES` | 5 | No | After an all-accounts stop, lanes start again spread over this time, at half speed. |
| `TEST_MAX_TURNS` | 3 | No | Person or text problems in a test before waiting again. |
| `TEST_LEASE_MINUTES` | 2 | No | A test without a result after this ends. |
| `TEST_DELAY_OTHER_LANES_SECONDS` | 30 | No | Other lanes wait this long while one lane tests. |
| `PERSON_ERROR_IN_A_ROW` | 5 | No | The same person code for this many different people in a row: banner + team email. |
| `AUTOMATION_BAD_TEXT_IN_A_ROW` | 5 | No | Refused text this many times in a row on one automation (comment still there): stop the automation. |
| `WRONG_PERMISSION_IN_A_ROW` | 3 | No | `CODES_WRONG_PERMISSION` for this many different people in a row: stop all lanes, ask to reconnect. Follow checks never count. |
| `NEVER_CONNECTED_SECONDS` | 5, 15, 60 | No | Waits after "never connected" (DNS, refused). |
| `TRY_LATER_MINUTES` | 1, 5, 15 | No | Opening DM "try later" waits. |
| `INTAKE_MAX_ATTEMPTS` | 5 | No | Intake tries before an event is `failed` (meepzo-be today), backoff from 5 seconds. A connection error does not use a try. |

### 36.11 Error code lists

Each code is in **one** group only (start check 36.24). The subcode is read first, then the code.

| Name | Codes | What happens |
|---|---|---|
| `CODES_TOO_FAST` | 613 (not 613/2018338), 17, 32, 80002, 80006, HTTP 429 | Stop this lane (a reply or hide: only the reply lane; a broadcast: only the broadcast lane, `BROADCAST_STOP_FACTOR` times longer). Instagram's time, else `TOO_FAST_STOP_MINUTES`. |
| `CODES_BLOCKED` | 368, 10/1893063, 100/2534029, 613/2018338 | Stop all lanes of the account (a reply: only the reply lane). Tests `BLOCKED_TEST_HOURS`. Email. |
| `CODES_ACCOUNT_FLAGGED` | **4 with any subcode** (e.g. 4/2207051 spam) | Stop the lane that got it (a reply: only the reply lane), like blocked. Never other accounts. |
| `CODES_LOGIN_EXPIRED` | 190 | Stop all lanes of every account of that Meta connection (one token covers them all), no end time. Connection `error`. Email + "Reconnect" banner. Never retried. Ends when the owner reconnects. |
| `CODES_ACCESS_OFF` | 200/2534041, 10/2534077 | Stop all lanes, test every `ACCESS_TEST_MINUTES`. Email. |
| `CODES_APP_LIMIT` | 4 **without a subcode**, 341 | Stop all accounts only when `APP_LIMIT_MIN_ACCOUNTS` accounts get it within `APP_LIMIT_WINDOW_MINUTES`. One account alone: that lane, as too fast. |
| `CODES_APP_NOT_APPROVED` | 200/2018028 | Stop all lanes of this account, test every `ACCESS_TEST_MINUTES`. Team alert (often: Advanced Access missing, section 41). |
| `CODES_WRONG_PERMISSION` | other code 10, and 200 to 299, not in another list | This message `failed`. `WRONG_PERMISSION_IN_A_ROW` (3) different people in a row: stop all lanes, ask the owner to reconnect. |
| `CODES_PERSON` | 551, 1545041, 10/2018108, 100/2018001, 100/2534014 | Only this message `skipped`. |
| `CODES_OTHER_APP` | 10/2018300, 100/2534037 | Another app controls her chat. Message `skipped`. `PERSON_ERROR_IN_A_ROW` people: banner + team email. |
| `CODES_WINDOW_CLOSED` | 10/2018278, 10/2534022 | A comment run goes back to a private reply in the slow lane (if not expired). A message of the list: `skipped` (`window_closed`), no rows are made for the rest, the run ends `cancelled` (`window_closed`). A nudge: `skipped`, the run still waits for her tap. A broadcast message: the recipient is `skipped` (`window_closed`). Others: `skipped` (`window_closed`), the run waits for `any` (section 30.2). |
| `CODES_COMMENT_GONE` | 100/33, 100/2534025 | Read the comment once. Gone or hidden: `skipped`, never counted "in a row". Still there: treated as bad text. |
| `CODES_LIVE_ENDED` | from test (section 43) | A Live private reply after the Live ended: `expired` (`live_ended`). Never a stop. |
| `CODES_ATTACHMENT_GONE` | from test (section 43) | The saved attachment id no longer works: the cached id is deleted, the places are given back, the message goes back to `waiting` and the file is uploaded again. After `ATTACHMENT_UPLOAD_TRIES` (3) tries: `failed` (`attachment_failed`), not counted (section 30.4). |
| `CODES_BAD_TEXT` | 100 (all other subcodes), HTTP 413 | Message `failed`, counts for `AUTOMATION_BAD_TEXT_IN_A_ROW`. |
| (no list) "check not possible" | any error of the follow read that is not a stop | One more try, then `FOLLOW_CHECK_FAIL_MEANS` (section 30). |
| `CODES_TRY_LATER` | 1, 2, HTTP 5xx with an answer, any unknown code (+ team alert) | Opening DM waits `TRY_LATER_MINUTES`. Others: `unknown`. |
| `CODES_ALREADY_SENT` | from test (section 43) | We tried this DM before: `sent`. First try: `skipped` (somebody else answered). In restore mode: `sent` (section 39). |

### 36.12 Helper and checks

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `HELPER_EVERY_SECONDS` | 60 | No | One helper round. |
| `LATE_TICKET_MINUTES` | 1 | No | A lane ticket this late is checked by the helper. |
| `HELPER_SLOTS` | 16 | No | Accounts are split into this many slots. |
| `HELPER_SLOT_LEASE_SECONDS` | 45 | No | A slot belongs to one server this long ... |
| `HELPER_SLOT_RENEW_SECONDS` | 15 | No | ... and is renewed this often. A server takes at most 16 / live servers. |
| `HELPER_PASS_LIMIT` | 500 | No | Rows one helper pass touches at most. |
| `WEBHOOK_CHECK_MINUTES` | 10 | No | Is the webhook subscription (`subscribed_apps`) of each account on? |
| `MISSED_CHECK_MINUTES` | 30 | No | Missed-comment normal round. |
| `MISSED_POSTS_PER_ROUND` | 25 | No | Posts per account per normal round (rotated when there are more). |
| `MISSED_POST_AGE_HOURS` | 168 | No (derived) | = `PRIVATE_REPLY_MAX_AGE_HOURS`. |
| `MISSED_LOOKBACK_MINUTES` | 10 | No | Read comments from `last_comment_at` minus this. |
| `MISSED_CALLS_PER_SECOND` | 1 | No | Missed-comment reads per account per second. |
| `MISSED_FULL_PASS_SPREAD_MINUTES` | 10 | No | After an outage the full pass is spread over this time across accounts. |
| `COUNT_KEY_HOURS` | 2 | No | A Redis count key ends after this without activity. |
| `COUNT_COMPARE_SECONDS` | 60 | No | Redis count vs Postgres minute counts. |
| `COUNT_REDIS_HIGHER_MINUTES` | 2 | No | Redis higher than Postgres for this long: rebuild. |
| `DAY_COUNT_CHECK_MINUTES` | 60 | No | Day count check (only if the day limit is ON). |
| `EMAIL_RETRY_MINUTES` / `EMAIL_STUCK_MINUTES` | 5 / 5 | No | `auth.mail_outbox` retries. |
| `EMAIL_AFTER_STOP_MINUTES` | 60 | No | A stop longer than this: email the owner. |
| `EMAIL_OWNER_GAP_HOURS` | 6 | No | At most one email of the same kind per account in this time (the month emails: once each per workspace and month). |
| `SAVE_RESULT_ALERT_MINUTES` | 5 | No | "Save result" jobs waiting longer: team alert. |

### 36.13 Notes, intake and Redis

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `SEEN_NOTE_MINUTES` | 10 | No | `seen:{account}:{event_key}` lives this long. |
| `SENT_NOTE_MINUTES` | 10 | No | `mid:{account}:{instagram_message_id}` lives this long. |
| `NOTICE_MATCH_MINUTES` | 10 | No | A "message was sent" notice matches a message tried in this time. |
| `COPY_SECONDS` | 60 | No | Copies `acct:`, `auto:` and the month count copy `cnt:month:` live this long (section 23). |
| `BANNER_SECONDS` | 10 | No | `banner:{account}` lives this long. |
| `INBOUND_PERSON_PER_MINUTE` | 20 | No | Over this many events from one person in a minute: only the event is saved and her contact time refreshed. No new run, no answer check (section 27). |
| `INTAKE_ACCOUNT_SOFT_LIMIT` | 500 | No | Over this many waiting comment events, the account's `comments` job gets `INTAKE_LOW_PRIORITY`. |
| `INTAKE_LOW_PRIORITY` | 10 | No | Priority of a viral account's `comments` intake job, and of the tag event jobs of an owner's bulk change. |
| `INTAKE_MESSAGES_PRIORITY` | 1 | No | Priority of an account's `messages` intake job (taps, answers, DMs, story replies and the other message starts) and of its `live` job (Live comments). Lower = first. |
| `INTAKE_COMMENTS_PRIORITY` | 5 | No | Priority of an account's `comments` intake job (comments and ad comments), and of one tag event job (section 24.2). |
| `COMMENT_TIME_CHECK_LATE_MINUTES` | 60 | No | A comment event that arrives more than this after `entry.time` (Meta's send time; for example a retry): intake reads the comment's `timestamp` once. Else `entry.time` is the comment time. |
| `INTAKE_EVENT_LEASE_MINUTES` | 5 | No | Lease of an event an intake job is handling (meepzo-be today). |
| `INTAKE_EVENTS_PER_JOB` | 25 | No | Events per intake job before it adds a follow-up job and yields (meepzo-be today). |
| `EVENT_LATE_SECONDS` | 60 | No | An event not handled after this gets help. |
| `REDIS_DOWN_EMAIL_MINUTES` | 1 | No | Redis down longer: team email. |
| `REDIS_MEMORY_ALARM_PERCENT` | 75 | No | Ticket Redis memory over this: alarm. |

### 36.14 Text and answers

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `EMAIL_MAX_LENGTH` | 254 | No | Longest email. |
| `EMAIL_ALLOWED_LOCAL` | letters, digits, `._%+-` | No | Allowed before the @. |
| `EMAIL_ALLOWED_DOMAIN` | letters, digits, `.-` | No | Allowed after the @. |
| `PHONE_DIGITS_MIN` | 10 | No | Fewest digits (meepzo check). |
| `PHONE_DIGITS_MAX` | 15 | No | Most digits (meepzo check). |
| `STOP_WORDS` | stop, unsubscribe | Yes, owner can add words | The whole message, after trim, lower case and no punctuation, must be one of them. She starts again only by her own new keyword comment, keyword DM, starter question tap or link (section 14). |
| `UNKNOWN_RATE_GOOD_PERCENT` | 1 | No | `unknown` under this share is good. |
| `UNKNOWN_RATE_ALERT_PERCENT` | 3 | No | Over this: team alert. |

Message text sizes are in 36.17.

### 36.15 Other

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `SETTINGS_VERSION` | 1, then +1 each change | No | Deploy rule in section 38. |
| `SETTINGS_MIXED_MAX_MINUTES` | 15 | No | Two versions running together longer: team email. |
| `RESTORE_WAIT_MINUTES` | 60 | No | After a restore, wait this long after the last real send before sending again. |
| `LATE_TICKET_ALERT_SECONDS` | 120 | No | Oldest late ticket over this: team alert. |
| `OLD_EVENT_ALERT_SECONDS` | 300 | No | Oldest unhandled event over this: team alert. |
| `HELPER_ROUND_ALERT_SECONDS` | 180 | No | No helper round for this long: team alert. |
| `HEALTH_CHECK_EVERY_SECONDS` | 60 | No | How often the outside checker calls `/health`. |
| (column `automatic_notice_enabled`) | false | Yes | Add a short "this is automatic" line to the first DM (section 41). |

### 36.16 Meta login, connect and Meta tasks

Words: **Unified Login** = Meta's login where the person signs in with Instagram or Facebook and shares Instagram accounts of a **business portfolio** (Meta's folder for a business's accounts). **Meta connection** = one login of one workspace to one business portfolio (`app.meta_connections`, section 25).

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `META_GRAPH_VERSION` | v27.0 | No | Graph API version on `graph.facebook.com` (Unified Login). |
| `INSTAGRAM_ACCOUNT_REQUIRED_SCOPES` | `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments` | No | Connect is refused without all of them. `ads_read` is asked too, but not required (section 41). |
| `INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS` | `comments`, `live_comments`, `messages`, `messaging_postbacks`, `messaging_referral`, `message_reactions` | No | Fields sent to `subscribed_apps` for each account at connect and by the webhook check. |
| `TOKEN_CHECK_EVERY_HOURS` | 24 | No | Each connected Meta connection's token is checked this often (one call, spread over the day). A token error: connection `error`, all its lanes stop, "Reconnect" banner. Nothing to refresh: the token does not end. |
| `CONNECT_STATE_MINUTES` | 10 | No | The login `state` lives this long in Redis (`connect:{state}`) and is used once. |
| `CONNECTION_ERRORS_HOUR_ALERT` | 5 | No | This many connections or more went to `error` in the last hour: team alert (section 40). |
| `META_TASK_RETRY_MINUTES` | 1, 5, 15, 60 | No | A task job's failed Meta call (account setup, starter questions, file upload, token check) is tried again after these waits. Then a banner on that account, one owner email, and the helper tries once an hour. |

### 36.17 Automation content

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `AUTOMATION_MESSAGES_MAX` | 10 | No | Messages in one automation's list. |
| `MESSAGE_TEXT_MAX_BYTES` | 1000 | No (Meta) | Text of a message without buttons, counted in UTF-8 bytes: an emoji or a Gujarati letter uses 2 to 4 bytes. Checked at save and at go-live; the screen shows what is left. |
| `BUTTON_TEXT_MAX_CHARS` | 640 | No (Meta) | Text of a message with buttons (the hello, the follow ask), in characters. |
| `HELLO_BUTTONS_MAX` | 3 | No (Meta max 3) | Buttons on the hello. Each opens a link or sends the next step. |
| `LINK_BUTTONS_MAX` | 3 | No (Meta max 3) | Link buttons on a text message. |
| `BUTTON_TITLE_MAX_CHARS` | 20 | No | Text on one button (meepzo-be check today). |
| `AUTOMATION_LINK_URL_MAX_LENGTH` | 2048 | No | Longest link, `https` only (meepzo-be check today). |
| `CARDS_MAX` | 10 | No (Meta max 10) | Product cards in one message. |
| `CARD_TITLE_MAX_CHARS` | 80 | No (Meta max 80) | Card title. |
| `CARD_SUBTITLE_MAX_CHARS` | 80 | No (Meta max 80) | Card line under the title. |
| `QUICK_REPLIES_MAX` | 13 | No (Meta max 13) | Quick reply choices in one message. |
| `QUICK_REPLY_MAX_CHARS` | 20 | No (Meta max 20) | Text of one quick reply. |
| `MESSAGE_VERSIONS_MAX` | 3 | No | Versions of the hello and of the follow ask. One is picked at random per run. |
| `QUESTION_WORDINGS_MAX` | 10 | No | Wordings of the email question and of the phone question. |
| `STARTER_QUESTIONS_MAX` | 4 | No (Meta max 4) | Starter questions per account, across all its live starter-question automations (1 to 4 in one automation). |
| `STARTER_QUESTION_MAX_CHARS` | 80 | No | Longest starter question (test needed, section 43). |
| `REF_CODE_MAX_CHARS` | 64 | No | Longest `ref_code` of a link or QR automation: letters, digits, `-`, `_`, `=`. Our own limit (Meta allows 2,083). |
| `AUTOMATION_STEPS_MAX_BYTES` | 65536 | No | Largest `steps` JSON of one automation. |
| `AUTOMATION_KEYWORDS_MAX_COUNT` | 50 | No | Keywords in one automation (meepzo-be today). |
| `AUTOMATION_KEYWORD_MAX_LENGTH` | 100 | No | Characters in one keyword (meepzo-be today). |
| `KEYWORD_TYPO_MIN_LETTERS` | 5 | No | Close spellings, word by word, also inside keywords of several words: a word of at least this many letters may have `KEYWORD_TYPO_MAX_EDITS` wrong letters; shorter words must be exact; the words come together, in the same order. |
| `KEYWORD_TYPO_MAX_EDITS` | 1 | No | At most this many wrong letters ("guied" matches "guide"). |
| `MESSAGE_IMAGE_MAX_MB` | 8 | No (Meta max 8) | Largest image (png or jpeg). |
| `MESSAGE_AUDIO_MAX_MB` | 25 | No (Meta max 25) | Largest voice note (aac, m4a, wav, mp4). |
| `MESSAGE_VIDEO_MAX_MB` | 25 | No (Meta max 25) | Largest video (mp4, ogg, avi, mov, webm). Used only if a video kind is offered. |
| `MESSAGE_FILE_MAX_MB` | 25 | No (Meta max 25) | Largest PDF. |
| `ATTACHMENT_UPLOAD_TRIES` | 3 | No | Tries to upload one file to Meta for one account (an attachment error also uploads again). All fail: the message is `failed` (`attachment_failed`; nothing went, not counted), banner on that automation, team alert (section 40). |

### 36.18 Month count and counters

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `DM_MONTH_COUNT_SLOTS` | 16 | No | Rows per workspace per month in `app.dm_month_counts`. Slot = account id mod 16. |
| `DM_MONTH_NOTICE_PERCENT` | 80 | No | At this share of the plan's `dm_month_limit`: notice + email, once a month. At 100%: notice + email again, once a month. |
| `DM_MONTH_KEEP_MONTHS` | 13 | No | Month rows kept: this month and the 12 before. |
| `DM_MONTH_CHECK_HOURS` | 24 | No | The helper compares the month count with the DM rows tried this month (section 40). |
| `DM_MONTH_DRIFT_ALERT_PERCENT` | 2 | No | A gap over this share: team alert. |
| `PLAN_LIMIT_STOPS_ALERT_PERCENT` | 20 | No | More than this share of active workspaces in a `plan_limit` stop (slow, fast and broadcast lanes): team alert (a count may be wrong). |
| `AUTOMATION_COUNT_SLOTS` | 16 | No | Rows per automation in `app.automation_counts`. Slot = run id mod 16. |
| `LAST_TRIGGERED_UPDATE_SECONDS` | 60 | No | `last_triggered_at` of an automation is rewritten only when it is older than this (fewer writes on a viral automation). |

### 36.19 Tags and contacts

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `TAG_BULK_PIECE` | 500 | No | Owner bulk add or remove: contacts per piece (one short transaction each). |
| `TAG_LIST_CACHE_SECONDS` | 60 | No | The tag list with counts lives this long in Redis (`tags:{account}`). |
| `AUTOMATION_TAGS_MAX_COUNT` | 20 | No | Tags one automation adds (meepzo-be today). |
| `AUTOMATION_TAG_MAX_LENGTH` | 50 | No | Characters in one tag (meepzo-be today). |
| `CONTACT_TAGS_MAX_COUNT` | 50 | No | Tags on one contact (meepzo-be today). |
| `CONTACT_LIST_TAGS_FILTER_MAX_COUNT` | 10 | No | Tags in one contact list filter (meepzo-be today). |
| `CONTACT_NOTE_MAX_CHARS` | 2000 | No | The owner's private note on a contact (section 41). |
| `TAG_CHAIN_MAX` | 3 | No | Tag starts stop at this `chain_no` of `app.contact_tag_events`: a run started by a tag that adds a tag makes `chain_no` + 1 (loop guard). |

### 36.20 Product (sections 44 to 48)

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `AUTH_PASSWORDS_ENABLED` | false | No | Switch: password routes and the password step-up are off (section 44). |
| `EMAIL_CODE_WRONG_TRIES_PER_DAY` | 20 | No | Wrong email-code tries per email per 24 hours. Then email code is closed for that email until 24 hours pass. |
| `TRUSTED_DEVICE_DAYS` | 30 | No | "Trust this device": no two-factor code on that device for this long, only in a workspace that does not require 2FA. |
| `TRUSTED_DEVICES_MAX` | 10 | No | Live trusted devices per person. An 11th revokes the oldest. |
| `MFA_STRONG_WARNING_AFTER_TRIES` | 3 | No | App number: the stronger two-factor message shows from this wrong try. |
| `OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES` | 16384 | No | Largest body of Apple's form POST return. |
| `TENANCY_CUSTOM_ROLES_ENABLED` | false | No | Switch: custom roles are off (section 45). |
| `INVITATION_PREVIEW_PER_MINUTE` | 30 | No | Invitation preview calls per IP per minute. |
| `INVITATION_EXPIRES_DAYS` | 7 | No | Life of an invitation (meepzo-be's `expires_in_days` default, now named). |
| `INVITE_EMAILS_MAX` | 20 | No | Emails in one invite request. |
| `BILLING_SEAT_SYNC_ENABLED` | false | No | Switch: the member count is not sent to Stripe as seats (flat prices, section 46). |
| `PLAN_STATE_CHECK_MINUTES` | 15 | No | How often the billing worker looks for graces that ended. |
| `CONTACT_DETAILS_NOTICE_EVERY_MINUTES` | 60 | No | At most one "new contact details" note per account in this time (section 47). |
| `WEEKLY_SUMMARY_WEEKDAY` | 1 (Monday) | No | Day of the weekly summary, in the workspace's time zone. |
| `WEEKLY_SUMMARY_HOUR` | 9 | No | Hour of the weekly summary, in the workspace's time zone. |
| `EMAIL_CONFIRM_LINK_HOURS` | 24 | No | Life of the confirm-email link. |
| `REFERRAL_CODE_LENGTH` | 8 | No | Letters and digits in a referral code (section 48). |
| `REFERRAL_CLAIM_WINDOW_HOURS` | 24 | No | Time after sign-up in which a referral can be claimed. |
| `REFERRAL_HOLD_DAYS` | 30 | No | Hold before an earning is approved. |
| `REFERRAL_TIERS` | 1:30, 10:40, 25:50 | No | Paying friends : percent of their payments. |
| `REFERRAL_COOKIE_DAYS` | 30 | No | App number: how long the app keeps a referral code from a link. |
| `REFERRAL_MIN_PAYOUT_USD` | 50 | No | Smallest payout. Less rolls over to the next month. |
| `PAID_TRIAL_DAYS` | 7 | No | Free trial of Creator or Studio, no card. One per workspace, and never again for an Instagram account that had one (checked by `instagram_user_id`). At the end with no payment: Free, by the moving-down rule (section 46). |
| `TRIAL_NOTICE_DAYS` | 3, 1 | No | Notice and email this many days before the trial ends. |
| `AUTOMATION_SWITCH_LOCK_SECONDS` | 10 | No | After a change, the automation's Live switch waits this long. The answer says how many seconds are left. |

"App number" = a number the app (meepzo-fe) uses; it is listed here so both sides use the same value.

### 36.21 Per-plan values (billing plan rows, not this file)

These live in `billing.plans.features` (typed, section 46). A plan change is a row change, not a deploy.

| Value | Key | Free | Creator | Studio |
|---|---|---|---|---|
| DMs a month (per workspace) | `dm_month_limit` | 1,000 | 10,000 | 50,000 |
| Instagram accounts (per workspace) | `instagram_accounts_max` | 1 | 3 | 10 |
| PRO features | `pro_features` | no | yes | yes |
| Team members (section 45) | none (no seat limit) | unlimited | unlimited | unlimited |
| Priority support | `priority_support` | no | no | yes |

PRO features: email and phone steps, "Reply like a person", several public reply lines, versions, broadcasts, run on past comments, "Delay before each message". Without PRO: a draft with a PRO step cannot go live (it can still be saved), and a save cannot turn a PRO step on. After a move down, PRO steps that were already on stay saved and are ignored by the engine (D57). All 4 roles (Owner, Admin, Editor, Viewer) on every plan.

Plan states (section 46): Free never ends, only its limits. Payment failed: sending goes on until the grace date (`BILLING_DUNNING_GRACE_DAYS` 14). A cancelled paid plan ends at the period end (no grace). Plan ended: stop `plan_ended` on all lanes, no go-live. Moving down a plan: at the period end, accounts the owner did not keep get lane stop `plan_downgrade` on all their lanes ("choose active accounts" swaps them at any time). Automations are never stopped: the PRO parts the new plan lacks are off by the plan and the engine ignores them. Scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`); drafts and saved audiences stay. An unfinished past-comments run ends `failed` (`plan_feature_off`); DMs it already queued still go. Nothing is deleted (D57). Trial (`PAID_TRIAL_DAYS` 7): the plan's full features and limits; at the end with no payment, the same moving-down rule to Free. meepzo-be's `NEW_ORGANIZATION_TRIAL_DAYS` is not used. Workspace `SUSPENDED`: sending stops, like the team suspend (section 15).

### 36.22 Fixed facts (not settings)

These are maths or rules of Meta and Postgres. They never change behaviour, so they are not settings. A setting with "Meta max" may be lower, never higher (36.24).

| Fact | Value |
|---|---|
| Seconds in an hour (box formula) | 3600 |
| Middle of two random numbers | 2 |
| Meta: private replies per hour per account (posts, reels) | 750 |
| Meta: one private reply per comment | 1 |
| Meta: private reply age | 7 days |
| Meta: chat window | 24 hours |
| Meta: Send API calls per second per account (text, links, reactions, stickers) | 100 (another Meta page says 300) |
| Meta: Send API calls per second per account (audio or video) | 10 |
| Meta: Conversations API calls per second | 2 |
| Meta: text of a message | 1,000 bytes (UTF-8) |
| Meta: buttons on one message / button message text | 3 / 640 characters |
| Meta: cards in one message / title and line / buttons per card | 10 / 80 characters each / 3 |
| Meta: quick replies / characters each | 13 / 20 |
| Meta: image / audio / video / PDF | png or jpeg 8 MB / aac, m4a, wav, mp4 25 MB / mp4, ogg, avi, mov, webm 25 MB / 25 MB |
| Meta: sharing a post in a DM (`MEDIA_SHARE`) | only the account's own posts |
| Meta: starter questions (ice breakers) per account | 4 |
| Meta: `ref` on an ig.me link | letters, digits, `-`, `_`, `=`; up to 2,083 characters |
| Meta: Instagram testers on an app in Development mode | 50 |
| Meta: reading comments | newest first, 50 per page, no time filter |
| Meta: calls that are not messages, per account per 24 hours | 4,800 x the account's impressions |
| Meta: webhook answer | within 5 seconds |
| Meta: Graph host | `graph.facebook.com` |
| HTTP answers the webhook gives | 200; 400 (wrong signature, as meepzo-be today); 413 (body over `WEBHOOK_MAX_BODY_MB`); 429 (over 1,200 requests a minute per IP, meepzo-be's limit); 500 |
| HTTP answers from Instagram | 429 is in `CODES_TOO_FAST`; 413 (text too large) is in `CODES_BAD_TEXT`; 5xx is in `CODES_TRY_LATER` |
| The day starts | 00:00 in the organization's time zone (`tenancy.organizations`) |
| The month starts | 00:00 on the 1st in the organization's time zone |

### 36.23 Derived values

These are worked out from other settings. The code never stores them on their own.

| Value | Formula |
|---|---|
| Box size of the slow lane | 3600 / opening hour limit (x `HALF_SPEED_FACTOR` at half speed) |
| Box size of the reply lane (ON) | 3600 / the automation's `public_reply_hour_limit` (x `REPLY_USAGE_FACTOR` when usage is high) |
| Day limit (only if ON, owner set none) | hour limit x `DAY_LIMIT_DEFAULT_FACTOR` |
| Last moment to send a private reply | comment time + `PRIVATE_REPLY_MAX_AGE_HOURS` - `EXPIRY_SAFETY_MINUTES` |
| Last moment for a message in her window | her last message + `MESSAGING_WINDOW_HOURS` - `WINDOW_SAFETY_MINUTES` |
| Not-before time of message N+1 | sent time of message N + its wait |
| Nudge time | hello sent + `NUDGE_AFTER_MINUTES` |
| Keep days of webhook events and event keys | `PRIVATE_REPLY_MAX_AGE_HOURS` / 24 + 1 |
| Age of posts in the missed-comment round | `PRIVATE_REPLY_MAX_AGE_HOURS` |
| Helper slots one server may hold | `HELPER_SLOTS` / live servers, rounded up |
| Month used | sum of the workspace's `DM_MONTH_COUNT_SLOTS` rows for this month |
| Month notice | month used >= `dm_month_limit` x `DM_MONTH_NOTICE_PERCENT` / 100 (and again at 100%) |
| Month stop (`plan_limit` on the slow, fast and broadcast lanes; the reply lane goes on) | month used >= `dm_month_limit` |
| Tries of a task job | 1 + the number of `META_TASK_RETRY_MINUTES` waits |
| Box size of the broadcast lane | 3600 / the account's broadcast hour limit |
| Extra pause before a fast answer | min + (max - min) x (r1 + r2) / 2 of the account's two delay columns |
| Longest wait from her message to our answer | `BOT_ANSWER_MAX_SECONDS` - `BOT_ANSWER_SAFETY_SECONDS` (25 seconds) |
| Broadcast lane stop after "too fast" | (Meta's time, else `TOO_FAST_STOP_MINUTES`) x `BROADCAST_STOP_FACTOR` |
| End of a free trial | trial start + `PAID_TRIAL_DAYS`; notices at the end - each of `TRIAL_NOTICE_DAYS` |
| Oldest comment a past-comments run reads | now - N days + `EXPIRY_SAFETY_MINUTES` |
| End of a "when her chat opens" broadcast | its start + its days (1 to `BROADCAST_OPEN_WAIT_DAYS_MAX`) |

### 36.24 Start checks (the server does not start if one fails)

1. Every minimum is not over its maximum (all `_MIN` / `_MAX` pairs, `FAST_DELAY_MIN_MS` <= `FAST_DELAY_MAX_MS`, `FOLLOW_CHECK_RETRY_MIN_MS` <= `FOLLOW_CHECK_RETRY_MAX_MS`).
2. No negative number. No empty list where a list is needed.
3. `OPENING_HOUR_LIMIT_MAX` < 750 (Meta).
4. `LEASE_SECONDS` x 1000 > `INSTAGRAM_TIMEOUT_MS` + `DB_STATEMENT_TIMEOUT_MS`, and > `ATTACHMENT_UPLOAD_TIMEOUT_MS` + `INSTAGRAM_TIMEOUT_MS` + `DB_STATEMENT_TIMEOUT_MS`.
5. `SERVER_KILL_SECONDS` > `SHUTDOWN_SECONDS` > `INSTAGRAM_TIMEOUT_MS` / 1000.
6. `COUNT_KEY_HOURS` x 60 >= `LIMIT_WINDOW_MINUTES` + 1.
7. `MINUTE_COUNT_KEEP_HOURS` x 60 >= `LIMIT_WINDOW_MINUTES` + 1.
8. Keep days cover the age: `WEBHOOK_EVENT_KEEP_DAYS` and `EVENT_KEY_KEEP_DAYS` >= `PRIVATE_REPLY_MAX_AGE_HOURS` / 24 + 1.
9. `MESSAGE_KEEP_DAYS` >= `RUN_WAIT_MAX_DAYS` + `PRIVATE_REPLY_MAX_AGE_HOURS` / 24.
10. Each error code is in one `CODES_*` group only.
11. `CODES_ALREADY_SENT` is not empty in production.
12. Every owner default sits inside its owner bounds. `REPLY_LIKE_PERSON_LIMIT_DEFAULT` is one of `REPLY_LIKE_PERSON_LIMITS`. `PUBLIC_REPLY_LINES_MIN_ON` is between `PUBLIC_REPLY_TEXTS_MIN` and `PUBLIC_REPLY_TEXTS_MAX`.
13. `FAST_MAX_PARALLEL_PER_ACCOUNT` x 3600 >= `FAST_HOUR_LIMIT_MAX` (the parallel cap can reach the limit, about 1 second per call).
14. `DB_POOL_SIZE_PER_SERVER` + `WEBHOOK_DB_POOL_SIZE` <= meepzo-be's `DATABASE_POOL_MAX`.
15. `SETTINGS_VERSION` is not lower than `app.sending_state.settings_version` (section 38).
16. `app.sending_state.environment_id` = env `SENDING_ENVIRONMENT_ID` (section 39).
17. Meta caps (36.22): `MESSAGE_TEXT_MAX_BYTES` <= 1000, `HELLO_BUTTONS_MAX` and `LINK_BUTTONS_MAX` <= 3, `BUTTON_TEXT_MAX_CHARS` <= 640, `CARDS_MAX` <= 10, `CARD_TITLE_MAX_CHARS` and `CARD_SUBTITLE_MAX_CHARS` <= 80, `QUICK_REPLIES_MAX` <= 13, `QUICK_REPLY_MAX_CHARS` <= 20, `STARTER_QUESTIONS_MAX` <= 4, `MESSAGE_IMAGE_MAX_MB` <= 8, `MESSAGE_AUDIO_MAX_MB`, `MESSAGE_VIDEO_MAX_MB` and `MESSAGE_FILE_MAX_MB` <= 25, `REF_CODE_MAX_CHARS` <= 2083.
18. `MESSAGE_WAIT_MAX_HOURS` x 60 and `NUDGE_AFTER_MINUTES` are under `MESSAGING_WINDOW_HOURS` x 60 - `WINDOW_SAFETY_MINUTES`.
19. 3600 / the largest of `REPLY_LIKE_PERSON_LIMITS` >= `PUBLIC_REPLY_GAP_MIN_SECONDS` (a box is never shorter than the gap).
20. `KEYWORD_TYPO_MAX_EDITS` < `KEYWORD_TYPO_MIN_LETTERS`.
21. `DM_MONTH_NOTICE_PERCENT` is between 1 and 99. `DM_MONTH_KEEP_MONTHS` >= 2.
22. `AUDIO_MAX_PARALLEL_PER_ACCOUNT` <= `FAST_MAX_PARALLEL_PER_ACCOUNT`. `FAST_HOUR_LIMIT_MAX` / 3600 < `LIVE_PRIVATE_REPLY_PER_SECOND`.
23. The `META_*` env values are set (36.26). `META_GRAPH_VERSION` looks like `v27.0`.
24. Product switches: `AUTH_PASSWORDS_ENABLED`, `TENANCY_CUSTOM_ROLES_ENABLED` and `BILLING_SEAT_SYNC_ENABLED` are false in production. `REFERRAL_TIERS` go up in both numbers.
25. `EXTRA_DELAY_MAX_SECONDS` + `FAST_DELAY_MAX_MS` / 1000 <= `BOT_ANSWER_MAX_SECONDS` - `BOT_ANSWER_SAFETY_SECONDS`.
26. `BROADCAST_HOUR_LIMIT_DEFAULT` <= `BROADCAST_HOUR_LIMIT_MAX`, and 3600 x 1000 / `BROADCAST_HOUR_LIMIT_MAX` >= `OPENING_MIN_GAP_MS` (a box is never shorter than the gap).
27. `BROADCAST_MESSAGES_MAX` <= `AUTOMATION_MESSAGES_MAX`. `BROADCAST_RECIPIENT_KEEP_DAYS` >= `BROADCAST_OPEN_WAIT_DAYS_MAX`.
28. `PAST_COMMENTS_MAX_DAYS` x 24 <= `PRIVATE_REPLY_MAX_AGE_HOURS`.
29. Each of `TRIAL_NOTICE_DAYS` is under `PAID_TRIAL_DAYS`. `RETRY_FAILED_MAX` is at least 1.

### 36.25 meepzo-be names that change or are used

meepzo-be already has some of these numbers. They move into the one settings file, with the new values.

| meepzo-be today | Value today | Becomes | New value |
|---|---|---|---|
| `AUTOMATION_RUN_RETENTION_DAYS` | 180 | `RUN_KEEP_DAYS` | 90 |
| `AUTOMATION_COMMENT_LOG_RETENTION_DAYS` | 180 | `COMMENT_LOG_KEEP_DAYS` | 90 |
| webhook event clean-up | 30 days | `WEBHOOK_EVENT_KEEP_DAYS` | 8 |
| `AUTOMATION_RUN_WAIT_MAX_DAYS` | 7 | `RUN_WAIT_MAX_DAYS` | 7 |
| `INSTAGRAM_PRIVATE_REPLY_WINDOW_MILLISECONDS` | 7 days | `PRIVATE_REPLY_MAX_AGE_HOURS` | 168 |
| `INSTAGRAM_MESSAGING_WINDOW_MILLISECONDS` | 24 hours | `MESSAGING_WINDOW_HOURS` | 24 |
| `AUTOMATION_OPENING_MESSAGE_SKIP_WINDOW_MILLISECONDS` | 24 hours | `OPENING_PERSON_GAP_HOURS` (new meaning: window closed only) | 24 |
| `AUTOMATION_SEND_PAUSE_MIN_MILLISECONDS` / `_MAX_` | 200 / 1000 | removed (a worker never waits) | `FAST_DELAY_MIN_MS` / `FAST_DELAY_MAX_MS` 500 / 2000 |
| `AUTOMATION_PUBLIC_REPLY_HOUR_WINDOW_MILLISECONDS` | 60 minutes | `LIMIT_WINDOW_MINUTES` | 60 |
| `INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS` | 5 | `INTAKE_MAX_ATTEMPTS` | 5 |
| `INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES` | 5 | `INTAKE_EVENT_LEASE_MINUTES` | 5 |
| `INSTAGRAM_WEBHOOK_EVENTS_PER_JOB` | 25 | `INTAKE_EVENTS_PER_JOB` | 25 |
| `AUTOMATION_MESSAGE_TEXT_MAX_LENGTH` | 1000 characters | `MESSAGE_TEXT_MAX_BYTES` (counted in bytes) | 1000 |
| opening message text | 1000 | `BUTTON_TEXT_MAX_CHARS` (the hello has buttons) | 640 |
| `AUTOMATION_BUTTON_TITLE_MAX_LENGTH` | 20 | `BUTTON_TITLE_MAX_CHARS` | 20 |
| `AUTOMATION_FINAL_MESSAGE_LINKS_MAX_COUNT` | 3 | `LINK_BUTTONS_MAX` | 3 |
| `AUTOMATION_PUBLIC_REPLY_TEXTS_MAX_COUNT` | 20 | `PUBLIC_REPLY_TEXTS_MAX` | 20 |
| `INSTAGRAM_GRAPH_API_VERSION` | v24.0 on the old Instagram host | removed with the old Instagram client: `META_GRAPH_VERSION` on `graph.facebook.com` | v27.0 |
| `INSTAGRAM_ACCOUNT_REQUIRED_SCOPES` | 3 names of the old Instagram app | same name, the Unified Login names (36.16) | 3 names |
| env: the old Instagram app's id, secret, return address and webhook verify token | set | removed: the `META_*` env values (36.26) | — |
| `instagram-account-daily-check` (the daily token job) | daily | replaced by the token check job (`TOKEN_CHECK_EVERY_HOURS`) | 24 hours |
| `INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS` | `comments`, `messages`, `messaging_postbacks` | same name | 6 fields (36.16) |
| env `DATABASE_LOCK_TIMEOUT_MS` | 3000 (whole app) | stays; sending transactions add `SET LOCAL` `DB_LOCK_TIMEOUT_MS` | 1000 |
| env `DATABASE_POOL_ACQUIRE_TIMEOUT_MS` | 10,000 (HTTP) | stays; sending work waits at most `DB_POOL_WAIT_TIMEOUT_MS` | 2000 |
| env `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 30 seconds | also set on the app role: `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 20 seconds |
| columns `public_reply_hour_limit`, `public_reply_chance_percent`, `public_reply_gap_min_seconds`, `public_reply_gap_max_seconds`, `is_public_reply_safety_enabled` on `app.instagram_account_settings` | 60, 80, 20, 60, true | removed (the reply style is per automation) | — |

Existing meepzo-be names the product changes or uses as they are (they stay in meepzo-be's own constants and env):

| meepzo-be name | Value today | Value in this plan | Used for |
|---|---|---|---|
| `VERIFICATION_CODE_CHARSET` | letters and digits (Crockford set) | digits `0` to `9` | Email code (section 44) |
| `VERIFICATION_CODE_LENGTH` | 6 | 6 | Email code |
| `VERIFICATION_CODE_TTL_MINUTES` | 15 | 15 | Email code life |
| `VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS` | 60 | 60 | Wait before "send again" |
| `VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS` | 5 | 5 | Wrong tries per code |
| `SUPPORTED_OAUTH_PROVIDERS` | `google`, `github` | `google`, `apple` | Social sign-in |
| `MAX_MFA_VERIFICATION_ATTEMPTS` | 10 | 10 | Wrong two-factor codes ... |
| `MFA_VERIFICATION_LOCKOUT_TTL_SECONDS` | 900 | 900 | ... in this time, then locked |
| `MFA_RECOVERY_CODE_COUNT` | 10 | 10 | Recovery codes |
| `MFA_RECOVERY_CODE_LENGTH` | 12 | 12 | Characters per recovery code |
| `PROVISIONAL_FACTOR_PERIOD_SECONDS` | 259200 (72 h) | 259200 | A factor added under an email-code step-up waits this long for strong actions |
| `OAUTH_STATE_TTL_SECONDS` | 600 | 600 | Social sign-in state (also Apple's name) |
| `MEMBER_ROLE_NAME` | `Member` | becomes `EDITOR_ROLE_NAME` (`Editor`) | Roles (section 45) |
| `BILLING_READ_ONLY_ENFORCED` (env) | false | true | Read-only plan state is enforced (section 46) |
| `BILLING_DUNNING_GRACE_DAYS` (env) | 14 | 14 | Grace after a failed payment |
| `NEW_ORGANIZATION_TRIAL_DAYS` | 14 | not used for Free (Free never ends) | Plan states |
| `UPLOAD_DTO_FILE_SIZE_MAX_BYTES` | 10 MB | 25 MB | Largest upload (voice notes, video and PDFs up to 25 MB) |
| `PRESIGNED_URL_EXPIRY_SECONDS` | 900 | 900 | Signed file links, also the link Meta reads a file from (section 41) |
| `TOMBSTONE_RETENTION_DAYS` (env) | 90 | 90 | A deleted file is removed after this (section 41) |
| `AUTOMATION_NAME_MAX_LENGTH` | 255 | 255 | Automation name |

### 36.26 Values outside the file (env, secret store)

These are not numbers of behaviour. They are links, ids and secrets, so they are never in the settings file. Each environment has its own (section 38).

| Name | What |
|---|---|
| `SENDING_ENABLED` | Global switch (true or false). False: nothing sends (section 39). |
| `SENDING_ENVIRONMENT_ID` | Must equal `app.sending_state.environment_id` (section 39). |
| `SECRETS_ENCRYPTION_KEYS` | meepzo-be's key list with versions. Encrypts the Meta tokens (section 41). |
| `DATABASE_URL` | Neon pooler link (section 37). |
| `DATABASE_MIGRATION_URL` | Neon direct link (section 37). |
| ticket Redis link, copy Redis link | With password and TLS (section 41). |
| `META_APP_ID` | Our Meta app id (Unified Login). Not secret. |
| `META_APP_SECRET` | Code exchange, webhook signature, Meta's callbacks, `appsecret_proof` (section 41). Secret. |
| `META_CONFIG_ID` | The Unified Login configuration id (`config_id`). Not secret. |
| `META_REDIRECT_URI` | The frontend's return page after login. Must equal a redirect URL in the Meta app. |
| `META_WEBHOOK_VERIFY_TOKEN` | Webhook check. Secret. |
| `OAUTH_APPLE_CLIENT_ID`, `OAUTH_APPLE_TEAM_ID`, `OAUTH_APPLE_KEY_ID`, `OAUTH_APPLE_PRIVATE_KEY`, `OAUTH_APPLE_REDIRECT_URI` | Apple sign-in (section 44). The private key is a secret. |

### 36.27 Account switches (owner columns)

These are owner columns on `app.instagram_account_settings`, not values of the settings file. The owner sets them per account (section 15).

| Column | Default | Owner? (bounds) | Meaning |
|---|---|---|---|
| `trigger_on_comment_replies` | true | Yes | A reply under another comment (it has `parent_id`) can start comment automations like any comment on that post. The public reply goes under the top-level comment. OFF: it never starts anything (comment log `ignored`, reason `thread_reply_off`). Both: a comment by the account itself never starts anything (reason `own_comment`). |
| `once_per_person_per_post` | true | Yes | ON: once per automation per post (section 9). OFF ("every time"): every new comment or keyword DM starts a new run; the once key is the event's own id (`starter:<event id>`, `ref:<event id>`, `ad:<event id>`, and so on). Still one open run per automation and person: a new comment, keyword DM or any other start while her run of the same automation is still open is `ignored` (`run_in_progress`). Still true when OFF: one private reply per comment (Meta), `OPENING_PERSON_GAP_HOURS`, `PERSON_HOUR_LIMIT_DEFAULT`. |
| `mark_seen_after_reply` | false | Yes | ON: after a message to her is `sent`, one `mark_seen` call for her chat. Fast lane, not a DM, not counted in any limit, at most once per her inbound message, skipped if the owner typed to her by hand. A failure is ignored (account stops stop as usual). Test needed (section 43). |
| `extra_delay_seconds_min`, `extra_delay_seconds_max` | empty (off) | Yes, PRO: 1 to `EXTRA_DELAY_MAX_SECONDS`, min <= max | "Delay before each message" (36.3): once per her event, on our first answer. Free, or after a move down: off. |
| `broadcast_hour_limit` | empty (= `BROADCAST_HOUR_LIMIT_DEFAULT`, 600) | Yes, PRO: 1 to `BROADCAST_HOUR_LIMIT_MAX` (2,000) | Broadcast messages per hour of this account (36.28). |

### 36.28 Broadcasts (lane `broadcast`, PRO)

| Name | Value | Owner? (min to max) | Meaning |
|---|---|---|---|
| `BROADCAST_HOUR_LIMIT_DEFAULT` | 600 | Yes, 1 to `BROADCAST_HOUR_LIMIT_MAX` (column `broadcast_hour_limit`) | Broadcast messages per hour per account. Box timing like the slow lane, at least `OPENING_MIN_GAP_MS` between two. Lowest priority: it never slows answers or opening DMs. |
| `BROADCAST_HOUR_LIMIT_MAX` | 2000 | No | Highest owner value. |
| `BROADCAST_MIN_GAP_HOURS` | 24 | No | A person who got a broadcast in this time is always left out (a hard cap). |
| `BROADCAST_MESSAGES_MAX` | 3 | No | Messages in one broadcast (the same kinds as the message list). |
| `BROADCAST_OPEN_WAIT_DAYS_MAX` | 7 | No | "Deliver when her chat opens" stays active 1 to this many days. |
| `BROADCAST_STOP_FACTOR` | 2 | No | A "too fast" stop of the broadcast lane lasts this many times longer (Meta's time, else `TOO_FAST_STOP_MINUTES`). A "too fast" stop of the slow or fast lane stops the broadcast lane for the same time too. |
| `BROADCAST_TICKET_PRIORITY` | 10 | No | BullMQ priority of broadcast lane tickets. Slow and reply tickets go first when places are busy (lower = first). |
| `BROADCAST_AUDIENCE_PIECE` | 500 | No | Contacts per piece of the `broadcast-audience` job (by contact id). |
| `SEGMENT_CONDITIONS_MAX` | 20 | No | Conditions in one audience. |
| `SEGMENT_GROUP_LEVELS_MAX` | 2 | No | Levels of AND / OR groups in one audience. |

1. A broadcast message is a DM: it counts in the month count, the person limit and gate 2 (group `broadcast`, Redis `cnt:broadcast:{account}`).
2. Conditions about automations read the runs of the last `RUN_KEEP_DAYS` (90) days. "Got message N of X" reads the run's `last_message_no`, not the message rows (kept 30 days). Follow conditions read meepzo-be's `is_following_account` and `follow_checked_at`.
3. "When her chat opens" waits `OWNER_CHAT_QUIET_HOURS` after the owner typed to her by hand.
4. Recipient rows are kept `BROADCAST_RECIPIENT_KEEP_DAYS` (36.7). A cancelled broadcast: its waiting recipients and their waiting messages end with reason `broadcast_cancelled`.
5. Broadcasts and past comments use the automation permission codes (`automation:create`, `automation:update`, `automation:read`). No new codes.

### 36.29 Run on past comments (PRO)

| Name | Value | Owner? (min to max) | Meaning |
|---|---|---|---|
| `PAST_COMMENTS_MAX_DAYS` | 7 | Yes: the owner picks N, 1 to this, for each run (`app.automation_backfills.days`) | "Also answer comments from the last N days". The oldest comment read is N days minus `EXPIRY_SAFETY_MINUTES` old. |
| `PAST_COMMENTS_POSTS_MAX` | 50 | No | "Any post" automation: at most this many of the newest posts with comments in those days are read. |
| `BACKFILL_STUCK_MINUTES` | 30 | No | A past-comments read with no new page for this long is started again by the helper (comments already saved are dropped by their keys). |

The `past-comments` job tries again after `META_TASK_RETRY_MINUTES`. Its reads count in Meta's limit for calls that are not messages (36.22).

### 36.30 Owner tools: retry failed messages, pause one person

| Name | Value | Owner? | Meaning |
|---|---|---|---|
| `RETRY_FAILED_MAX` | 1 | No | Times the owner may send one `failed` message again ("Retry failed messages", column `instagram_messages.owner_retry_at`). Fails again: it stays `failed`. |
| `RETRY_FAILED_PIECE` | 500 | No | Messages per piece of the `retry-failed` job. |

1. The job looks only at `failed` messages of the last `MESSAGE_KEEP_DAYS` (30). A message goes back to `waiting` only if it is still allowed now: an opening private reply before its 7-day end; any other DM only while her window is open; never after an error that is final for her, never while the automation's text is still refused, never a broadcast message.
2. Retried messages go through the normal lanes, gates and limits, and count in the month count when sent.
3. "Pause automations for this person" (column `app.contacts.automations_off_at`) has no number of its own (41.19).

---

## 37. Neon (Postgres) setup

### 37.1 Two links

| Link | Used by | Why |
|---|---|---|
| Pooler link (host ends with `-pooler`, transaction mode) | the app: API, webhook, workers, helper | Many servers share few real connections. Neon's pooler takes up to 10,000 client connections. |
| Direct link (no `-pooler`) | migrations (`DATABASE_MIGRATION_URL`), the partition worker, long maintenance | Table changes need one fixed session and a lock time. meepzo-be's migration runner already refuses a pooler link. |

We run **no connection pooler of our own**. Neon's pooler is the pooler.

### 37.2 What the pooler does not allow

In transaction mode, each transaction may land on a different real connection. So these do **not** work through the pooler:

1. `SET` for the whole session (use `SET LOCAL` or `set_config(..., true)` inside the transaction).
2. `LISTEN` / `NOTIFY`.
3. Session advisory locks (`pg_advisory_lock`). Transaction advisory locks are fine.
4. Temporary tables that live longer than one transaction.
5. Named prepared statements (SQL `PREPARE`).

### 37.3 What meepzo-be already does right

| Item | Where in meepzo-be |
|---|---|
| Every statement is unnamed (Drizzle), so nothing stays prepared | `src/infrastructure/database/database.overview.md` |
| Organization context with `set_config(key, value, true)` inside the transaction | `contexts/database-context-runtime.ts` |
| `SET LOCAL statement_timeout` per transaction | `transaction.ts` |
| Three timeouts as connection settings: statement, idle in transaction, lock (3000 ms) | `connection.ts`, env `DATABASE_*` |
| Getting a connection is bounded and answers 503 | env `DATABASE_POOL_ACQUIRE_TIMEOUT_MS` |
| Connection budget check at boot (servers x pool <= allowed) | `safety/assert-connection-budget.ts` |
| Migrations refuse a pooler link | `migration/migrate.ts` |
| TLS must check the certificate (Neon's `sslmode=require` alone is refused) | `safety/assert-database-tls-safety.ts` |
| Refuses a superuser or a role that skips row security | `safety/assert-database-rls-safety.ts` |

### 37.4 What we add

1. **Sending transactions set their own short limits** at the start, with `SET LOCAL`: `lock_timeout` = `DB_LOCK_TIMEOUT_MS` (1000), `statement_timeout` = `DB_STATEMENT_TIMEOUT_MS` (5000).
2. **On the app database role:** `idle_in_transaction_session_timeout` = `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (20 seconds). A frozen server can then hold a lane row for at most 20 seconds.
3. **Test needed (section 43.6):** do meepzo-be's connection-level timeouts really reach Postgres through Neon's pooler? If not, the role setting (point 2) and `SET LOCAL` (point 1) are what protect us.
4. **Own small pool for the webhook:** `WEBHOOK_DB_POOL_SIZE` (5). Its save has `WEBHOOK_SAVE_TIMEOUT_MS` (3000). Sending can never fill the webhook's pool.
5. **Pool for sending:** about `DB_POOL_SIZE_PER_SERVER` (20) connections per server (estimate). No connection is held during an Instagram call or a file upload to Meta (section 35).
6. **Scale to zero: OFF** for production. A cold start would make the webhook miss Meta's 5 seconds.
7. **Autoscaling:** about 1 to 8 compute units now (estimate). The minimum must carry the webhook at night. At 1,000 accounts, up to about 16 at the worst (section 42). Watch the real use in the first month.
8. **Same region** as the app servers. 5 ms more per call adds up fast (about 5 calls per DM, section 35).
9. **Restore window (history):** 7 days. Longer costs storage, because Neon keeps the history of every change.
10. **Read replica:** not needed for sending (all writes). Optional later for team reports.

### 37.5 New tables: notes for Neon

1. **Small rows that change all the time:** `app.dm_month_counts` and `app.automation_counts` get +1 in many send and intake commits. They follow the same rule as the lane rows (fillfactor, section 19), so an update stays on its page. They are read only by their key.
2. **The month read sits inside the send commit** (section 31): one key read of at most 16 rows, plus one update of the account's own slot. No new round trip to Neon (estimate).
3. **`app.meta_connection_tokens`:** own table. No retention sweep and no maintenance role reads it (section 41).
4. **No new link and no new pool.** The task jobs (`instagram-tasks`: token check, starter questions, file uploads) use the normal sending pool, and never hold a connection during the Meta call.
5. **History cost:** each +1 writes a little history in Neon. It is small next to the message rows (estimate). Check it in the first month.
6. **Contact columns for audiences** (`last_comment_at`, `comment_count`, `last_story_activity_at`, `last_broadcast_at`, follow result, how she came in) change in the same commits as their events. No new round trip (estimate).
7. **Audience counts** use indexes for the common conditions. A complex audience is counted by the `segment-count` job with meepzo-be's normal statement timeout, never inside a sending transaction.
8. **`app.broadcast_recipients`** is split by month (section 21) and dropped whole after `BROADCAST_RECIPIENT_KEEP_DAYS`.

### 37.6 When Neon has a problem

Times as Neon publishes them (checked 22 November 2026). Our answer is the same for all: timeouts end waits, nothing hangs.

| Neon problem | Neon's time (published) | What we do |
|---|---|---|
| Compute restarts | a few seconds | Transactions fail fast. Tickets come back after a short delay. Results already in hand go to the "save result" job (section 33). |
| Compute does not answer | up to about 5 minutes | Webhook: save to the Redis buffer and answer 200 (section 26). Workers: tickets wait. Alerts go by the outside checker (section 40). |
| A whole zone fails | about 1 to 10 minutes | Same as above. |
| Planned Neon update | short restart | Same as a restart. |

---

## 38. Deploy, restart and many servers

### 38.1 Shutdown order of one server

```text
SIGTERM
   |
   v
1. /health says "not ready"   -> load balancer sends new webhooks to other servers
   |
   v
2. Webhook finishes the requests it already has
   |
   v
3. All workers: worker.close() -> take no new ticket
   |
   v
4. Sends on their way finish   (at most INSTAGRAM_TIMEOUT_MS + the save)
   |
   v
5. Helper gives back its slots (lease ends at once)
   |
   v
6. Exit after at most SHUTDOWN_SECONDS (30)
   The platform kills at SERVER_KILL_SECONDS (45) if still running.
```

A send that is still not finished becomes `unknown` after its lease (section 34), as always. A file upload to Meta that is cut sent nothing: it is tried again (36.8).

### 38.2 Rolling restart

1. Restart **one server at a time**. Never all together.
2. Start the next one only when the restarted one says "ready" on `/health`.
3. Lanes do not care which server runs them. Tickets are in Redis, not in a server.

### 38.3 Settings version rule

```text
Server starts. File says SETTINGS_VERSION = N.
Postgres (app.sending_state.settings_version) says S.

   N < S  -> refuse to start ("older settings")
   N = S  -> start
   N > S  -> write S = N, then start
   (older servers keep running until their own restart)

Two versions running together for over SETTINGS_MIXED_MAX_MINUTES (15): team email.
```

Why this is safe: the limits are always checked again in Postgres (gate 2 and the month count, section 31). For a few minutes two servers may use two delays or two box sizes. No limit is passed.

Settings that need all servers on the new version **within 15 minutes**: `HELPER_SLOTS` and the partition settings. Restart all servers one by one, right away.


### 38.4 Database changes in steps

A database change never breaks the code that still runs.

1. **Add:** new table or new column, empty or with a default. Old code does not see it.
2. **Use:** new code writes and reads it. Old code still works.
3. **Remove:** only when no running code uses the old thing.

A new column carries its data: add it empty, fill old rows, then make it required (meepzo-be rule, `docs/reference/data/migrations.md`).

The `app` migrations are changed in place until they reach `main`. The merged domains (auth, tenancy, billing, user, notify, upload, audit) get **new** migrations only (section 50).

### 38.5 Many servers: rules

1. **Any server takes any ticket.** A server keeps nothing important in its memory.
2. **One clock:** every time that is saved or compared comes from Postgres (`now()`). Never the server's own clock. This also decides the month of the month count.
3. **Ticket delays:** worked out as "target time minus Postgres now". BullMQ then wakes the ticket by the server's clock. So every minute each server compares its clock with Postgres. Over `CLOCK_SKEW_MAX_MS` (2000): team alert, and that server takes no tickets until it is fixed.
4. **Turn still mine:** a worker changes a lane only if `working_turn` is its own turn (section 28). A frozen worker never overwrites a newer one.
5. **Redis and Postgres** each have a second copy that takes over by itself (Redis replica; Neon's own high availability).
6. **Places:** each server has the same places (section 24). More servers = more places. The limits per account stay the same.

### 38.6 Meta app per environment

Each environment has its **own Meta app**, owned by our business portfolio, with its own values (36.26). A test server can never log in or send with the production app.

| Environment | Meta app mode | `config_id` | Redirect URL | App secret, verify token | Who can connect |
|---|---|---|---|---|---|
| Local (developer) | Development | own configuration | the local frontend's return page | own, in the developer's env | People with a role on that app |
| Staging | Development | own configuration | staging frontend page | own, in the staging secret store | People with a role on that app (our test accounts) |
| Production | Live, Advanced Access (section 41) | own configuration | production frontend page | own, in the production secret store | Any customer |

Rules:

1. The redirect URL must be in the app's list of valid redirect URLs, exactly. The code exchange sends it again.
2. The webhook URL and verify token are set per app. Staging webhooks never reach production.
3. The configuration asks only the permissions of section 41. Meta's default configuration adds `instagram_content_publish` and `ads_management`: remove them.
4. The configuration has the "Instagram Login Compatible" label, or the Instagram option does not show. The login link adds `prompt=login`.
5. Our Meta app uses Facebook Login for Business only. An app can use only one of Facebook Login and the older Instagram-only login (test, section 43).
6. Development mode: up to 50 Instagram testers. Meta's test users do not work. Test accounts must be public.
7. The app secret is changed (rotated) in Meta and in the secret store together: new secret in the store, restart server by server, then turn the old one off in Meta.

### 38.7 Meta changes: version and configuration

| Change | How |
|---|---|
| New Graph version (`META_GRAPH_VERSION`) | 1. Read Meta's changelog. 2. Change it on staging, run the smoke tests of section 43. 3. Production by the settings version rule (38.3). Check Meta's end date for our version when you plan releases. |
| A new permission in the configuration (a later feature, section 49) | Only when that feature is built (App Review needs a working demo). New configuration or changed one: connected customers connect again once. Old connections keep working with their old permissions. |

---

## 39. Backup, restore and test copies

### 39.1 Two guards

1. **Environment id.** `app.sending_state.environment_id` must equal the env value `SENDING_ENVIRONMENT_ID` of the server. Not equal: workers and helper do not start. A copy of production (a Neon branch, a restore into a new place) has the production id. A test server has another id, so it cannot send.
2. **Global switch outside the database.** Env `SENDING_ENABLED` (true or false). False: the webhook still saves events, but no worker and no helper sends. A restore cannot switch this back on, because it is not in the database.

### 39.2 Restore steps

Example: at 15:00 the team restores Neon to 13:00.

```text
1. SENDING_ENABLED = false on all servers           (nothing sends)
          |
2. Restore Neon to the chosen time                   (rows of 13:00 come back)
          |
3. Clear the ticket Redis: queues, counts (cnt:*), notes (seen:, mid:),
   login states (connect:). Clear the copy Redis (cnt:month: and the other copies)
          |
4. All messages `waiting` or `sending` that were created
   or tried after the backup time  -> `unknown` (DMs) or `skipped` (replies, hides)
          |
5. Turn on restore mode: a first try that gets "already sent"
   is saved as `sent` (her run waits for her tap), never `skipped`
          |
6. Wait RESTORE_WAIT_MINUTES (60) after the last real send,
   so the hour counts in Instagram are clean
          |
7. For ALL accounts: missed comment check (full pass, section 34),
   webhook subscription check, starter questions sent to Meta again
          |
8. Connections changed after the backup time: fix by hand (39.3)
          |
9. SENDING_ENABLED = true, server by server. Restore mode ends after 7 days.
```

Why step 4 uses "after the backup time" and not "the last hour": the mix sends old DMs too (up to 7 days old), so any row of the lost time may have gone.

Why step 7 sends starter questions again: they live at Meta. After a restore our rows may not match what Meta has.

Stop words, deletes, disconnects, tag changes and notes of the lost 2 hours: they come back in step 7 only partly. The team reads the audit log (`audit.logs`) and the Meta callback log of that time, and does them again by hand.

**Month counts** go back to 13:00 too. DMs sent between 13:00 and 15:00 are not in the count, so a workspace may send a little more than its limit this month. We accept it (estimate: at most the DMs of the lost hours). The all-time counters (`app.automation_counts`) lose those hours the same way.

**Broadcasts and past-comments runs:** broadcast messages are DMs, so step 4 makes them `unknown`; their recipient rows of the lost time become `unknown` too, and the person is not sent that broadcast again by itself. A past-comments run that was `reading` becomes `failed`; the owner can run it again (the once rule and "already answered" stop repeats). Scheduled broadcasts keep their time.

### 39.3 Tokens in backups

1. Backups and Neon's history hold `app.meta_connection_tokens` **only as ciphertext**. The key is in the secret store, never in the database. A stolen backup alone cannot use a token.
2. **A restore can bring back a token that was removed** (the owner disconnected between 13:00 and 15:00). Step 8: for each connection the audit log shows as disconnected or revoked in the lost time, set it `revoked` again and delete its token, in the same commit as its lanes stop (section 41).
3. **A restore can lose a new connection** (made between 13:00 and 15:00). Its rows are gone, so its webhooks find no account and save nothing (section 26). The team emails that owner: "please connect again".
4. A token the customer removed at Meta stays dead after a restore. The daily token check (`TOKEN_CHECK_EVERY_HOURS`) finds it and shows "Reconnect".
5. Attachment ids made after the backup time are lost. The file is just uploaded to Meta again when it is next needed.

### 39.4 Test copies

1. A developer never starts the app on a copy of production data.
2. Test branches only from a **cleaned copy**:
   - tokens deleted (`app.meta_connection_tokens` emptied), connections set to `revoked`;
   - emails, phones, contact notes and event bodies emptied;
   - `environment_id` changed.
3. A test copy uses its own file storage and keys. It never gets read links to production files.
4. Neon keeps deleted rows in its history for the restore window (7 days). Say this in the privacy text.

### 39.5 Practise once

Before going live: restore a test project once with these steps. Write down how long each step took.

---

## 40. Health checks and alerts

### 40.1 /health on each server

meepzo-be already has readiness checks. We add these:

| Check | Bad when |
|---|---|
| Postgres answers | no answer in 2 seconds |
| Ticket Redis answers | no answer in 1 second |
| Last helper round | older than `HELPER_ROUND_ALERT_SECONDS` (180) |
| Oldest late ticket | older than `LATE_TICKET_ALERT_SECONDS` (120) |
| Oldest unhandled event | older than `OLD_EVENT_ALERT_SECONDS` (300) |
| Partitions ready ahead | fewer than `PARTITIONS_AHEAD_ALERT_DAYS` (2) days |
| Server clock vs Postgres | more than `CLOCK_SKEW_MAX_MS` (2000) apart |
| Settings version | older than the one in Postgres |
| Last token check round | older than 2 x `TOKEN_CHECK_EVERY_HOURS` |

### 40.2 One outside checker

1. A service **outside** our servers and outside Neon calls `/health` of each server every `HEALTH_CHECK_EVERY_SECONDS` (60).
2. It alerts by a **second channel** (SMS or chat), not only by email. Email needs our own system, which may be the broken part.
3. Our own emails go through meepzo-be's mail outbox `auth.mail_outbox`.

### 40.3 Watch numbers

| Number | Good | Alert | Who is told |
|---|---|---|---|
| Time from tap to answer | under 15 s (`ANSWER_GOOD_SECONDS`) | over 30 s (`BOT_ANSWER_MAX_SECONDS`) | team |
| Oldest late ticket | under 60 s | over 120 s | team |
| Oldest unhandled event | under 60 s | over 300 s | team |
| `unknown` share per day | under 1% | over 3% | team |
| Accounts in an Instagram stop | few | an app-limit stop, or over 30% "down" | team |
| "Save result" jobs waiting | 0 | any for over 5 minutes (`SAVE_RESULT_ALERT_MINUTES`) | team |
| Failed events | 0 | any | team (grouped) |
| Partitions ready ahead | 3 days | under 2 days | team |
| Ticket Redis memory | under 75% | over 75% | team |
| Postgres pool wait | 0 | over 1 second | team |
| Meta usage header | under 80% | over 80% | team |
| Token check errors | 0 | any | owner ("Reconnect" banner + email) + team (grouped) |
| Connections that went to `error` in the last hour | 0 or 1 | 5 or more (`CONNECTION_ERRORS_HOUR_ALERT`) | team. Many at once means Meta, or our app lost a permission or Live mode |
| Month count drift: month used vs DM rows tried this month (every `DM_MONTH_CHECK_HOURS`) | gap under 2% | gap over `DM_MONTH_DRIFT_ALERT_PERCENT` (2) | team |
| Task jobs (account setup, starter questions) | 0 failed | a job failed after all `META_TASK_RETRY_MINUTES` waits | owner (banner on that account + one email) + team |
| File uploads to Meta | 0 failed | a file failed `ATTACHMENT_UPLOAD_TRIES` (3) times | owner (banner on that automation) + team (grouped) |
| Broadcast lane stops ("too fast", blocked, flagged) | 0 | any | owner (banner on that broadcast) + team (grouped) |
| Past-comments runs | 0 failed | a run `failed` after all `META_TASK_RETRY_MINUTES` waits | owner (banner on that automation) + team |
| Workspaces in a `plan_limit` stop (slow, fast and broadcast lanes) | shown daily | over `PLAN_LIMIT_STOPS_ALERT_PERCENT` (20) of active workspaces | team (a count may be wrong) |
| Messages `expired` per account per day | 0 | any | owner (banner + daily count) |

Why the drift check is not exact: an `unknown` message that goes again is 2 calls on one row. So a small gap is normal (estimate: under 2%).

### 40.4 What the owner sees every day

A small daily count per account:

1. `sent`, `unknown`, `failed`, `skipped`, `expired`, and the "will go / may expire" estimate (section 12).
2. `skipped` with reason `window_closed` (message lists whose window closed) and `expired` with reason `live_ended`.
3. DMs used this month and the reset date (the month count, per workspace).
4. Runs and "% tapped" of each automation: (button taps on the hello + typed answers to the hello) / runs started (the all-time counters).
5. Each broadcast: matched, sent, skipped (most often `window_closed`), failed, replies (once per person, `replied_at`) and taps.
6. Each past-comments run: found, matched, queued, and the "will go / may expire" estimate.

---

## 41. Security and privacy

### 41.1 Tokens

Words: a **system user token** is the key Meta gives us with Unified Login. It belongs to the customer's business portfolio, not to a person, covers all the Instagram accounts the customer shared, and does not end by default.

1. meepzo-be keeps the token in its own table `app.meta_connection_tokens`, **only as ciphertext**. No retention sweep and no maintenance role can read it.
2. The key: only in the secret store (`SECRETS_ENCRYPTION_KEYS`, with versions for rotation). Never in the settings file, never in Postgres, never in Redis.
3. The token is decrypted only in the worker, just before the call.
4. The token goes only in the `Authorization` header. **Never in a URL.** (Today's old tool puts it in the URL; see the review, item C1.)
5. Never in a log, a job, an email, an audit entry or an answer to the frontend. Never log a header or a full URL.
6. **One token opens all accounts of a connection.** So a leak is bigger than with one token per account. That is why we send `appsecret_proof` (41.4) and check the token every day (`TOKEN_CHECK_EVERY_HOURS`).
7. The code exchange runs only on the server. The login `state` lives in Redis `connect:{state}` for `CONNECT_STATE_MINUTES` (10), holds only ids, is used once and must match the signed-in user and workspace.
8. Disconnect deletes the token in the same commit (41.10).

### 41.2 Permissions we ask, and why

We ask only what we use now. Each later feature asks its own permission when it is built (section 49).

| Permission | What we use it for | Webhook fields |
|---|---|---|
| `instagram_basic` | Read the profile at connect; read posts, reels and stories for the post picker, targeting and "your post sent to you" | — |
| `instagram_manage_messages` | Send and receive DMs (hello, nudge, follow ask, email and phone questions, message lists), the follow check, her name for `{name}`, starter questions (`messenger_profile`), file uploads | `messages`, `messaging_postbacks`, `messaging_referral`, `message_reactions` |
| `instagram_manage_comments` | Comment and Live comment events, private replies, public replies, hiding comments, missed comment reads | `comments`, `live_comments` |
| `ads_read` | The ad picker: ad id, name and post of the customer's ads, for "Ad comment" and "Ad Send message". No spend, no insights. Not required: without it the picker asks to connect again | — |

Not asked now: `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_events`, `instagram_shopping_tag_products`, `ads_management`, `business_management` (only for the token refresh call, which we do not use), any `pages_*`. Not subscribed: `mentions` (story mentions come as messages), `messaging_seen` (read receipts are not saved), `story_insights`.

### 41.3 App Review, Advanced Access and business verification

Words: **Standard Access** = only people with a role on our Meta app can use it. **Advanced Access** = any customer; Meta gives it per permission after **App Review** (Meta checks a working demo).

```text
1. Build with Standard Access (our own test accounts)
        |
2. At least one good call per permission, recorded on screen,
   with test steps for Meta
        |
3. App Review -> Advanced Access for each permission
   (live_comments webhooks need it too)
        |
4. Business verification of our business portfolio
        |
5. App in Live mode -> real customers
```

Checklist for App Review:

| Item | What Meta wants |
|---|---|
| App details | App icon 1024 x 1024, Privacy Policy link, category, business email |
| Calls first | At least 1 successful call per permission before we ask |
| Screen recordings | One per permission, English screens, with captions |
| Test steps | Step by step, so Meta's reviewer can repeat them |
| Business verification | Our business portfolio is verified |
| Required actions | Meta's "Required actions" (for example the Data Use Checkup) done on time, or access stops |

1. All of this is done **before real customers**.
2. A permission without Advanced Access gives errors like 200/2018028 (`CODES_APP_NOT_APPROVED`): team alert.
3. A later permission (section 49) goes through App Review again, with its own demo.

### 41.4 `appsecret_proof`

Words: `appsecret_proof` = a short code made from the token and our Meta app secret (HMAC-SHA256). Meta then accepts the token only from someone who also knows the secret.

1. We send it on **every** Graph call made with a customer token (Unified Login).
2. It is made in the worker next to the token, never saved, never logged.
3. After a test that all our calls work with it (section 43), turn on "Require App Secret" in the production Meta app.

### 41.5 What logs, jobs and emails may hold

1. Logs and team emails hold **ids and types only**. Never the message text, an email, a phone, a note, a token or a login `code`.
2. An intake job holds only ids (organization, account, kind), never the event body.
3. The event body is cleared when the event is done (kept only while `received`, `queued` or `failed`). Our own "message was sent" notices and read receipts are not saved at all.
4. meepzo-be's comment log keeps Instagram's error class, codes and trace id, never Instagram's error text (it can name the person). Keep this rule.

### 41.6 Emails and phones she gives

1. **Strict email check** (`EMAIL_ALLOWED_LOCAL`, `EMAIL_ALLOWED_DOMAIN`, `EMAIL_MAX_LENGTH`). meepzo-be's check today also accepts characters like `<`, `>` and `=`, so make it strict.
2. Saved only when one of her runs waits for an email or a phone.
3. Every screen escapes the text. A CSV export puts `'` before a value that starts with `=`, `+`, `-` or `@`.

### 41.7 Files (images, voice notes, PDFs)

| Question | Rule |
|---|---|
| Where they live | meepzo-be's upload domain (private S3 storage, under the workspace's own prefix), bound to the automation |
| Who may upload | Members with `upload:manage` in the workspace: Owner, Admin and Editor (Editors make automations and their message files, section 45.5). Not Viewer |
| Who may read | Members of the workspace, through signed links valid `PRESIGNED_URL_EXPIRY_SECONDS` (15 minutes, meepzo-be). Meta, once per account: a 15-minute signed link when we upload the file to Meta |
| Checks | Type and size (`MESSAGE_IMAGE_MAX_MB`, `MESSAGE_AUDIO_MAX_MB`, `MESSAGE_VIDEO_MAX_MB`, `MESSAGE_FILE_MAX_MB`), the first bytes must match the type (meepzo-be's check). Location data is removed from photos (meepzo-be's `removeImageLocation`) |
| How long kept | While an automation uses the file. Removed from the automation, or the automation is purged: the file is soft deleted, then deleted after meepzo-be's `TOMBSTONE_RETENTION_DAYS` (90). Its `app.meta_attachments` row goes with it. Meta's own copy follows Meta's rules |
| Safety | meepzo-be's upload domain scans every uploaded file. A file that is not scanned clean can't be used in a message |

meepzo-be's workspace file type (`ORGANIZATION_FILE`) allows images and PDF up to 10 MB today. Message files need a new upload purpose (for example `MESSAGE_MEDIA`, name to confirm) with audio types and these sizes (section 50).

### 41.8 What we never keep

1. **Story mention media:** the event carries a Meta link to the story. We never download or store the media (Meta's rule). The link goes with the event body when it is cleared.
2. **Her free text:** "What happened" on a contact shows our sent messages and her saved answers (email, phone, taps) from the last `MESSAGE_KEEP_DAYS` (30). Her own free text is never kept.
3. **Shared posts:** only the post's media id is kept.

### 41.9 The contact note

1. The note is the owner's own text about her (`CONTACT_NOTE_MAX_CHARS` 2000). She never sees it.
2. Only members who may read contacts see it (section 45). It is never sent to Meta, never in a log or a team email.
3. Escaped on every screen. Cleared when she is erased (41.11).

### 41.10 Disconnect and Meta's callbacks

meepzo-be already has: the owner's disconnect (status `revoked`), Meta's deauthorize and data deletion callbacks, and contact erase. We follow meepzo-be's rule. In the same commit as `revoked` (one account, or a whole connection):

1. A whole connection `revoked`: its token is deleted. One account `revoked`: the token stays for the other accounts of that connection, and is deleted with the last one.
2. All lanes of the account -> `stopped`, no ticket.
3. After the commit: delete the account's Redis keys (`cnt:*`, `acct:`, `auto:`, `banner:`, `estimate:`, `tags:`).
4. Helper rules (token check, webhook check, missed comments) run only for accounts with `connection_status` = `connected`.
5. `waiting` messages **stay waiting**. They expire by the 7-day rule, or go on if the same Instagram account reconnects.
6. A disconnect keeps the account's automations, contacts and history. Sending stops. Only Meta's data deletion callback, or deleting the workspace, erases the data. It never starts an account stopped `plan_downgrade` by itself (section 10.4).
7. Meta's data deletion callback runs meepzo-be's erasure flow.
8. With Unified Login the callbacks are set in the Meta app's login settings. Which id they carry is a test (section 43).
9. The customer can also remove our app in Meta (business settings) or move the Instagram account to another portfolio. Meta may send no callback. The daily token check, or the next call, gets a token error: connection `error`, lanes stop, "Reconnect" banner. Meta says: stop retrying and ask the customer to connect again.

### 41.11 Delete one person

meepzo-be's contact erase clears her personal data in place, also her copies in comment logs and runs. We add: her `waiting` rows in `app.instagram_messages` become `cancelled` (message rows hold no text), her `waiting` broadcast recipient rows become `skipped`, and her note, tags and pause columns are cleared. After erase her stop mark is gone too; a new comment from her starts fresh.

### 41.12 Owner checks

1. Every owner action first checks that the account belongs to the logged-in organization. meepzo-be's row security (section 22) also blocks other organizations' rows.
2. **Reconnect:** saved only if the Instagram account id comes back in `assigned_instagram_accounts` of the new login and equals `instagram_user_id` of the row. Another Instagram account: refused.
3. **One workspace per Instagram account:** an account already live in another workspace is refused (meepzo-be's `idx_instagram_accounts_instagram_user_live`).
4. **Accounts per plan:** checked at connect under a lock (`instagram_accounts_max`, 36.21).
5. Owner numbers are checked against their bounds in the API and again in the worker (36.1).

### 41.13 Webhook rules

meepzo-be already does these well: signature checked over the raw bytes before parsing, header `X-Hub-Signature-256`, timing-safe compare, wrong signature answered 400, JSON only, body at most `WEBHOOK_MAX_BODY_MB` (5). We add:

1. Drop events whose Instagram time is older than `EVENT_KEY_KEEP_DAYS` (an old signed event sent again).
2. The verify token comes from env.
3. The signature is checked with `META_APP_SECRET`.

### 41.14 Redis

1. Both Redis (ticket and copy) need a password, TLS and a private network.
2. The Redis link is a secret (env).
3. Redis never holds a token, an `appsecret_proof` or a login `code`. `connect:{state}` holds ids only.

### 41.15 Team tools and the audit log

1. **Suspend an account** (team only): `suspended_at` on the lanes. The owner's Resume does not clear it.
2. Every owner and team action writes an entry in meepzo-be's `audit.logs`: who, which account, what, old and new value, time. Also connect, disconnect, go-live, bulk tag changes, plan changes, the account switches (36.27), every broadcast send and cancel, every past-comments run, every "Retry failed messages", and every pause or unpause of one person.
3. A support role sees counts, not emails, phones, notes or tokens.

### 41.16 Telling people it is automatic

Setting per account `automatic_notice_enabled`. ON: a short line is added to the first DM ("This is an automatic message"). Meta asks for this in some places (California, Germany) and suggests it everywhere.

### 41.17 Unified Login only: why, and the risks

We build only Unified Login. It is a new app with no customers, so there is no other login and no data to move.

Why:

1. Meta calls it the setup for new integrations. New Meta apps cannot set up the older Instagram-only login any more.
2. New Instagram API features ship only for Unified Login.
3. The ad picker now, and ads and Facebook Pages later (section 49), need it.

| Risk | What we do |
|---|---|
| Every creator needs a business portfolio | The creator test (section 43) shows the steps. We write a help guide and help screens (section 25) |
| No login through the Instagram app | The login opens in the browser; the help guide says so |
| No switch from a personal to a professional account during login | Help screen: "Switch to a professional account in Instagram first" |
| No handover (passing a chat to another app or a person's inbox) | We do not use it now |
| Some messaging features are shown in Meta's pages only for the older login | We test each one with Unified Login before we build on it (section 43) |

### 41.18 Broadcasts: who gets them, and what we keep

1. **Meta's window rule:** a broadcast message goes only to a person whose chat is open: she wrote to the account in the last 24 hours, minus `WINDOW_SAFETY_MINUTES`. It is checked when the audience is built and again just before each send. Closed: the recipient is `skipped` (`window_closed`). We never use a message tag (such as `human_agent`) to pass the window: those are for a real person, never for automation.
2. **Hard cap:** a person who got a broadcast in the last `BROADCAST_MIN_GAP_HOURS` (24) is always left out. One broadcast reaches one person at most once. The person limit and the month count apply too.
3. **Opt-out:** opted-out and deleted contacts are always left out. A stop word during a broadcast makes her waiting recipient rows `skipped` (`opted_out`). A broadcast never starts her again (section 14).
4. **"When her chat opens":** she gets it only after her automation run has finished (or when none starts), and never within `OWNER_CHAT_QUIET_HOURS` (6) of the owner typing to her by hand.
5. **Data used:** only what we keep already: tags, runs of the last 90 days, the contact's columns (first seen, last active, comments, story activity, follow result, how she came in) and whether she has an email or a phone. Never her free text.
6. **What we keep:** a recipient row holds ids, status and reason only, for `BROADCAST_RECIPIENT_KEEP_DAYS` (90). A saved audience (`app.segments`) holds conditions (tags, automation ids, post ids, keywords, codes), never a list of people.
7. **Who:** Owner, Admin and Editor make and send (the automation permission codes). A Viewer only sees. Every send and cancel is in `audit.logs` (41.15).
8. **Paused people:** a contact with `automations_off_at` set is always left out (reason `contact_excluded`, 41.19).

### 41.19 Pausing automations for one person (exclude)

1. "Pause automations for this person" is the **owner's** private choice about her: `app.contacts.automations_off_at` and `automations_off_by_user_id`. She never sees it, and nothing is sent to Meta.
2. While it is set: no automation starts for her, her waiting messages are `skipped` and her open runs `cancelled` (reason `contact_excluded`), broadcasts leave her out, her comments get no DM, no public reply and no hide, and no "mark seen" goes. Her events are still saved.
3. The owner can undo it at any time. Nothing restarts by itself: her next own action starts normally.
4. It is not the stop word. The stop word is HER choice and the owner cannot undo it (section 14).
5. Who: Owner, Admin and Editor. Every pause and unpause is in `audit.logs` (41.15). Erasing her clears both columns (41.11).

---

## 42. Size for 1,000 accounts (speed and storage)

**All numbers in this section are estimates.** Nothing was load tested. Measure in the first month.

### 42.1 Speed

Model: each busy account at full speed: 600 opening DMs per hour, 40% of people tap, about 7 fast calls after a tap (follow check, follow ask, email and phone questions, a list of 3 messages, some with an image), a public reply for every comment ("Reply like a person" OFF: the worst case; OFF is the only choice on Free, and a paid owner may turn ON off), and a hide for half of them. That is about 3,180 Instagram calls per busy account per hour.

| | 10% busy | 30% busy | All busy (worst) |
|---|---|---|---|
| Instagram calls per second | 88 | 265 | **883** |
| Events arriving per second | 120 | 360 | **about 1,200** |
| Events saved per second (our own notices not saved) | 62 | 185 | **about 615** |
| Slow queue places needed (opening + reply + hide) | 42 | 125 | **417** |
| Fast queue places needed | 47 | 140 | **467** |
| Postgres calls per second | 880 | 2,640 | **about 8,800** |
| Redis operations per second | 1,900 | 5,700 | **about 19,000** |

What the parallel fast lane changes:

1. The total work is the same. One account can use up to 20 places at once, so the 30-second rule holds even for a viral account.
2. A send still needs about 5 Postgres calls (section 35). The person check and the month count are inside the claim transaction.
3. Redis is never called inside a Postgres transaction. Connections are held for less time.

| | Now (20 to 200 accounts) | 1,000 accounts, worst |
|---|---|---|
| App servers | 2 | about 10 (one is spare) at today's places; fewer if `SLOW_PLACES` is raised after measuring |
| Places per server (intake / fast / slow) | 5 / 40 / 40 | 20 / 100 / 50 |
| Postgres | Neon, about 1 to 2 compute units | Neon, about 8 to 16 compute units |
| Redis | ticket Redis + replica, copy Redis | same, medium size |

Start with 2 servers. Add a server when tickets start late, never because many DMs wait (DMs wait for Instagram's limits and the month limit, not for workers).

A broadcast at the default speed adds 600 calls per hour per account. If all 1,000 accounts broadcast at once: about 167 calls per second more and 167 more slow places (at 2,000 per hour: about 556). Broadcasts have the lowest priority, so they wait when places are short.

### 42.2 Load from the new features

1. **Message lists:** about 7 fast calls after a tap. An image with text is 2 calls.
2. **Public replies OFF:** one reply per comment whose DM went: the opening DMs (up to 600 per hour per account) and the fast-lane DMs of comments with an open window, so it can be more than 600 an hour (estimate). This is the biggest new load on the reply lane. Meta gives no safe number; test 13 (section 43) watches it. OFF has no hour limit; the risk that Meta flags a Free account is accepted (D59). Paid plans start with ON.
3. **Hides:** up to one more reply-lane call per comment.
4. **Nudges:** at most one per message-first run. Small.
5. **Live comments:** private replies are fast messages, so a big Live is held by the fast limit (10,000 per hour, about 2.8 per second per account), far under Meta's 100 per second. What is left when the Live ends expires (`live_ended`). Every Live comment is saved as an event (8 days).
6. **Audio:** Meta allows 10 audio or video calls per second per account. A call takes about 0.5 to 1 second, so `AUDIO_MAX_PARALLEL_PER_ACCOUNT` (5) keeps us under it.
7. **File uploads to Meta:** once per file per account, and again after an attachment error. A few per automation.
8. **Month count:** one key read of 16 rows and one +1 in the send commit. The account's lane row is already locked in that commit, so the account's own slot row adds little wait (a few ms).
9. **Counters:** +1 at run start and at a tap, in the same commit, spread over 16 slots per automation.
10. **New webhook fields:** `message_reactions` (about 5% of our DMs get one), `messaging_referral` (link and ad clicks, small), `live_comments` (only during a Live). Our public replies come back as comment events (600 per hour per busy account, dropped in intake). Not subscribed: `messaging_seen`, `mentions`.
11. **Token check:** one call per connection per day.
12. **Person limit:** one full run with no waits (hello, follow, email, phone, 10 messages with images) is about 24 calls to her in an hour; with asks again about 30. So `PERSON_HOUR_LIMIT_DEFAULT` is 60: one long run fits. Two long runs in one hour can reach it; then the rest waits for room, inside her window.
13. **Broadcasts:** one busy account sends about 1 broadcast a day to about 10,000 matched people; about 4,000 still have an open chat when their turn comes, 2 messages each = 8,000 calls (about 13 hours at 600 per hour). They count in the month limit, so a plan's month total does not grow.
14. **"When her chat opens":** one extra check when she writes (is there a waiting broadcast for her?). One key read (estimate).
15. **Audience counts:** most use indexes; a complex one is a `segment-count` job. A few per broadcast.
16. **Past comments:** one run reads up to 50 posts. A post with 2,000 comments in 7 days is 40 pages of 50. 50 such posts = 2,000 reads, about 33 minutes at 1 read per second (the missed-comment pace, estimate). The reads count in Meta's limit for calls that are not messages. Then the matched comments go as "old" opening DMs at the opening limit, mixed 4 new : 1 old, so new comments still go first. Example: the owner of account B runs it for 3 days on one reel: 1,200 comments found, 900 match: about 1.5 hours of the slow lane when no new comments come, longer when they do (new ones go first).
17. **Reply comments ON (default):** more comments can start runs, but opening DMs still go at 600 per hour, so the busy-day numbers stay.
18. **"Every time" mode:** more runs per person on one post where it is OFF; Meta's one private reply per comment, the 24-hour gap and the person limit hold it (small).
19. **Mark seen ON:** about 1 more call per answered message of hers (fast lane, not a DM). Default OFF.
20. **Extra delay ON:** the first answer after her event waits as a delayed ticket in Redis, up to 20 seconds. No places are held (small).
21. **Retry failed messages:** at most once per failed message, in pieces of 500, through the normal lanes and limits (small).
22. **Paused people:** one more check in intake on the contact row it already reads (no new call).

### 42.3 What the month limit changes

Example: the owner of account A is on Studio (50,000 DMs a month). At full speed A sends 600 opening DMs and about 1,440 other DMs an hour = about 2,040 DMs an hour (follow checks, replies and hides do not count).

| Plan | Month limit | Full speed reaches it in |
|---|---|---|
| Free | 1,000 | about 30 minutes |
| Creator | 10,000 | about 5 hours |
| Studio | 50,000 | about 1 day |

Then the workspace stops `plan_limit` on the slow, fast and broadcast lanes until the 1st or an upgrade. Public replies and hides of DMs that already went still go. The owner of account B on Creator with a quiet account (100 DMs a day) never reaches it.

So the speed table is a peak for hours, not for months. Storage is set by the plans (messages kept 30 days; runs, run events and comment logs 90 days):

| Model | DMs a day (1,000 accounts) | Size kept in Neon (estimate) |
|---|---|---|
| Busy day every day (10% of accounts at full speed, 42.4) | about 5.7 million (with 0.8 million broadcast messages) | about 425 GB (42.4), not possible for long under the plans |
| Plan ceiling: each account its own Studio workspace, whole limit used | about 1.6 million (50 million a month) | about 130 GB |
| Example mix: 400 Free accounts, 400 Creator accounts (2 per workspace), 200 Studio accounts (4 per workspace) | about 0.16 million (4.9 million a month) | about 12 GB |

### 42.4 Storage

Model for this table: a **busy day**, 10% of 1,000 accounts at full speed for 24 hours. Partitions are dropped whole, so a table can hold up to one part more than its keep time.

| Table | Rows per day | Keep | Rows kept | Size with indexes |
|---|---|---|---|---|
| `app.instagram_messages` | 8.4 million (with 0.8 million broadcast messages) | 30 days (+ 1 week part) | about 310 million | about 95 GB |
| `app.broadcast_recipients` | 1.0 million | 90 days (+ 1 month part) | about 120 million | about 18 GB |
| `app.automation_comment_logs` | 1.5 million | 90 days (+ 1 month part) | about 180 million | about 125 GB |
| `app.automation_runs` | 1.6 million | 90 days after end (+ 1 month part) | about 180 million | about 90 GB |
| `app.automation_run_events` | 4.8 million | with its runs | about 540 million | about 55 GB |
| `app.instagram_webhook_events` | 5.3 million | 8 days | about 42 million | about 21 GB |
| `app.instagram_send_attempts` | 8.4 million | 8 days | about 67 million | about 13 GB |
| `app.instagram_webhook_event_keys` | 5.3 million | 8 days | about 42 million | about 6 GB |
| `app.contacts` | about 0.5 million new | until erased | grows | about 100 GB per year (with the audience columns and their indexes) |
| month counts, counters, reply state, attachments, connections, tokens, tag events (8 days), segments, broadcasts, past-comments runs | small | 8 days to all time | small | under 1 GB |
| lanes, minute counts, stops, open keys, state | small | — | small | under 1 GB |
| **Total** | | | | **about 425 GB, plus contacts growing about 100 GB a year** |

How the rows per day come out: 1.44 million opening DMs; 4.0 million fast messages; 1.44 million public replies (OFF: every comment, all go); 0.72 million hides; 0.8 million broadcast messages (100 busy accounts, 8,000 each); 1.0 million broadcast recipients (10,000 matched each). A past-comments run adds the comments of at most 7 days of those posts, once per run (small next to a busy day). A message row also holds the small list columns (`message_no`, `message_kind`, `version_no`, `wording_no`, `counts_as_dm`). Run events stay about the same: each list message is a message row, not a run event.

"Reply like a person" ON at 60 per hour, one viral day: with at most 500 waiting, about 700 of 1,640 replies go. The rest are skipped `hour_limit`. The DMs are not affected.

A quieter day (3% busy) is about one third. A 30% busy day is about three times.

**Files** (images, voice notes, PDFs) are in file storage, not in Neon: about 60 GB for 1,000 accounts (20 files of 3 MB each per account).

### 42.5 If storage costs too much

Messages are already kept only 30 days. Contacts stay until the owner deletes them, Meta asks to delete the data, or the workspace is deleted (no clean-up by age). In this order, each one is a small change:

1. Do not save a public reply row that is over `PUBLIC_REPLY_MAX_WAITING` (500) ("Reply like a person" ON). The comment log says "skipped". (A reply not chosen by chance has no row at all.)
2. Comment logs: clear the long error columns (`error_stack`, `error_response`) after 7 days.
3. Run history: save only the status changes the owner sees.
4. Broadcast recipients: keep 30 days in place of 90 (the broadcast's counters stay). Saves about 9 GB.
5. Neon: check the storage price and the restore window cost.

---

## 43. Tests to run with Meta before building

Each "test needed" in this plan points here. Run them with our own test accounts in Development mode: up to 50 Instagram testers, Meta's test users do not work, and test accounts must be public.

### 43.1 Order

```text
1. Our Meta app and login setup (43.2 rows 1 and 2)
        |
2. Creator test: how hard is the business-portfolio step? (43.2 row 3)
        |    -> help guide and help screens (section 25)
        v
3. 43.3 and 43.4 with Unified Login
        |
4. Fill the "from test" code lists (36.11) and the "test needed" values (36.17)
```

### 43.2 Login and connect (Unified Login)

| # | Test | Why | If it fails |
|---|---|---|---|
| 1 | Our Meta app: is the older Instagram-only login set up on it? An app can use only one of the two logins | We use only Unified Login (section 41) | Remove that login from the app, or make a new Meta app |
| 2 | Our configuration has the label of 38.6 (rule 4), and the link with `prompt=login` shows the Instagram option | People sign in with Instagram or Facebook | Fix the configuration in the App Dashboard |
| 3 | **Creator test.** 2 creator accounts with no business portfolio connect. Count the steps and screens. Does the login make a portfolio for them? | Every creator needs a business portfolio (D24). The help guide and help screens are written from what we see | Write the help guide and screens around those steps. Unified Login stays |
| 4 | Deauthorize and data deletion callbacks: do they come, and which id do they carry? Also when the customer removes our app in business settings | Disconnect and erase (41.10) | Rely on the daily token check; erase on request by hand; say so in the privacy text |
| 5 | Every call works with `appsecret_proof`, also with "Require App Secret" on | 41.4 | Send it where it works; leave "Require App Secret" off |
| 6 | `subscribed_apps` takes all 6 fields with our permissions | Webhook fields (36.16) | Drop the field that fails and hide its way to start |
| 7 | Which call shows the permissions of a system user token? | Connect checks the permissions (section 25) | Check each permission with one small call |
| 8 | Remove our app in business settings, or move the account to another portfolio: which error comes? | `CODES_LOGIN_EXPIRED` | Add that code to `CODES_LOGIN_EXPIRED` |
| 9 | Which read-only call shows that "Allow access to messages" is off, and which code comes? | The account setup banner (section 25) | Keep `CODES_ACCESS_OFF` as it is; the first DM shows it |

### 43.3 With a real Instagram account

| # | Test | Why | If it fails |
|---|---|---|---|
| 1 | Send two private replies to one comment. Write down the exact error of the second. | Fills `CODES_ALREADY_SENT`. | No production start without it (36.24, check 11) |
| 2 | Does the "message was sent" notice come for a private reply? Does it carry the message id? | Matching `unknown` to `sent`. | `unknown` waits for her tap or message (no change) |
| 3 | A private reply with a button template (1 to 3 buttons: link and "next step"). Meta's example shows text only. | The hello has buttons. | The hello in a private reply uses what works; the screen says so |
| 4 | Follow check right after she taps a button of a private reply: does the tap count as her consent? Which error if not ("User consent is required")? | The follow check needs her consent (a message, a starter question or a menu tap). | `FOLLOW_CHECK_FAIL_MEANS` (following) |
| 5 | Is the person id in a comment the same number as in her DMs? Save the recipient id the private reply returns. | If not, DMs to commenters fail with 100/2534014. | Use the recipient id from the private reply for her DMs |
| 6 | Private reply to a deleted comment: which code? | `CODES_COMMENT_GONE`. | Add the code |
| 7 | Can a public comment reply return 4/2207051? | `CODES_ACCOUNT_FLAGGED`. | No change (4 with any subcode is covered) |
| 8 | A public reply that starts with `@username`: does it show as a tag? Is it refused? | `PUBLIC_REPLY_MENTION_DEFAULT` and the automation's `public_reply_mention`. | `PUBLIC_REPLY_MENTION_DEFAULT` = false |
| 9 | When account A DMs account B (both ours), do both get the same message id? | Event keys and `mid:` notes are per account. | No change (keys are per account) |
| 10 | The comment list of a post: only top-level comments? Ask for the `replies` field too. | Missed comment check. | One more read for comments with replies |
| 11 | The comment webhook has no comment time. Rule: use `entry.time`; if it is over 1 hour old when it arrives, read the comment's `timestamp` once. Is `entry.time` close enough, also on retries? | The 7-day clock (`trigger_occurred_at`). | Read the comment's `timestamp` once for every comment |
| 12 | Does Instagram turn the webhook off after long failures? After how long? | Meta's pages say 1 hour and 36 hours. | The webhook check turns it on again (section 34) |
| 13 | How many public replies per hour are really safe? OFF sends one per comment DM (600 an hour or more per account, estimate); ON 10 to 100. | Meta gives no number. | "Too fast" stops only replies (section 33). OFF keeps no hour limit: the risk on Free is accepted (D59) |
| 14 | Does a story reply event carry the story id? | Story runs (`story:<story id>`). | Once key `story:<date>` |
| 15 | Does Meta send the usage header after a public reply? | Reply slow-down. | Rely on "too fast" errors only |
| 16 | Is her event time in the webhook correct? | The delay starts at the right moment. | Use the time the event arrived |
| 17 | Can we read comments of every kind of post (photo, reel, ad)? | Missed comment check. | That kind is covered by webhooks only |
| 18 | Does the webhook stay on after one server restarts? | Rolling restart. | The webhook check turns it on again |
| 19 | What is the app limit of one Meta app for 1,000 accounts? **Ask Meta.** | An app limit stops every account. | Lower default limits, and ask Meta for more |
| 20 | Does the send speed per account stay the same with 5 servers? | Limits are per account. | Find the cause before adding servers |

### 43.4 Unified Login messaging, new ways to start, pickers

| # | Test | Why | If it fails |
|---|---|---|---|
| 1 | Quick replies, product cards, button template, starter questions, her profile (name, follow), typing dots and file upload, all with Unified Login (Meta's pages show them only for the older login). Also the longest starter question Meta takes | Message kinds and steps (section 5); `STARTER_QUESTION_MAX_CHARS` | A kind that fails is hidden on the screen until Meta allows it |
| 2 | `caption` and `media_product_type` on posts with Unified Login | The post picker tells reels from posts and shows captions | The picker shows the picture and the date only |
| 3 | `GET /stories` with Unified Login | The story picker ("one story") | Only "any story" |
| 4 | ig.me link: `ig.me/<username>` or `ig.me/m/<username>`? Does a link opened with no message open her window? Does the `ref` also come inside her message? | Link and QR starts (D43) | Use the form that works; a refused DM is `skipped` (`window_closed`) |
| 5 | Must starter questions be set to get the `ref` on a brand-new chat? | Link and QR starts | Go-live of a link automation warns when the account has no starter question |
| 6 | Ad comments with our setup: Meta's docs say they carry `media.ad_id`, `ad_title` and `original_media_id`. Do they reach our `comments` webhook, also on dark ads (ads that are not boosted posts)? Can we reply to them and hide them? Does `ads_read` give the ad's Instagram post (`effective_instagram_media_id`)? Without `ads_read`, does the ad referral (`ad_id`) still come? | Ad starts | Ad comment not offered ("Waiting on Meta"); the owner types the ad id |
| 7 | Window after a click-to-message ad: 24 hours or 7 days? | Ad "Send message" runs | Keep 24 hours |
| 8 | Which error says a saved attachment id no longer works? | `CODES_ATTACHMENT_GONE` | Any attachment error: upload again, up to `ATTACHMENT_UPLOAD_TRIES` |
| 9 | Story repost and "they follow you": does any webhook come? | Ways to start | Not offered ("Waiting on Meta") |
| 10 | Live (Meta's Live pages did not load): which error does a private reply get after the Live ended? Does `live_comments` carry the Live media id and the comment time? Which `media_product_type` does a Live have? | `CODES_LIVE_ENDED`, key `live:<media id>`, `live_ended` | Expire waiting replies when the Live is gone from `GET /live_media`, or after `LIVE_REPLY_MAX_AGE_MINUTES` |
| 11 | Hide and reply order: is a reply to a hidden comment refused (which code)? After we hide her comment, can others still see our reply? | Hide option (section 13) | The screen says "Hiding her comment also hides your reply" |
| 12 | Story mention: does the event carry a story id? | Key `mention:<story id>` | Key `mention:<mid>` |
| 13 | Shared post: which attachment type (`share` or `ig_post`), and does it carry the post's media id? | "Your post sent to you", key `share:<media id>` | Only "any post" with key `share:<date>` |
| 14 | A reply under a comment: does its webhook carry `parent_id`? Does our own comment carry `from.id` or `self_ig_scoped_id`? | `trigger_on_comment_replies`; own comments never start (`own_comment`) | Read `parent_id` with one call; drop own comments by the account id |
| 15 | A private reply to a reply comment: does it work? Does the public reply land under the top-level comment? | Reply comments start automations (D64) | `trigger_on_comment_replies` is OFF and hidden until Meta allows it |
| 16 | `mark_seen` (sender action) with Unified Login (Meta's page shows only the older login) | `mark_seen_after_reply` (D66) | The switch is hidden |
| 17 | Past comments: how fast can we page `/comments` (50 per page) for 50 posts? What does the usage header show? Does the `replies` field work? | Run on past comments (D69) | Fewer posts per run (lower `PAST_COMMENTS_POSTS_MAX`) and slower reads |
| 18 | A broadcast to someone whose chat is open, sent by our app as a normal message (not an answer to an automation): is it delivered with no error? | Broadcasts (D68) | Broadcasts only in "deliver when her chat opens" mode |

### 43.5 For later

Tests for later features are in `Instagram-DM-Later-Features-v8.md` (section 9). They are not needed to build now.

### 43.6 Technical checks (not Meta)

| # | Check | Why |
|---|---|---|
| 1 | Do meepzo-be's connection-level timeouts reach Postgres through Neon's pooler? | Section 37.4. |
| 2 | BullMQ: does a delayed ticket wake by the server clock? | Clock rule, section 38.5. |
| 3 | Row security on partitioned tables: is it on for every part? | Section 22. |
| 4 | Practise one restore (section 39.5). | Restore steps. |
| 5 | Row security on the new tables (`app.meta_connections`, `app.meta_connection_tokens`, `app.dm_month_counts`, `app.automation_counts`, `app.automation_reply_state`, `app.meta_attachments`, `app.contact_tag_events`, `app.segments`, `app.broadcasts`, `app.broadcast_recipients` and all its parts, `app.automation_backfills`). | Section 22. |
| 6 | Month count: two sends at the same moment near the limit go over by at most the sends in flight. The month starts at 00:00 on the 1st in the workspace's time zone. | Section 31. |
| 7 | No token, `appsecret_proof`, login `code`, email, phone or note in logs, jobs or Redis (search the logs of a test run). | Section 41. |
| 8 | The common audience conditions use their indexes (look at the query plan on a cleaned test copy). | Section 37.5. |
| 9 | "Delay before each message" at its highest (20 s) still answers within 25 seconds (`BOT_ANSWER_MAX_SECONDS` - `BOT_ANSWER_SAFETY_SECONDS`). | Section 36.3. |


---

# Part F. The product around sending

## 44. Sign-in and security

Flowdm signs people in with no password: Google, Apple, a passkey, or a code sent by email. meepzo-be's `auth` domain has most of this already. The `auth` domain is in `main`, so every database change here is a NEW migration (section 50).

Words used here:

1. **Step-up**: a fresh check of who you are, just before a risky action (for example removing a passkey). It opens a short window.
2. **Passkey**: a sign-in key kept by the phone or laptop (Face ID, fingerprint). meepzo-be calls it WebAuthn.
3. **Two-factor (2FA)**: a second check after sign-in: a 6-digit code from an app, or a recovery code.
4. **Trusted device**: a browser where the person ticked "Trust this device for 30 days". It skips the 2FA screen at sign-in, only in a workspace that does not require 2FA.

### 44.1 What changes

| # | Flowdm needs | meepzo-be today (route or table) | Change | New migration (domain) |
|---|---|---|---|---|
| 1 | No passwords anywhere | `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/password/change` are live; `auth.users.password_hash`; password step-up | Switch `AUTH_PASSWORDS_ENABLED` false: the 4 routes are not registered (404). `POST /auth/step-up` refuses a password | auth: `password_hash` set to NULL; `PASSWORD` rows in `auth.auth_methods` revoked |
| 2 | Apple sign-in | Google and GitHub only; the return route is a GET | Provider `apple`; a new form POST return route (44.4) | none (`provider` is free text) |
| 3 | GitHub not shown | `SUPPORTED_OAUTH_PROVIDERS` = `google`, `github` | `google`, `apple` only (44.8) | none |
| 4 | 6-digit email code | 6 letters and digits (`VERIFICATION_CODE_CHARSET`, Crockford set) | Digits only, still 6 (44.3) | none |
| 5 | Wrong code and expired code apart; resend timer | One error `invalidOrExpiredVerificationCode`; the 60 s wait is not sent to the app | Separate reasons, `tries_left`, `resend_after_seconds` (44.3) | none |
| 6 | 2FA: app code or 12-character recovery code | Built: TOTP, 10 recovery codes of 12 characters | — | — |
| 7 | "Trust this device for 30 days" | Missing | New table and cookie (44.6) | auth: `auth.trusted_devices` |
| 8 | A message after wrong 2FA codes, a stronger one after 3 | 10 wrong codes per 15 minutes, then locked; no count sent | Send `tries_left`; keep 10 as the hard limit (44.6) | none |
| 9 | Remove a passkey or Google with no password | Needs a password or 2FA step-up; a person with neither is stuck | Email code is a strong step-up for a person with no 2FA (44.7) | none |
| 10 | Connect Google or Apple from Settings | Linking only at sign-in, by the same email | Link mode while signed in (44.8) | none |
| 11 | "Sign-in failed" screen | Errors exist, not one list | One fixed `reason` list (44.5) | none |
| 12 | Email code always on | The `EMAIL_CODE` row can be removed | Removing it is refused (44.8) | none |

### 44.2 Rules

1. Four ways to sign in: Google, Apple, passkey, email code.
2. Email code is always on. It is the way back in when everything else is lost.
3. No password is ever asked, stored or checked.
4. With no passwords, the mailbox is the key to the account. 2FA is the extra lock.
5. A first sign-in makes the person (meepzo-be's find-or-create). Every sign-in, step-up, trusted device and removal writes to `audit.logs`. Both as today.

### 44.3 Email code

| What | Value | Setting |
|---|---|---|
| Code | 6 digits (`0` to `9`) | `VERIFICATION_CODE_LENGTH` 6, `VERIFICATION_CODE_CHARSET` digits |
| Lives | 15 minutes | `VERIFICATION_CODE_TTL_MINUTES` 15 |
| Resend | after 60 seconds | `VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS` 60 |
| Wrong tries per code | 5, then a new code is needed | `VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS` 5 |
| Wrong tries per email per day | 20, then email code is closed for that email until 24 hours pass | `EMAIL_CODE_WRONG_TRIES_PER_DAY` 20 |

Answers the app gets:

| Route | Answer | When | App shows |
|---|---|---|---|
| `POST /auth/email/send-code` | 200 with `resend_after_seconds`, `expires_in_seconds` | Same answer for every email (no hint whether the email is known) | Six boxes and the resend timer |
| `POST /auth/email/send-code` | 429 `code_resend_too_soon` + `retry_after_seconds` | Under 60 s since the last code | The timer keeps running |
| `POST /auth/email/login` | 401 `code_wrong` + `tries_left` | Wrong code, unknown email, used code | "That code is not right. 3 tries left." |
| same | 401 `code_expired` | The newest code of this email is over 15 minutes old | "This code expired. Send a new one." |
| same | 401 `code_used_up` | 5 wrong tries on this code | "Too many tries. Send a new code." |
| same | 429 `code_day_limit` + `retry_after_seconds` | 20 wrong tries today | "Use Google, Apple or a passkey, or try later." |

Rules:

1. `code_expired` only when this email really has an expired newest code. Every other case is `code_wrong`. So a stranger learns nothing new.
2. A new code ends the old one (meepzo-be's "one live code", as today).
3. Digits only gives 1,000,000 codes. With 5 tries per code, a new code at most once a minute and 20 wrong tries a day, a guesser has about 20 in 1,000,000 chances per email per day (estimate). The day cap keeps this small.
4. A stranger can spend a person's 20 tries and close email code for a day. Google, Apple and passkeys still work, the signed-in step-up has its own try count (meepzo-be's A-8), and our team can clear the count.

### 44.4 Apple sign-in

Apple sends its answer as a form POST (the browser posts a form to our server) when we ask for the name and email. The app page cannot take a POST, so the server takes it first.

```text
App                         meepzo-be                                  Apple
 |-- GET /auth/oauth/apple --> state + nonce in Redis (10 min)
 |<-- redirect_url ------------|
 |------------------------------------------------------------> sign-in page
 |                             |<-- form POST: code, state, user* --|
 |                             | POST /auth/oauth/apple/callback:
 |                             |   state known? keep `user` (name)
 |<-- 303 to /callback/apple?code=..&state=..
 |-- GET /auth/oauth/apple/callback?code&state (+ oauth_nonce cookie)
 |                             | use the state once, check the nonce,
 |                             | swap the code (client secret JWT),
 |                             | read id_token: sub, email
 |<-- session (or the 2FA screen)
```

(* Apple sends `user`, with her name, only the first time.)

Rules:

1. New PUBLIC route `POST /api/v1/auth/oauth/apple/callback`. Body: a form, at most 16 KiB (`OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES` 16384). It never signs anyone in.
2. It checks that the `state` exists. It keeps Apple's `user` name in Redis next to the state, for the state's life (`OAUTH_STATE_TTL_SECONDS` 600). Then it answers 303 to the app page.
3. The cookie check (`oauth_nonce`) runs in the second call. A cross-site POST from Apple does not carry our cookie.
4. Client secret: a short JWT signed with our Apple key (ES256), made fresh for each code swap. Config (secret store): `OAUTH_APPLE_CLIENT_ID`, `OAUTH_APPLE_TEAM_ID`, `OAUTH_APPLE_KEY_ID`, `OAUTH_APPLE_PRIVATE_KEY`, `OAUTH_APPLE_REDIRECT_URI`.
5. The person is matched by Apple's `sub`. Later sign-ins may carry no email.
6. The email may be an Apple relay address (`...@privaterelay.appleid.com`). To email it, our sending domain must be registered with Apple (Apple's rule; check when building, section 53).
7. Same account rules as Google: find or create; link into an existing account only if its email is verified (meepzo-be's guard, as today).
8. PKCE (a second secret that ties the code to our request): kept if Apple accepts it. If not, the `state` and the `nonce` inside Apple's `id_token` do that job (check when building, section 53).

### 44.5 Sign-in failed

The app shows "Sign-in failed" with a way back to sign-in. The server gives one `reason` from this list:

| `reason` | When | Screen line |
|---|---|---|
| `oauth_cancelled` | The person pressed Cancel (Google `access_denied`, Apple `user_cancelled_authorize`) | "You cancelled. Try again." |
| `oauth_expired` | The state is over 10 minutes old, or was used | "That took too long. Try again." |
| `oauth_failed` | The code swap failed, or the provider gave an error | "Google or Apple did not answer. Try again." |
| `login_method_turned_off` | The person removed this way of signing in (as today) | "This sign-in is turned off for your account." |
| `oauth_link_needs_verified_email` | An account with this email exists, email not verified (as today) | "Sign in with an email code first." |
| `account_not_active` | Suspended or locked (as today) | "This account is paused. Contact support." |

Google's errors come back to the app page directly; the app shows the screen without calling us. Apple's errors come in the form POST; the route answers 303 to the app's failed page with the `reason`.

### 44.6 Two-factor and "trust this device"

2FA stays as built: a 6-digit code from an app (TOTP), or one of 10 recovery codes of 12 characters (`MFA_RECOVERY_CODE_COUNT` 10, `MFA_RECOVERY_CODE_LENGTH` 12).

Wrong codes:

1. Each wrong code answers 401 `mfa_code_wrong` with `tries_left`.
2. Hard limit: 10 wrong codes in 15 minutes (`MAX_MFA_VERIFICATION_ATTEMPTS` 10, `MFA_VERIFICATION_LOCKOUT_TTL_SECONDS` 900). Then 429 `mfa_locked` with `retry_after_seconds`.
3. The app shows the stronger message from the 3rd wrong code (an app number, `MFA_STRONG_WARNING_AFTER_TRIES` 3).

Trust this device:

```text
Owner of account A signs in (Google, Apple, passkey or email code)
  |
  v
2FA on? --no--> session
  | yes
  v
`trusted_device` cookie sent, row live, same person, not expired,
AND the workspace that opens does not require 2FA?
  | yes --> session, no code asked (`last_used_at` updated)
  | no
  v
2FA screen --> code right --> "Trust this device" ticked?
                                 | yes --> new row + cookie (30 days)
                                 v
                              session
```

| Part | Rule |
|---|---|
| Table | `auth.trusted_devices`: `id`, `public_id`, `user_id`, `token_hash`, `user_agent`, `created_at`, `expires_at`, `last_used_at`, `revoked_at`. Row security: own rows only (like `auth.sessions`). |
| Cookie | `trusted_device`: 32 random bytes. HttpOnly, Secure, SameSite Lax, path `/api/v1/auth`, 30 days. Only its hash is stored. |
| Life | 30 days from the tick (`TRUSTED_DEVICE_DAYS` 30). Use does not make it longer. |
| How many | At most 10 live per person (`TRUSTED_DEVICES_MAX` 10). An 11th revokes the oldest. |
| Ends early | 2FA turned off or its factor removed; "Sign out everywhere else" (all but this browser); account deleted or suspended. |
| Skips | Only the 2FA screen at sign-in. Never a step-up. Never for `super_admin`. |
| Workspace requires 2FA | The code is always asked (D56). A session opened by a trusted device is not marked as 2FA-checked (`mfa_verified_at` stays empty). Switching to a workspace that requires 2FA asks for the code (meepzo-be's `mfa_required`, as today). |

Where: `POST /auth/mfa/login` takes `trust_device` (true or false). The first-factor finish (`completeFirstFactorAuth`) reads the cookie.

### 44.7 Step-up without a password

Today an email-code step-up is "weak": it can add a factor but cannot remove one. So a person with no password and no 2FA can never remove a passkey or sign out a session. New rule:

| Action | Step-up needed |
|---|---|
| Add a passkey, turn on 2FA | Any recent step-up (as today) |
| Remove a passkey | Strong |
| Remove Google or Apple | Strong |
| Sign out one session, or everywhere else | Strong |
| Turn off 2FA | A 2FA code only |
| Delete the account | Any recent step-up (as today) |

**Strong** = a 2FA code for a person with 2FA; an email code for a person without 2FA.

1. `POST /auth/step-up` takes `email_code`: the same 6 digits, its own try count.
2. `requireStrongRecentStepUpPreHandler` accepts an `email_code` window as strong when the person has no settled 2FA factor.
3. The provisional rule stays (`PROVISIONAL_FACTOR_PERIOD_SECONDS`, 72 h): a factor added under an email-code step-up cannot do strong actions until that time passes, and the owner gets an email.
4. While the only factor is still provisional, an email code still opens a strong step-up. So the real owner can remove a factor someone else added.
5. Why this is safe: the mailbox can already sign the person in. A strong email-code step-up gives no new power.

### 44.8 Sign-in ways in Settings, and GitHub off

1. Settings > Security lists: Email code (always on), Google (connect or remove), Apple (connect or remove), Passkeys (add or remove), 2FA (on or off, with a confirm).
2. Connect while signed in: `GET /api/v1/auth/oauth/:provider?intent=link` (signed in, recent step-up). The return links that Google or Apple account to this person, even with another email, and clears a "turned off" mark (meepzo-be's A-5). Already someone else's: 409 `provider_account_in_use`.
3. Removing the `EMAIL_CODE` row: 409 `email_code_always_on`. Removing the last other way is fine.
4. GitHub off: `SUPPORTED_OAUTH_PROVIDERS` = `google`, `apple`, so `GET /auth/oauth/providers` lists those two. A person who used GitHub signs in with an email code (same email), then can connect Google or Apple. The GitHub code stays unused (a later clean-up).

---

## 45. Workspaces, members and roles

Workspace = meepzo-be's organization (`tenancy.organizations`, type `TEAM`). The `tenancy` and `user` domains are in `main`: NEW migrations only.

### 45.1 What changes

| # | Flowdm needs | meepzo-be today (route or table) | Change | New migration (domain) |
|---|---|---|---|---|
| 1 | Onboarding: name, Instagram handle, workspace name, goal | `PATCH /users/me` (name, `job_title`), `POST /users/me/onboarding/complete`, `POST /tenancy/organizations` | 2 new fields (45.2) | user: `auth.users` + `instagram_handle`, `goal` |
| 2 | Invitation page, 7 states | Accept and decline routes; no read of one invitation | New preview route (45.3) | none |
| 3 | Choose a workspace: role, counts, search | `GET /users/me/organizations`: plain list, personal one included | Role, counts, `q`, personal hidden (45.4) | app: a counts function (it reads app tables) |
| 4 | Workspace that opens at sign-in | Built: `auth.user_settings.default_organization_id` | Refuse the personal workspace | none |
| 5 | Roles Owner, Admin, Editor, Viewer; 9 permissions; no custom roles | Owner, Admin, Member (locked) + custom roles; 30 codes | Member becomes Editor, new Viewer, new `contact:update`, custom roles off (45.5) | tenancy: rename, new role, new code, grants |
| 6 | Invite one or several emails with a role | One email per invite | `emails` list (45.6) | none |
| 7 | Counts by role | Members list without counts | `counts_by_role` in the list answer | none |
| 8 | Slug read only | The slug can be changed | Refused on update (45.7) | none |
| 9 | Initials on a tile, 5 colours | Logo upload only | `logo_color` (45.7) | tenancy: `tenancy.organizations.logo_color` |
| 10 | Workspace paused | `status` `SUSPENDED`; sending goes on | Sending stops (45.7) | none |
| 11 | A team on every plan | Seats per plan (`included_seats`) | Unlimited members and all 4 roles on every plan; no seat limit (45.5) | billing: `included_seats` null on every plan (same migration as 46.2) |

### 45.2 Onboarding

```text
New person signs in, has no TEAM workspace, onboarding not done
  |
  v
1. Your name          -> PATCH /users/me   first_name, last_name
2. Instagram handle   -> PATCH /users/me   instagram_handle
3. Workspace name     -> POST /tenancy/organizations   (TEAM, name pre-filled)
4. Your goal          -> PATCH /users/me   goal
  |
  v
POST /users/me/onboarding/complete  -> the chooser opens with a welcome
```

| Column (`auth.users`) | Type | Rule |
|---|---|---|
| `instagram_handle` | VARCHAR(30), null | Letters, digits, `.` and `_`, at most 30 (Instagram's rule). Saved without `@`, in lower case. |
| `goal` | VARCHAR(20), null | One of `capture_leads`, `drive_sales`, `grow_community`. |

Rules:

1. "Skip for now" skips a question. Both new columns can stay null.
2. Step 3 always makes a workspace. Skipped = the pre-filled name ("Asha's workspace"). App routes need a TEAM workspace.
3. The handle is a profile note. It does not connect Instagram (section 25). "What you do" in Profile is today's `job_title`.

### 45.3 Invitation page (7 states)

New route: `POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/preview`.

1. PUBLIC; a signed-in caller is recognised. Body: `{ token }` from the email link. POST keeps the token out of URLs and logs.
2. Answer: `state` (`valid`, `accepted`, `expired`, `revoked`), workspace name and `logo_color`, role name, the inviter's first name, `expires_at`, `signed_in`, and `email_matches` (only when signed in).
3. A wrong token or id: 404, the same as unknown. A signed-out caller never sees the invitee's email. A declined invitation answers `revoked`.
4. At most 30 a minute per IP (`INVITATION_PREVIEW_PER_MINUTE` 30).

| Flowdm state | Answer | Button |
|---|---|---|
| 1. Loading | (the app waits for the answer) | — |
| 2. Valid | `valid`, `email_matches` true | Accept invitation (today's accept route) |
| 3. Already accepted | `accepted` | Go to workspace |
| 4. Expired | `expired` | Ask the sender for a new one |
| 5. Revoked | `revoked` | — |
| 6. Wrong account | `valid`, `signed_in` true, `email_matches` false | Switch account |
| 7. Signed out | `signed_in` false | Sign in to continue, then back to this invite |

An invitation lasts 7 days (meepzo-be's `expires_in_days` default, `INVITATION_EXPIRES_DAYS` 7).

### 45.4 Choose a workspace

`GET /users/me/organizations` changes:

1. Each row adds `role` (main role name), `members_count`, `instagram_accounts_count`, `live_automations_count`. `q` searches by name. The personal workspace is hidden.
2. The counts come from one SECURITY DEFINER function, limited to the caller's active memberships (meepzo-be already reads across organizations this way). It reads app tables, so it is a migration file next to the `app` ones.
3. The app shows the chooser when the person has 2 or more workspaces.

The personal workspace: meepzo-be still makes one for each person. Flowdm never shows it and never opens it. A person with no TEAM workspace gets onboarding. `PATCH /users/me/settings` refuses a personal workspace as `default_organization_id` (422 `team_organization_required`).

Example: the owner of account A is Owner of "Asha Studio" and Editor in "Bloom Agency". The chooser shows both, each with role, members, accounts and live automations.

### 45.5 Roles and the 9 permissions

| # | Group | Permission (Flowdm screen; names to confirm) | Owner | Admin | Editor | Viewer | meepzo-be codes |
|---|---|---|---|---|---|---|---|
| 1 | Automations | See automations and their numbers | yes | yes | yes | yes | `automation:read`, `instagram-account:read` |
| 2 | Automations | Create, edit, duplicate, go live, pause; upload files for messages (images, voice notes, PDFs) | yes | yes | yes | no | `automation:create`, `automation:update`, `upload:manage` |
| 3 | Automations | Delete automations | yes | yes | yes | no | `automation:delete` |
| 4 | Contacts | See contacts | yes | yes | yes | yes | `contact:read` |
| 5 | Contacts | Tag contacts, write notes | yes | yes | yes | no | `contact:update` (new) |
| 6 | Contacts | Erase a contact's data | yes | yes | no | no | `contact:delete` |
| 7 | Workspace | Connect and remove Instagram accounts | yes | yes | no | no | `instagram-account:manage` |
| 8 | Workspace | Members, workspace name, API keys | yes | yes | no | no | `membership:*`, `role:read`, `organization:update`, `api-key:*` |
| 9 | Workspace | Billing and plans | yes | yes | no | no | `subscription:read`, `subscription:manage` |

Every role also has `organization:read`. Codes that are not on the screen (webhooks, audit logs, notification policies, `instagram-webhook-event:read`) stay with Owner and Admin, as today. `upload:manage` goes to Owner, Admin and Editor (row 2), because Editors make automations and their message files. Owner only: delete the workspace (`organization:delete`) and hand over ownership.

Rules:

1. All four are locked system roles in every TEAM workspace.
2. Member becomes Editor: the same row with a new name, plus `contact:update`, `automation:delete` (D55: Editors may delete automations) and `upload:manage` (message files). The constant `MEMBER_ROLE_NAME` becomes `EDITOR_ROLE_NAME`.
3. Viewer is new. It is added by provisioning, by `reconcileDefaultTeamRoles`, and by a new migration for workspaces that exist.
4. `contact:update` is a new code (tags, notes, bulk tags of D45 and D46). New migration: the permission row and its grants to Owner, Admin and Editor.
5. Custom roles are off (`TENANCY_CUSTOM_ROLES_ENABLED` false). Create, edit, delete, restore and "replace codes" answer 403 `custom_roles_off`. Extra roles per member (`membership_additional_roles`) are off too. A member who already holds a custom role keeps it until an Admin changes it.
6. The read routes stay: the Roles screen reads them. "Who holds it" = the members list filtered by role (built).
7. Every plan (Free, Creator, Studio) has unlimited members and all 4 roles (D55). No seat limit.
8. "Previewing as a role" is in the app only. The API always answers with the real role.
9. Broadcasts, saved audiences and "run on past comments" (D68, D69): Owner, Admin and Editor make and send them (`automation:create`, `automation:update`); Viewer only sees them (`automation:read`). Every send and cancel goes to `audit.logs`.
10. "Pause automations for this person" (exclude a contact, D71): Owner, Admin and Editor turn it on or off (`contact:update`), on one contact or in the bulk bar. Viewer only sees it. Audit log.
11. "Retry failed messages" (D72): Owner, Admin and Editor, on an automation (`automation:update`) or on a contact (`contact:update`). Audit log.

### 45.6 Members and invitations

1. `POST /tenancy/organization/memberships` takes `emails` (1 to 20, `INVITE_EMAILS_MAX` 20) and one role. One invitation per email. One idempotency key covers the whole request.
2. The answer has one line per email: `invited`, `already_member`, `already_invited` or `invalid_email`. Each `invited` email gets its own invite email.
3. The members list answer adds `counts_by_role` (Owner 1, Admin 2, ...). Change role, remove, send again, cancel, filter by role: built.

Example: the owner of account A types 3 emails and picks Editor. Two are new: `invited`. One is in the team already: `already_member`.

### 45.7 Workspace: general and paused

| Part | Rule |
|---|---|
| Name | `PATCH /tenancy/organization` (built) |
| Slug | Read only. Made once from the name when the workspace is made. An update with `slug` answers 422 `slug_read_only` |
| Tile colour | `tenancy.organizations.logo_color` VARCHAR(10): one of 5 chip tones (`sky`, `lav`, `sage`, `peach`, `slate`; names to match the design). The default is picked from the name, so one name always gets one colour |
| Uploaded logo | Stays in the API (`PUT /tenancy/organization/logo`). Flowdm does not show it |
| Workspace paused | `status` `SUSPENDED` (set by our team). All sending stops on every account, like a team suspend (section 15). `GET /auth/me/context` carries the status. The app shows "Workspace paused" |

---

## 46. Plans, billing and limits

The `billing` domain is in `main`: NEW migrations only. Stripe stays the truth for payments (meepzo-be's rule).

### 46.1 What changes

| # | Flowdm needs | meepzo-be today (route or table) | Change | New migration (domain) |
|---|---|---|---|---|
| 1 | Free, Creator, Studio | `billing.plans` rows Free, Starter, Growth, Pro (with seats) | New rows (46.2) | billing: rows and features |
| 2 | Plan limits the product checks | `plans.features` is loose JSON; nothing checks it | Typed features (46.2) | billing (same migration) |
| 3 | Free never ends | Free turns read only after 14 days (`NEW_ORGANIZATION_TRIAL_DAYS`) | Free is `active` for ever (46.3); that read-only trial is not used | none |
| 4 | Plan ended stops sending | Read only blocks edits only | Stop `plan_ended` on all lanes (46.3) | none |
| 5 | Payment failed: runs until a date | Built: `grace`, `grace_ends_at`, 14 days | Kept; the date goes in the notice | none |
| 6 | DMs used this month, reset date | Missing | Month count (sections 10, 31); meter (46.5) | app (section 19) |
| 7 | Accounts per plan | A unique index allows 1 (`idx_instagram_accounts_organization_live`) | 1, 3 or 10 (46.6) | app (section 18) |
| 8 | PRO tags | No plan check | PRO gate at go-live (46.7) | none |
| 9 | Remove a card, pick the default card | List and add only | 2 routes (46.8) | none |
| 10 | Yearly price shown per month | `price_yearly` is a yearly total | `price_yearly_per_month` in the answer | none |
| 11 | Flat prices | The member count is pushed to Stripe as seats | Seat sync off (`BILLING_SEAT_SYNC_ENABLED` false) | none |
| 12 | 7-day trial of Creator or Studio, no card | Stripe trials exist (`trial_end`, status `TRIALING`), not used for this | A trial per workspace and per Instagram account; the end without payment moves to Free (46.9) | billing: `billing.trial_accounts` |

### 46.2 The three plans

Flowdm's prices are samples. They stay as placeholders until the final prices are set (open item, section 53).

| Plan | Monthly | Yearly total | Yearly per month | `dm_month_limit` | `instagram_accounts_max` | `pro_features` | `priority_support` |
|---|---|---|---|---|---|---|---|
| Free | $0 | $0 | $0 | 1,000 | 1 | false | false |
| Creator | $29 | $276 | $23 | 10,000 | 3 | true | false |
| Studio | $79 | $756 | $63 | 50,000 | 10 | true | true |

Rules:

1. These numbers live only in the plan rows, not in the settings file.
2. `features` is checked by one zod type `PlanFeatures` with exactly these 4 keys. It is checked when a row is written and when it is read. A missing or unknown key is an error.
3. One new migration in billing: the Free row updated, Creator and Studio added, Starter, Growth and Pro set `is_active` false (billing rows are never deleted). The reference seed matches it.
4. Stripe product and price ids: our team makes them in Stripe, then puts them on the rows.
5. `included_seats`: null on every plan (unlimited members, D55). Prices are flat: the seat sync to Stripe (`subscription-seat-sync`) is off (`BILLING_SEAT_SYNC_ENABLED` false), so Stripe quantity stays 1.
6. `GET /billing/plans` adds `price_yearly_per_month` = `price_yearly` / 12.

### 46.3 Plan states

| State | `plan_access.state` | When | Sending | The owner can | Notice (section 47) |
|---|---|---|---|---|---|
| Free | `active` | No paid plan | Yes, inside Free limits | All that Free allows | — |
| Paid | `active` | Creator or Studio, paid | Yes | Everything | — |
| Trial | `active` + `trial_ends_at` | Creator or Studio on a 7-day trial, Stripe `trialing` (46.9) | Yes, with that plan's limits | Everything of that plan | Trial ends soon (3 and 1 days before) |
| Payment failed | `grace` + `grace_ends_at` | Stripe `past_due` or `unpaid`, until period end + 14 days (`BILLING_DUNNING_GRACE_DAYS` 14) | Yes | Everything | Payment failed |
| Plan ended | `read_only` | The grace is over, or a cancelled paid plan reached its period end | No: stop `plan_ended` on every lane of every account | Pause, delete, disconnect, choose a plan | Plan ended |
| Workspace paused | workspace `status` `SUSPENDED` | Our team | No (section 15) | Read only | Workspace paused (screen) |

```text
        pays            card fails           grace over (14 days)
Free --------> Paid ---------------> Payment -------------------> Plan
 ^              ^ ^                  failed                       ended
 |              | +--- paid again ------+                           |
 |              +---------- picks a paid plan ----------------------+
 +------------------------ picks Free (owner picks what stays) -----+

Paid --cancelled, period over--> Plan ended (`plan_ended`, no grace)
Trial --paid at the end--> Paid
Trial --not paid at the end--> Free (moving-down rule, 46.4)
Paid --moved down, period over--> smaller plan (extra accounts: `plan_downgrade`;
                                  PRO parts off by the plan, automations run)
```

Rules:

1. Free never ends. `resolvePlanAccess` gives `active` to a workspace that never paid. The 14-day new-workspace trial is not used.
2. The grace is only for a failed payment. A cancel ends at the period end, with no grace.
3. `BILLING_READ_ONLY_ENFORCED` is true.
4. Billing sends a new event `PLAN_STATE_CHANGED` when a Stripe event changes the state. The app domain sets or clears `plan_ended` on the lanes of every account of that workspace.
5. A grace date passes with no Stripe event. So a billing worker (`plan-state-check`) looks every 15 minutes (`PLAN_STATE_CHECK_MINUTES` 15) for graces that ended, and sends the same event.
6. Plan ended, then a new plan: a paid plan is `active` once Stripe says paid; Free starts at once: accounts over Free's limit get `plan_downgrade` stops, and the PRO parts are off by the plan, as in 46.4. The `plan_ended` stops clear and the lanes wake as after any stop (section 33).
7. During a stop, waiting messages stay `waiting`. The 7-day rule still applies (section 12). Read only (403 `organization_read_only`) still lets the owner pause, delete, disconnect and choose a plan.

### 46.4 Moving between plans

```text
Owner asks to move down (Studio -> Creator, or a paid plan -> Free)
  |
  v
Screen shows what the smaller plan cannot hold: extra Instagram accounts;
and which PRO parts will be off by the plan in which automations
  |
  v
Owner picks which accounts stay active (saved now, can change until then)
  |
  v
End of the billing period: the new plan starts
  accounts not kept -> lane stop `plan_downgrade` on all 4 lanes
  automations       -> keep running; PRO parts the plan lacks are ignored
  notice + email once; nothing is deleted
```

1. **Up** (Free to Creator to Studio): at once. The new month limit and account limit apply at once. All `plan_downgrade` stops are cleared, and the PRO parts that were off by the plan work again by themselves. A `plan_limit` stop is cleared if the count is now under the new limit.
2. **Down**: allowed (D57). It starts at the end of the billing period.
3. **Automations are never stopped by a plan change.** At the period end the PRO features the new plan lacks are switched off by the plan, and each automation keeps running:
   - the email and phone steps are skipped: the run goes straight to its messages; a run waiting for her email or phone at that moment moves on to its next step (its waiting question becomes `skipped`, `plan_feature_off`);
   - "Reply like a person" works as OFF (replies right after each DM, no pace);
   - only the first public reply line is used;
   - only version A of the hello and of the follow ask is used;
   - "Delay before each message" is off (the account setting stays saved);
   - no broadcast is sent: a `scheduled` or `waiting_for_chats` broadcast ends `cancelled` (reason `plan_feature_off`); drafts and saved audiences stay;
   - a past-comments run that has not finished ends `failed` (reason `plan_feature_off`); opening DMs it already queued go on as normal.
4. Nothing is deleted. The PRO settings stay saved in the automation. The engine reads the plan's features at run time (the `acct:` copy, section 23) and ignores the PRO parts the plan lacks.
5. The owner gets a notice and an email once (notification type `subscription.updated`, kind Billing, section 47.2), for example: "Moved to Free: email and phone steps are off in 3 automations. Upgrade to switch them on again." The editor shows those steps as "PRO, off on your plan".
6. Turning a PRO step on still needs PRO (46.7). Steps that were on before the move down stay saved and are ignored; the owner can still edit and save the rest of the automation.
7. **Instagram accounts:** the number of active accounts must fit the plan's limit (1, 3 or 10). The change-plan route first answers which accounts do not fit, then takes the pick (`keep_instagram_account_ids`). The pick is saved with the planned change (`billing.subscriptions.downgrade_keep` JSONB, accounts only; new migration in billing). The owner can change it until the period end. At the period end `PLAN_STATE_CHANGED` tells the app domain which accounts to stop: the accounts not kept get lane stop `plan_downgrade` on all 4 lanes (slow, reply, fast, broadcast). No pick: the oldest-connected accounts stay.
8. An account with `plan_downgrade`: no sending on its 4 lanes; webhooks are still saved; the 7-day rule applies to its waiting messages.
9. **Swap ("choose active accounts"):** at any time the owner may choose which accounts are active inside the app, as long as the number fits the limit: making a stopped account active stops another one (`plan_downgrade`). It runs under the workspace lock (section 35). Disconnecting is not a swap: when the owner disconnects an active account, no stopped account starts by itself; the owner picks.
10. A cancelled paid plan ends at the period end: stop `plan_ended` (46.3). The grace is only after a failed payment. A trial that ends without payment is different: it moves to Free by this moving-down rule (46.9).
11. Members and roles stay on every plan (section 45).
12. The month count stays. If it is at or over the new limit, `plan_limit` starts at once on the `slow`, `fast` and `broadcast` lanes (section 10).
13. "Switch plan with undo": the app waits a few seconds before it calls change-plan. Undo cancels the call. No backend change.

Example: a Studio workspace with accounts A, B and 4 more moves to Creator (3 accounts) on 10 December; its period ends on 31 December. The owner keeps A, B and C. On 31 December the other 3 accounts get `plan_downgrade` on their 4 lanes; nothing is deleted. In January she makes account D active in place of C ("choose active accounts"): D sends again, C stops. In February she moves back up to Studio: the stops clear at once.

Example 2: a Creator workspace moves to Free. On the period end its automation GUIDE (email step, "Reply like a person" ON, 3 reply lines, 2 hello versions) keeps running: Riya's run skips the email step and goes to the messages, the public reply goes right after the DM with the first line, and every new run gets version A. The owner gets one notice and one email. When she moves up again, all of it works again without any edit.

### 46.5 The month count

The rules are in section 10 (what counts, what happens at the limit) and section 31 (the check in the send commit). Here only:

1. The limit is the plan row's `dm_month_limit`.
2. The month is the calendar month in the workspace's time zone (`tenancy.organizations.timezone`).
3. `GET /auth/me/context` adds `active_organization.dm_month`: `used`, `limit`, `resets_on`, `state` (`ok`; `nearly` from 80 %, `DM_MONTH_NOTICE_PERCENT` 80; `reached` at 100 %).
4. It reads the Redis copy `cnt:month:{organization}`, or the Postgres sum when Redis is empty. Every role sees it (the meter in the account menu).
5. At the limit, go-live is refused: 422 `dm_month_limit_reached`.

### 46.6 Accounts per plan

Free 1, Creator 3, Studio 10 (`instagram_accounts_max`, D26). Checked when an account is connected, under a transaction lock on the workspace (`pg_advisory_xact_lock` on the organization id, then its `app.meta_connections` rows, sections 25.5 and 35); over the limit: 409 `plan_account_limit`. After a move down, only the kept accounts send (46.4).

### 46.7 PRO gate

PRO steps (Creator and Studio):

1. Ask for their email; ask for their phone (D31).
2. "Reply like a person" ON (D32). New automations on Creator and Studio start with it ON (`REPLY_LIKE_PERSON_DEFAULT_PAID` true, D59). ON needs at least 3 reply lines (`PUBLIC_REPLY_LINES_MIN_ON` 3, D52).
3. More than one public reply line (D32).
4. More than one version of the hello or of the follow ask (D30, D31).
5. Broadcasts, with saved audiences (D68).
6. "Run on past comments" (D69).
7. "Delay before each message", an account setting (D67).

Rules:

1. Saving a draft with a PRO step: always allowed.
2. Go live of a draft: refused with 422 `pro_feature_required` and the list of PRO steps, when a PRO step is on and the plan has no `pro_features`.
3. Saving a live or paused automation, or going live from `paused`: refused the same way only when the save turns a PRO step on (it is off in the saved automation). PRO steps that were on before a move down stay saved and are ignored by the engine (46.4), so the owner can still edit and save the rest.
4. Go-live is also refused when the plan ended (403 `organization_read_only`) or the DM limit is reached (46.5).
5. One function in the app domain, `assertPlanAllows`, runs at go-live, at each save of a live or paused automation, when a broadcast is scheduled or sent, when a past-comments run starts, and when the extra delay is saved. The engine has its own check at run time: it skips the PRO parts the plan lacks (46.4).
6. Free: "Reply like a person" is OFF only (no pace, no hour cap). The risk that Meta flags a Free account is accepted (D59).
7. Teams and all 4 roles are on every plan (section 45).

Example: on Free, the owner of account A adds an email step. The draft saves. "Go live" answers `pro_feature_required` with "Ask for their email". The app shows Upgrade.

### 46.8 Cards and invoices

| Need | Today | Change |
|---|---|---|
| List cards | `GET /billing/payment-methods` | Adds `is_default` |
| Add a card | `POST /billing/payment-methods/setup` | — |
| Remove a card | Missing | `DELETE /api/v1/billing/payment-methods/:payment_method_id` (`subscription:manage`). Stripe detaches it. The default card cannot be removed while a paid plan is on and it is the only card: 409 `default_card_in_use` |
| Default card | Missing | `POST /api/v1/billing/payment-methods/:payment_method_id/default` (`subscription:manage`, idempotency key). Sets the Stripe customer's default card and the subscription's |
| Invoices | `GET /billing/invoices` | — |

Stripe calls run outside database contexts (meepzo-be's rule).

### 46.9 Free trial of Creator or Studio (D73)

```text
Owner picks "Try Creator for 7 days" (no card)
  |
  v
Checks: no trial before in this workspace, and no connected Instagram
account had a trial before (by `instagram_user_id`)
  |
  v
Stripe subscription with a 7-day trial, no card -> Stripe `trialing`:
the plan's features and limits at once
  |
  v
3 days and 1 day before the end: notice + email "Add a card to keep Creator"
  |
  +-- card added: Stripe charges at the end --> Paid (the plan goes on)
  +-- no card: Stripe cancels at the end --> our Stripe webhook moves
      the workspace to Free by the moving-down rule (46.4)
```

1. Creator and Studio have a 7-day trial with no card (`PAID_TRIAL_DAYS` 7). One trial per workspace.
2. An Instagram account gets a trial only once, in any workspace (checked by `instagram_user_id`). New table `billing.trial_accounts` (`instagram_user_id` unique, `organization_id`, `plan_id`, `started_at`; new migration in billing). The trial start writes every connected account; an account connected during the trial is written too.
3. Refused with 409 `trial_already_used` when the workspace or one of its accounts had a trial. Connecting, during a trial, an account that already had one: 409 `trial_used_by_account` ("Add a card to connect this account").
4. During the trial the workspace has that plan's features and limits: the full month DM limit, its accounts, PRO.
5. A plan change during the trial keeps the same end date.
6. Notices and emails 3 days and 1 day before the end (`TRIAL_NOTICE_DAYS` 3, 1; section 47).
7. Stripe: `POST /billing/subscriptions` takes `trial: true`. The subscription gets 7 trial days, asks for a card only if required, and is set to cancel when the trial ends with no card. With a card, the plan goes on and Stripe charges as usual.
8. End with no card: Stripe cancels the subscription. Our Stripe webhook sees a trial that ended without payment and moves the workspace to Free by the moving-down rule (46.4): PRO parts switch off, nothing is deleted, accounts above 1 get `plan_downgrade` lane stops, and the owner can swap which account is active. It is not "Plan ended".
9. The owner can pick in advance which account stays (the same `downgrade_keep` as 46.4). No pick: the oldest-connected account stays.
10. `GET /auth/me/context` `plan_access` adds `trial_ends_at` (null when there is no trial). meepzo-be's `NEW_ORGANIZATION_TRIAL_DAYS` (a read-only trial) is not used for this product.

Example: the owner of account A starts a Creator trial on 1 December and connects accounts A and B. She adds an email step. On 5 and 7 December she sees "Your Creator trial ends on 8 Dec". She adds no card. On 8 December the workspace is on Free: account A keeps sending (the oldest connected), B gets `plan_downgrade`, the email step is skipped, and nothing is deleted. Account A can never get a trial again.

---

## 47. Profile, settings, notifications and notices

### 47.1 Settings: the 11 sections

| # | Section | Flowdm shows | meepzo-be today | Change |
|---|---|---|---|---|
| 1 | Profile | Name, "what you do", email (read only), avatar, completeness meter | `PATCH /users/me`, `PUT /users/me/avatar` | The app counts completeness from the fields |
| 2 | Security | Email code (always on), Google, Apple, passkeys, 2FA | auth routes | Section 44 |
| 3 | Notifications | 7 kinds × Email, In-app, Push (Flowdm's 6 + broadcasts and past comments) | `GET` and `PUT /users/me/notification-preferences` (type × channel) | Kinds (47.2); check before send (47.3) |
| 4 | Sessions | Devices with place and last active; sign out one; everywhere else | `GET` and `DELETE /auth/me/sessions` | Place (47.5); strong step-up (44.7) |
| 5 | Appearance | Light or Dark; Reduce motion | `auth.user_settings.is_dark_mode_enabled` | `reduce_motion` (47.6) |
| 6 | Account | Account ID, verified email, role, workspace at sign-in, delete account | `GET /users/me`, `PATCH /users/me/settings`, `DELETE /users/me` | Confirm email (47.7) |
| 7 | General | Name, slug (read only), tile colour | `PATCH /tenancy/organization` | Section 45.7 |
| 8 | Members | Counts, invite emails, list, roles, invitations | membership routes | Section 45.6 |
| 9 | Roles | 4 roles, 9 permissions, who holds each | role routes (read) | Section 45.5 |
| 10 | Billing | DMs used, reset date, 3 plans, cards, invoices | billing routes | Section 46 |
| 11 | Integrations | API keys: create, list, revoke | `/tenancy/organization/api-keys` | — (built) |

### 47.2 Notifications: 7 kinds

| Kind (on the screen) | Notification types | Who gets it | Email | In-app | Push |
|---|---|---|---|---|---|
| An automation stops or hits an error | `automation.stopped` (new), `instagram.reconnect_required` | Owner, Admin, Editor | on | on | later |
| DM limit nearly reached | `billing.usage_threshold` (80 % and 100 %) | Owner, Admin, Editor | on | on | later |
| A new contact leaves details | `contact.details_left` (new) | Owner, Admin, Editor | off | on | later |
| Team changes | `membership.invite_accepted`, `membership.invite_declined`, `membership.role_changed` (new), `membership.removed` (new) | Owner, Admin, and the member it is about | on | on | later |
| Billing | `billing.payment_failed`, `billing.payment_succeeded`, `subscription.updated`, `billing.trial_ending` (new; 3 days and 1 day before a trial ends) | Owner, Admin | always on | on | later |
| Weekly summary | `report.weekly_summary` (new) | Every member | on | off | later |
| A broadcast or a past-comments run is done (7th kind) | `broadcast.done` (new), `automation.backfill_done` (new) | The member who started it, plus Owner and Admin | off | on | later |

The Email and In-app columns are the defaults (D54). Billing emails cannot be turned off.

Rules:

1. The screen saves a kind × channel. The server writes one row per type of that kind in `user_notification_preferences` (no new table). Changes save as they are made.
2. New types go into `NOTIFICATION_TYPES`. The kind map is one constant, `NOTIFICATION_KINDS`.
3. Push: the choice is saved now (channel `WEB_PUSH`). Nothing sends it yet (section 49). The app marks it "soon".
4. Not in the grid, always sent: security notices (`security.alert`), sign-in codes, invitation emails, the confirm-email link. Billing emails are in the grid but cannot be turned off.
5. New contact details are grouped: at most one note per account per hour (`CONTACT_DETAILS_NOTICE_EVERY_MINUTES` 60), for example "3 new contacts left details on @account_a".
6. `automation.stopped` goes once per automatic stop (section 15), not once per failed message.
7. The 80 % email goes once a month (D34). The 100 % one too.
8. `broadcast.done` goes when a broadcast ends (`done`, or `cancelled` by the owner or by the plan), with its numbers: "Broadcast SALE done: 310 sent, 12 skipped (chat closed), 41 replies". A "when chat opens" broadcast sends it at its end date.
9. `automation.backfill_done` goes when a past-comments run ends: "GUIDE: found 340 comments, 290 match, 250 queued" (or why it failed).

Example: Riya leaves her email in account A's automation at 10:05. Two more people do at 10:20 and 10:40. At 11:05 the owner of account A sees one in-app note: "3 new contacts left details". No email: the default for this kind is off.

### 47.3 Check the choice before each send

Today the dispatch sends without reading the choice. New:

```text
Something happens (for example: an automation stops)
  |
  v
Who gets it? (the role rule of 47.2, active members only)
  |
  v
For each person, read the choice for this type:
  In-app on? --> notification row (as today)
  Email on?  --> mail outbox row (dedupe key = the notification's public id)
  Push on?   --> nothing yet (section 49)
```

1. A missing row = the default of 47.2.
2. The workspace's own mute (`organization_notification_policies`) still wins, as today.
3. One query reads the choices of all the people of one notification.

### 47.4 Weekly summary

1. A worker runs every hour (`weekly-summary`, in the notify domain).
2. It picks workspaces where it is now Monday, 09:00 to 09:59, in the workspace's time zone (`WEEKLY_SUMMARY_WEEKDAY` 1, `WEEKLY_SUMMARY_HOUR` 9).
3. Per workspace, per account, for the last 7 days: runs started, DMs sent, % tapped, new contacts, emails and phones collected, the top automation. Plus the month count.
4. It reads `app.automation_counts`, `app.dm_month_counts` and the runs (kept 90 days): one read per workspace. Nothing happened in 7 days: no email.
5. One email per person who has the kind on, through the mail outbox. Dedupe key `weekly:{organization}:{year-week}:{user}`, so a restart never sends twice.

Estimate: 1,000 workspaces spread over their time zones = a few hundred reads in one hour. Small.

### 47.5 Sessions: place

1. When a session is made, and when its IP changes on refresh, we look up the city and country of the IP.
2. The lookup uses a local IP-to-place file (for example a GeoLite2 file; licence and monthly updates to check, section 53). The IP never goes to an outside service.
3. New columns `auth.sessions.place_city`, `auth.sessions.place_country` (null when not found). New migration in auth. The screen shows "Chrome on Mac · Mumbai, India · active 5 min ago".
4. Sign out one, sign out everywhere else: built, with the strong step-up of 44.7. "Everywhere else" also ends trusted devices, except this browser.

### 47.6 Appearance

1. Light or Dark: built (`is_dark_mode_enabled`).
2. Reduce motion: new column `auth.user_settings.reduce_motion` BOOLEAN, default false. New migration in user. `PATCH /users/me/settings` takes it.
3. The app also follows the device's own reduce-motion setting.

### 47.7 Confirm your email

1. New route `POST /api/v1/users/me/email-confirmation` (signed in). It emails a link. Resend after 60 s (the same wait as the code).
2. The link holds a one-time token (`auth.verification_tokens`, type `EMAIL_CONFIRM`), good for 24 hours (`EMAIL_CONFIRM_LINK_HOURS` 24).
3. New PUBLIC route `POST /api/v1/auth/email/confirm` with `{ token }` sets `is_email_verified` true.
4. Signing in with an email code also confirms the email, so this notice is rare. An unconfirmed email cannot accept an invitation (both as today).

### 47.8 Notices

Strips at the top of the app. Each one needs one field from the server.

| Notice | Shows when | Server field | Action | Can be dismissed |
|---|---|---|---|---|
| DM limit nearly reached | `dm_month.state` is `nearly` | `active_organization.dm_month` (46.5) | Billing | Yes, until next month (kept by the app) |
| DM limit reached | `dm_month.state` is `reached` | the same; the date from `resets_on` | Billing | No |
| Payment failed | `plan_access.state` is `grace` | `plan_access.grace_ends_at` | Billing | No |
| Trial ends soon | 3 days or less before `plan_access.trial_ends_at` | `plan_access.trial_ends_at` (46.9) | Billing (add a card) | Yes, until the last day (kept by the app) |
| Plan ended | `plan_access.state` is `read_only` | `plan_access` | Choose a plan | No |
| Confirm your email | `user.is_email_verified` is false | `user` | Resend (47.7) | Yes (kept by the app) |
| Workspace being set up | No connected Instagram account | `active_organization.instagram_accounts_count` (new) | — | No |
| Previewing as a role | The app's preview mode | none (app only) | Exit preview | — |

Rules:

1. All fields come in `GET /auth/me/context`. The app reads it at start and after each workspace switch.
2. A dismiss is kept by the app on that device. No new table.
3. Order when several apply: Plan ended, DM limit reached, Payment failed, Trial ends soon, DM limit nearly reached, Workspace being set up, Confirm your email. The app shows the first three (Flowdm: up to three at once, section 15.3).
4. While the limit is reached or the plan has ended, go-live is refused (46.5, 46.7).
5. "Broadcast done" and "past comments done" are notifications (47.2), not strips. A broadcast that is sending, or waiting for chats, shows its own progress on the broadcast screen (section 15).
6. System screens: 404 and 500 as built. 403 "No access" = meepzo-be's `permission_denied`. "Workspace paused" = workspace `status` `SUSPENDED` (45.7).

---

## 48. Refer

A person shares a link. When a friend signs up with it and pays, the person earns 30 to 50 % of what the friend pays, every month. meepzo-be has nothing for this. New sub-domain `referral` in the billing domain, with NEW migrations.

Words used here: **referrer** = the person who shares the link; **friend** = the person who signs up with it; **tier** = the percent, set by how many friends paid that month; **payout** = money our team sends to a referrer.

### 48.1 How it works

```text
1. Owner of account A opens Refer  -> link https://<app>/r/K7P2QM9X
2. Owner of account B opens it     -> the app keeps the code (30 days)
3. B signs up                      -> app: POST /billing/referrals/claim (within 24 h)
4. B's workspace pays Creator $29  -> Stripe invoice.paid -> one earning line
5. 1st of the next month           -> month closed: tier set, lines priced
6. 30 days later                   -> lines approved (refunds taken off)
7. Our team pays A                 -> the payout is recorded
```

### 48.2 Tables

| Table | Main columns | Note |
|---|---|---|
| `billing.referral_links` | `id`, `public_id`, `user_id` (unique), `code` (unique, 8 letters and digits, `REFERRAL_CODE_LENGTH` 8), `created_at`, `disabled_at` | One link per person, made the first time Refer opens |
| `billing.referrals` | `id`, `public_id`, `referrer_user_id`, `friend_user_id` (unique), `referral_link_id`, `claimed_at`, `status` (`joined`, `paying`, `blocked`), `blocked_reason`, `first_paid_at` | One referrer per friend, for ever |
| `billing.referral_earnings` | `id`, `referral_id`, `referrer_user_id`, `organization_id`, `stripe_invoice_id` (unique), `month_start`, `amount_cents` (paid minus tax), `refunded_cents`, `percent`, `earning_cents`, `status` (`open`, `pending`, `approved`, `void`), `created_at` | One line per paid invoice |
| `billing.referral_payouts` | `id`, `public_id`, `referrer_user_id`, `amount_cents`, `currency`, `method`, `reference`, `paid_at`, `recorded_by_user_id`, `note` | Written by our team only |

Rules:

1. Row security: a person reads only her own rows (like `auth.user_settings`). The Stripe webhook and the month worker write with meepzo-be's worker role.
2. Money is in cents, in the plan currency (USD).

### 48.3 Tiers and earnings

| Paying friends that month | Percent |
|---|---|
| 1 to 9 | 30 % |
| 10 to 24 | 40 % |
| 25 or more | 50 % |

Setting: `REFERRAL_TIERS` 1:30, 10:40, 25:50.

1. A paying friend = a friend with at least one paid invoice that month. The tier of the month applies to all that month's lines of that referrer.
2. A line is made on Stripe `invoice.paid` for a workspace whose owner is a friend. Amount = paid minus tax.
3. Refunds (`charge.refunded`) and disputes (`charge.dispute.created`) reduce the line. These 2 Stripe events are added to the webhook list.
4. The month worker (`referral-month-close`, the 1st of the month, 03:00 UTC) sets `percent` and `earning_cents` on last month's lines. Status `pending`.
5. After 30 days (`REFERRAL_HOLD_DAYS` 30): `approved`. A line refunded in full: `void`.
6. "Earning this month" on the screen = this month's open lines × today's tier (estimate).

Example: in December, 3 friends of the owner of account A pay. Tier 30 %. The owner of account B pays Creator $29 (no tax), so A earns $8.70 from B. The lines turn `pending` on 1 January and `approved` on 31 January.

### 48.4 Payouts

1. Our team pays approved earnings outside the product. Minimum payout $50 (`REFERRAL_MIN_PAYOUT_USD` 50); a smaller amount rolls over to the next month (D53). How the money is paid (bank, PayPal, Stripe Connect, or credit on their own bill) is an open item (section 53).
2. The team records it: `POST /api/v1/billing/referral-payouts` (`super_admin`, strong step-up). It writes an audit row.
3. A payout cannot be more than the approved, unpaid earnings. "Paid out so far" = the sum of payouts.

### 48.5 Anti-abuse basics

1. No self-referral: the claim of your own code is refused. No line is made when the referrer is a member of the paying workspace.
2. One referrer per friend. The claim works only within 24 hours of the friend's account being made (`REFERRAL_CLAIM_WINDOW_HOURS` 24).
3. Only paid months count. Free never counts. Refunds and disputes are taken off.
4. A 30-day hold before money is approved.
5. Disposable emails are already refused at sign-up (meepzo-be).
6. Our team can block a referral (`blocked` + reason). Its `open` and `pending` lines become `void`.

### 48.6 Routes

| Route | Who | What |
|---|---|---|
| `GET /api/v1/billing/referrals/me` | Signed in | The link (made if missing), friends joined, paying friends this month, tier, earning this month (estimate), approved and unpaid, paid out so far |
| `POST /api/v1/billing/referrals/claim` | Signed in | `{ code }`. Refused: own code, already claimed, over 24 h, unknown code |
| `POST /api/v1/billing/referral-payouts` | `super_admin` | Record a payout |

The ready message, the WhatsApp and Email buttons and the "what it could add up to" slider live in the app only. The app keeps the code from the link for 30 days (`REFERRAL_COOKIE_DAYS` 30).

---

## 49. Later features (moved to their own file)

Later features are not part of this build. The full list is in `Instagram-DM-Later-Features-v8.md`: Messenger and Facebook Pages, post scheduling, ads publishing, analytics, booking with Google Calendar, link tracking, AI FAQ, forms, integrations, ads sync, the InstantDM items, the ideas, what Unified Login cannot do, the later engine items, and the tests to run before building them.

Two rules stay here:

1. Nothing in this plan depends on them. The plan only leaves room for them now (D27: the `channel` column and `app.meta_connections`).
2. Each one asks its own Meta permission only when it is built (Meta's review needs a working demo). Connected customers then reconnect once.

---

# Part G. Build and track

## 50. Build steps in meepzo-be

### 50.1 The process

meepzo-be has its own design-iteration process (`iterations/CLAUDE.md`, `iterations/README.md`, `docs/design-workflow/process/README.md`). A change follows it: questions first, plan before code, the user approves, then build.

```text
questions -> branch <type>/<topic> -> pnpm iteration:new ... --both -> intake (--check)
  -> plan, no code (KICKOFF.md, plans/*, routes-final.md) -> approved
  -> one ROUTE row at a time (AS-BUILT.md) -> close (done) -> frozen -> the user's PR
```

1. The launch iteration `launch-2026-11-20-ujai` is `done`, but not merged to `main`.
2. Your team picks one:
   - re-open it (`pnpm iteration:status launch-2026-11-20-ujai planning --reason "..."`), or
   - open new iterations. Suggestion: one `change` iteration for the sending engine and the app (sections 4 to 43), and one `feat` iteration for the product around sending (sections 44 to 48). Both with `--both`, because meepzo-fe builds the screens.
3. Update the iteration's plan files (tables, routes, background work, decisions) from this plan, before any code.
4. The plan proposes; meepzo-be's agent-os decides. It may change names, types, paths or job details. Each difference goes into `AS-BUILT.md` and back into `plans/db-changes.md`, `route-changes.md` and `worker-changes.md`.

### 50.2 Step 0: the Meta app check and the creator test

Unified Login is the only login (D24). It is a new app with no customers: nothing is moved from the old login. Step 0 does not hold up the build. It shows how hard the business-portfolio step is for a creator, so we can write a help guide and connect screens for it.

**The Meta app setup is the owner's task** (not code): remove the old Instagram-only login product from our Meta app, or make a new Meta app; business verification; the Unified Login configuration; Meta's review (50.8). The build team gives the owner the details each step needs.

```text
The owner checks our Meta app in the App Dashboard:
  owned by our business portfolio; use case "Manage messaging & content on
  Instagram"; Facebook Login for Business; Unified Login setup (config_id) with
  the Instagram-compatible label (section 25); the Instagram-only login product
  NOT set up on this app (an app cannot use both: remove it if it is there)
  |
  v
2 creator accounts with NO business portfolio connect while we watch
  |
  v
Write down each step, each word Meta shows, where they get stuck, the time taken
  |
  v
Help guide + connect screens (section 25): make a business portfolio, pick the
account, allow messages; calm errors (#10 account type, #200 message access)
```

1. The test steps are in section 43.
2. Development mode: up to 50 Instagram testers. Meta's test users do not work. Test accounts must be public.
3. The same day: the owner starts Meta business verification. It can take days to weeks (estimate).
4. Risk we accept: every creator needs a business portfolio. The help guide is how we make that step easy.

### 50.3 Order of work

```text
 0. Meta app check + creator test + start business verification --+
 1. Tests with Meta (section 43)                                   | all three
 2. Iteration plans written and approved                           | run together
      |                                                            |
      v                                                            |
 3. Settings file (section 36)                                     |
      |                                                            |
      +----------------------------------+                         |
      v                                  v                         |
 Track A: app and sending           Track B: product around sending
 A1 app migrations (in place)       B1 auth (section 44)           |
 A2 reset the dev database          B2 user and tenancy (45, 47)   |
 A3 Unified Login connect  <------- help screens from step 0 ------+
 A4 sending sub-domain              B3 billing plans and states (46)
 A5 workers and queues              B4 notify (section 47)
 A6 run engine  <------------------ B3 (plan rows, PRO gate, month limit)
 A7 webhook and intake              B5 refer (section 48)
 A8 owner and team actions  <------ B2 (`contact:update`), B3 (plan states)
 A9 broadcasts, past comments  <--- B3 (PRO gate)
 A10 health and alerts              B6 upload purpose for message files
      |                                  |
      +----------------+-----------------+
                       v
 4. Meta's review (50.8) -> Live mode
 5. Tests, then close and freeze the iterations (50.9)
```

### 50.4 Track A: app and sending (the `app` migrations change in place)

Step 3, before both tracks: the **settings file**. All numbers of section 36. Remove the old meepzo-be constants that it replaces (section 36).

1. **A1 Migrations.**
   - Change the 7 `app` migrations **in place** (allowed: they are not in `main`): `20261121050908_app_schema.sql`, `20261121064529_app_instagram_account.sql`, `20261121094404_app_instagram_media.sql`, `20261121094503_app_contacts.sql`, `20261121094626_app_instagram_webhook_events.sql`, `20261121150135_app_automations.sql`, `20261121170217_app_automation_runs.sql`.
   - Put in the changes of section 18 (list in 50.7): new columns; automation status `draft`, `live`, `paused`; `steps JSONB`; `channel`; the 15 `trigger_type` values; `starter_questions`; the 4 account settings of D64 to D67 on `app.instagram_account_settings`; the contact columns for audiences (D68); message type `broadcast`; the 4th lane `broadcast`; the partitions (section 21).
   - Remove what section 18 lists as removed: `app.instagram_account_tokens` (the old token table), the 5 account public reply columns (D32), the old "also from a DM keyword" switch and the finished-run count (D38, D36), `automation_runs.trigger_text`, and the unique index `idx_instagram_accounts_organization_live` (D26).
   - Add new migration files for the new `app` tables (section 19, list in 50.7). Row security ON and FORCE, owner, grants, and the force-RLS table list.
   - Follow meepzo-be's migration rules: one statement per `--> statement-breakpoint`, `IF NOT EXISTS`, `migration-safety` headers, `pnpm db:migrate:lint`.
2. **A2 Reset the development database:** `pnpm dev:stack:reset-db`. The development database already ran the old files.
3. **A3 Remove the Instagram Login code and replace it with Unified Login** (section 25).
   - Remove: today's connect flow, `app.instagram_account_tokens` and its code, the daily token renewal worker, the `instagram_business_*` scope names (`INSTAGRAM_ACCOUNT_REQUIRED_SCOPES`), the `graph.instagram.com` client (`src/infrastructure/social/instagram.client.ts`), the Instagram-app secret and its env names.
   - Build: the Unified Login connect (`config_id`, `graph.facebook.com` `v27.0`), `app.meta_connections` and `app.meta_connection_tokens`, pick accounts up to the plan limit (organization lock, section 35), `subscribed_apps` with the 6 fields (a job after the commit), the token check (`token-check` job, in place of `instagram-account-daily-check`), account routes with `:instagram_account_id`, the help screens of step 0.
   - Keep Meta's deauthorize and data-deletion callbacks, checked with our Meta app's secret.
4. **A4 Sending sub-domain** `src/domains/app/sub-domains/instagram-sending/` (name to confirm with the team): repositories for messages, attempts, lanes, minute counts, month counts, stops; the gates (section 31); the "save result" function used by worker, helper and intake.
5. **A5 Workers and queues** with meepzo-be's queue setup: `instagram-send-slow` (slow, reply and broadcast lane tickets), `instagram-send-fast`, the helper (every minute; it also queues `app.contact_tag_events` rows that are not queued yet, starts scheduled broadcasts, ends "when chat opens" broadcasts at their end date, and watches past-comments runs), `instagram-partition-maintenance` (family `retention`), and the queue `instagram-tasks` (jobs `account-setup`, `starter-questions`, `attachment-upload`, `token-check`, `tag-bulk`, `month-wake`, `plan-change`, `segment-count`, `broadcast-audience`, `past-comments`, `retry-failed`). Worker places: section 36.
6. **A6 Run engine** (`automation-run.service.ts`, `automation-run-message.service.ts`): the steps of section 5 (hello with buttons and versions, nudge, follow, email and phone wordings, message list with waits, tags, hide, public reply ON or OFF); 1 to 4 starter questions per automation, at most 4 per account (D42); the once keys of section 9. "Send" saves a `waiting` message and adds a ticket. The worker never waits. Result handling moves to the shared "save result" function. Draft and go-live with the full check and the PRO gate (needs B3). Fast lane: "Delay before each message" (D67, at most `EXTRA_DELAY_MAX_SECONDS` 20; the whole wait stays under `BOT_ANSWER_MAX_SECONDS` 30 minus `BOT_ANSWER_SAFETY_SECONDS` 5 = 25 seconds) and "mark as seen" after a sent message (D66, not a DM).
7. **A7 Webhook and intake** (sections 26, 27): the 6 webhook fields, the new event kinds, the 15 ways to start, the match order, tag events (written to `app.contact_tag_events` in the same commit as the tag change); replies under comments (D64: `parent_id`, the account switch) and the account's own comments never start anything; the "once per person per post" switch (D65: "every time" keys); the "when chat opens" broadcast hook; the audience contact columns kept in the same commits as the events; our own notices checked before the save; read receipts not saved; event keys table; Redis buffer when Postgres is down; taps before comments; inbound flood counter.
8. **A8 Owner and team actions** (section 15): pause (Keep or Cancel), resume, limits, fix text, reconnect, disconnect, delete person, team suspend, workspace suspend, plan stops; banners; "will go / may expire"; counters; contacts (note, bulk tags, detail, "Pause automations for this person" D71); "Retry failed messages" on an automation or a contact (D72: the `retry-failed` job in pieces of 500, `RETRY_FAILED_PIECE` 500; each message at most once, `RETRY_FAILED_MAX` 1; the count shown first); tag list; duplicate; the keyword "try it" route. Each writes to `audit.logs`.
9. **A9 Broadcasts and past comments** (sections 8, 15, 30; D68, D69).
   - Audiences: `app.segments` (conditions JSONB, zod, at most `SEGMENT_CONDITIONS_MAX` 20 conditions), the count preview ("1,240 match. 310 can get it now"), the `segment-count` job for complex conditions.
   - Broadcasts: `app.broadcasts`, `app.broadcast_recipients` (monthly parts, kept 90 days, `BROADCAST_RECIPIENT_KEEP_DAYS` 90), 1 to 3 messages (`BROADCAST_MESSAGES_MAX` 3), the 3 modes (now, at a set time, when her chat opens for up to 7 days, `BROADCAST_OPEN_WAIT_DAYS_MAX` 7), the `broadcast` lane with box timing (`BROADCAST_HOUR_LIMIT_DEFAULT` 600, owner up to `BROADCAST_HOUR_LIMIT_MAX` 2000), gate group `broadcast` (`cnt:broadcast:{account}`), the window check when the audience is built and again before each send, at most one broadcast per person per 24 hours (`BROADCAST_MIN_GAP_HOURS` 24), the month count.
   - Past comments: the "Also answer comments from the last N days" button (1 to `PAST_COMMENTS_MAX_DAYS` 7; for "any post" the newest `PAST_COMMENTS_POSTS_MAX` 50 posts with comments), the `past-comments` job (one at a time per account), `app.automation_backfills`, the estimate, intake as "old" comments.
   - Each send, cancel and past-comments start writes to `audit.logs`.
10. **A10 Health and alerts** (section 40), including broadcast lane stops and past-comments failures.

### 50.5 Track B: the product around sending (NEW migrations only)

1. **B1 auth** (section 44): passwords off, Apple, digits-only code, reasons and `tries_left`, trusted devices, email-code step-up, link mode, GitHub off.
2. **B2 user and tenancy** (sections 45, 47): onboarding fields, reduce motion, session place, confirm email, invitation preview, workspace chooser, roles (Editor, Viewer, `contact:update`, custom roles off), several emails per invite, slug read only, `logo_color`.
3. **B3 billing** (section 46): plan rows and typed features, Free never ends, plan states with `PLAN_STATE_CHANGED` and the 15-minute check, `BILLING_READ_ONLY_ENFORCED` on, seat sync off, card routes, `dm_month` in `GET /auth/me/context`; the 7-day trial (46.9: `trial: true` on subscribe, `billing.trial_accounts`, `trial_ends_at`, the Stripe webhook moving an unpaid trial to Free, the trial notices sent by `plan-state-check` 3 days and 1 day before).
4. **B4 notify** (section 47): kinds, the check before send, new types, the weekly summary worker, grouped contact notes.
5. **B5 refer** (section 48).
6. **B6 upload:** a new upload purpose for message files (name to confirm, for example `MESSAGE_MEDIA`). Today's `ORGANIZATION_FILE` takes only images and PDF up to 10 MB, and no audio. The new purpose: image png or jpeg up to 8 MB (`MESSAGE_IMAGE_MAX_MB` 8), voice note aac, m4a, wav or mp4 up to 25 MB (`MESSAGE_AUDIO_MAX_MB` 25), PDF up to 25 MB (`MESSAGE_FILE_MAX_MB` 25); bound to the workspace. The upload ceiling `UPLOAD_DTO_FILE_SIZE_MAX_BYTES` goes from 10 MB to 25 MB. The purpose list is a code constant (no migration).
   - **File scan (D58):** the upload domain scans every uploaded file. A file that is not scanned clean cannot be used in a message. meepzo-be has no scanner today, so B6 adds one: a scan step after the upload is confirmed, and a scan result on the upload row (`scan_status`: `pending`, `clean`, `blocked`, `failed`; name to confirm; new migration in upload). The scanner is picked when building.

New migrations in merged domains (file name `YYYYMMDDHHMMSS_<name>.sql`; names are sketches):

| Domain | Migration | What | Section |
|---|---|---|---|
| auth | `auth_passwords_off` | `password_hash` set to NULL; `PASSWORD` auth methods revoked | 44.1 |
| auth | `auth_trusted_devices` | New table, row security ON and FORCE | 44.6 |
| auth | `auth_sessions_place` | `place_city`, `place_country` | 47.5 |
| user (schema `auth`) | `auth_users_onboarding_fields` | `instagram_handle`, `goal` and their checks | 45.2 |
| user (schema `auth`) | `user_settings_reduce_motion` | `reduce_motion` | 47.6 |
| tenancy | `tenancy_roles_editor_viewer` | Member renamed Editor (+ `automation:delete`, `upload:manage`); Viewer added to every TEAM workspace; grants | 45.5 |
| tenancy | `tenancy_permission_contact_update` | `contact:update` row and grants | 45.5 |
| tenancy | `tenancy_organizations_logo_color` | `logo_color` and its check | 45.7 |
| billing | `billing_flowdm_plans` | Free updated, Creator and Studio added, old rows off | 46.2 |
| billing | `billing_referrals` | The 4 referral tables, row security | 48.2 |
| app (new file) | `app_member_workspace_counts` | The chooser's counts function | 45.4 |
| upload | `upload_scan_status` | `scan_status` on the upload row (name to confirm) | 50.5 |
| billing | `billing_trial_accounts` | `billing.trial_accounts` (one trial per Instagram account) | 46.9 |
| billing | `billing_subscriptions_downgrade_keep` | `downgrade_keep` JSONB (the owner's pick of active Instagram accounts for a move down; accounts only) | 46.4 |
| notify | none | Types are code constants, not a database check | 47.2 |

### 50.6 Names added by Part F

| Kind | Names |
|---|---|
| Tables | `auth.trusted_devices`, `billing.referral_links`, `billing.referrals`, `billing.referral_earnings`, `billing.referral_payouts`, `billing.trial_accounts` |
| Columns | `auth.users.instagram_handle`, `auth.users.goal`, `auth.user_settings.reduce_motion` (next to dark mode), `auth.sessions.place_city`, `auth.sessions.place_country`, `tenancy.organizations.logo_color` |
| Plan features | `dm_month_limit`, `instagram_accounts_max`, `pro_features`, `priority_support` |
| Billing column and field | `billing.subscriptions.downgrade_keep`; `plan_access.trial_ends_at` in `GET /auth/me/context` |
| Roles and codes | Editor (was Member), Viewer; `contact:update` |
| Notification types | `automation.stopped`, `contact.details_left`, `membership.role_changed`, `membership.removed`, `report.weekly_summary`, `broadcast.done`, `automation.backfill_done`, `billing.trial_ending` |
| Token type | `EMAIL_CONFIRM` |
| Upload | purpose `MESSAGE_MEDIA`, column `scan_status` (names to confirm) |
| Event | `PLAN_STATE_CHANGED` |
| Workers | `weekly-summary` (notify), `plan-state-check` (billing; also the trial notices), `referral-month-close` (billing) |
| New routes | `POST /auth/oauth/apple/callback`, `POST /auth/email/confirm`, `POST /tenancy/membership-invitations/:membership_invitation_id/preview`, `POST /users/me/email-confirmation`, `DELETE /billing/payment-methods/:payment_method_id`, `POST /billing/payment-methods/:payment_method_id/default`, `GET /billing/referrals/me`, `POST /billing/referrals/claim`, `POST /billing/referral-payouts` (all under `/api/v1`) |
| Removed routes | `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/password/change` (switch off) |

### 50.7 App names from sections 18 to 20

The `app` changes the iteration's `plans/db-changes.md` must carry (details in sections 18 to 20):

| Kind | Names |
|---|---|
| New tables (D68, D69) | `app.segments`, `app.broadcasts`, `app.broadcast_recipients` (monthly parts, kept 90 days), `app.automation_backfills` |
| New tables | `app.meta_connections`, `app.meta_connection_tokens`, `app.automation_counts` (`taps`, `typed_answers`, `runs_by_version`, `taps_by_version`, `typed_by_version`), `app.automation_reply_state`, `app.meta_attachments`, `app.dm_month_counts`, `app.contact_tag_events` (kept 8 days) |
| Removed table | `app.instagram_account_tokens` |
| New columns | `automations.starter_questions` (TEXT[], 1 to 4), `instagram_accounts.starter_questions_set_at`, `automations.target_starts_at`, `automations.target_ends_at`, `automations.public_reply_mention`, `steps.tags`; `instagram_media.live_ended_at`; `meta_connections.status_changed_at`, `last_check_error`, `disconnected_at`; comment log `hide_status`, `hidden_at`; the `messages_*` names of section 18 |
| New columns (D64 to D68) | `instagram_account_settings.trigger_on_comment_replies`, `once_per_person_per_post`, `mark_seen_after_reply`, `extra_delay_seconds_min`, `extra_delay_seconds_max`; contacts `last_comment_at`, `comment_count`, `last_story_activity_at`, `last_broadcast_at`, `came_in_via`, `came_in_ref` (follow state uses meepzo-be's existing `is_following_account` and `follow_checked_at`); `instagram_account_settings.broadcast_hour_limit` (empty = 600, 1 to 2,000); messages `broadcast_id` |
| New columns (D71, D72, alignments) | contacts `automations_off_at`, `automations_off_by_user_id`; messages `owner_retry_at`; runs `last_message_no`; broadcast recipients `replied_at`; `post_key` VARCHAR(255) |
| Removed columns | `automation_runs.trigger_text`; the 5 account public reply columns; the DM keyword switch; the finished-run count |
| New values | message reasons `window_closed`, `live_ended`, `plan_limit`, `answered`, `attachment_failed`, `cancelled_by_owner`, `once_per_post`, `plan_feature_off`; run cancel reasons `expired`, `opted_out`, `window_closed`; comment log ignored reason `once_per_post` (was `previous_run_final`); lane stop reasons `plan_limit`, `plan_ended`, `plan_downgrade` (accounts only: a plan change never sets an automation `stopped_reason`); message reason `opted_out`; run events `hello_tapped`, `follow_tapped`; message type `broadcast`; lane `broadcast`; count group `broadcast`; comment log ignored reasons `thread_reply_off`, `own_comment`, `run_in_progress`; message and run reason `contact_excluded`; recipient reasons `recent_broadcast`, `owner_chat`, `window_closed`, `opted_out`, `contact_excluded`, `broadcast_cancelled`, `plan_feature_off`; Redis note `seenmark:{account}:{contact}` (24 hours); broadcast states `draft`, `scheduled`, `sending`, `waiting_for_chats`, `done`, `cancelled`; backfill states `queued`, `reading`, `done`, `failed` |
| Removed values | event kind `read` |
| Rules | delete reason optional; contact sort indexes per account; the engine reads the plan's `pro_features` at run time and skips PRO parts the plan lacks (D57); "choose active accounts" (account swap under the workspace lock) |

### 50.8 Meta's review: checklist and timing

| Item | What Meta needs |
|---|---|
| Access | Advanced Access per permission, Live mode, business verification |
| First | At least 1 successful call per permission |
| App details | App icon 1024 x 1024, Privacy Policy link, category, business email |
| Recording | One screen recording per permission, English screens with captions |
| Test steps | Step-by-step steps for Meta's reviewer, with a test account |
| Required actions | Meta's "Required actions" (for example Data Use Checkup) done on time, or access stops |
| Permissions now | `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `ads_read`; Advanced Access also for the `live_comments` webhooks |

```text
Day 0      Meta app check + creator test (Standard Access: only people
           with a role on our app). Start business verification
Build      Each Meta feature works end to end on test accounts
           (at least one good call per permission)
Submit     The checklist above, per permission
Approved   Advanced Access -> Live mode -> the first real customers
```

1. No real customer before Advanced Access, Live mode and business verification (D24, section 41).
2. Submit after Track A steps A3, A6 and A7 work on test accounts (connect, comments, DMs, Live comments).
3. Review can take days to a few weeks (estimate). Plan the launch date after it.
4. Permissions for later features (section 49) are not in this review.
5. Broadcasts, past comments and "mark as seen" use the permissions above: no new permission. A broadcast goes only to a person whose chat window is open (Meta's rule, D68).

### 50.9 Tests and close

1. **Tests:** unit, integration with two connections (locks), chaos (Redis down, Postgres restart), the route suites. meepzo-be's own gates (`pnpm ci:local`).
2. **Close** each iteration with meepzo-be's steps: pre-merge review (`/be-pre-merge-review`), acceptance (`plans/acceptance.md`), the frontend route map (`pnpm iteration:frontend-map <iteration>`), `pnpm iteration:status <iteration> done`, then `frozen`.
3. Commit, push and pull request only when you say so.

---

## 51. Review items: where each one is fixed

The review of 23 November 2026 had 45 items (`Plan-Review-23-Nov.md`). All are in this plan.

### 51.1 Must fix (A)

| Item | Problem | Fix | Section |
|---|---|---|---|
| A1 | Settings change could not be deployed | Newer version may start, older refused | 38 |
| A2 | Unique rules broke on month parts of messages | Messages split by the run's start; key includes it | 19, 21 |
| A3 | A small fixed pick of rows hid DMs | One small search per group, paused automations filtered inside | 19, 28, 29 |
| A4 | A new turn during a send left the lane dead | `working_turn`; helper adds a late ticket only if it is really gone | 28, 34 |
| A5 | No lock order, deadlocks | One lock order, retry on deadlock | 35 |
| A6 | No Postgres timeouts, shared webhook pool | `SET LOCAL` limits, role timeout, own webhook pool | 35, 37 |
| A7 | Restore or copy sends again | Environment id, global switch, restore steps | 39 |
| A8 | No disconnect or Meta callbacks | meepzo-be flows + token removed, lanes stopped, Redis clean; waiting DMs expire or go on after reconnect | 15, 41 |
| A9 | Data kept forever, no delete person | 90 days, partitions dropped, contact erase | 15, 21, 41 |
| A10 | Alerts used the failing parts | `/health`, outside checker, second channel | 40 |
| A11 | Failed follow check was a dead end | 2 tries, then "following" | 14, 33 |
| A12 | Code 4 with a subcode stopped all accounts | Only code 4 without subcode, 2 accounts | 33 |
| A13 | Own notices saved before they were dropped | `mid:` check before the save | 26 |

### 51.2 Should fix (B)

| Item | Problem | Fix | Section |
|---|---|---|---|
| B1 | Fast lane could not reach its limit | Parallel fast messages, no gap per account | 11, 30 |
| B2 | Typing instead of tapping did nothing | Any text moves a run that waits for the tap | 14 |
| B3 | "Her answer" not defined; any tap made `unknown` into `sent` | Answer types table; tap proves only its own message | 14, 20 |
| B4 | Email and phone checks | Take the part out, save only when asked, strict check | 14, 41 |
| B5 | Same question twice | "Already asked" rule + meepzo-be's queued automations | 14 |
| B6 | Waiting runs never ended | 7-day wait end | 20 |
| B7 | Stop word not defined | Whole message, cleaned, owner words | 14 |
| B8 | Deleted or fake comments stopped automations | Read the comment first; gone = person problem | 33 |
| B9 | Two lanes tested at once | One test claim per account | 33 |
| B10 | Intake changed a picked opening DM | Close the old row "only if waiting", lock the picked row | 27, 28 |
| B11 | Short Postgres break made results `unknown` | Ticket back; "save result" job | 33, 35 |
| B12 | Taps waited 1 hour; intake jobs never removed | Connection error uses no try; jobs removed; "done only if not done" | 24, 27 |
| B13 | Taps lost when Postgres was down | Redis buffer, answer 200 | 26 |
| B14 | "Instagram down" rule fit only 1,000 accounts | Share of accounts, growing waits | 33 |
| B15 | Everything started together after a stop-all | Steps 15, 30, 60; spread start at half speed | 33 |
| B16 | Missed comment check had blind spots | Full pass after an outage, replies too | 34 |
| B17 | Redis inside the lane lock | Redis never inside a transaction | 31 |
| B18 | Gate 2 read too many rows | Minute counts | 31 |
| B19 | Hot lane rows | Fillfactor 50, no `next_run_at` index | 19 |
| B20 | Nobody made tomorrow's part | Partition worker, parts ahead, alert | 21 |
| B21 | Helper scans unbounded; Cancel touched every row | `HELPER_PASS_LIMIT`; `cancelled_before_at` | 15, 34 |
| B22 | No storage estimate | Storage table | 42 |

### 51.3 Security (C)

| Item | Problem | Fix | Section |
|---|---|---|---|
| C1 | Token rules | Secret store key, header only, never logged | 41 |
| C2 | Owner checks, reconnect id | Row security + same Instagram id | 22, 41 |
| C3 | Full DM text kept | Body cleared when done; ids only in logs | 21, 41 |
| C4 | DM flood went first | Inbound counter per person | 27 |
| C5 | Owner numbers without limits | MIN and MAX for every owner number | 36 |
| C6 | Webhook, Redis, team tools | Webhook rules, Redis password + TLS, suspend + audit | 26, 41 |

### 51.4 Small fixes (D) and tests (E)

| Item | What | Section |
|---|---|---|
| D1 | Settings that move together, start checks, empty owner columns | 36 |
| D2 | Slow start for new accounts, other app controls the chat, text length, disclosure, helper slots | 10, 14, 15, 33, 34 |
| D3 | Old and wrong text | whole plan (rewritten) |
| D4 | Small state gaps (`sending` while a second comment comes, window-closed codes, ask again, public reply after attach) | 20, 27, 28 |
| E | Tests with Meta | 43 |

---

## 52. Decision history

### 52.1 Versions 1 to 6 (22 November 2026)

| Version | What was decided |
|---|---|
| 1 | Your first decisions: 3 common queues, limits per account, only opening DMs count, 600 per hour, new comments first with some old, once per post, 24 hours between opening DMs to one person, window open: no opening DM, public reply after the DM, too old after 3 days, pause saves and sends later, start again by itself, never resend when not sure. 26 fixes. |
| 2 | Random second inside a box for opening DMs. Public replies with their own limit (60, owner 30 to 200), random box, newest first. Fast lane with a random delay and a 2,000 per hour limit. About 5 Postgres calls per DM. |
| 3 | A worker never waits: every wait is a delayed ticket. Fast delay 2 to 6 seconds. |
| 4 | Five fixes: drop a ticket for a working lane, finish sends on restart, webhook check every 10 minutes, 40 fast places, "blocked" on a reply stops only replies. |
| 5 | Fast delay 500 to 2,000 ms. Every number in one settings file. |
| 6 | Redis counts as gate 1, Postgres as gate 2. Day limit OFF. Person limit 30, Postgres only. Built for 1,000 accounts. Multi-server rules. |

### 52.2 Version 7 (23 November 2026)

Your answers after the review, and the move into meepzo-be:

| # | Decision |
|---|---|
| 1 | All 45 review items go in. |
| 2 | Fast lane: each message its own ticket and random delay, many at once per account (at most 20), no gap per account, one person one at a time. Fast limit 10,000 per hour. |
| 3 | Follow check: 2 tries, then treat her as following. |
| 4 | 7 days for the opening DM and the public reply, then `expired`. "Will go / may expire" estimate for the owner. |
| 5 | Built inside meepzo-be, schema `app`. The `app` migrations are changed in place. |
| 6 | Once per automation per post. |
| 7 | Public replies look human: `@username`, random text, random second, gap, about 80%, newest first, at most 500 waiting. |
| 8 | Webhook events kept 8 days. Read receipts and our own notices not saved. |
| 9 | Window open: the opening message goes at once as a normal DM. This replaces "window open: no opening DM". |
| 10 | Runs, run history, comment logs and messages kept 90 days. |
| 11 | Neon's pooler, no PgBouncer of our own. |

### 52.3 Rules that changed up to version 7

| Before | Now |
|---|---|
| Too old after 3 days | 7 days, then `expired` |
| Public reply too old after 24 hours | 7 days after the comment |
| Fast: 1,000 to 3,000 ms gap per account, 2,000 per hour | No gap per account, many at once, 10,000 per hour |
| 10 per hour per person | 30 per hour per person |
| Follow check failed: 1, 5, 15 minutes, then failed | 2 tries, then "following" |
| Window open: no opening DM | Opening message as a normal DM |
| Once per post | Once per automation per post |
| Same settings version on all servers | Newer may start, older refused |
| PgBouncer | Neon's pooler |
| Gate 2 = a count of rows | Gate 2 = minute counts |
| Events kept 3 days (meepzo-be: 30) | 8 days |
| Runs and comment logs kept 180 days (meepzo-be) | 90 days |

### 52.4 Version 8 (23 November 2026)

The Flowdm v4 product (prototype Version 181) is added. The plan now designs its whole backend in meepzo-be. Your answers:

| # | Decision |
|---|---|
| 1 | Flowdm v4 is what we build (D23). Screens belong to meepzo-fe. |
| 2 | Messenger (Facebook Page) later. Tables get a `channel` column now (D27). |
| 3 | "Reply like a person" OFF = no pace: the public reply goes right after the DM, every comment gets one. ON (PRO) = the human style, per automation, 10 to 100 an hour (D32). |
| 4 | All 12 new ways to start are in this version, 15 in all. "Story repost" only if Meta sends it (D37). |
| 5 | Month count = every DM into her chat. Public replies, hides and follow checks do not count. At the limit, DMs wait (D34). (Made exact later the same day: 52.6, C17.) |
| 6 | Unified Login, after a test with 2 creator accounts that have no business portfolio. If they could not connect easily, keep Instagram Login. (Changed later the same day: 52.5, item 1.) |
| 7 | Post scheduling, Facebook Pages and ads publishing later. Each permission is asked when its feature is built (D47). |
| 8 | Page permissions are not in Unified Login. Facebook Pages later = a second login configuration (D27, D47). (Made wider later the same day: 52.5, item 4.) |

Also decided in version 8 (rule sheet D25 to D48): many accounts by plan, draft and go-live, the message list with kinds and waits, hello buttons, versions and nudge, hide comment, Live comments built, starter questions, link or QR, tags and contacts, DMs per month, plan states, and the product around sending (sections 44 to 48).

### 52.5 Version 8, after Meta's docs were read (23 November 2026)

| # | Decision |
|---|---|
| 1 | **Unified Login only.** No Instagram Login, no fallback, no data move: it is a new app with no customers. meepzo-be's Instagram Login code is removed and replaced (section 50.4, A3). Why: Meta says new apps cannot set up Instagram Login; new Instagram API features ship only on Unified Login; ads and Facebook Pages later need it (D24). |
| 2 | Risks accepted: every creator needs a business portfolio; Unified Login has no handover, no login through the Instagram app, no personal-to-professional switch during login; some messaging features are documented only for Instagram Login, so they are tested on Unified Login (section 43). |
| 3 | The creator test no longer decides the login. It shows how hard the business-portfolio step is, so we write a help guide and screens (section 50.2). |
| 4 | All of Meta's Instagram Platform docs were read (about 90 pages; notes in `Meta-Instagram-Platform-Notes.md`). Facebook Page permissions are not in Unified Login's own list: they can be added to our setup later, or go in a second setup (section 49). |
| 5 | A permission added later needs a reconnect and Meta's review (section 49). |
| 6 | Post scheduling, Facebook Pages and ads publishing stay later (section 49). |

### 52.6 User answers on the open items (23 November 2026)

| # | Answer |
|---|---|
| C1 (D49) | Stop word: no automatic message after it. She starts again only by her own new action that matches a keyword comment, keyword DM, starter question tap or ig.me link. The owner cannot restart her. |
| C2 (D50) | Messages kept 30 days. Runs, run events and comment logs stay 90 days. |
| C3 (D51) | No contact clean-up by age. Contacts stay until the owner deletes them, Meta asks, or the workspace is deleted. |
| C4 (D52) | "Reply like a person" ON needs at least 3 reply lines. OFF: 1 is enough. Free: OFF only. |
| C5 (D53) | Referral: minimum payout $50; less rolls over. Still open: how money is paid, and for how long a friend earns. |
| C6 | Plan prices: Flowdm's samples stay as placeholders. Final prices and Stripe products still open. |
| C7 (D54) | Email on by default for every kind except "new contact left details". Security and billing emails cannot be turned off. Push and AI later. |
| C8 (D55) | Editors may delete automations. |
| C9 (D55) | Unlimited members and all 4 roles on every plan. `team_roles` removed. No seat limit. |
| C10 (D56) | A trusted device skips the 2FA code only in a workspace that does not require 2FA. |
| C11 (D57) | Moving down a plan is allowed at the period end; the owner picks what stays; the rest gets `plan_downgrade`. A cancelled plan ends at the period end with `plan_ended`; grace only after a failed payment. |
| C11, follow-up (D57; replaced by follow-up 2) | Yes: an automation stopped `plan_downgrade` for a missing PRO feature also comes back when the owner turns off every PRO step or option the plan lacks and saves (the full check must pass); a not-kept automation comes back when the owner switches it on and the go-live checks pass. Moving up still clears every stop. Accounts clear only by moving up. |
| C11, follow-up 2 (D57): PRO parts off, account swap | Moving down never stops an automation: at the period end the PRO parts the new plan lacks are switched off by the plan (email and phone skipped, "Reply like a person" as OFF, first reply line only, version A only), nothing is deleted, and they work again after a move up. A notice and an email go once. Turning a PRO step on still needs PRO. `stopped_reason` `plan_downgrade` for automations is removed. Accounts over the limit get lane stop `plan_downgrade`; the owner may swap active accounts at any time inside the app ("choose active accounts"); a disconnect starts no stopped account by itself. A disconnect keeps automations, contacts and history; only Meta's data deletion or deleting the workspace erases the data. |
| C12 (D58) | The upload domain scans every file; a file not scanned clean cannot be used in a message. |
| C13 (D59) | "Reply like a person" ON by default on paid plans. Free: OFF only; the flag risk is accepted; no hour cap for OFF. |
| C14 | The Meta app setup (old login product, business verification, Unified Login configuration, Meta's review) is the owner's task. |
| C15 (D60) | Close spellings also inside keywords of several words; words under 5 letters exact; same words, same order. |
| C16 (D61) | "% tapped" = (taps on the hello + typed answers to the hello) / runs started. |
| C17 (D62) | Month limit reached: only new DMs stop (`slow` and `fast` lanes). Public replies and hides of DMs that already went still go. |
| C18 | Confirmed: "first message" only when nothing else catches her first DM; a comment-kind automation with no hello, follow, email or phone sends 1 text message; the owner's quiet time is per contact. |
| C19 | Reacting to her message (a heart): later (section 49). |
| C20 (D63) | `@username` in public replies: per automation, on by default. |
| C21 | All tests stay (section 43). |
| C22 | Open items left: referral payout method and how long a friend earns; final plan prices and Stripe products; AI. Numbers Claude picked stay as written in section 36. |

### 52.7 New features: settings, broadcasts, past comments, later list (23 November 2026)

Claude's design, approved by you:

| # | Decision |
|---|---|
| D64 | Account setting: replies under comments may start comment automations (on by default). The account's own comments never start anything. |
| D65 | Account setting: once per person per post (on by default). Off = "every time": each new comment or keyword DM starts a new run; Meta's and our safety rules still hold. |
| D66 | Account setting: "mark as seen" after our message is sent (off by default). Not a DM, not counted. |
| D67 | Account setting (PRO): "Delay before each message", 1 to 20 seconds; the whole answer stays under 25 seconds. |
| D68 | Broadcasts (PRO): audiences with conditions, only to people whose chat is open; now, at a set time, or when her chat opens; a 4th lane `broadcast`, 600 an hour by default; they count as DMs. |
| D69 | Run on past comments (PRO): answer comments of the last 1 to 7 days after go-live, as "old" comments in the slow lane. |
| D70 | Later list: booking with Google Calendar, link tracking, AI FAQ, forms, integrations through meepzo-be's outgoing webhooks, ads sync, and 12 ideas (section 49). |

### 52.8 Alignments, exclude, retry failed, trial, InstantDM later list (23 November 2026)

Claude's design, approved by you:

| # | Decision |
|---|---|
| Alignments | "Every time" mode ignores a new comment while her run of that automation on that post is open (`run_in_progress`). "Got message N" reads `last_message_no` on the run. Once keys in "every time" mode use the event's own id. A cancelled broadcast skips its waiting recipients (`broadcast_cancelled`). The extra delay is added once, to the first answer after her event. Broadcasts and past comments end `plan_feature_off` after a move down. They reuse the automation permission codes. A 7th notification kind for them. Exact names for the new settings and columns. |
| D71 | Exclude a contact: "Pause automations for this person". The owner's choice, which the owner can undo; different from her stop word. |
| D72 | Retry failed messages: only `failed` messages of the last 30 days that are still allowed now; each at most once. |
| D73 | 7-day trial of Creator or Studio with no card, once per workspace and once per Instagram account. No payment at the end: the workspace moves to Free by the moving-down rule. |
| Later | The 10 InstantDM features (`Instagram-DM-Later-Features-v8.md` section 5). |
| Two small points (Claude) | "Every time" mode keeps one open run per automation and person for every start, DMs too (`run_in_progress`). A broadcast recipient `skipped` (`owner_chat`) does not use up the broadcast: her next message after the quiet time puts the same row back to `waiting` while the broadcast is active. |

### 52.9 Rules that changed in version 8

| Before (version 7 or meepzo-be) | Now |
|---|---|
| One Instagram account per workspace | 1, 3 or 10 by plan |
| Instagram Login, 60-day token renewed daily | Unified Login only: token that never expires, daily check; the Instagram Login code removed |
| The creator test decides the login | The creator test shapes the help guide and connect screens |
| One `final_message` | A list of 1 to 10 messages, 7 kinds, waits |
| Opening message: 1 button, 1,000 letters | Hello: 640 letters, up to 3 buttons, versions, nudge |
| Public replies per account, 60 an hour (owner 30 to 200) | Per automation: OFF (right after the DM) or ON (PRO, 10 to 100) |
| Live comments left for later | Built: fast private replies while the Live is on |
| 3 ways to start | 15 |
| `is_dm_keyword_trigger_enabled` TRUE for every automation | "Also start from", empty by default |
| Automation `live` or `inactive`; every save complete | `draft`, `live`, `paused`; full check at go-live |
| Automation name used as a tag | Removed |
| Passwords on | No passwords |
| Owner, Admin, Member, custom roles | Owner, Admin, Editor, Viewer; no custom roles |
| Free, Starter, Growth, Pro; Free read only after 14 days | Free, Creator, Studio; Free never ends |
| Plan ended: live automations keep sending | Plan ended: sending stops |
| No month limit | DMs per month by plan |
| Person limit 30 per hour | 60 per hour (one long run can need about 24 to 30 calls) |
| Messages kept 90 days | 30 days (runs, run events, comment logs: 90 days) |
| Seats per plan; Member could not delete automations | Unlimited members, all 4 roles on every plan; Editors may delete automations |
| One global `@username` setting | Per automation `public_reply_mention`, on by default |
| Once per automation per post, always | An account switch: once per person per post (default) or every time |
| 3 lanes per account | 4 lanes: `slow`, `reply`, `fast`, `broadcast` |
| A 14-day read-only trial for a new team (meepzo-be) | A 7-day trial of a paid plan with no card; then Free |

---

## 53. Open items

### 53.1 Your answer is needed

All other open items are answered (section 52.6).

1. **Referral payouts:** how is money paid (bank, PayPal, Stripe Connect, or credit on their own bill)? Does a friend earn for the referrer for ever, or for 12 months? (The $50 minimum is decided, section 48.4.)
2. **Plan prices:** Flowdm's are placeholders ($29 or $23 yearly; $79 or $63 yearly). Final prices and Stripe products?
3. **AI (later):** which AI service, and may her message text be sent to it for same-meaning keywords and the AI FAQ (`Instagram-DM-Later-Features-v8.md` section 4)?

### 53.2 To test (section 43)

Full list and steps in section 43. In short:

1. The "already sent" error code.
2. A private reply with a button (Meta's example shows text only).
3. Follow check right after a button tap: does the tap count as consent?
4. `@username` in a public reply.
5. Comment person id vs DM person id.
6. Comment time: is `entry.time` close enough, also on retries?
7. The Meta app limit for 1,000 accounts (ask Meta).
8. Neon pooler and connection-level timeouts.
9. The creator test: how hard is the business-portfolio step (section 50.2)?
10. On Unified Login: quick replies, product cards, button template, starter questions, user profile, typing dots, attachment upload.
11. `caption` and `media_product_type` on posts; `GET /stories`.
12. Story repost: does Meta send anything? Ad comments with our setup: do they reach the `comments` webhook (also on dark ads), and can we reply and hide?
13. A ref on a brand-new chat: are starter questions needed? The link format: `ig.me/<username>` or `ig.me/m/<username>`? The window after a click-to-message ad: 24 hours or 7 days?
14. Live: the Live rules (Meta's Live pages did not load), and Live comment webhooks with Advanced Access.
15. Tests for later features: `Instagram-DM-Later-Features-v8.md` section 9.
16. Account settings and broadcasts: a reply comment's webhook has `parent_id`; a private reply to a reply comment works; `mark_seen` on Unified Login; reading comments for "run on past comments" (speed, limits); a broadcast inside her window from our app (a normal send).

### 53.3 To check when building (not Meta)

1. Apple: does it accept PKCE (section 44.4)?
2. Apple: register our sending domain for relay emails (section 44.4).
3. The IP-to-place file: licence and monthly updates (section 47.5).
4. Stripe trial with no card: the subscription settings for "card only if required" and "cancel at the trial end with no card", and the webhook events our handler reads (section 46.9).

### 53.4 Left for later

Later features and later engine items are in `Instagram-DM-Later-Features-v8.md` (pointer: section 49).
