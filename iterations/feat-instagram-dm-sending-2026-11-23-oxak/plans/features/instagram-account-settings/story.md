Status: draft
Kind: screen
Depends on: channel-accounts, plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 2.B — route 12

## Stories

- As an Owner or Admin I want to set each Instagram account's sending limits within Meta's bounds so that the account sends as fast as is safe for it.
- As an Owner or Admin I want to choose whether replies under comments start automations, whether a person is answered once per post, and whether "Seen" shows after we answer so that the account behaves the way I want.
- As an Owner or Admin on Creator or Studio I want a short extra delay before each answer so that replies look more human.
- As an Owner or Admin I want my own stop words so that people who say them are never messaged again by this account.

## Rules

- Owner limits replace the settings file's values; empty means the file's value (quality.sending-settings; D22)
- Opening DMs per hour: 600 by default, up to 700; a new account sends 150 an hour for its first 7 days unless the owner sets a value; the day limit is off unless set; fast answers 10,000 an hour; per person 5–100 an hour; broadcasts per hour within its bounds (operations.instagram-send-limits; D5, D11)
- Replies under comments start automations (default ON); "once per person per post" (default ON; OFF = every time); mark as seen after a reply (default OFF) (operations.instagram-account-settings-v8; D64, D65, D66)
- Mark as seen can be switched on only once its Meta test has passed (operations.instagram-mark-seen, operations.feature-check; P36)
- Delay before each message is PRO: both empty = off, each 1–20 seconds, the minimum not above the maximum (operations.instagram-extra-delay; D67, P83)
- A change counts for new events only; messages already waiting keep their time; changing a limit gives the slow and reply lanes a new turn (operations.instagram-account-settings-v8; plan §15.4, §15.8)
- The launch's five public-reply settings leave the account: public replies are set per automation (operations.automation-public-reply-per-automation; D14, D32)
- Owner and Admin change the settings; every member with account read access sees them (access.channel-account-codes; P59)
- Each change leaves one audit entry with the old and new values (quality.audit)

## Acceptance criteria

- AC-3.1 — A new account's settings read replies under comments ON, once per person per post ON, mark as seen OFF, delay before each message off, and empty limits that act as the settings file's values — intake-files/Instagram-DM-Sending-Plan-v8.md:2679
- AC-3.2 — An opening-DM limit above 700 an hour is refused; with no owner value a new account sends at most 150 opening DMs an hour for its first 7 days — intake-files/Instagram-DM-Sending-Plan-v8.md:216
- AC-3.3 — A per-person limit outside 5–100 an hour is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:1960
- AC-3.4 — On Free, switching the delay before each message on is refused with `plan_lacks_feature`; on Creator or Studio a minimum above the maximum, or a value outside 1–20 seconds, is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:278
- AC-3.5 — Switching mark as seen on while its Meta test has not passed is refused with `feature_not_offered` — plans/decisions.md P36
- AC-3.6 — With replies under comments OFF, a reply under another comment starts nothing and is logged `ignored` · `thread_reply_off` — intake-files/Instagram-DM-Sending-Plan-v8.md:275
- AC-3.7 — With once per person per post OFF, a second keyword comment of the same person on the same post starts a new run once her earlier run has ended — intake-files/Instagram-DM-Sending-Plan-v8.md:276
- AC-3.8 — A changed limit or setting applies to events that arrive after it; messages already waiting keep their planned time; the slow and reply lanes get a new turn — intake-files/Instagram-DM-Sending-Plan-v8.md:2684
- AC-3.9 — The account settings carry no public-reply fields; sending one is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:225
- AC-3.10 — An Editor or a Viewer can read the settings and is refused a change with `missing_permission` — intake-files/Instagram-DM-Sending-Plan-v8.md:7871
- AC-3.11 — Each change writes one audit entry with the changed fields' old and new values — intake-files/Instagram-DM-Sending-Plan-v8.md:2660

## Work items

- operations.instagram-account-settings-v8
- operations.instagram-send-limits
- operations.instagram-mark-seen
- operations.instagram-extra-delay
- operations.feature-check
- operations.automation-public-reply-per-automation
- quality.sending-settings
- access.channel-account-codes
- quality.audit
