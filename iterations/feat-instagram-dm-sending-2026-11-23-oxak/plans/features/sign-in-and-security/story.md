Status: draft
Kind: screen
Depends on: roles-and-organization
Route review: [routes-final.md](../../routes-final.md) § 10 — routes 120–128, 143–147; four routes removed (RC-98–RC-101)

## Stories

- As a person I want to sign in with Google, Apple, a passkey or a 6-digit email code, never a password, so that signing in is simple and safe.
- As a person with two-factor I want to trust this device for 30 days so that I am not asked the code every time.
- As a person without a password I want an email code to count as a strong step-up so that I can still remove a sign-in way or end a session.
- As a person I want to see each session's place so that I spot one that is not mine.
- As a person I want to connect Google or Apple from Settings so that I have more ways in.

## Rules

- No password is asked, stored or checked: the four password routes and their code paths are removed and stored hashes are emptied (access.sign-in-v8; P84)
- The email code is 6 digits, lives 15 minutes, may be resent after 60 seconds, allows 5 wrong tries per code and 20 per email a day, and answers separate reasons (`code_wrong` with tries left, `code_expired`, `code_used_up`, `code_day_limit`) without revealing whether an email is known (access.sign-in-v8; plan §44.3)
- The email-code way is always on and can never be removed (access.sign-in-v8)
- Apple sign-in posts a form to our server, which never signs anyone in by itself and sends the browser on to the app page — the one named exception to the method-status policy (access.sign-in-v8; P85)
- Sign-in failures answer one reason from a fixed list (access.sign-in-v8)
- GitHub is hidden; Google and Apple can be linked while signed in after a recent step-up, also with another email; another person's account is refused (access.sign-in-v8)
- "Trust this device": 30 days from the tick, at most 10 a person, skips only the 2FA screen at sign-in and only where the organization does not require 2FA; it ends when 2FA is turned off, a factor removed, or "sign out everywhere else" (access.trusted-device; D56)
- A wrong 2FA code answers the tries left; 10 wrong in 15 minutes locks (access.sign-in-v8)
- Strong step-up is a 2FA code for a person with 2FA and an email code for a person without (access.sign-in-v8; plan §44.7)
- Each session shows its city and country from a local IP-to-place file; no file means no place; the IP never leaves the server (access.session-place; P86)
- Every sign-in, step-up, trusted device and removal leaves an audit entry (quality.audit)
- Auth's changes ship as new auth migrations only (data.merged-domains-forward-only; D48)

## Acceptance criteria

- AC-13.1 — The password sign-in, forgot, reset and change routes no longer exist, and no code path checks a password — plans/decisions.md P84
- AC-13.2 — A sent code is 6 digits; the answer gives when a new code may be asked and when it expires, the same for a known and an unknown email; a resend within 60 seconds is refused with its wait — intake-files/Instagram-DM-Sending-Plan-v8.md:7648
- AC-13.3 — A wrong code answers `code_wrong` with the tries left; an expired newest code `code_expired`; 5 wrong tries `code_used_up`; 20 wrong tries a day `code_day_limit` with its wait — intake-files/Instagram-DM-Sending-Plan-v8.md:7650
- AC-13.4 — Removing the email-code way is refused with `email_code_always_on` — intake-files/Instagram-DM-Sending-Plan-v8.md:7777
- AC-13.5 — The Apple form callback over 16 KiB is refused; a good one keeps the name with the state and sends the browser on to the app page without signing anyone in; it is the one named exception to the method-status policy — plans/decisions.md P85
- AC-13.6 — The sign-in providers list answers Google and Apple only — intake-files/Instagram-DM-Sending-Plan-v8.md:7778
- AC-13.7 — Linking Google or Apple while signed in needs a recent step-up and links even with another email; one already linked to someone else is refused with `provider_account_in_use` — intake-files/Instagram-DM-Sending-Plan-v8.md:7776
- AC-13.8 — After a right 2FA code with "trust this device", the next sign-in on that browser within 30 days skips the code; in an organization that requires 2FA the code is still asked — intake-files/Instagram-DM-Sending-Plan-v8.md:267
- AC-13.9 — An 11th trusted device ends the oldest; turning 2FA off, removing the last factor, or "sign out everywhere else" ends trusted devices (except this browser for the last) — intake-files/Instagram-DM-Sending-Plan-v8.md:7745
- AC-13.10 — A wrong 2FA code answers the tries left; the 11th in 15 minutes is locked with its wait — intake-files/Instagram-DM-Sending-Plan-v8.md:7717
- AC-13.11 — A person without 2FA can remove a passkey, remove Google or Apple and end a session after an email-code step-up — intake-files/Instagram-DM-Sending-Plan-v8.md:7765
- AC-13.12 — The sessions list shows each session's city and country; with no place file the place is empty and nothing fails — plans/decisions.md P86
- AC-13.13 — Sign-in, step-up, trusting a device and removing a way each leave one audit entry — intake-files/Instagram-DM-Sending-Plan-v8.md:7632

## Work items

- access.sign-in-v8
- access.trusted-device
- access.session-place
- data.merged-domains-forward-only
- quality.audit
