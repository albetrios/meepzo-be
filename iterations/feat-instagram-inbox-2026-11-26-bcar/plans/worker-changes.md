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
| Stage | Step 4 — I-D3 (24 h idle), I-D5 (12 months), I-D6 (Meta deletion erases), I-D7 (copy files), I-D9 (direct team send) |

| Change | Count |
| --- | --- |
| NEW | 5 |
| CHANGED | 8 |
| **Total** | **13** |

| # | Change | Work | What must be true | Brief |
| --- | --- | --- | --- | --- |
| WC-1 | CHANGED | the webhook intake's event transaction | writes the inbound message to its conversation (unread +1, last message, `waiting_on_us`) in the same transaction as the contact event — once per Meta id | 1 |
| WC-2 | CHANGED | the classifier / dispatch | carries `mid`, attachments, `reply_to`; an unsent message erases the stored text; an edit updates it; read receipts (`messaging_seen`) set `seen_at` | 1, 16, 17 |
| WC-3 | CHANGED | the send core's result save | the call answers what it sent (text, attachment); the one result save writes the automation / broadcast message into the conversation (team replies are written by their own route, I-D9) | 2 |
| WC-4 | CHANGED | the intake on an echo our app did not send | the conversation is taken by "Instagram app" and every automation DM to that contact on that account waits ([I-D3](decisions.md)); an echo of a **team** reply (matched by Meta's message id) never does | 13 |
| WC-5 | CHANGED | contact erase (CT11) and the organization delete | a `ContactErasureStep` removes conversations, messages, notes and copied files; **Meta data deletion** erases the account's conversations too ([I-D6](decisions.md)) | 6 |
| WC-6 | NEW | inbound file copy | copies Meta's expiring file into uploads with its own purpose ([I-D7](decisions.md); owner test I2) | 7 |
| WC-7 | CHANGED | partition upkeep | creates and drops `instagram_conversation_messages` monthly parts — dropped after **12 months** ([I-D5](decisions.md)) | 8 |
| WC-8 | NEW | new-message notice | notifies the assignee (else the team) of a new DM, per member preference | 15 |
| WC-9 | NEW | window-closing notice | notifies the assignee when a conversation waiting on us has under 2 hours of window left | 15 |
| WC-10 | NEW | snooze wake-up | a snoozed conversation reopens at its time | 14 |
| WC-12 | CHANGED | the send repair sweep | also repairs a team reply stuck `sending` ([I-D10](decisions.md)) | 3 |
| WC-13 | CHANGED | every job reading the sender's ledger | reads `app.instagram_automation_messages` after the rename ([I-D13](decisions.md)); no behaviour change | — |
| WC-11 | NEW | idle hand-off release | a taken conversation with no team message for **24 hours** releases and the bot resumes ([I-D3](decisions.md)) | 4 |
