# Instagram DM System: Simple Guide (version 8)

**For:** the owner, and every developer who joins later.
**Based on:** `Instagram-DM-Sending-Plan-v8.md`, version 8, 23 November 2026. That plan is the full truth with every detail. This guide is the short, simple version. If they ever disagree, the plan wins.
**Status:** plan only. Nothing is built yet. It will be built inside meepzo-be. The product is Flowdm (its screens are in meepzo-fe). All speed and size numbers are estimates; nothing was load-tested.

"(plan section 27)" means: read section 27 of the plan for every detail.

---

## Part 1. The idea in 10 lines

1. Someone does one of 15 things on Instagram: comments "GUIDE", sends a DM, replies to a story, taps a starter question, opens a link ...
2. Meta tells our server (webhook).
3. We **save it first** in Postgres. Then intake decides which **one** automation answers.
4. Every message waits as a row in Postgres with status `waiting`.
5. Redis holds only small **tickets**: "go and look at this lane" or "send this message".
6. Workers take a ticket, send **one message**, then take the next ticket. A worker never waits.
7. Each Instagram account has its own **4 lanes** (slow, reply, fast, broadcast) and its own **limits**. Each workspace has a **DM limit per month** from its plan.
8. All accounts send at the same time, through **3 common sending queues**.
9. If Instagram gives an error, **only that account's lane** (or lanes) stops. Others go on.
10. If we are not sure a DM arrived, we **never send it again by ourselves**.

---

## Part 2. What is new in version 8

1. **Flowdm v4 is the product.** The plan designs its whole backend in meepzo-be.
2. **Unified Login only.** No Instagram Login. Its code is removed. Nothing is migrated (Part 6).
3. **Many accounts per workspace:** Free 1, Creator 3, Studio 10.
4. **15 ways to start** (was 3), with one fixed match order (Part 7).
5. **Draft, live, paused**, and a full check at "Go live" (Part 8).
6. **Hello with buttons and versions**, a **nudge**, and a **message list** of 1 to 10 messages in 7 kinds (Part 9).
7. **Tags** (a step, a list, and a way to start) and **hide their comment**.
8. **Public replies per automation:** "Reply like a person" ON or OFF (Part 17).
9. **DMs per month** by plan. At the limit only new DMs stop (Part 19).
10. **Stop word:** she starts again only by her own new keyword action (Part 18).
11. **Live comments** are built. **Counters** "1.3k runs · 51% tapped".
12. **4 account settings:** replies under comments, "once per post" or "every time", mark as seen, and a delay before each message (PRO) (Part 10).
13. **Broadcasts** (PRO): messages to people picked by conditions, only while their chat is open. A **4th lane**, `broadcast` (Part 15).
14. **Run on past comments** (PRO): a comment automation also answers comments from the last 1 to 7 days (Part 13).
15. **Pause automations for one person** (the owner's choice) and **retry failed messages** (Parts 18 and 22).
16. **7-day free trial** of Creator and Studio, no card (Part 21).
17. **The product around sending:** sign-in without passwords, roles, plans, settings, notices, refer (Part 25).
18. **Later features** moved to their own file, `Instagram-DM-Later-Features-v8.md` (Part 26).
19. Changed numbers: person limit **60** per hour (was 30). Messages kept **30 days** (was 90).

---

## Part 3. One real-life example: Swiggy

| Swiggy | Our system |
|---|---|
| Restaurant | One Instagram account |
| Restaurant company (1 to 10 outlets) | One workspace (1, 3 or 10 accounts by plan) |
| Customer order | A comment, a tap, a DM, a story reply ... |
| Swiggy's order record | Postgres (the truth) |
| "Parcel ready" alert on a board | A ticket in a queue (Redis) |
| Order desk person | Intake worker |
| Normal rider / express rider | Slow worker / fast worker |
| Pickup windows of one restaurant | The 4 lanes of one account |
| Supervisor who walks around | Helper |
| Kitchen speed | Account limit (1 opening DM every 6 seconds at 600 per hour) |
| Monthly order quota in the contract | DMs per month of the plan |
| A flyer for regulars who are in the shop right now | A broadcast (only to people whose chat is open) |

**Riders are common for all restaurants.** Our queues and workers are common for all accounts. But each account has **its own** lanes.

---

## Part 4. Words you must know

| Word | Simple meaning |
|---|---|
| Postgres | Main database (on Neon). It keeps the truth. |
| Redis | Fast memory: queues, tickets, quick counts, copies. Can be rebuilt from Postgres. |
| Ticket, delayed ticket | A small note in a queue (only ids). A delayed one wakes at a set time, like an alarm. |
| Worker, place | A program that takes a ticket and does one job. A place = one job at the same moment on one server (not a DM limit). |
| Lane | One sending line of one account: `slow`, `reply`, `fast` or `broadcast`. |
| Gate | "Is there room under the limit?" Gate 1 = Redis (fast). Gate 2 = Postgres (exact). |
| Workspace | A team (meepzo-be organization). Owns accounts, members and a plan. |
| Automation, way to start | One set-up that answers for one account; what starts it (`trigger_type`, 15 kinds). |
| Run | One automation working for one person. |
| Contact | One person who talked to one account. Riya on A and on B = 2 contacts. |
| Hello, version, nudge | The first message (with buttons); one of up to 3 texts picked at random; the hello again after 1 hour. |
| Message list | The 1 to 10 messages of "Send your messages", each with a wait. |
| Once key | `post_key` on the run. One run per automation, person and key. |
| Private reply | An opening DM sent as an answer to her comment. One per comment, up to 7 days. |
| Public reply | Our reply under her comment, visible to all. |
| Chat window | Her last message or tap + 24 hours. A comment does NOT open it. |
| PRO | Only on the paid plans Creator and Studio. |
| Broadcast, segment | A message the owner sends to many contacts of one account (PRO); the saved conditions that pick them. |
| Past comments run | A one-time read so a comment automation also answers comments of the last 1 to 7 days (PRO). |
| Unified Login | Meta's login for businesses. The only login we use. |
| Business portfolio | Meta's folder of one business: its Instagram accounts, Pages, ad accounts. |
| System user token | The key Unified Login gives. Belongs to her business portfolio. Never expires by default. |

---

## Part 5. The whole system in one picture

```text
 Owner: "Connect Instagram" (Unified Login) --> accounts, token, 6 webhook fields
 Owner: a broadcast to an audience (PRO) --> recipients --> lane 3d below

 Instagram: comment, Live comment, DM, story reply, mention, shared post,
 tap, starter question, link, ad, reaction
        |
        v
 1. WEBHOOK: check signature, drop repeats, save in Postgres FIRST, answer 200
        |                 tag added or removed (inside meepzo-be)
        v                         |
 2. QUEUE `instagram-webhook` <---+
    INTAKE: match order, once key, makes the run and its `waiting`
    messages. Sends nothing.
        |
        +-----------------+-----------------+-----------------+
        v                 v                 v                 v
   3a. slow lane     3b. reply lane    3c. fast          3d. broadcast
   opening DMs as    public replies    one ticket per    owner's broadcasts,
   private replies   and hides         message, many     open chats only
   (slow queue)      (slow queue)      (fast queue)      (slow queue, PRO)
        +-----------------+-----------------+-----------------+
                             v
 4. WORKER: pause, stops, plan, window, age; gate 1 (Redis);
    ONE commit: gate 2 + month count + status `sending`
                             v
 5. ONE call to Meta (max 15 s, no database transaction open)
                             v
 6. SAVE RESULT (sent, unknown, failed, skipped ...) and make the next
    message: public reply, hide, next step, next list message, nudge

 HELPER (every minute): repairs lost tickets, dead workers, expired
 messages, missed comments. It never sends a DM.
 QUEUE `instagram-tasks`: account set-up, starter questions, file uploads,
 token check, bulk tags, month wake, plan change, audiences, past comments,
 retry failed. None of these jobs sends a DM itself.
```

**Where it lives:** the sending engine is a new sub-domain `src/domains/app/sub-domains/instagram-sending/`; login is a new `meta-connection` sub-domain (names to confirm). Every number is in `src/shared/config/instagram-sending.config.ts`. The `app` migrations are changed in place (not in `main` yet). Other domains (auth, tenancy, billing, user, notify, upload, audit) get **new** migrations only (plan section 3.1).

---

## Part 6. Meta login: Unified Login only

```text
 Owner presses "Connect Instagram" in workspace W
   -> Meta's page: she logs in with Instagram OR Facebook
   -> picks a business portfolio -> picks Instagram accounts
   -> ad account step (may skip) -> permissions
   -> back to us with a code -> server swaps it for a system user token
   -> owner ticks accounts (up to the plan's limit: 1, 3 or 10)
   -> ONE commit: account rows + 4 lane rows each
   -> one `account-setup` job per account: subscribe 6 webhook fields
```

1. **No Instagram Login.** Meta says new apps cannot set it up, and new features ship only on Unified Login. Its code, token table, renewal worker and secret are removed. **Nothing is migrated:** a new app, no customers.
2. **A business portfolio is needed.** No Facebook Page.
3. **One token per Meta connection** covers all accounts shared from that portfolio. Kept only encrypted (`app.meta_connection_tokens`).
4. **The token never expires** by default. We do not renew it. A `token-check` job checks it once a day.
5. It stops working only when our app is removed from her portfolio, or the account moves to another portfolio. Then: `error`, lanes stop, "Reconnect" banner and email.
6. **Reconnect:** the same flow. Same portfolio = same connection row, new token. Only the same Instagram id gets its old row back.
7. **Disconnect:** account `revoked`, lanes stop. Automations, contacts and history **stay**. Waiting DMs expire by the 7-day rule, or go on after a reconnect. Only Meta's data deletion, or deleting the workspace, erases data.
8. **Gaps we accept:** no handover to another app, no login through the Instagram app, no personal-to-professional switch during login. Help screens explain. The account must be **public** (else no comment webhooks) and have **"Allow access to messages"** ON.
9. **Permissions now:** `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `ads_read`. **Webhook fields:** `comments`, `live_comments`, `messages`, `messaging_postbacks`, `messaging_referral`, `message_reactions`. Before real customers: App Review, Live mode, business verification (Part 27).

---

## Part 7. The 15 ways to start, and the match order

| # | Way (`trigger_type`) | What Riya does (account A) | First message goes | Once key |
|---|---|---|---|---|
| 1 | Post or reel comment (`comment`) | Comments "GUIDE" under a reel | Slow lane private reply (window open: fast DM) | media id |
| 2 | Live comment (`live_comment`) | Comments "LINK" during a Live | Fast lane private reply, only while live | `live:<media id>` |
| 3 | Story reply (`story_reply`) | Replies "price?" to a story | Fast | `story:<story id>` |
| 4 | Story mention (`story_mention`) | Mentions @A in her story | Fast | `mention:<story id>` |
| 5 | Story repost (`story_repost`) | Reposts A's story | Waiting on Meta (test) | — |
| 6 | DM keyword (`dm_keyword`) | DMs "PRICE" | Fast | `dm:<date>` |
| 7 | First message (`first_message`) | Writes "hi" for the first time | Fast | `first` |
| 8 | Your post sent to you (`shared_post`) | Shares A's own reel back to A | Fast | `share:<media id>` |
| 9 | Starter question (`starter_question`) | Taps "How do I join?" | Fast | `starter:<date>` |
| 10 | Link or QR (`ref_link`) | Scans A's QR code | Fast | `ref:<date>` |
| 11 | No other automation answered (`default_reply`) | "ship to Pune?", nothing matches | Fast | `default:<date>` |
| 12 | Ad comment (`ad_comment`) | Comments "INFO" under an ad | Like a post comment: slow lane private reply (window open: fast DM) | media id |
| 13 | Ad "Send message" (`ad_message`) | Taps "Send message" on an ad | Fast | `ad:<ad id>` |
| 14 | Tag added (`tag_added`) | Tag "vip" is added to her | Fast, only if her window is open | `tag:<tag>:<event id>` |
| 15 | Tag removed (`tag_removed`) | Tag "waitlist" is removed | Fast, only if her window is open | `untag:<tag>:<event id>` |

1. `<date>` = the day in the workspace's time zone. So a DM keyword, starter question or link answers her once per automation per day.
2. "No other automation answered": "once a day per person" (default) or "every time".
3. **Not offered:** "They follow you" (Meta sends no webhook). **Need a test first:** story repost (built only if Meta sends it) and ad comment (offered after the test passes).

**Match order.** One message can fit many automations. **Only one answers.** Intake stops at the first match (plan section 4.3):

```text
 One event from Riya to account A (DM, story reply, mention, shared post,
 tap, starter question, link, ad message)
    |
 1. Does one of her runs wait for this? (tap, answer, any text) --yes--> move it
    | no
 2. Exact source: starter question, link ref, ad id ------------yes--> it starts
    | no
 3. Keyword or kind: DM keyword, story reply, mention, shared
    post, "also start from" ------------------------------------yes--> it starts
    | no
 4. Her first ever DM to A, and a live "first message"? --------yes--> it starts
    | no
 5. A live "no other automation answered"? ---------------------yes--> it starts
    | no
 Nothing starts. Her message time is still saved (her window).
```

1. Inside one level: one post or one story beats "any"; an automation's own way beats "also start from"; then the oldest.
2. **A match stopped by its once key still ends the search.** Riya sends "PRICE" twice on Monday: the second time nothing is sent.
3. Reactions, read receipts, edits and our own echoes never start anything. A photo or sticker can start only levels 4 and 5.
4. Level 5 stays quiet for 6 hours after the owner typed to her by hand (`OWNER_CHAT_QUIET_HOURS`). Only for her.
5. At most one live "first message" and one live "no other automation answered" per account.
6. Examples: "GUIDE" as her first DM, with GUIDE (keyword) and WELCOME (first message) live: **GUIDE** answers (level 3 before 4). "hi" as her first DM: **WELCOME**. "yes" while her GUIDE run waits for a tap: her **run moves on** (level 1).

**Comments** (ways 1, 2, 12) use meepzo-be's rule: post-linked automations first (one post, my next post, posts between, the ad), else "any post"; the oldest wins; others are logged `ignored`. An automation with no words answers every comment. Replies under comments and the account's own comments: Part 10.

---

## Part 8. Automation status and the go-live check

```text
            Save draft (needs only a name)
  (new) ----------------------------------> draft
                                              |  Go live (full check)
  Duplicate --> new draft "(copy)"            v
                                            live <-----------+
                         Pause: Keep / Cancel |              | Go live
                                              v              | (full check)
                                            paused ----------+
  Delete (any status): stops at once. Contacts stay.
  Automatic stop (refused text 5 times, post deleted): stays `live` with
  `stopped_reason` and sends nothing until the owner fixes it.
```

1. **Pause + Keep:** people in the middle finish. **Pause + Cancel:** its waiting messages become `cancelled`.
2. A waiting message reads its text when sent, so an edit reaches it. A message whose step was removed: `cancelled`.
3. **Go live (and every save of a live or paused automation) is refused when:** no name; account not connected; plan ended; month limit reached; a PRO step turned on without PRO; the way to start is not complete; a DM keyword has no word; over 4 starter questions on the account; link name empty, over 64 or used; a second live "first message" or catch-all; the hello has no "sends your next step" button; a comment automation with no hello, follow, email or phone has more than 1 message or a non-text one; a message is broken, a wait over 23 hours, or a file not scanned clean; reply ON with no line, or "Reply like a person" ON with under 3 lines; tag step with no tag. **Only warnings:** two live automations share a word; the account is private.

---

## Part 9. The steps of an automation

```text
 Event matched, once key new
    v
 Hello (`opening_message`)
    |  comment / ad comment, window closed: private reply, slow lane
    |  Live comment: private reply, fast lane, only while live
    |  all others (and window open): normal DM, fast lane
    +--> comment and ad comment, after the DM went:
    |       public reply (if ON), then hide (if ON)
    v
 Wait for her tap ("sends your next step") or any text
    |  she messaged first and no tap in 60 min: nudge, once
    v
 Follow check --> not following: follow ask --> wait for "I'm following"
    v
 Email question (PRO) --> wait for a valid email
    v
 Phone question (PRO) --> wait for a valid phone
    v
 Message 1 --wait--> message 2 --wait--> ... N   (window check before each)
    v
 Tags added. Run `completed`.
```

A step that is off or not needed (she follows, we have her email) is skipped. Replies and hides never hold back the DM steps.

**Say hello first** (plan section 5.6):

1. Text 1 to 640 characters. `{name}` puts in her name (or her username).
2. 1 to 3 buttons, title up to 20 characters. Each "opens a link" (`https://`) or "sends your next step". At least one "sends your next step" is needed: a link button sends us no tap.
3. 1 to 3 **versions**. One is picked at random per run and saved. Versions 2 and 3 are PRO.

**Nudge** (plan section 8.8):

1. Only when **she messaged first** (story reply, mention, DM, first message, shared post, starter question, link, ad message, tag start). Never for comments or Live comments.
2. 60 minutes after the hello was sent (`NUDGE_AFTER_MINUTES` 60), the same hello (same version) goes **once** more. 1 DM.
3. Her tap or any message before that cancels it (`answered`). A heart does not. Window closed then: `skipped`.

**Follow, email, phone:**

1. Follow ask: text + "Visit profile" + "I'm following". 1 to 3 versions. The follow check makes **2 tries**; both fail = we treat her as following. She is never left with nothing.
2. Email and phone (PRO): 1 to 10 wordings each, one at random, never the same as the last one to her. Phone after email. Never asked if we have it. A wrong answer: asked again at most 3 times.

**Send your messages** (always on, plan section 5.9): 1 to 10 messages. Each has a kind and a wait before it (none, or 1 minute to 23 hours).

| Kind (`message_kind`) | What it is | Meta's limit | DMs |
|---|---|---|---|
| `text` | Text, up to 3 link buttons | 1,000 bytes (640 characters with buttons) | 1 |
| `image` | A picture, text optional | png or jpeg, 8 MB | 1, or 2 with text |
| `cards` | 1 to 10 cards (picture, title, line, link) | title and line 80 characters | 1 |
| `quick_replies` | Text + 1 to 13 choices | 20 characters each | 1 |
| `audio` | A voice note | aac, m4a, wav, mp4; 25 MB | 1 |
| `file` | A PDF | 25 MB | 1 |
| `post` | One of the account's own posts, or "Newest" | own posts only | 1 |

1. **Each call into her chat = 1 DM** in every count. A picture with text = 2 calls, 2 rows, 2 DMs.
2. Message N+1 is made when N is `sent`. It waits as a delayed ticket. Condition: "Always" only (others later).
3. **Window check** before each one. Closed: that message `skipped` (`window_closed`), nothing more is made, run `cancelled`.
4. **Files:** the upload domain scans every file; not clean = not usable. Uploaded to Meta once per account. 3 failed uploads: `failed`, not counted.
5. Emoji and Gujarati letters use 2 to 4 bytes. 1,000 bytes is not 1,000 letters. Cards and quick replies do not show on desktop.

**Tag them:** 0 to 20 tags, added when she finishes. Every tag added or removed writes a row in `app.contact_tag_events` in the same commit, so no tag start is lost. Bulk tags go in pieces of 500. An automation never starts itself by its own tag; a loop stops at chain number 3 and by the person limit.

**Hide their comment:** an option on comment and ad-comment automations (Part 17).

**Also start from** (empty by default): a comment automation may also start from a story reply or a DM; a story reply automation from a DM; a DM keyword automation from a story reply. It uses its own words and the once key of the other place. A comment is never added to the others. Such a start sends no public reply and no hide. **Which post:** any post, my next post, posts between two dates, or one post. Stories: any or one. Ads: one ad.

**Keywords** (plan section 5.5): up to 50, each up to 100 characters.

1. Lower case. Her text **contains** the keyword anywhere: match.
2. Else **close spelling:** a keyword word of 5+ letters matches a word one change away (a letter changed, added or removed, or two letters swapped).
3. **Several words:** all words together and in the same order. Each word of 5+ letters may be one change away. Words under 5 letters must be exact.

| Keyword | She writes | Match? | Why |
|---|---|---|---|
| guide | "GUIDE pls" | Yes | Contains |
| guide | "guied" | Yes | Two letters swapped |
| guide | "glade" | No | Two changes |
| price | "prize" | Yes | One change (a real word can match) |
| cat | "cta" | No | Under 5 letters: exact only |
| free guide | "send the free guied" | Yes | "guied" one change, "free" exact |
| free guide | "fre guide" | No | "free" has 4 letters: exact only |
| free guide | "guide free" | No | Wrong order |

Two live automations sharing a word get a warning. A **"try it"** route shows which word matched and which automation would answer; it sends nothing. "Same meaning" match is later. The owner does not set matching, timing, pace or which version goes: those are in the settings file.

---

## Part 10. Account settings

Four settings per Instagram account (not per automation), in `app.instagram_account_settings` (plan section 5.15). A change counts for new events only. Every change goes to the audit log.

| Setting | Default | PRO | What it does |
|---|---|---|---|
| Replies under comments start automations (`trigger_on_comment_replies`) | ON | No | ON: a reply under another comment can start comment automations. OFF: it starts nothing (`thread_reply_off`) |
| Once per person per post (`once_per_person_per_post`) | ON | No | ON: the once rule. OFF ("every time"): each new comment or keyword DM can start a new run |
| Mark as seen after our reply (`mark_seen_after_reply`) | OFF | No | She sees "Seen" after our answer. Not a DM, not counted |
| Delay before each message (`extra_delay_seconds_min`, `extra_delay_seconds_max`) | Off | Yes | An extra random 1 to 20 seconds before our first answer to her |

**Replies under comments** (plan section 7.6): a comment **written by the account itself** never starts anything (`own_comment`), whatever the setting, so our own public replies never trigger an automation. A reply under another comment comes with `parent_id`. ON: it works like any comment on that post; our public reply goes under the top-level comment. OFF: `ignored` (`thread_reply_off`).

**"Every time"** (once per person per post OFF, plan section 9.6):

1. Each new comment or keyword DM starts a new run. The once key becomes the event's own id, for example `<media id>:<comment id>` or `dm:<message id>`.
2. **Still one open run per automation and person.** A new start while her run of that automation is still open is `ignored` (`run_in_progress`). After that run ends, the next one starts a new run.
3. Still true: Meta's one private reply per comment; one opening private reply per person per 24 hours while her window is closed; the person limit; "first message" stays once ever; "no other automation answered" keeps its own choice.

Example: account B has "every time". Monday 10:00 Riya comments "PRICE" on post P, taps at 10:02 and gets the list (run `completed`). Tuesday 09:00 she comments "PRICE" on P again: a new run starts. Her window is open until 09:47, so the hello goes as a normal DM at 09:00:01. With the setting ON, nothing would go.

**Mark as seen** (plan section 14.6): after our message to her is `sent`, one "seen" call for her chat. At most once per message she sent. Not when the owner typed to her by hand after her message, and not for a person paused by the owner. A failure is ignored. Test needed on Unified Login.

**Delay before each message** (PRO, plan section 11.6):

1. Min and max, each 1 to 20 seconds. A new random value each time, added to the normal 500 to 2,000 ms.
2. **Once per her event:** only on the first answer after her tap, typed answer, story reply or DM. Never after a follow check, and never for slow-lane private replies, public replies, hides, nudges, list waits or broadcasts.
3. Her whole wait stays at most **25 seconds** (Meta's 30 minus 5 safety). A longer draw is cut. Free: not available. After a move down it is off.

Example (3 to 8 seconds): Riya taps at 10:00:00. Normal delay 1.1 s, extra 5.4 s: her answer goes at 10:00:06.5. Message 2 (no wait) gets only the normal delay.

---

## Part 11. Lanes, message types, queues and workers

**The 4 lanes of one account** (one row each in `app.instagram_send_lanes`):

| Lane | Sends | Speed |
|---|---|---|
| `slow` | Opening DM after a post, reel or ad comment, window closed (private reply) | One at a time, random second in each box, 600 per hour |
| `reply` | Public replies and hides | One at a time |
| `fast` | Everything else: hellos as normal DMs, Live private replies, nudges, follow, questions, message lists | Up to 20 at once, one person at a time, 10,000 per hour |
| `broadcast` | Broadcast messages (PRO), only to open chats | One at a time, random second in each box, 600 per hour (owner 1 to 2,000). Lowest priority |

Lanes let us stop only one account (and only the lane with the problem). A pause changes 4 rows, never thousands of messages.

**Message types** (one row per Instagram call in `app.instagram_messages`; the row keeps no text):

| Type | Lane | Counts as DM |
|---|---|---|
| `opening_message` | `slow` (comment, window closed) or `fast` (all others) | Yes |
| `nudge`, `follow_request`, `email_question`, `invalid_email`, `phone_question` | `fast` | Yes |
| `message` (list, 1 to 10) | `fast` | Yes, each call |
| `follow_check` (only reads) | `fast` | No |
| `public_reply`, `hide_comment` | `reply` | No |
| `broadcast` (1 to 3 per person) | `broadcast` | Yes |
| A "mark seen" call (no message row) | `fast` | No |

**Queues** (common for all accounts; never one per account; we stop a lane, never a queue):

| Queue | Holds | Taken by |
|---|---|---|
| `instagram-webhook` | Intake jobs of saved events and tag events | Intake worker (sends nothing) |
| `instagram-send-slow` | Tickets of the slow, reply and broadcast lanes (broadcast: lowest priority) | Slow worker |
| `instagram-send-fast` | One ticket per fast message | Fast worker |
| `instagram-tasks` | `account-setup`, `starter-questions`, `attachment-upload`, `token-check`, `tag-bulk`, `month-wake`, `plan-change`, `segment-count`, `broadcast-audience`, `past-comments`, `retry-failed` | Task worker (sends no DM) |

1. Intake has three jobs per account: `messages` and `live` (priority 1) and `comments` (priority 5). A person waiting for an answer goes first. A viral account (over 500 waiting comments) drops to priority 10 for comments.
2. A ticket holds **only ids**. The worker reads the message from Postgres at the last moment.
3. **Places per server:** now intake 5, fast 40, slow 40 (slow, reply and broadcast lanes), tasks 2, helper 1. At 1,000 accounts: 20, 100, 50, 5, 1.

**Golden rule: a worker never waits.** No sleep, no timer. Every wait is a delayed ticket.

---

## Part 12. Comment flow, step by step

Riya comments "GUIDE" on post P of account A. Her window is closed.

**Step 1. Webhook (saves only).**

1. Check the signature first. Wrong: 400.
2. Drop read receipts and our own "sent" notices. Account unknown or revoked: answer 200, save nothing. Older than 8 days or seen before: skip.
3. Save the event and its key in Postgres (one short commit, max 3 seconds). Postgres down: Redis `webhook-buffer`.
4. Answer 200 (Meta needs it within 5 seconds). Add the intake job.

**Step 2. Intake (decides, sends nothing).**

1. Lock Riya's contact. Save her if new.
2. Written by the account itself, or a reply under a comment with that setting OFF? `ignored`. Riya paused by the owner? Nothing starts.
3. Find one automation: post-linked first, then "any post", the oldest. (Opted out before? This keyword comment restarts her.)
4. Once key (media id) used for her already? Logged `ignored`. ("Every time": a new key for each comment, but not while her run is open.)
5. Create the run. `runs_started` + 1 in the same commit.
6. Window closed: the hello waits in the **slow lane**. Window open: fast lane.
7. Commit. Then wake the slow lane. Intake never blocks on the month limit or the plan: the send decides.

**Step 3. Slow worker (sends one DM).**

1. Gate 1 (Redis): room under 600? Full: ticket back at the free time.
2. Lock A's slow lane row. Old turn number? Drop the ticket.
3. Paused, stopped, plan stop, test? Act on it.
4. Random second of this box reached? No: ticket back at that second.
5. Pick one message: 4 new : 1 old (3 : 2 when one has under 12 hours left).
6. Check it again: 7 days over, stop word, once rule, automation off, window now open. Got an opening DM in the last 24 hours? It waits until 24 hours are over.
7. **One commit:** gate 2 + month count + `sending` + attempt row + lane `working`.
8. Redis counts + 1. Call Meta once (max 15 s, no transaction open).
9. OK: write the `mid:` note, save the result, add the next ticket. Go to any other account.

**Step 4. After the DM:** the public reply (if ON), then the hide (if ON). The run waits for her tap.

**Step 5. Riya taps (or types any text).** Her window opens for 24 hours. The tap proves the hello arrived (`unknown` becomes `sent`). In the **fast lane**, 500 to 2,000 ms later: follow check, email, phone, then the message list. Last message sent: tags added, run `completed`.

A comment never gets a nudge. A comment automation with no hello, follow, email or phone step may have only **1 text message** (Instagram allows one message until she answers).

---

## Part 13. Run on past comments (PRO)

A live comment or ad-comment automation can also answer comments that came **before** it went live (plan section 7.7). Not for Live comments.

```text
 GUIDE is live. Owner: "Also answer comments from the last 7 days" (1 to 7)
    v
 job `past-comments` (queue `instagram-tasks`), one at a time per account:
 reads each target post's comments, newest first, 50 per page, until older
 than N days (replies only if that setting is ON)
    v
 normal intake as "old" comments: match, once rule, stop words, paused people,
 own comments, already answered
    v
 opening DMs wait in the slow lane ("old" in the 4 new : 1 old mix)
    v
 "Found 340 comments. 290 match. About 250 will go, about 40 may expire."
```

1. Posts read: the automation's target posts. For "any post": the newest 50 posts with comments in those days.
2. Each comment keeps **its own 7-day clock**, so the oldest may expire. The estimate says how many. Her window open: a normal DM in the fast lane, as for any comment.
3. One running past-comments run per automation. A failed read is tried again (1, 5, 15, 60 minutes), then `failed`. The reads count in Meta's non-messaging limit (test needed: speed and limits).
4. After a move down: an unfinished run ends `failed` (`plan_feature_off`). DMs already queued still go.

Example: post P went up 6 days ago with 340 comments. Today GUIDE goes live and the owner presses "last 7 days". 290 match. Riya's comment from 6 days and 20 hours ago has about 3.5 hours left, so it is urgent and goes early in the old line. New comments still go first.

---

## Part 14. Story reply, DM and other message flows

She wrote first, so her window is open. No private reply, no public reply. Everything goes in the fast lane.

```text
 Riya writes to A: story reply, DM, mention, shared post, starter question
 tap, link open, or ad "Send message"
        |
 Webhook saves it. Intake. Her window is open now (24 hours).
        |
 Stop word? ------------------------------------------- yes --> opted out
 Paused by the owner for her? ------------------------- yes --> nothing starts
 A run of hers waits for this? ------------------------ yes --> move that run
 Match order: exact source -> keyword/kind -> first message -> catch-all
        | one automation matched
 Opted out before? Only a keyword DM, starter question or link restarts her
 Once key new? ---------------------------------------- no  --> nothing
        | yes
 Run starts, fast lane, 500 to 2,000 ms:
   hello --> wait for tap (nudge after 60 min) --> follow --> email
   --> phone --> message 1 ... N --> tags --> `completed`
```

1. **Starter questions:** 1 to 4 per automation, at most 4 live per account (Meta). A `starter-questions` job sets them when one goes live, pauses or changes. Not shown on desktop.
2. **Link or QR:** `https://ig.me/m/<username>?ref=<ref_code>`. The ref names the automation. Up to 64 characters, unique per account. Example: A prints `ref=diwali-stall`; Riya scans it at the stall; the DIWALI hello goes.
3. **Ad "Send message":** Meta sends `ad_id`; that ad's automation answers. Her window: 24 hours (7 days only after a test).
4. **Tag starts:** one tag event starts the oldest live automation for that tag, **only if her window is open**. Closed: no run, nothing sent.
5. **Live comments:** a private reply in the fast lane, only while the Live is on. No public reply, no hide. Live ended (or 240 minutes): `expired` (`live_ended`).
6. **A waiting broadcast:** if a "when her chat opens" broadcast matches her, she gets it after her run ends, or soon after her message when no run starts (Part 15).

---

## Part 15. Broadcasts (PRO)

A broadcast is a message the owner sends to many contacts of **one account**. It is not an automation: it has no way to start. Creator and Studio only (plan section 8.10).

**Meta's rule:** a broadcast can go only to a person whose **chat window is open** (she wrote in the last 24 hours, minus 15 minutes). Checked when the audience is built, and again just before each send.

**Who gets it (the audience):** conditions in AND / OR groups (at most 2 levels, at most 20 conditions). A set can be saved as a segment and used again.

| Group | Conditions |
|---|---|
| Tags | Has any, all or none of these tags |
| Automations | Started, finished, still in, or never got automation X; tapped its hello; got message N of X |
| How she came in | First automation, ref link code, starter question, ad, story mention, first message |
| Comments | Commented on post X or any post in the last N days; used keyword Y; at least N comments |
| Activity | Last active in the last N hours or days; first seen in the last N days |
| Details | Has an email, a phone, or neither; follows the account (last follow check) |
| Story activity | Replied to or mentioned a story in the last N days |
| Broadcast history | Did not get a broadcast in the last N days |

1. **Always left out:** opted-out people, people paused by the owner, deleted contacts, and anyone who got a broadcast in the last **24 hours** (a hard cap).
2. Automation conditions use runs (kept 90 days). "Got message N" reads the run's `last_message_no`.
3. **Count preview:** "1,240 match. 310 can get it now (chat open)." Counted again when sending. **Content:** 1 to 3 messages, the same 7 kinds as the message list, `{name}`, versions A/B. A button can "start automation X" for her.

**The 3 modes:**

1. **Send now:** matching people whose chat is open now.
2. **Send at a set time:** the helper starts it then; the audience is built at that time.
3. **When her chat opens:** active 1 to 7 days. A matching person gets it when she writes:

```text
 "New guide", when her chat opens, active Monday 10:00 to Thursday 10:00
    |
 a contact writes to account A. Does she match now? ------- no --> nothing
    | yes (not got it yet, not opted out, no broadcast in 24 h)
 an automation run for her? ------------------------------- yes --> after it ends
    | no run, or it ended
 owner typed to her in the last 6 hours? ------------------ yes --> skipped for now
    | no             (her next message after the quiet time can still get it,
    v               while the broadcast is active)
 broadcast lane, box timing --> `sent` (once per person per broadcast)
```

**Sending (all modes):**

1. A **4th lane** per account, `broadcast`. Its tickets go in the slow queue with the **lowest priority**, so it never slows answers or opening DMs.
2. Box timing like the slow lane: **600 per hour** by default (owner 1 to 2,000). The person whose window closes soonest goes first.
3. Each broadcast message **counts as a DM** in the month count and in the person limit.
4. Chat closed at send time: `skipped` (`window_closed`).
5. Account stops stop this lane too. "Too fast" on a broadcast stops only this lane, for **double** the time. The month limit stops it (`plan_limit`).
6. **Results:** matched, sent, skipped, failed, replies (once per person), taps.
7. **Cancel:** waiting people `skipped`, their waiting messages `cancelled` (`broadcast_cancelled`). Sent ones stay sent.
8. **Who:** Owner, Admin, Editor make and send; Viewer only sees. Every send and cancel goes to the audit log.
9. **After a move down:** scheduled and "when her chat opens" broadcasts end `cancelled` (`plan_feature_off`). Drafts and saved segments stay.

**Examples.** (1) The owner of A sends "Diwali sale" now to tag "vip". 1,240 match; 310 have an open chat. At 600 per hour, one every 6 seconds: about 31 minutes for all (estimate). (2) "New guide" (when her chat opens). Tuesday 14:00 Riya (tag "vip") replies to A's story. Her STORY run ends at 14:01:30. At 14:01:36 she gets "New guide": 1 DM in the month. Wednesday she writes again: nothing (once per broadcast).

---

## Part 16. The chat window, the 7-day rule and the once rule

**Chat window** = her last message or tap + 24 hours - 15 minutes safety.

1. Opened by: her message, tap, story reply, mention, shared post, starter question, link, ad message, reaction. **Never** by a comment, a Live comment or a tag change.
2. **Window closed:** a comment's hello is a private reply (slow lane), one per person per 24 hours (not for Live). Nothing else can go.
3. **Window open:** the hello goes as a normal DM in the fast lane, no 24-hour wait, not in the 600.
4. Checked when the event comes and again just before sending. If it changed, the **same row** moves to the other lane.
5. A hello, follow ask or question whose window closed: `skipped`; the run waits for her next message. (A comment's first message instead goes back to the slow lane as a private reply, if under 7 days.)
6. The waits count from **her** last message, not ours. So waits add up:

```text
 Riya taps at 10:00 (her window open until 09:45 next day)
   Message 1, no wait     -> 10:00:01           sent
   Message 2, wait 23 h   -> 09:00:01 next day  sent (still inside)
   Message 3, wait 2 h    -> 11:00:01 next day  skipped (closed at 09:45)
                                                 run `cancelled` (window_closed)
 If she writes "thanks!" at 20:00 the first day, her window ends 19:45
 next day, and message 3 goes.
```

**7-day rule:**

1. A private reply, a public reply and a hide can go up to **7 days after the comment, minus 30 minutes**. Then `expired`. Never sent.
2. Comment time = Meta's `entry.time`. If the event arrives over 1 hour late, we read the real comment time once.
3. A run waiting for her answer waits at most 7 days, then `cancelled`.
4. A stop (blocked, month limit, plan ended) never makes a message live longer.

**Once rule: once per automation per post** (one run per automation, person and once key):

| She does | Result |
|---|---|
| Comments on post 1 ("any post" automation) | DM |
| Comments on post 2 | DM again (another post) |
| Comments on post 1 again | Nothing |
| Same DM keyword, starter question or link, same day | Nothing. Next day: again |
| Replies to the same story, or same ad again | Nothing |
| Writes again after "first message" | Nothing ever |
| Tag added again later | Again (each tag event) |
| Same post, after the old run is deleted | DM again. The old run is deleted about 90 days after it ended (approximate). Not for "first message": that is once ever |

**Two automations on one post** (GUIDE and PRICE): they share **one opening message**; her **one tap** moves both; follow, email and phone are asked once; then both lists go, one message at a time to her. One comment with both words starts only one. An `unknown` message counts as sent.

**"Every time"** (an account setting): each new comment or keyword DM can start a new run, but only one open run per automation and person (Part 10).

---

## Part 17. Public replies and hiding comments

"Reply under their comment" is a step of comment and ad-comment automations, ON or OFF per automation. Never on a Live comment.

| | "Reply like a person" OFF | "Reply like a person" ON (PRO) |
|---|---|---|
| Who | Every plan. **The only choice on Free** | Creator and Studio. **ON by default** for new automations |
| When | Right after the DM went | Random second in the automation's box |
| Which comments | Every comment whose DM went | About 80% |
| Hour limit | None, no pace. Replies follow every DM that went, so more than 600 an hour is possible (estimate) | 10, 20, 30, 60 or 100 (default 60) |
| Gap | None | At least 20 s after the account's last ON reply |
| Order when many wait | Oldest first | Newest first, at most 500 waiting |
| Lines | At least 1 | **At least 3** |

1. **Only after the DM went** (`sent`). An `unknown` DM makes no reply.
2. **`@username` first** when the automation's `public_reply_mention` is on (default). Off: the line alone.
3. One of the lines at random, never the same as the last. Up to 20 lines of 300 characters. More than 1 line is PRO.
4. One reply per comment, up to 7 days. No reply to a deleted, hidden or Live comment.
5. Own lane: a reply never delays a DM. "Too fast" on a reply stops only the reply lane.
6. Meta's usage header at 80%: ON boxes 2 times bigger. At 95%: replies and hides wait.
7. On Free every comment whose DM went gets a reply with no pace. Opening DMs go through both the slow lane and the fast lane (window open), so OFF replies can be more than 600 an hour (estimate). The risk that Meta flags such an account is accepted.

```text
 OFF: 10:00:00 Riya comments "GUIDE". DM 10:00:04. Reply 10:00:05:
      "@riya Check your inbox"
 ON, 60/h: 10:00:00 comment "PRICE". DM 10:00:04. Draw says "reply".
      Box 10:00:00-10:01:00, last ON reply 09:59:55 -> earliest 10:00:15.
      Random second 10:00:37: "@riya Check your inbox"
```

**Hide their comment** (off by default):

1. **Public reply first, then hide.** A hidden comment cannot get a reply. No reply (step off, or the draw said no): hide right after the DM.
2. Reply lane, type `hide_comment`, no box, no gap.
3. **Not a DM.** Not counted anywhere. A failed hide never stops the DM or the reply.
4. Example (reply ON, like a person OFF, hide ON): comment 10:00:00, private reply 10:00:04, public reply 10:00:05, hidden 10:00:06.

---

## Part 18. Her answers, stop words and pausing one person

| She sends | What it does |
|---|---|
| Text | An answer. Counts like a tap for a run waiting for the hello button. Cancels a nudge |
| Button tap | Moves only the run and step in its payload. Proves only that message arrived |
| Quick reply of ours | Her choice is saved. Moves a run waiting for `any` |
| Link button tap | Meta sends us nothing |
| Heart, photo, sticker | Refreshes her window. Never an answer, never a wrong answer |
| Owner typed by hand | No automatic "ask again" and no catch-all to her for 6 hours |

**Email and phone:** we take the first email-like or phone-like part ("my email is Riya@Gmail.com" gives `riya@gmail.com`). Saved **only when a run of hers waits for it**. Email: strict check, a dot after `@`. Phone: 10 to 15 digits, optional `+`.

**Ask once:** never ask again for what we have or what already waits. GUIDE and PRICE both need her email: one question, her one answer moves both.

**Stop words** (plan section 14.4):

1. Her **whole** message is cleaned (spaces, case, punctuation, emoji). Exactly a stop word: she opted out. Default: "stop", "unsubscribe". The owner can add words, for example "band karo". "Stop!" counts; "nonstop.riya@gmail.com" does not.
2. Opted out: nothing automatic goes to her on that account. Waiting messages `skipped`, open runs `cancelled`.
3. **She starts again only by her own new action** that matches a live automation: a **keyword comment** (post, reel, Live or ad), a **keyword DM**, a **starter question** tap or an **ig.me link**. A DM that matches a comment automation through "also start from DM" counts as a keyword DM, so it restarts her too.
4. **Never** restart her: story replies, mentions, shared posts, "first message", "no other automation answered", ad "Send message", tag starts, nudges.
5. The owner cannot restart her by hand. A new stop word stops her again.

```text
 Monday     Riya writes "STOP"       -> opted out
 Wednesday  she replies to a story   -> nothing is sent
 Friday     she DMs "GUIDE"          -> GUIDE matches, opt-out cleared, run starts
```

**Pause automations for one person** (the owner's choice, plan section 14.7):

1. A switch on the contact, and in the bulk bar of Contacts: "Pause automations for this person".
2. While it is on: no automation starts for her; her waiting messages are `skipped` and her open runs `cancelled` (`contact_excluded`); her comments get no DM, no public reply, no hide; broadcasts leave her out; no "mark seen". Her events are still saved.
3. The owner can turn it off at any time. Nothing restarts by itself: her next own action starts normally. Who: Owner, Admin, Editor. Audit log.

| | Stop word | Paused by the owner |
|---|---|---|
| Whose choice | Hers | The owner's |
| Set by | Her message "stop" | A switch on the contact |
| Waiting messages, open runs | `skipped`, `cancelled` (`opted_out`) | `skipped`, `cancelled` (`contact_excluded`) |
| How it ends | Only her own keyword comment, keyword DM, starter question or link | The owner turns it off |
| The owner can undo it | No | Yes |

Example: Riya comments "GUIDE" many times a day. The owner pauses automations for her: her 2 waiting messages are `skipped`. Her next comment is saved, but nothing goes. A week later the owner turns it off. Nothing is sent by itself. The next day she DMs "PRICE": the run starts normally.

---

## Part 19. Limits and the month limit

| Limit | Default | Owner can set | Counts |
|---|---|---|---|
| Opening DMs | 600 per hour per account | 1 to 700 (Meta allows 750) | Private replies in the slow lane |
| New account | 150 per hour, first 7 days | Any owner value replaces it | Same |
| Day limit | OFF (if ON: hour limit x 10) | When ON: hour limit to hour limit x 24 | Since midnight |
| Fast messages | 10,000 per hour per account | 1 to 20,000 | Every fast call into her chat (not follow checks) |
| Fast at the same moment | 20 per account | Settings file only | Fast messages sending now |
| Per person | 60 per hour | 5 to 100 | Automatic fast calls and broadcast messages to one person (loop guard) |
| Public replies ON | 60 per hour per automation | 10, 20, 30, 60, 100 | That automation's replies |
| Public replies OFF, hides | No limit | — | One at a time |
| Broadcast messages (PRO) | 600 per hour per account | 1 to 2,000 | The broadcast lane |
| Broadcasts per person | 1 in 24 hours | Settings file only (hard cap) | Broadcasts she got |
| Mark seen calls | No limit | — | At most one per her message, not counted |
| **DMs per month** | Free 1,000, Creator 10,000, Studio 50,000 | The plan | Every call into her chat, whole workspace |
| **Accounts** | Free 1, Creator 3, Studio 10 | The plan | Connected accounts |
| Starter questions | 4 per account | Fixed (Meta) | Live questions |

1. Hour limits are **per account**; the month count is **per workspace**. An hour count is always "the last 60 minutes": nobody resets it.
2. Every number is in **one settings file**. Owner values in `app.instagram_account_settings` (empty = file value). Plan numbers in the plan row.
3. **Meta's limits:** private replies 750 per hour per account; Live private replies 100 per second while live; Send API 100 calls per second; no hourly number for comment replies; bots answer within 30 seconds (we answer in about 1 to 3).

**The month limit** (plan section 10.2):

1. **Counts:** hello, nudge, follow ask, email and phone questions, list messages, Live private replies, broadcast messages (picture + text = 2). **Does not count:** public replies, hides, follow checks, mark seen.
2. Checked **in the same commit** that marks a DM `sending` (16 slot rows per workspace and month). It may go over by a few DMs sent at the same moment.
3. **80%:** notice + email, once a month. **100%:** notice + email, once a month.
4. **At 100% only new DMs stop:** stop `plan_limit` on the `slow`, `fast` and `broadcast` lanes of every account. The `reply` lane goes on: public replies and hides of DMs that already went still go.
5. Waiting DMs stay `waiting`. The 7-day rule still applies: a DM whose 7 days end while it waits becomes `expired` (`plan_limit`). "Go live" is refused.
6. **Ends** on the 1st at 00:00 (workspace time zone), or when the owner upgrades. Tickets spread over 5 minutes. At full speed: Free reaches the limit in about 30 minutes, Creator about 5 hours, Studio about 1 day (estimate).

```text
 Free workspace, account A
 25 Nov    820 sent -> notice "820 of 1,000 DMs used this month" + email
 28 Nov  1,000 sent -> stop `plan_limit`; 40 DMs wait; replies and hides go on
 1 Dec   00:00      -> count 0, lanes wake, the 40 go (if under 7 days)
```

---

## Part 20. Timing that looks human

1. **Opening DMs:** box = 3600 / hour limit (600 per hour = 6-second boxes). One DM at a **random second** in each box, at least 1.5 s apart. Missed boxes are never sent together.
2. **Fast messages:** each gets its own delay, 500 to 2,000 ms after her action (the average of two random numbers, so most are in the middle). Up to 20 at once per account. **One message at a time to one person**, so her messages stay in order. Viral example: 200 people tap in one second; 20 go at once; the last answer arrives about 10 to 12 seconds later, far under Meta's 30 seconds.
3. **List waits:** N+1 goes at N's sent time + its wait. **Nudge:** 60 minutes after the hello.
4. **Delay before each message** (PRO account setting): an extra 1 to 20 seconds on the first answer after her event; her whole wait stays at most 25 seconds (Part 10).
5. **Broadcasts:** box timing like the slow lane (600 per hour = 6-second boxes), at least 1.5 s apart, lowest priority.
6. **Half speed** after an error: boxes 2 times bigger, fast at most 10 at once.

```text
time    10:00:00          10:00:20          10:00:40          10:01:00
slow    .....x.......x.........x......x.........x.....x......x...  (6 s boxes)
fast    xx..x.xxx......x.x....xxxx.........x....x..x.xx......x...  (taps, lists)
reply   ......rh....r.....r.........R.....rh......r...........R..  (replies)
bcast   ...b.......b....b........b......b.......b.....b.......b..  (6 s boxes)
        x = message   r = OFF reply   R = ON reply   h = hide   b = broadcast
```

---

## Part 21. Plans: Free, Creator, Studio

| Plan | Monthly (placeholder) | DMs per month | Accounts | PRO | Priority support |
|---|---|---|---|---|---|
| Free | $0 | 1,000 | 1 | No | No |
| Creator | $29 ($23 per month yearly) | 10,000 | 3 | Yes | No |
| Studio | $79 ($63 per month yearly) | 50,000 | 10 | Yes | Yes |

**PRO parts:** email step, phone step, "Reply like a person", more than 1 reply line, a second or third version, broadcasts, run on past comments, delay before each message. **Every plan:** unlimited members and all 4 roles. Prices are Flowdm's samples (open item).

| State | Sending | Go live |
|---|---|---|
| Free | Yes, in its limits. **Free never ends** | Yes, without PRO steps |
| Paid | Yes | Yes |
| Trial of Creator or Studio (7 days, no card) | Yes, with that plan's features and limits | Yes |
| Payment failed | Yes, until the grace date (period end + 14 days) | Yes |
| Paid plan cancelled | Yes until the period end. **No grace.** Then plan ended | Yes |
| Plan ended (read only) | No: stop `plan_ended` on every lane. Automations keep their status | No. Owner can pause, delete, disconnect, choose a plan |
| Month limit reached | No new DMs. Replies and hides go | No |
| Workspace paused by our team | No | No |

**Moving down** (plan section 46.4):

1. Allowed. Starts at the **end of the billing period**.
2. **It never stops an automation.** The PRO parts the new plan lacks are **switched off by the plan**: email and phone steps skipped (a run waiting for them moves on); "Reply like a person" works as OFF; only the first reply line; only version A.
3. **Nothing is deleted.** PRO settings stay saved. After a move up they work again by themselves.
4. A notice and an email go once ("Moved to Free: email and phone steps are off in 3 automations"). The editor shows "PRO, off on your plan". Turning a PRO step **on** still needs PRO.
5. **Accounts:** the active accounts must fit the new limit. The owner picks which stay (no pick: the oldest-connected stay). The others get lane stop `plan_downgrade` on all 4 lanes. Webhooks are still saved; the 7-day rule applies.
6. **Account swap ("choose active accounts")** inside the app, at any time: making a stopped account active stops another one.
7. A **disconnect** never starts a stopped account by itself. It keeps automations, contacts and history.
8. **Broadcasts and past comments:** scheduled and "when her chat opens" broadcasts end `cancelled`; drafts and segments stay. An unfinished past-comments run ends `failed`; DMs it already queued still go.

**Moving up:** at once. Clears every `plan_downgrade` stop. PRO parts work again. `plan_limit` ends if the count is under the new limit. Example: a Studio workspace with 6 accounts moves to Creator (3); its period ends 31 December. She keeps A, B and C; the other 3 stop. In January she makes D active in place of C: D sends, C stops. In February she moves up: all stops clear.

**7-day free trial** (plan section 46.9):

```text
 "Try Creator for 7 days" (no card), if this workspace and its accounts never
 had a trial --> the plan's features and limits at once (Stripe trial)
    |
 3 days and 1 day before the end: notice + email "Add a card to keep Creator"
    +-- card added --> the plan goes on, Stripe charges
    +-- no card    --> moves to Free by the moving-down rule (not "plan ended")
```

1. One trial per workspace. An Instagram account gets a trial only once, in any workspace (`billing.trial_accounts`).
2. During the trial: that plan's full month DM limit, accounts and PRO.
3. End with no card: PRO parts switch off, nothing is deleted, accounts above 1 get `plan_downgrade`, the owner can swap which account is active.

Example: the owner of A starts a Creator trial on 1 December and connects A and B. She adds an email step. On 5 and 7 December she sees "Your Creator trial ends on 8 Dec". No card: on 8 December the workspace is on Free. A keeps sending (oldest connected), B stops, the email step is skipped, nothing is deleted. A can never get a trial again.

---

## Part 22. Counters and what the owner sees

**Counters** (plan section 15.1):

1. Each automation shows **"1.3k runs · 51% tapped"**. A draft: "0 runs · edited 1h ago". Top bar: "3 live · 5k runs".
2. **% tapped** = (button taps on the hello + typed answers to the hello) / runs started. A typed answer = her first text while the run waits for the hello button. One of the two per run. Link buttons never count. Example: 200 runs, 80 taps, 22 typed answers = **51% tapped**. Also shown **per version**.
3. Kept in `app.automation_counts` (16 slot rows), + 1 in the same commit. **All-time:** they stay after old runs are deleted. Never recounted.

**Banners on one account** (35 in plan section 15.2), for example:

1. "Opening DM limit (600) is full. 320 DMs wait. Next DM at 11:42."
2. "Instagram asked us to slow down. 800 DMs wait. Starts again at 11:15. Answers still go out."
3. "Instagram blocked messages. 800 DMs wait. Next test: tomorrow 10:00."
4. "The text of automation GUIDE is refused by Instagram. Please fix it. 90 DMs wait."
5. "3,000 DMs waiting. About 2,860 will go. About 140 may expire. Raise the limit to send more." (made every 10 minutes, plan section 12.3)
6. "DM limit reached. 40 DMs wait. Sending starts again on 1 Dec, or when you upgrade. Comment replies still go."
7. "Instagram asked us to slow down broadcasts. 120 wait. Starts again at 12:15. Answers and DMs still go out."
8. "Broadcast 'Diwali sale' is done: 296 sent, 14 skipped (chat closed), 12 replies."
9. "GUIDE: found 340 past comments. 290 match. About 250 will go, about 40 may expire."
10. "Retry for GUIDE: 30 messages go again, 12 cannot (too old, or her chat is closed)."
11. Daily line: "Today: 1,250 sent, 12 not sure, 30 skipped (14 because the chat closed), 8 expired."

**Notices for the whole workspace** (up to three at once): DM limit nearly reached (80%), DM limit reached, payment failed (with the date), trial ends soon (3 days and 1 day before), plan ended ("Sending has stopped. Your automations stay as they are."), workspace being set up (no account yet), workspace paused (full screen). The account menu shows "820 of 1,000 DMs used this month".

**Emails:** blocked, Meta connection stopped, message access off, refused text, any stop over 1 hour, missed comments found, DM limit 80% and 100%, plan ended, payment failed, trial ends (3 days and 1 day before), PRO parts off after a move down. At most one of the same kind per account per 6 hours; month emails once a month. Never twice (mail outbox `dedupe_key`).

**Owner actions:** pause and resume an account; save draft, go live, pause (Keep or Cancel), undo, save changes, duplicate, delete an automation; fix a refused text; change limits and the reply step; connect, reconnect, disconnect; tags and notes; delete a person; the 4 account settings; segments and broadcasts (send, cancel); run on past comments; pause automations for a person; retry failed messages; start a trial, upgrade, move down, choose active accounts, cancel the plan. Each checks the workspace and the role, and goes to the audit log. **Contacts:** "via" automation, private note (2,000 characters), phone search, tags for many at once, and "What happened": our messages and her saved answers of the **last 30 days**. Her own free text is never kept.

**Retry failed messages** (a button on an automation and on a contact, plan section 33.10):

```text
 Owner presses "Retry failed messages" on GUIDE
    |
 count first: "42 failed: 30 can go again, 12 too old or chat closed"
    |
 job `retry-failed`, pieces of 500: each `failed` message of the last 30 days,
 never retried before. Still allowed NOW?
    | yes                                      | no
 back to `waiting` (normal lanes and limits)   stays `failed`
```

1. Only `failed` messages. Never `unknown`, `skipped`, `expired` or `cancelled`, and never broadcast messages.
2. **Still allowed now:** an opening private reply only before its 7-day end; any other DM only if her chat is open now. Not when the error is final for her (she blocked us, user not found, no consent, opted out, paused), and not while the text is still refused (fix it first).
3. **Once per message.** If it fails again, it stays `failed`.
4. Retried messages count in the month count when they are sent. Audit log.

---

## Part 23. Safety

**The gates:**

```text
 ticket --> GATE 1: Redis look --> ONE commit: lane lock + GATE 2 + MONTH COUNT
            (fast, not exact)      + `sending` (Postgres, the truth)
                                     --> Redis +1 --> call Meta
```

1. Gate 1 is skipped when Redis is slow (over 100 ms) or empty. Gate 2 sums the minute rows of the last 61 minutes, in the **same commit** that marks `sending`. The month count is checked in that same commit.
2. A try that never connected gives its place back. Redis and Postgres disagree: the helper compares every minute; the higher one wins until repaired. The limit is never passed.

**Errors: did Instagram get it?** (plan section 33)

| Result | What happens |
|---|---|
| OK | `sent` |
| Never connected (DNS, refused) | `waiting`, place given back, try after 5, 15, 60 s |
| "Try later" on an opening DM | Try after 1, 5, 15 min, then `failed` |
| "Try later" on others; no answer; worker died | `unknown`. Never sent again by itself |
| Too fast | Stop that lane: Meta's time, else 15, 30, 60, 120, 240, 360 min |
| Too fast on a broadcast | Stop only the broadcast lane, for double the time |
| Blocked | Stop all lanes of the account. Test after 24, 48, then every 72 h |
| Login not valid (190) | Stop every account of that Meta connection. Owner reconnects |
| Message access off | Stop all lanes of the account. Test every hour |
| App limit (2 accounts in 5 min) | Stop **all accounts**: 15, 30, 60 min, release over 5 min |
| Instagram down (3 unclear in a row) | Stop that account 5, 10, 20, 40 min. Read-only test first |
| Person problem, comment deleted | That message `skipped` |
| Text refused | `failed`. 5 in a row: stop that automation |
| Wrong permission, 3 people in a row | Stop all lanes, ask to reconnect |
| Live ended | `expired` (`live_ended`) |

"Too fast" or "blocked" on a public reply or hide stops **only the reply lane**.

**Stop and start again:**

| Stop | What stops | Who starts it again |
|---|---|---|
| Instagram error stop | That lane, or all lanes of the account | The sleeping ticket, after one test |
| Login stop | All lanes of the connection's accounts | Owner reconnects |
| Owner paused / team suspended | The account's 4 lanes | Owner Resume / team only |
| Workspace `SUSPENDED` | Every lane of the workspace | Our team |
| `plan_limit` | Slow, fast and broadcast lanes of every account | 1st of the month, or upgrade |
| `plan_ended` | Every lane | A plan becomes active |
| `plan_downgrade` | All 4 lanes of an account not kept | Move up, or choose it as active |
| Refused text 5 in a row | That automation | Owner fixes the text |

1. **Waiting messages never move.** They stay `waiting` in Postgres. After an error stop, **one test** DM goes first. Good: half speed for 1 hour (24 hours after a block). Plan, pause, suspend and login stops are never tested.

**Crash and recovery:**

1. Worker dies before `sending`: the message is still `waiting`; the helper adds the ticket again. After `sending`: the 2-minute lease ends; the helper marks it `unknown`.
2. Postgres fails after Meta answered: a "save-result" job in Redis, retried every 30 s. No `unknown` from a short restart.
3. Redis down or back empty: the webhook still saves in Postgres; sending waits; the helper adds tickets and counts are rebuilt in 1 to 2 minutes. Nothing is sent twice. Postgres down: the webhook uses the Redis buffer. Both down: 500; the missed-comment check finds comments later.
4. Deploy: rolling restart, one server at a time; each finishes its sends (30 s).

**Stopping double DMs:** unique event key; contact row lock; one open run per automation, person and key; once rule (`unknown` counts as sent); lane lock + turn number + lease; `waiting` to `sending` "only if still waiting"; `unknown` never resent by itself; Instagram allows one private reply per comment.

**Restore from backup:** an environment id (a copy of production cannot send) and a global switch `SENDING_ENABLED` outside the database. Steps: switch off, restore, clear Redis, mark messages of the lost time `unknown`, wait 60 minutes, full missed-comment pass, starter questions again, fix connections by hand, switch on server by server (plan section 39).

**Health:** `/health` on each server (Postgres, Redis, helper round, late tickets, old events, partitions, clock, settings version, token check). One **outside checker** alerts by a **second channel** (SMS or chat). Watch: tap to answer (alert over 30 s), `unknown` share (under 1%), stops per reason, Redis memory (75%), month count drift.

**For developers:**

1. One lock order: contact -> automation -> run -> message -> own lane -> other lanes -> reply state -> minute counts -> month slot -> counter slot. A lock out of order uses `skip locked`.
2. **Never** call Meta or Redis inside a transaction. All times come from the **Postgres clock**.
3. Time limits: statement 5 s, lock 1 s, Meta call 15 s, Redis 100 ms, lease 2 min.
4. The **helper** runs every minute on every server (16 slots), never sends, and every rule is safe to run twice: save-result jobs, dead workers, webhook buffer, stuck events, lost tickets, expired messages, closed windows, count compare, emails, clock; every 10 s the down check; every 10 min estimates and webhook subscriptions; every 30 min missed comments; token checks spread over the day; month start; tag events not queued; scheduled broadcasts start and "when her chat opens" ones end; stuck past-comments runs (30 minutes) (plan section 34).

**Privacy:** the token is kept only encrypted, sent only in the header with `appsecret_proof`, never in a log, job, email or URL. Logs hold ids only. Her free text and story pictures are never kept. An option per account adds "This is an automatic message" to the first DM. A broadcast goes only to open chats, at most one per person per 24 hours, never to opted-out or paused people. A saved segment holds conditions, never a list of people.

---

## Part 24. Data

**Existing meepzo-be tables (changed):** `app.instagram_accounts`, `app.instagram_account_settings`, `app.instagram_media`, `app.contacts`, `app.automations`, `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.instagram_webhook_events`. **Dropped:** `app.instagram_account_tokens` (old Instagram Login token).

**New for sending:** `app.instagram_messages`, `app.instagram_send_attempts`, `app.instagram_send_lanes`, `app.instagram_send_minute_counts`, `app.instagram_webhook_event_keys`, `app.automation_run_open_keys`, `app.instagram_send_stops`, `app.sending_state`, `app.sending_helper_slots`. **New for Flowdm and login:** `app.meta_connections`, `app.meta_connection_tokens`, `app.automation_counts`, `app.automation_reply_state`, `app.meta_attachments`, `app.dm_month_counts`, `app.contact_tag_events`.

**New for broadcasts, past comments and trials:** `app.segments`, `app.broadcasts`, `app.broadcast_recipients`, `app.automation_backfills`, and `billing.trial_accounts` (new migration in billing). New columns: the 4 account settings and `broadcast_hour_limit`; contact columns for audiences (`first_seen_at`, `last_comment_at`, `comment_count`, `last_story_activity_at`, `last_broadcast_at`, `came_in_via`, ...) and `automations_off_at`; `owner_retry_at` and type `broadcast` on messages; `last_message_no` on runs.

**Product (new migrations in their domains):** `auth.trusted_devices`, the `billing.plans` rows, `billing.referral_links`, `billing.referrals`, `billing.referral_earnings`, `billing.referral_payouts`, and a few columns.

**Redis:** queues and tickets, gate 1 counts (also `cnt:broadcast:`), the month copy, notes (`seen:`, `mid:`, `seenmark:`), login state, copies, `webhook-buffer`. Rule: **"Can I lose it? Yes: Redis. No: Postgres."**

**Statuses:**

1. Message: `waiting` -> `sending` -> `sent`; also `unknown` (not sure, counts as sent), `failed`, `skipped`, `cancelled`, `expired`.
2. Run: `running` -> `waiting` (hello tap, follow, email, phone or `any`) -> `completed`; or `cancelled` or `failed`.
3. Lane: `ready`, `working`, `sleeping`, `stopped`. Automation: `draft`, `live`, `paused`. Meta connection: `connected`, `error`, `revoked`. Broadcast: `draft`, `scheduled`, `sending`, `waiting_for_chats`, `done`, `cancelled`. Past comments run: `queued`, `reading`, `done`, `failed`.

**How long data is kept** (big tables are split by time; old parts are dropped in one step):

| What | Kept |
|---|---|
| Webhook events, event keys, send attempts, tag events | 8 days |
| **Messages** | **30 days** |
| Runs, run history, comment logs, stop history, broadcast recipients | 90 days |
| Month counts | 13 months |
| Minute counts | 2 hours |
| All-time counters | With the automation |
| Contacts | No clean-up by age: until the owner deletes, Meta asks, or the workspace is deleted |

---

## Part 25. The product around sending

**Sign-in** (plan section 44):

1. **No passwords.** Sign in with Google, **Apple**, a passkey, or a 6-digit email code (always on; 15 minutes; resend after 60 s).
2. 2FA by app code or recovery code. "Trust this device for 30 days" skips the code **only** in a workspace that does not require 2FA.
3. GitHub sign-in is off. For a person without 2FA, an email code is the strong check for risky actions.

**Workspaces and roles** (plan section 45): onboarding asks name, Instagram handle, workspace name, goal. Invite up to 20 emails at once. **Unlimited members and all 4 roles on every plan.** No custom roles.

| Can do | Owner | Admin | Editor | Viewer |
|---|---|---|---|---|
| See automations, contacts, numbers | yes | yes | yes | yes |
| Create, edit, go live, pause, delete automations | yes | yes | yes | no |
| Upload files for messages (images, voice notes, PDFs) | yes | yes | yes | no |
| Tag contacts, write notes | yes | yes | yes | no |
| Broadcasts, past comments, pause a person, retry failed | yes | yes | yes | no |
| Erase a contact, connect accounts, members, billing | yes | yes | no | no |

Owner only: delete the workspace, hand over ownership.

**Settings and notices** (plan section 47): 11 sections (Profile, Security, Notifications, Sessions, Appearance, Account, General, Members, Roles, Billing, Integrations). 7 notification kinds. Email **ON** by default for: automation stopped or error, DM limit 80% and 100%, team changes, billing, weekly summary. **OFF** (in-app only): "a new contact left details" and the 7th kind, "a broadcast or a past-comments run is done". Security and billing emails cannot be turned off. Push is later.

**Refer** (plan section 48):

1. A friend signs up with your link (claim within 24 hours) and pays. You earn every month: 30% (1 to 9 paying friends), 40% (10 to 24), 50% (25+).
2. Earnings wait 30 days (refunds taken off). Minimum payout $50; less rolls over. Our team pays and records it. No self-referral. Free never counts.

---

## Part 26. Later features (in their own file)

Later features are not part of this build. They are listed in `Instagram-DM-Later-Features-v8.md` (plan section 49 points there): Messenger and Facebook Pages, post scheduling, ads, analytics, booking with Google Calendar, link tracking, AI FAQ, forms, integrations, the InstantDM items and the ideas.

1. Nothing we build now depends on them.
2. Each one asks its own Meta permission only when it is built. Connected customers then reconnect once.

---

## Part 27. Size and build order

**Size (estimates):** start with **2 servers** (5 intake, 40 fast, 40 slow, 2 task places each). 1,000 busy accounts (worst): about 10 servers, Neon 8 to 16 compute units. **Add servers when tickets start late**, never because many DMs wait. Storage on a busy-day model: about 400 GB, plus contacts about 70 GB a year (plan section 42).

**Step 0 is the owner's task** (not code). The build team gives the details:

1. Check our Meta app: owned by our business portfolio; Facebook Login for Business; the Unified Login set-up (`config_id`) with the "Instagram Login Compatible" label; the old Instagram-only login **not** on it.
2. Start Meta business verification the same day (days to weeks).
3. **Creator test:** 2 creator accounts with no business portfolio connect while we watch. Write down every step and where they get stuck.
4. From it: a help guide and help screens. The test does **not** decide the login. Unified Login stays.

```text
 0. Meta app check + creator test + business verification --+
 1. Tests with Meta (plan section 43)                        | together
 2. Iteration plans written and approved                     |
 3. Settings file (every number)                             |
      +---------------------------+                          |
      v                           v                          |
 Track A: app and sending     Track B: product around sending
 A1 app migrations (in place) B1 auth (no passwords, Apple)  |
 A2 reset the dev database    B2 user and tenancy (roles)    |
 A3 Unified Login connect <-- help screens from step 0 ------+
 A4 sending sub-domain        B3 billing: plans, states, trial
 A5 workers and queues        B4 notify: notices, emails
 A6 run engine <------------- B3 (plan rows, PRO gate, month)
 A7 webhook and intake        B5 refer
 A8 owner and team actions    B6 upload: message files + scan
 A9 broadcasts, past comments <-- B3 (PRO gate)
 A10 health and alerts
      +---------------------------+
                  v
 4. Meta's review -> Live mode -> first real customers
 5. Tests, then close and freeze the iterations
```

1. meepzo-be's own process: questions first, plan before code, the owner approves, then build.
2. Submit to Meta's review after connect, comments, DMs and Live comments work on test accounts.
3. No real customer before Advanced Access, Live mode and business verification.
4. A8 also builds the account settings screen, "pause automations for this person" and "retry failed messages". A9 builds segments, broadcasts with their lane, and the past-comments job.
5. Commit, push and pull request only when the owner says so.

---

## Part 28. Tests with Meta, and open items

**Tests before we build on them** (full list in plan section 43):

1. The error of a second private reply on one comment ("already sent"). No production start without it.
2. Does the "message was sent" notice come for a private reply, with its id?
3. A private reply with buttons (Meta's example shows text only).
4. Follow check right after a button tap: does the tap count as her consent?
5. `@username` in a public reply. Is the person id in a comment the same as in DMs?
6. Is `entry.time` close enough to the comment time?
7. On Unified Login: quick replies, cards, button messages, starter questions, profile read, file upload.
8. Ad comments (reply, hide), link format and the ref on a new chat, the window after an ad (24 h or 7 days).
9. Live rules, story repost, "they follow you". The app limit of one Meta app for 1,000 accounts (ask Meta). How many public replies per hour are safe.
10. New features: a reply comment carries `parent_id`; a private reply to a reply comment; `mark_seen` on Unified Login; reading many past comments (speed, limits); a broadcast inside her window (a normal send). Stripe's trial with no card (check when building).

**Open items** (only three left, plan section 53):

1. **Referral payouts:** how the money is paid (bank, PayPal, Stripe Connect, or credit on their bill), and does a friend earn for ever or for 12 months?
2. **Final plan prices** and Stripe products (today's are placeholders).
3. **AI (later):** which AI service, and may her message text be sent to it (same-meaning keywords, the AI FAQ)?

---

## Part 29. Questions a new developer asks

| Question | Short answer |
|---|---|
| Where do waiting DMs live? | Postgres, `app.instagram_messages`, status `waiting`. Never in Redis. |
| How many lanes per account? | 4: slow, reply, fast, broadcast. Still 3 sending queues. |
| How many automations answer one message? | One. The match order decides. |
| What stops at the month limit? | Only new DMs. Replies and hides of sent DMs still go. |
| Can a broadcast go to anyone? | No. Only to people whose chat is open, at most one broadcast per person per 24 hours. |
| Where are all numbers? | One settings file. Owner values override it. Plan numbers in the plan row. |
