# Route changes — feat-instagram-engage-2026-11-26-suzw

Mode initial · Intake mode brief · 2026-11-26 · proposals (method + path); the route review (Step 5) settles them.
Route numbers continue from 175 (route review sub-domain 1: 175–179; sub-domain 2: 180–181). Base `/api/v1/app/social`.

| Area | NEW | CHANGED | REMOVED |
| --- | --- | --- | --- |
| Comments | 5 | 0 | 0 |
| Mentions and tags | 2 | 0 | 0 |
| Automations | 0 | 2 | 0 |
| **Total** | **7** | **2** | **0** |

## Comments

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-1 | NEW (route 175) | GET | `/instagram/accounts/{channel_account_id}/comments` | instagram-account · read | list comments (filters: post, not answered, automation answered) | B:5-6 |
| RC-2 | NEW (route 176) | POST | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}/replies` | instagram-comment · manage | reply publicly | B:7 |
| RC-3 | NEW (route 177) | POST | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}/hide` | instagram-comment · manage | hide | B:7 |
| RC-4 | NEW (route 178) | POST | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}/unhide` | instagram-comment · manage | unhide | B:7 |
| RC-5 | NEW (route 179) | DELETE | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}` | instagram-comment · manage | delete | B:7 |

## Mentions and tags

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-6 | NEW (route 180) | GET | `/instagram/accounts/{channel_account_id}/mentions` | instagram-account · read | list mentions | B:9 |
| RC-7 | NEW (route 181) | GET | `/instagram/accounts/{channel_account_id}/tagged-media` | instagram-account · read | list tagged media, live from Meta | B:11 |

## Automations

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-8 | CHANGED | POST | `/automations` | automation · create | accepts `trigger_type: mention` | B:10, B:22 |
| RC-9 | CHANGED | PATCH | `/automations/{automation_id}` | automation · update | same | B:10 |

## Before → after

| # | Route | What changes | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| RC-8 | `POST /automations` | input | 15 trigger types | + `mention`, optional `trigger.config.sources` (`caption` · `comment`) | B:10 |
| RC-9 | `PATCH /automations/{automation_id}` | input | 15 trigger types | + `mention`, optional `trigger.config.sources` (`caption` · `comment`) | B:10 |
