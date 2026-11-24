Status: draft
Kind: screen
Depends on: sign-in-and-security, roles-and-organization
Route review: [routes-final.md](../../routes-final.md) § 11 — routes 130–136, 148–149 (11.A–11.D)

## Stories

- As a new person I want onboarding to save my Instagram handle and my goal so that the app fits what I want to do.
- As a person with several organizations I want a chooser with my role and each organization's counts so that I open the right one.
- As a person I want to confirm my email from a link so that invitations and notices reach me.
- As a person I want to choose, per kind and channel, which notifications I get so that I hear what matters and nothing else.
- As every member I want a weekly summary of each account so that I see progress without opening the app.
- As an Owner, Admin or Editor I want new contact details grouped into one note an hour so that I am not interrupted for each one.

## Rules

- Onboarding saves an Instagram handle (letters, digits, `.` and `_`, at most 30, saved lowercase without `@`) and a goal (`capture_leads`, `drive_sales`, `grow_community`), both optional (operations.user-profile-onboarding; plan §45.2)
- Settings add reduce motion; a personal organization cannot be the one that opens at sign-in (operations.user-profile-onboarding; plan §47.6)
- The organization chooser hides the personal organization and answers role, members, accounts and live automations per organization, searchable by name (operations.organization-chooser; plan §45.4)
- The confirm link holds a one-time token good for 24 hours; a resend within 60 seconds is refused with its wait (operations.email-confirmation; plan §47.7)
- Notification preferences speak 7 kinds × channels, stored one row per type of the kind; billing and security email cannot be turned off; defaults follow D54 (notifications.kinds-v8; D54, P87)
- Before each send the person's choice is read: in-app on → a notification row; email on → a mail outbox row with the caller's dedupe key; push saved but not sent yet; the organization's own mute still wins (notifications.kinds-v8; P88)
- The weekly summary goes on Monday 09:00–09:59 in the organization's time zone, per account, only when something happened, once per person per week (background.weekly-summary; plan §47.4)
- New contact details are grouped: at most one note per account per hour (notifications.kinds-v8; plan §47.2)
- User and notify changes ship as new migrations in their domains only (data.merged-domains-forward-only; D48)

## Acceptance criteria

- AC-14.1 — The profile saves and answers an Instagram handle (lowercased, `@` removed) and a goal; a handle with other signs or over 30 characters, or another goal, is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:7819
- AC-14.2 — Settings save and answer reduce motion; choosing a personal organization as the default is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:8204
- AC-14.3 — The organization list hides the personal organization and answers each one's role, members, accounts and live automations, filtered by a name search — intake-files/Instagram-DM-Sending-Plan-v8.md:7853
- AC-14.4 — Asking for a confirm link emails one; asking again within 60 seconds is refused with its wait; the link's token confirms the email once and an unknown, spent or older-than-24-hours token is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:8209
- AC-14.5 — The preferences read answers the 7 kinds × channels with their defaults (email off for new contact details and for "broadcast or past comments done") — intake-files/Instagram-DM-Sending-Plan-v8.md:8137
- AC-14.6 — Turning billing or security email off is refused — plans/decisions.md P87
- AC-14.7 — With in-app off and email on, a notification sends an email with the caller's dedupe key and writes no in-app row; with both off nothing is sent — plans/decisions.md P88
- AC-14.8 — The weekly summary reaches each member who has it on once on Monday morning in the organization's time zone, with each account's runs, DMs sent, % tapped, new contacts, details collected and top automation; a week with nothing sends nothing; a restart never sends it twice — intake-files/Instagram-DM-Sending-Plan-v8.md:8188
- AC-14.9 — Three people leaving details within one hour on one account produce one in-app note "3 new contacts left details" and no email by default — intake-files/Instagram-DM-Sending-Plan-v8.md:8161

## Work items

- operations.user-profile-onboarding
- operations.email-confirmation
- notifications.kinds-v8
- notifications.owner-email-defaults
- background.weekly-summary
- background.contact-details-notice
- data.merged-domains-forward-only
- data.platform-columns
- notifications.check-before-send
- notifications.contact-details-left
- notifications.weekly-summary
- operations.organization-chooser
