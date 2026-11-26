# Worker changes — feat-instagram-inbox-2026-11-26-bcar

What must happen without a click — never how.

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-inbox-2026-11-26-bcar` |
| Mode | initial |
| Baseline | none |
| Intake mode | brief — from scratch |
| Intake hash | `1082fd1734e6` |
| Date | 2026-11-26 |
| Stage | Steps 1–3 draft — pending Q2, Q4, Q5, Q6 |

| Change | Count |
| --- | --- |
| NEW | 5 |
| CHANGED | 6 |
| **Total** | **11** |

| # | Change | Work | What must be true | Brief |
| --- | --- | --- | --- | --- |
| WC-1 | CHANGED | the webhook intake's event transaction | writes the inbound message to its thread (unread +1, last message, `waiting_on_us`) in the same transaction as the contact event — once per Meta id | 1 |
| WC-2 | CHANGED | the classifier / dispatch | carries `mid`, attachments, `reply_to`; an unsent message erases the stored text; an edit updates it; read receipts (`messaging_seen`) set `seen_at` | 1, 16, 17 |
| WC-3 | CHANGED | the send core's result save | the call answers what it sent (text, attachment); the one result save writes the outbound thread message | 2 |
| WC-4 | CHANGED | the intake on an echo our app did not send | the thread is taken by "Instagram app" and the contact's automations pause (scope Q2) | 13 |
| WC-5 | CHANGED | contact erase (CT11) and the organization delete | a `ContactErasureStep` removes threads, messages, notes; Meta data deletion pending Q5 | 6 |
| WC-6 | NEW | inbound file copy | copies Meta's expiring file to uploads (pending Q6) | 7 |
| WC-7 | CHANGED | partition upkeep | creates and drops `contact_thread_messages` parts (retention Q4) | 8 |
| WC-8 | NEW | new-message notice | notifies the assignee (else the team) of a new DM, per member preference | 15 |
| WC-9 | NEW | window-closing notice | notifies the assignee when a thread waiting on us has under 2 hours of window left | 15 |
| WC-10 | NEW | snooze wake-up | a snoozed thread reopens at its time | 14 |
| WC-11 | NEW | idle hand-off release | a taken thread with no team message for the set time releases and the bot resumes (Q2) | 4 |
