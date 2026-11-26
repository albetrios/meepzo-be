# Requirements — hand-off — sub-domain 2.A

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `hand-off.hold` | a taken conversation holds every automation DM to that contact on that account (`conversation_taken`) | rule 4, AC 4, I-D3 | CV4 |
| `hand-off.idle-release` | 24 hours with no team message releases the conversation | I-D3 | CV4 |
| `hand-off.instagram-app-takeover` | an echo our app did not send takes the conversation as `instagram_app` | rule 13, AC 8 | CV4 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `hand-off.hold` | only the default reply, 6 h | every automation DM waits |
| `hand-off.idle-release` | — | 24 h |
| `hand-off.instagram-app-takeover` | owner_message only | taken |
