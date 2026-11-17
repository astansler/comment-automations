# Failure modes and races

Each row is something that will happen in production, what the system does about it, and the test that demonstrates it. Scenario tests live in [`test/runtime.scenarios.ts`](../test/runtime.scenarios.ts) and run against both the in-memory store and real Postgres.

## Inbound: webhooks

| What happens | What the system does | Test |
|---|---|---|
| The same comment webhook is delivered twice | The event ID is a primary key; the second insert is a no-op and nothing else runs | `ignores a redelivered comment webhook, and a second event for the same comment` |
| A different event arrives for a comment that already triggered | `(automation, comment)` is unique; the run is found and reported as already triggered | same test |
| The same message webhook is delivered twice | The message ID is a primary key | `ignores a redelivered message webhook` |
| Our own "Sent you a DM!" comes back as a comment containing a keyword | Comments authored by the account never match a trigger | `does not trigger on the account's own comment containing the keyword` |
| The platform echoes a message we sent | Ignored, not stored | `ignores the echo of a message we sent and does not store it` |
| A DM from someone with no run | Stored, left unconsumed for the human inbox | `stores a message from a contact with no run and leaves it unconsumed` |
| A webhook never arrives | Not handled by this code. Needs a slow reconciliation poll per account with waiting runs | designed only |

## Correlating a reply with a run

| What happens | What the system does | Test |
|---|---|---|
| The person answers before we have recorded that the question was delivered | The message is stored unconsumed; when the run starts waiting it drains stored messages and proceeds | `uses a reply that arrives before the prompt is acknowledged, without waiting for another one` |
| The reply has no email in it | Reprompt, up to `maxAttempts`; the deadline does not move | `reprompts on a reply without an email, without extending the deadline, then completes` |
| They never send an email | `failed` with `no_valid_reply` | `fails the run with no_valid_reply when every attempt is used up` |
| Nobody answers | `expired` at the deadline; a later message is not attributed to the dead run | `expires a run nobody answers, and leaves a later message unmatched and unconsumed` |
| Reply and timeout are due at the same moment | Both go through the same locked transition. Whichever commits first decides; the other is a no-op | `lets a reply ingested at the deadline win over the timer due in the same tick`, `expires the run when the timer is processed first, and leaves the reply unmatched` |
| Two automations want the same person's email | The second run queues. When the first ends it is promoted, skips its question because the email is known, and sends its link as the private reply to its own comment | `queues a second automation for the same contact and promotes it when the first ends, asking only once` |
| One comment matches two automations | Only one run starts (first by automation ID); the other is reported `comment_taken`. A comment has one private reply to give | `starts only one automation per comment, so a second run never mistakes the first run's private reply for its own` |
| The same person comments again and again | One run per comment, and a cooldown per contact per automation | `skips a re-trigger by the same contact inside the cooldown window, and accepts one after it` |

## Outbound: sending

| What happens | What the system does | Test |
|---|---|---|
| Temporary platform error | Back to pending with exponential backoff | `retries a retryable error after the backoff and delivers once` |
| Rate limit | The account is throttled until retry-after; the attempt is not counted; other accounts are unaffected | `throttles a rate-limited account without counting the attempt, while other accounts keep sending` |
| The public reply keeps failing | Given up; the run continues, because a courtesy comment must not cost the lead | `gives up on a public reply after the last attempt and lets the run continue` |
| A DM keeps failing | The run fails with `retries_exhausted` | `fails the run when the link DM runs out of attempts` |
| The person has blocked DMs, or the comment is gone | The run fails with the platform's code; the conversation is freed for the next queued run | `fails the run on a permanent DM error and promotes the queued run of the same conversation` |
| The customer cancels while a message is queued | The message is never sent | `cancelling a run drops its pending effect undelivered and promotes the next queued run` |

## The unknown outcome: the platform accepted, we did not record it

This is the case that cannot be engineered away, only decided. One test per policy:

| Message | What the system does | Test |
|---|---|---|
| Private reply | Retried; the platform refuses the second one; counted as sent. Delivered once | `private_reply (retry_safe): retried, the platform answers already_sent, delivered once` |
| Public reply, platform confirms it arrived | Not resent | `reply_to_comment (at_most_once): not resent; after the lease lapses reconcile says sent` |
| Public reply, platform cannot tell us | Assumed sent, never resent | `reply_to_comment (at_most_once): reconcile unknown is assumed sent and never resent` |
| Public reply, platform confirms it did not arrive | Sent once | `reply_to_comment (at_most_once): a throw before reaching the platform reconciles as not_sent and sends once` |
| The link DM | **Delivered twice.** The run still completes once | `direct_message (at_least_once): the link is delivered twice by design, and the run completes once` |
| A worker dies between claiming and sending | The lease expires, another worker claims the row and applies the policy above | `reclaims an effect whose worker died between claim and send once the lease lapses, and applies its policy` |

## Workers stepping on each other

| What happens | What the system does | Test |
|---|---|---|
| A worker's lease expires partway through its batch and another worker has already sent the rest | The first worker checks its lease before every send and does not send | `does not send a batched effect whose lease lapsed before its turn, even after another worker sent it` |
| Same, but nobody has reclaimed the message yet | It goes back to pending as unsent, so it is not later treated as possibly delivered | `puts a batched effect whose lease lapsed before its turn back to pending, unsent and not in doubt` |
| A slow worker tries to write over a newer claim | Writes are fenced on the attempt counter and are dropped | `does not take back another worker's claim: a lapsed batch member reclaimed by a worker that died after sending stays in doubt` |
| Two workers claim at the same instant | `FOR UPDATE SKIP LOCKED`: each due row goes to one claimer | `test/store.pg.test.ts`, `test/concurrency.pg.test.ts` |
| Thirty comments from one person at once | Runs execute strictly one at a time for that conversation | `test/concurrency.pg.test.ts` (hammer) |

## Definitions and versions

| What happens | What the system does | Test |
|---|---|---|
| A customer edits an automation while conversations are in progress | Those runs finish on the version they started with; new comments use the new one | `keeps a run on the version it started with; new comments use the latest; a disabled latest triggers nothing` |
| A definition that would need two private replies | Rejected at publish with the step named | `rejects a definition that would send two DMs before the contact replies, and stores nothing` |

## Known gaps

Things I know are not handled, in rough order of how much I would worry about them.

1. **A send slower than its lease.** If one platform call takes longer than the lease (60 seconds by default), a second worker can claim the same message while the first call is still in flight. For private replies the platform deduplicates. For the link it is one more route to the duplicate the policy already accepts. For the public reply it can produce a real duplicate, because reconciliation may truthfully answer "not sent" about a request that is still on its way. The fix is a request timeout comfortably below the lease, which belongs in the adapter.
2. **Someone else spends the private reply.** If a person on the customer's team privately replies to the comment by hand before the automation does, the platform answers "already sent" and the run believes its own message was delivered. Detecting this needs the echo webhook.
3. **Reconciliation is only as good as the platform's read-after-write.** If listing a comment's replies lags behind posting one, "not sent" can be wrong.
4. **A split answer costs a needless reprompt.** "sure" followed by "it's jane@example.com" in a second message: the first message triggers a reprompt, the second completes the run. Correct outcome, slightly awkward conversation. A short debounce before judging a reply would fix it.
5. **A late reply is accepted if it beats the timer.** A reply that arrives after the deadline but before a worker has processed the timeout completes the run. I consider that the right behaviour (the person answered), but it means the deadline is "at least", not "exactly".
6. **Clock comparison across systems.** "This message predates the run" compares the platform's message timestamp with our clock.
7. **Cancel while a public reply's outcome is unknown.** The outbox row is marked failed (`run_ended`) although the reply may have been posted. Nothing is sent; the record can be wrong.
8. **Rate-limit knowledge can be lost in a crash** between the platform's answer and our write. The next attempt rediscovers it.
