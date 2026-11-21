# How the Webhook and Worker Work (Instagram Automation Backend)

## 1. Big picture

- Stack: Node.js with Express, PostgreSQL through Knex, Redis, and BullMQ for queues.
- Instagram (Meta) sends events to our webhook URL: comments, DMs and button clicks.
- The webhook does very little. It checks the signature, answers "200 OK" fast and puts the event in a queue.
- A worker takes the event from the queue and does the real work. It finds the account, matches automations, sends replies and DMs, and saves to the database.
- The webhook server and the workers run in the **same Node process**. They start together when the server starts.

Flow:
Instagram → Webhook (check, then 200 OK) → Redis queue (one per Instagram account) → Worker (one per account) → Processor (automation logic) → Instagram API and database

## 2. Receiving an event (POST)

1. The body parser keeps the raw bytes of the request body. The signature check needs them.
2. The app secret comes from `INSTAGRAM_APP_SECRET`, or `APP_SECRET` if that is not set. If both are missing, we return 503.
3. Signature check: the `x-hub-signature-256` header must look like `sha256=` plus 64 hex characters. We compute HMAC-SHA256 of the raw body with the app secret and compare it with a timing-safe compare. If it does not match, we return 403.
4. Parse the JSON.
5. **Answer 200 "OK" right away**, so Meta does not retry.
6. Queue the work in the background, after the answer is sent.
7. If the JSON is broken or anything else fails, we still answer 200 and log the error.

## 3. Queueing (still inside the webhook)

The payload has an `entry` array. For each entry:

1. `entry.id` is the Instagram business account ID. If it is missing, the entry is skipped.
2. A short interaction ID (CID) is made for the logs. It follows the event through the queue and the worker.
3. **Echo messages** (`is_echo: true`, which are messages we sent) and **read receipts** are skipped.
   - Important: if an entry has an echo or a read receipt, the **whole entry** is skipped, even if it also has other real events. A warning is logged.
4. The code gets or creates the queue for this account and makes sure a worker exists for it.
5. Job ID is `webhook-{instagramAccountId}-{time in milliseconds}`.
   - If two entries for the same account come in the same millisecond, BullMQ keeps only the first one. The second is dropped and logged as DROPPED.
6. The job is added with the name `process-webhook`, priority 1 and this data: `entry`, `instagramUserId`, `headers`, `cid`.
7. Duplicate events (the same comment ID or message ID within 10 minutes) are **only logged** as DUPLICATE. They are still queued. This tracking lives in memory, per process.

## 4. Queues

- There is one BullMQ queue per Instagram account. The name is `webhooks-{instagramAccountId}-{NODE_ENV}`, and NODE_ENV defaults to `local`. This lets dev and prod share one Redis without mixing jobs.
- Job settings:
  - 3 tries.
  - Exponential backoff: 2s, then 4s.
  - Redis keeps the last 100 completed jobs and the last 500 failed jobs.
- Redis connection:
  - The address comes from `REDIS_URL` (default `redis://127.0.0.1:6379`).
  - TLS turns on by itself for Upstash, or when the URL starts with `rediss://`.
  - If the connection drops, it keeps reconnecting forever, waiting up to 2s between tries.
  - While Redis is offline, commands wait in memory.
- The list of known queues is kept **in the process memory only**.

## 5. Workers

- There is one worker per account queue. It is created when the first webhook for that account arrives.
- Concurrency comes from `WEBHOOK_WORKER_CONCURRENCY` (default 5). Up to 5 jobs of the **same account** can run at once, so events for one account do not always run in order.
- Rate limit: each worker runs at most 100 jobs per second.
- A scanner runs every `WEBHOOK_WORKER_SCAN_INTERVAL` ms (default 10000).
  - It makes sure every known queue has a worker.
  - It closes workers whose queue is no longer known.
  - It logs a summary only when the counts change, plus a heartbeat every 30 minutes.
- For each job, the worker:
  1. Sets the log context: account, CID, job ID, try number.
  2. Logs PROCESSING.
  3. Runs the processor.
  4. Logs COMPLETED with the time taken and the database result, or FAILED with retry info.
  5. If a try fails after messages were already sent, it logs "DUPLICATE RISK", because the retry can send those messages again.
- A stalled job (worker crash or lost lock) is run again by BullMQ and logged as STALLED.
- On shutdown (SIGTERM or SIGINT), it stops the scanner, closes all workers and exits.

## 6. Processor: what one job does

1. It starts **one database transaction** for the whole job.
2. It finds the account by `platform_user_id` = Instagram ID and `type` = INSTAGRAM.
   - If not found: rollback and return "account not found". No retry.
3. **Automation On/Off switch.** If `automation_enabled` is false on any matching account row:
   - All events are skipped, with rollback.
   - It returns success, so there is no retry.
   - The skipped events are never processed later.
4. Each messaging event (DMs, button clicks) goes to the DM handler.
5. Each change event: `comments` goes to the comment handler, and `messages` goes to the DM handler.
6. It commits. If an earlier database error broke the transaction, Postgres turns the commit into a rollback, and this is logged.
7. If an error is thrown at this level, it rolls back and the worker retries.

**Important:** the comment and DM handlers catch their own errors and only log them. So most errors do **not** cause a retry. Retries mostly happen for errors outside the handlers, like the account lookup or the transaction start or commit.

## 7. Comment flow

1. It needs the commenter ID and the post (media) ID. If either is missing, it skips.
2. It finds or creates the contact.
3. **"Next post" automations.** If the post is new to us and an automation is waiting for "the next post", this post is linked to it.
   - This costs one Graph API call. The result is cached in the account media table.
   - It runs in its own savepoint, so a failure cannot break the rest of the job.
4. It finds automations that are LIVE, have trigger type COMMENTS, are set to this post or to any post, and have the DM trigger on. "Next post" automations that are still waiting or expired are left out.
5. **Email comes first.** If this person has any run waiting for their email:
   - It sends the email request again.
   - It saves the matching automations as "pending" on that run. They start after the email is collected.
   - It stops here.
6. For each automation, it checks the keywords: lowercase "contains" on any keyword. An empty keyword list matches anything.
7. If there is an unfinished run for this person and this automation:
   - WAITING for email: ask for the email again.
   - WAITING for anything else: skip.
   - RUNNING: continue that run.
   - Any other status: skip.
8. If there is no run, it creates one, writes a run log and starts the steps.

## 8. DM and button-click flow

1. It looks for an email in the message: the quick reply payload, `message.email`, or the attachments.
2. It detects story replies.
3. **Button click (postback)** with payload `automationId::runId`:
   - If the person has a run waiting for email, it sends the email request again and stops.
   - If the run is COMPLETED, it ignores the click.
   - Otherwise it sets the run back to RUNNING, logs the tap and continues the run.
   - At the follow step, it checks the follow status with the API. If the person follows, it continues. If not, it sends the follow request again.
4. If a run is waiting for **email or phone**, this message is treated as the answer and validated. A follow can only be confirmed with a button click.
5. Otherwise:
   - It finds or creates the contact.
   - It finds LIVE DM automations (or story automations for a story reply).
   - The first keyword match wins.
   - It creates a new run and starts it, or continues the existing run.

## 9. Automation steps

Run statuses: RUNNING, WAITING, COMPLETED, FAILED, CANCELLED.

Steps, in order:

1. **KEYWORD_MATCH**: already checked before the run was created.
2. **COMMENT_REPLY** (comment trigger only):
   - First, an optional public reply on the comment. Reply safety can skip it. If it fails, the flow still goes on.
   - Then the opening private-reply DM, often with a button. It is sent only if the person never chatted with us, or last chatted 24 hours ago or more.
   - If there is a button, the run goes to WAITING for the click.
3. **FOLLOW_CHECK**: if this step is turned on and the person does not follow, it sends a follow request with buttons. The run goes to WAITING "follow".
4. **EMAIL_COLLECT**: if this step is turned on and the email is not known yet, it asks for the email with a quick reply. The run goes to WAITING "email".
5. **PHONE_COLLECT**: the same for the phone number. The run goes to WAITING "phone".
6. **FINAL_DM**: it sends the final message and the run becomes COMPLETED. The contact is tagged with the automation, and any pending automations start.

Rules:

- After each step, if the run is WAITING, it stops. The next user action continues from the last step, one step at a time.
- If a needed message fails to send, the run becomes FAILED and the error is saved in the run log.
- Invalid email: it sends an error message and asks again. The run stays WAITING.
- Not a phone number: nothing is sent and the run keeps waiting.
- Run logs are written **outside** the transaction, so they are kept even after a rollback.

## 10. Instagram API calls

- Graph API at `graph.instagram.com`, version `v24.0`:
  - DM and private reply: `/{igUserId}/messages`
  - Public comment reply: `/{commentId}/replies`
  - Follow check: `/{userId}?fields=is_user_follow_business`
- Before each send there is a random wait between `IG_SEND_DELAY_MIN_MS` and `IG_SEND_DELAY_MAX_MS` (default 200 to 1000 ms), so replies look human.
- The access token comes from the account token table.

## 11. Public reply safety

- It is set per account and is off by default.
- When it is on, it checks three rules in this order:
  1. Random chance: by default 80% of comments get a public reply.
  2. Gap: skip if the last public reply was too recent. The gap is random, 20 to 60 seconds by default.
  3. Hour limit: skip if the account already sent the maximum in the last 60 minutes (default 60).
- The same reply text is never used twice in a row.
- Counts are kept in Redis with one atomic step, so 5 workers or several servers cannot pass at the same moment.
- If Redis does not answer, the reply is sent anyway.
- A handled comment is remembered for 1 hour, so a retry does not reply twice.
- It only affects the public reply. The DM always goes.

## 12. Logs

- Each entry gets a CID. When one entry has several events, they get CID-1, CID-2 and so on.
- Main log lines:
  - WEBHOOK: QUEUED, SKIPPED, DROPPED, DUPLICATE
  - WORKER: PROCESSING, COMPLETED, FAILED, RETRY, STALLED
  - WORKERS: READY, ALIVE
  - REDIS: "down", then "back after N seconds"
- Message text is only previewed, emails and phone numbers are masked, and secrets are never logged.
