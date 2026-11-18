# Capacity, stages and spikes

All load figures here are **my assumptions**, chosen to be plausible for a product with thousands of paying customers. I have no access to real numbers. What matters is the method and where the design changes, not the exact values.

## Cost of one run

The example automation, start to finish:

| | Count |
|---|---|
| Transactions | about 8 (trigger, 3 claims, 3 settles, 1 reply) |
| Row writes | about 25 (run insert and updates, 3 effects with claim and settle, log lines, message, lead) |
| Platform calls | 3 (public reply, private reply, DM) |
| Inbound webhooks | 2 or more (comment, reply, plus echoes) |

A waiting run costs one row and one entry in a partial index. Nothing else.

## Stages

Assumption: one in ten customers uses the feature, and an active account gets about 50 matching comments a day outside of spikes. Peak is taken as ten times the daily average.

| Stage | Accounts using it | Runs / day | Row writes, avg | Row writes, peak | What the design needs |
|---|---|---|---|---|---|
| Today | 1,000 | 50,000 | 15 / s | 150 / s | Exactly what is in this repo. One Postgres. Worker count follows from sends, below. |
| 10× | 10,000 | 500,000 | 150 / s | 1,500 / s | Same shape. Partition `run_log`, `messages` and `inbound_events` by month and drop old partitions. Move finished runs out of the hot table or rely on the partial indexes, which already exclude them. |
| 100× | 100,000 | 5,000,000 | 1,500 / s | 15,000 / s | A single primary is now the constraint. Changes below. |

### Sends, not writes, set the number of workers

The table above counts database writes, which Postgres absorbs easily. The tighter limit is the outbox worker, which makes one platform call at a time.

| | Sends |
|---|---|
| Per run | 3 |
| Today, average | 150,000 a day, about 1.7 / s |
| Today, peak | about 17 / s |
| One worker | 1 / (latency of a platform call): about 3 / s at an assumed 300 ms |

So two workers cover the average with room to spare, and the assumed peak needs about six. Until then the outbox simply runs behind for the length of the peak, which delays messages and loses none. Two ways to add throughput:

- **More workers.** Needs nothing new: each due row goes to one claimer, and the concurrency tests run four workers at once.
- **Concurrent sends inside a worker.** Cheaper per dyno. Sends for one conversation are already serialised by the run (one message in flight per run), so a batch can go out in parallel; what has to be kept is the lease check before each send and the per-account stop on a rate limit. Not built.

The latency is my assumption; the number to watch in production is the age of the oldest due row in the outbox.

Storage at today's stage: about 1.25 million rows a day, most of them log lines. At a few hundred bytes each that is well under a gigabyte a day before retention.

### What changes at 100×

In the order I would do them, each only when a measurement says so:

1. **Stop writing the run log to Postgres row by row.** It is the largest write volume and the least important to transact. Batch it, or ship it to cheaper storage.
2. **Move webhook ingest behind a queue** (SQS). The endpoint then only verifies and enqueues, and Postgres is protected from the burst. The transactional outbox for *sending* stays in Postgres, because its value is committing with the run.
3. **Partition by account.** Every query and every lock in this design is already scoped to an account or a conversation, and no transaction spans two accounts. That makes sharding by account a mechanical change, which is the main thing the data model buys for the future.
4. **Replace polling with notification** for the outbox, to cut idle queries.

What I would not do at any of these stages is adopt a workflow engine. The run model stays a row and a pure function; only the plumbing around it changes.

## Spikes: the platform is the bottleneck

Meta's limit for private replies to comments on posts and reels is **750 calls per hour per Instagram account**. That is 18,000 a day, and about 126,000 inside the 7 days in which a comment can still receive its private reply.

A viral reel with 100,000 matching comments in one hour therefore takes more than five days to work through, whatever we build. So during a spike the system has four jobs:

| Job | How |
|---|---|
| Absorb | Ingest is one small transaction per comment. 30 comments a second from one account is nothing. Runs are created `queued` or go straight to the outbox. |
| Pace | Today: a rate-limit response throttles the account until the platform's retry-after, and the attempt is not counted against the message. Next: a token bucket per account so we rarely hit the limit at all. |
| Stay fair | The throttle is per account, and the outbox claim skips throttled accounts, so one customer's backlog never delays another's sends. A per-account cap on claimed rows per batch would make that a guarantee rather than a tendency. |
| Shed and report | A matched comment that cannot be reached within 7 days should be marked expired up front, and the customer should see "12,400 queued, about 16 hours" in the product. Not built. |

The backlog order (newest first converts better, oldest first loses fewer to the deadline) is a product decision; see the open questions in the README.

Other limits that matter less: ordinary text DMs are limited per second (100 on the Instagram Login path), far above anything one account's conversations produce. The conversations API is limited to 2 calls a second, which is why reconciliation by polling must be slow and targeted, not a substitute for webhooks.

## Sources

- [Meta: Private Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies)
- [Meta: Messenger Platform rate limits](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting)
- [Meta: Instagram webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks)
- [Meta: Messenger Platform webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks)
