# Brief — an Instagram inbox: every DM with a contact kept as a thread, read and answered by the team

## What changes

Today no DM text is kept: an inbound message lives only in its raw webhook event (8 days, emails masked), an
outbound message is composed at send time and its record (`app.instagram_messages`, no text) goes after ~30 days,
and the contact activity route says "her own words never appear". The team reads chats only in the Instagram app.

This iteration keeps the conversation and lets the team answer from our app:

- **Inbox list** — one thread per contact and Instagram account, newest activity first; unread count, last message
  preview, whether the 24-hour messaging window is open and until when, the thread's owner and state.
- **Thread** — every message both ways in order: her DMs (text, attachments, story replies and mentions, shared posts,
  button taps, reactions, unsent / edited marks), what our automations and broadcasts sent, what a team member sent
  from our app, and what the account sent from the Instagram app itself (echoes).
- **Reply** — a team member sends text or a file while the window is open; the send goes through the existing paced
  sender and its limits; it shows sent, failed (with the reason) or waiting.
- **Hand-off** — a team member takes a thread: the contact's automations pause for it until released or closed, so a
  bot never answers over a person.
- **Read state** — opening a thread marks it read for the team; Meta's read receipts (`messaging_seen`) may show
  whether she read ours.

## Why

Automations start conversations; people finish them. Without the history and a reply box the team switches to the
Instagram app, loses the context of what the automation already said, and the bot can talk over them.

## Affected screens, entities and routes

- Screens: inbox list, thread, reply box, hand-off control, contact detail (link to its thread)
- Entities: contact (`app.contacts`, `app.contact_activities`), channel account, Instagram webhook event, Instagram
  message (`app.instagram_messages`), automation run, broadcast; new conversation and conversation-message entities
  as the plan decides
- Routes: `GET /app/contacts/{contact_id}` and `/activity`, the webhook intake (routes 60–62); new inbox routes as
  the plan decides

## Rules

1. **Source of truth is our webhook intake** — every inbound DM, echo, reaction, edit and unsend already passes the
   classifier; the inbox is written from it, once per Meta id (the existing event keys), never from a second path.
2. **Outbound text is captured when sent** — the composed text (and file reference) of every automation, broadcast
   and manual message is stored with its result; echoes of our own sends are matched to them, not shown twice.
3. **Messaging window** — a reply is allowed only while Meta's 24-hour window is open (her last inbound message);
   outside it the reply box says why. The Human agent tag (7 days) is a later option behind its own permission and
   App Review — the plan decides whether to design for it now.
4. **Hand-off** — a taken thread pauses the contact's automations for that account; release, close, or a set idle
   time ends it (the plan sets the time). Broadcasts skip a taken thread (plan decides).
5. **Roles** — reading needs a contact/inbox read permission, replying and taking need a manage permission; new
   permission codes go through the tenancy permission set.
6. **Privacy and retention** — message text is personal data: kept for a set time (the plan proposes, the owner
   decides), erased with the contact (CT11), with the account's data deletion (Meta callback 17) and with the
   organization; never in logs; emails and phones not masked in the thread the team reads (they are her words to
   the business) but never copied elsewhere.
7. **Attachments** — Meta's file URLs expire; the plan decides whether to copy files to our storage (upload domain)
   or show them only while the URL lives.
8. **Scale** — threads and messages are tenant tables with FORCE RLS; message tables split by time like the existing
   message tables; the list is a keyset page.
9. **Backfill** — conversations from before the connect: the plan decides whether to read Meta's `/conversations` edge
   (limits unverified) or start empty from the connect.
10. **Instagram only, Pages-ready** — thread and message carry the channel so Messenger can join later.
11. **Data model (from the schema-v3 mapping)** — a contact is already per organization, Instagram account and person,
    so a thread is **1:1 with a contact**: a narrow `contact_threads`-style table (state, assignee, unread, last read,
    snooze, first and last response times, Meta `conversation_id` only when a backfill fills it), apart from
    `app.contact_activities` so its frequent updates stay cheap. Messages in a `conversation_messages`-style table
    split by month, keyset-paged by contact and time, with `direction`, `source` (automation, broadcast, team,
    instagram_app, contact), text, attachment refs and the Meta message id unique per account (the same key as
    `app.instagram_webhook_event_keys`). Outbound rows link `app.instagram_messages`, their text written in the
    sender's existing one result save; inbound rows written by the existing intake — one path each. The 24-hour window
    is read from `contact_activities.last_direct_message_received_at`, never stored twice. Inbound files are copied as
    `uploads` with their own purpose. Team actions (reply, take, assign, close, note) go to the audit log.
12. **Real-time** — the backend has no push to the browser today (SSE only for MCP). The plan decides SSE or short
    polling for new messages, unread counts and thread changes.
13. **Hand-off from the Instagram app** — an echo our app did not send means a person replied in the Instagram app:
    the thread is taken (by "Instagram app") and the bot pauses, as for a team take.
14. **Thread states and assignment** — open, waiting on us, waiting on her, closed, snoozed until a time; assign to a
    member (take = assign to me), unassign; filters: unread, mine, unassigned, window closing soon, account, tag;
    search by username (searching message text is a privacy and index decision for the plan).
15. **Team workflow** — internal notes on a thread (never sent); saved replies per organization; notifications of a
    new DM and of a window closing soon through the notify domain, per member preference; first and last response
    times on the thread.
16. **Messaging extras** — read receipts (`messaging_seen` added to the subscribed fields); typing indicator while a
    member writes; `mark_seen` when a member opens the thread as an organization setting (it tells her we read it);
    react to her message; reply to a specific message. ⚠️ the send-side actions are unverified for Unified Login —
    each needs a dev-app check before it is built.
17. **Unsent and edited** — when she unsends, the stored text is erased and a "message removed" mark kept; an edit
    keeps the latest text and an edited mark.
18. **Human agent tag ready** — the window is stored as a kind and an end (24 hours now, 7 days with the Human agent
    tag after App Review), so adding the tag needs no table change.

## Acceptance criteria

- [ ] Every inbound DM kind the classifier knows appears once in its contact's thread, in Meta's order.
- [ ] Every message our automations, broadcasts and team send appears with its text and result; its echo is not
      shown twice.
- [ ] A team reply inside the window is sent through the paced sender and appears in the thread; outside the window
      it is refused with the window's end time.
- [ ] Taking a thread pauses the contact's automations for that account until it is released, closed or idle.
- [ ] Erasing a contact, Meta's data deletion and an organization delete remove its threads and messages.
- [ ] Message text never reaches a log; every new table has FORCE RLS with USING and WITH CHECK.
- [ ] The inbox list and thread are keyset-paged; an unread count is right after a read and after a new message.
- [ ] A reply sent from the Instagram app takes the thread and pauses its automations.
- [ ] Assign, unassign, state changes, snooze, notes and saved replies work and are audited.
- [ ] An unsent message's text is gone from the database; an edited one shows its latest text.
- [ ] New messages and unread counts reach the open inbox without a page reload (by the chosen method).
- [ ] Team notifications for a new DM and a closing window respect each member's preference.

## Out of scope

Facebook Messenger threads, AI replies or suggestions, automatic assignment rules (round robin, load), insights, content publishing, @mention and comment inboxes (a later iteration), the
frontend screens (meepzo-fe plans them from the route map), and the connect flow (`feat-meta-connect-flow`).
