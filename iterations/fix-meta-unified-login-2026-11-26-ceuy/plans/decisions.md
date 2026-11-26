# Decisions — fix-meta-unified-login-2026-11-26-ceuy

Add-only. Kind: `RED` (answered by the user), `AMBER` (safe default, still open), `SCOPE`.

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| F-D1 | How the fixes ship | separate lite fix · rows of the new feat | separate lite `fix` iteration, before `feat-meta-connect-flow` | 2026-11-26 | user | RED |
| F-D2 | C4 — token end | never-ending configuration · `business_management` + renewal job | never-ending configuration (P359 confirmed); code only flags a dated token (F4) | 2026-11-26 | user | RED |
| F-D3 | C1 — when neither `/me/permissions` nor `/debug_token` can be read | let the connect through with empty scopes · refuse as an outage · new reason | refuse as today's outage: empty scopes would make every feature answer `permission_not_granted`, and a new reason is a contract change for the feat iteration. Logged with step `permissions_unreadable` | 2026-11-26 | Claude | AMBER |
| F-D4 | C1 — fallback order | `/debug_token` first · `/me/permissions` first | `/me/permissions` first (built and tested), `/debug_token` only when it is empty or refused — one extra call only on that path. ⚠️ `debug_token`'s `scopes` for this token type is unverified (owner test O1) | 2026-11-26 | Claude | AMBER |
| F-D5 | C2 — keep the refused-quick-reply fallback? | keep · remove | keep `isQuickReplyRefused` → plain text: other quick replies (`text`) still use it | 2026-11-26 | Claude | AMBER |
| F-D6 | C3 — match Meta's deauthorize by the system user id too? | add a third resolver · store only | store only: Meta documents no deauthorize callback for Unified Login, so which id a signed request carries is unknown (owner test O3); a resolver on a guess is speculative | 2026-11-26 | Claude | AMBER |
| F-D7 | C5 — a login that shares no Instagram account | fix here · design in the feat | moved to `feat-meta-connect-flow-2026-11-26-bqmw`: it is a connect outcome the frontend must show | 2026-11-26 | Claude | SCOPE |
| F-D8 | C6 — the "Allow access to messages" probe | change code · test first | test first (owner test O2); no code change | 2026-11-26 | Claude | SCOPE |

## Owner items (need the Meta dev app — not code)

| # | Test | Settles |
| --- | --- | --- |
| O1 | On a real Unified Login token: `GET /me/permissions` and `GET /debug_token` — which answers the granted permissions | F-D4 |
| O2 | `GET /{ig-user-id}/conversations?platform=instagram&limit=1` with "Allow access to messages" off and on | F-D8 |
| O3 | Remove the app from a test business portfolio: does Meta call the deauthorize URL, and with which id | F-D6 |
| O4 | One send with a `user_email` quick reply: refused (error) or sent without the button | F2's evidence |
| O5 | App Dashboard → each Unified Login configuration's token is **Never expires**; Webhooks → Instagram object has the six fields on | F-D2 |
