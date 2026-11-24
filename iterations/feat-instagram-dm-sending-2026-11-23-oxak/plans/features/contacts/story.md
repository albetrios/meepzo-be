Status: draft
Kind: screen
Depends on: channel-accounts
Route review: [routes-final.md](../../routes-final.md) § 3 — routes 18–23, 25 (3.A), with the tag events of 3.B

## Stories

- As any member I want to list, search, filter and sort the contacts of the selected account so that I find a person fast.
- As any member I want to open a contact and see her profile, the details she gave, her tags, how she came in and whether she opted out or is paused so that I know who she is.
- As an Owner, Admin or Editor I want to write a private note and add or remove tags on a contact so that my team shares what we know.
- As an Owner, Admin or Editor I want to tag, untag, pause or resume many contacts at once so that I can act on a whole group.
- As an Owner, Admin or Editor I want to pause automations for one person so that someone who abuses a keyword is not messaged any more.
- As any member I want a tag list with how many contacts carry each tag so that I can filter and build audiences.
- As an Owner or Admin I want to delete a person so that her personal data is erased when she asks.

## Rules

- Contacts are shared by every channel and listed per account: the account is a required filter (data.shared-product-tables, operations.shared-product-routes; P48, P65)
- Search needs at least 3 characters and also matches the phone she gave; sorts and filters include tags, opted out, paused and how she came in (operations.contact-search; D46, P97)
- The private note holds up to 2,000 characters and sends nothing (operations.contact-note; D46)
- A tag added or removed writes one tag event in the same commit as the tag change, so a tag automation can start from it (operations.contact-tag-events; D45)
- Bulk actions take ids (1–500) or the list's filters, and run in the background in pieces of 500 (operations.contact-bulk-actions; P66)
- The tag list counts contacts per tag, is cached for at most 60 seconds per organization and account, and confirms the account in Postgres inside the organization's scope first (operations.contact-tags; P5, P64, P97)
- Pausing automations for a person: nothing starts for her by any way to start, her waiting messages become `skipped` · `contact_excluded` and her open runs `cancelled` · `contact_excluded`; switching it off restarts nothing by itself (operations.contact-pause-automations; D71)
- A stop word sets her opted out; the owner cannot start her again by hand (operations.contact-stop-words; D49)
- Note, tags and pause need `contact:update` (Owner, Admin, Editor); delete needs `contact:delete` (Owner, Admin); every role reads (access.contact-update-code; P20)
- Contacts are never cleaned up by age: a contact stays until the owner deletes it, Meta asks, or the organization is deleted (quality.retention; D51)
- Deleting a person wipes her personal data, keeps the row, cancels her open runs and her waiting messages (operations.contact-delete; plan §15.4)
- Note, tag, pause and delete changes leave an audit entry; her emails and phones never appear in logs (quality.audit, quality.message-privacy)

## Acceptance criteria

- AC-5.1 — The contact list without an account is refused; with one it shows only that account's contacts with tags, opted out, paused, how she came in, first message, last comment and comment count — plans/decisions.md P65
- AC-5.2 — A search under 3 characters is refused; a search matches name, username, email or phone; filters and sorts work across pages — plans/decisions.md P97
- AC-5.3 — A contact read answers her profile, the email and phone she gave, tags, note, opted out, paused (by whom, when) and the automation she came in through; another organization's contact answers not found — intake-files/Instagram-DM-Sending-Plan-v8.md:257
- AC-5.4 — A note over 2,000 characters is refused; a saved note sends nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:2626
- AC-5.5 — Adding or removing a tag on one contact writes exactly one tag event in the same commit, and a live tag automation of that tag can start from it — intake-files/Instagram-DM-Sending-Plan-v8.md:256
- AC-5.6 — A bulk action with more than 500 ids, or with neither ids nor a filter, is refused; a good one answers at once and changes the contacts in pieces of 500 in the background — plans/decisions.md P66
- AC-5.7 — The tag list without an account is refused; with one it answers each tag with its count; a tag change shows in the list within 60 seconds — plans/decisions.md P64
- AC-5.8 — Pausing automations for a person skips her waiting messages (`contact_excluded`), cancels her open runs (`contact_excluded`), and a later comment of hers is saved but sends no DM, public reply or hide — intake-files/Instagram-DM-Sending-Plan-v8.md:2789
- AC-5.9 — Switching the pause off sends nothing by itself; her next own matching action starts normally — intake-files/Instagram-DM-Sending-Plan-v8.md:2616
- AC-5.10 — There is no way for the owner to clear a person's opted out; only her own new matching action does — intake-files/Instagram-DM-Sending-Plan-v8.md:260
- AC-5.11 — A Viewer reads contacts and is refused note, tags, pause and bulk with `missing_permission`; an Editor may do those and is refused delete — intake-files/Instagram-DM-Sending-Plan-v8.md:7869
- AC-5.12 — Deleting a contact wipes her personal data, keeps the row, cancels her open runs and her waiting messages — intake-files/Instagram-DM-Sending-Plan-v8.md:2628
- AC-5.13 — No contact is removed by age by any clean-up — intake-files/Instagram-DM-Sending-Plan-v8.md:262
- AC-5.14 — Note, tag, pause and delete each leave one audit entry; no log line holds her email or phone — intake-files/Instagram-DM-Sending-Plan-v8.md:7257

## Work items

- data.shared-product-tables
- operations.shared-product-routes
- operations.contact-search
- operations.contact-note
- operations.contact-tags
- operations.contact-tag-events
- operations.contact-bulk-actions
- operations.contact-pause-automations
- operations.contact-stop-words
- operations.contact-delete
- access.contact-update-code
- quality.retention
- quality.message-privacy
- quality.audit
