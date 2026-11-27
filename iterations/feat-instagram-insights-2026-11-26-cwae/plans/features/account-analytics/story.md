# Feature 1 — account analytics (our numbers)

**As** an owner, **I want** to see what our automations and broadcasts brought each day, week and month, **so that** I know the automations pay off.

Requirements: `analytics.own-numbers`, `analytics.organization-day`, `background.day-count-increment`, `background.day-count-fill`, `data.analytics-day-counts`, `quality.pre-aggregated`, `access.analytics-read`, `quality.insights-retention`, `quality.tenant-isolation`.

## Acceptance criteria

- AC-1.1 — Each source commit (a DM sent, a reply, a tap, an email, a phone, a new contact, a first response) raises that day's count once; a rolled-back commit counts nothing.
- AC-1.2 — Route 182 answers totals and a zero-filled series by day, week or month in the organization's time zone; 183 and 184 the same for one automation or broadcast; the numbers match the run and message tables for the range.
- AC-1.3 — After the one-time fill, the stored history (runs 90 days, messages a year) shows; rerunning the fill changes nothing.
- AC-1.4 — A Viewer reads; another organization's account, automation or broadcast is 404; no plan limits the range.
