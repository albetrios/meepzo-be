# Worker changes — feat-instagram-engage-2026-11-26-suzw

Mode initial · Intake mode brief · 2026-11-26.

| Change | Count |
| --- | --- |
| NEW | 3 |
| CHANGED | 2 |
| REMOVED | 0 |

| # | Change | Background work | When it runs | What it touches | On failure | Who is told | Requirement | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WC-1 | CHANGED | the webhook comment processing also stores the comment | a comment event is processed | instagram_comment | the event's own retry; one row per comment id (a repeat changes nothing) | nobody | `background.comment-store` | B:42 |
| WC-2 | CHANGED | the account set-up and subscription check subscribe `mentions` too | at set-up and every subscription check | the account's webhook fields | as today (retry ladder) | as today | `integrations.mentions-webhook` | B:36 |
| WC-3 | NEW | process a mention event: store it, start a mention automation when one is live | a `mentions` webhook item | instagram_mention, runs | the event's own retry; never doubled | nobody | `background.mention-store` | B:9-10 |
| WC-4 | NEW → **none** (IC3) | ~~send a team reply / hide / unhide / delete to Meta, paced~~ — the route review sends them **directly in the request, gated** (K4), not in the background; kept as a record | — | — | — | — | `quality.comment-writes-paced` | B:32 |
| WC-5 | NEW | comment and mention retention | daily | instagram_comment, instagram_mention | safe to retry | nobody | `quality.comment-retention` | B:38 |
