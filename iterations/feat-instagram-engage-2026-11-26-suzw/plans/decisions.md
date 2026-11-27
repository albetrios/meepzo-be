# Decisions — feat-instagram-engage-2026-11-26-suzw

Add-only; a changed mind is a new row that supersedes an old one.

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| E-D1 | Step 0 — plan this iteration (engage, then insights) | engage · insights | **engage first**, Baseline none (brief from scratch) | 2026-11-26 | user | RED |
| E-D2 | Step 4 — which comments the inbox stores (E1) | every comment · watched posts only | **every comment** on the account's posts and reels, from the webhook, answered or not | 2026-11-26 | user | RED |
| E-D3 | Step 4 — retention of comments and mentions (E5) | 90 days · 12 months | **90 days**, as the comment log (`AUTOMATION_RUN_KEEP_DAYS`), dropped by the shared upkeep | 2026-11-26 | user | RED |
| E-D4 | Step 4 — what starts a `mention` automation (E4) | both · comment mentions only · list only | **both** comment and caption mentions — a 16th trigger type; the DM follows Meta's rules (owner test EO1) | 2026-11-26 | user | RED |
| E-D5 | Step 4 — access and table names | as the brief · Owner and Admin only | **as the brief**: `instagram-comment:manage` for Owner, Admin, Editor (Viewer reads); tables `app.instagram_comments`, `app.instagram_mentions` | 2026-11-26 | user | RED |
| E-D6 | Step 5 — route review sub-domain 1, Instagram comment (IC1–IC6, routes 175–179) | confirm · change | **confirmed as drafted** (rev 1) | 2026-11-27 | user | RED |

## Owner items (need the Meta dev app — not code)

| # | Test | Settles |
| --- | --- | --- |
| EO1 | Which payload the `mentions` field sends under Unified Login (caption vs comment mention), and the read that returns its text (`mentioned_media` / `mentioned_comment`) | E7, data.instagram-mention |
