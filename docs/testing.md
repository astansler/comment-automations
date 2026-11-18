# Testing

249 tests in four layers. Everything runs with `npm test`; the Postgres layers need `DATABASE_URL` and skip without it.

| Layer | Files | What it is for |
|---|---|---|
| Engine | `engine.test.ts`, `engine.properties.test.ts` | The pure `transition` function: 69 example tests and 6 properties, each over 500 random definitions and event sequences |
| Stores | `store.contract.ts` run by `store.memory.test.ts` and `store.pg.test.ts` | One suite of 42 tests that both stores must pass, plus Postgres tests with separate connections for locking and `SKIP LOCKED` |
| Scenarios | `runtime.scenarios.ts` run on both stores | 38 named situations, each asserting the run's state and what the fake platform actually received |
| Adversarial | `simulation.test.ts`, `concurrency.pg.test.ts` | Randomized whole-system simulation with crash injection; real concurrency on Postgres |

The fake platform ([`test/support/fakePlatform.ts`](../test/support/fakePlatform.ts)) enforces the two Instagram rules the design depends on: a second private reply to the same comment is refused, and a DM to someone who has not written is refused. A test cannot pass by doing something the real platform would reject.

## The simulation

Each of 1,000 generated sequences drives a real runtime over the in-memory store, the fake platform and a manual clock with up to about sixty actions drawn from:

- comments (matching, non-matching, redelivered, a new event for an old comment, the account's own);
- messages (an email, junk, redelivered, timestamped slightly in the past);
- worker ticks and clock jumps (backoff-sized, lease-sized, timeout-sized);
- platform faults on the next send (temporary, rate limited, permanent, failing before or after the platform accepted);
- reconciliation answering "unknown";
- cancelling a run;
- things happening inside a send (a fast reply, a second worker after the lease expired, a cancel);
- two calls in flight at once;
- crashes at the storage boundary: the next transaction fails either before it runs, or **after it commits**, so the caller never learns it succeeded.

It is deterministic. A failure prints a seed and path, and `SIM_SEED=<seed> SIM_PATH=<path> npx vitest run test/simulation.test.ts` replays it.

### Invariants, checked after every action

| | Claim |
|---|---|
| I1 | At most one run per conversation is active. No run is stored in the transient `running` state. A queued run exists only behind an active one. |
| I2 | At most one run per trigger comment. No run is started by the account's own comment. Two runs of an automation for one contact are further apart than its cooldown. |
| I3 | The platform never refused a send for breaking its rules: no DM outside the window, and no private reply answered "already sent" unless that same message had been delivered. At most one private reply delivered per comment. |
| I4 | Public replies and private replies are delivered at most once per message, under every fault. A later DM is delivered twice only if a fault touched that exact message: a failure after delivery, a crash while sending, or a lease that expired during the send. |
| I5 | A run is waiting on a send if and only if the message it names is pending or being sent. Every pending message belongs to a run waiting on exactly it, or to a run that has ended. |
| I6 | A consumed message was consumed by one run, of its own conversation, that had started by the time the message was received. A run examines at most `maxAttempts` messages per question. No run expires while a reply it could have used sits unconsumed: one written after its question was recorded as delivered, or an earlier one that contains the email asked for. |
| I7 | Within a run, deliveries happen in step order. No send is started for a run that has already ended. |
| I8 | Every stored lead value came from a message that contact actually sent. |
| I9 | A run that has ended never changes again. Checked after every commit. |
| I10 | A message recorded as sent reached the platform, unless it is a public reply explicitly recorded as "outcome unknown, assumed sent". |
| I11 | A question marked `skipIfKnown` is never sent to someone whose answer was already stored when the run started. |
| I12 | A settled message never changes again. Checked after every commit. |
| I13 | A run never expires before its question's timeout has elapsed since the question was delivered. |
| I14 | No send starts while a recorded throttle for its account and kind of message is in the future. |
| I15 | A failed public reply never ends a run. |
| Liveness | With faults switched off, ticking and advancing the clock reaches a state where every run has ended and every message is sent or failed. |

The test also fails if any of thirty listed situations was never reached during the run (a crash after commit, a drained early reply, a duplicated DM, an assumed-sent public reply, and so on), so the generator cannot quietly stop exercising what the invariants are about.

Two of these are narrower than they first look, and the narrowing is itself a finding:

- **I14** originally compared against the retry-after the platform announced. That failed legitimately: a crash between the platform's answer and our write loses the throttle. The claim that holds is about throttles that were committed.
- **I7**'s second half is asserted only while no calls overlap. The worker checks "has this run ended?" without a lock just before sending, so a cancel that commits in that instant is indistinguishable from a send already in flight.

## The two bugs it found

Both were in the runtime, which at that point passed all 216 existing tests.

**1. One comment, two automations.** Found by I3 and I10. A comment matching two automations created two runs on the same comment. The first spent the comment's private reply. The second run's first DM was also a private reply to that comment; the platform said "already sent", the `retry_safe` policy read that as success, and the message never reached the person. Fix: a comment starts at most one run, enforced by a unique index on `(account, trigger comment)`.

**2. A lease that covers a batch.** Found by I4. Worker A claims messages E1 and E2 under one lease. E1's send outlasts the lease. Worker B reclaims E2, reconciles it, sends it, settles it. A finishes E1 and moves to E2, which it believes it freshly claimed, and sends it again with no reconciliation: a duplicate public reply. Fix: before each send the worker checks that its lease has not expired; if it has, the message goes back to pending (fenced on the attempt counter) and is never treated as possibly delivered.

## Do the tests have teeth?

Twenty-one bugs were introduced into `src/` one at a time, then reverted. "Caught" means the simulation failed at 1,000 sequences with a random seed.

| Mutation | Caught by simulation | Invariant |
|---|---|---|
| Do not drain stored replies when a run starts waiting | yes | I6 |
| Do not promote the next queued run when one ends | yes | I1 |
| Settle a message without checking it is still being sent | yes | I12 |
| Retry a public reply after an unknown outcome | yes | I4 |
| Drop the "message predates the run" check at ingest | yes | I6 |
| Drop the same check when draining | yes | I6 |
| Remove the attempt-counter fence on rescheduling | about 4 runs in 10 | I4; a deterministic scenario was added |
| Remove the lease check before sending (fix 2) | yes | I4 |
| Allow two runs per comment (fix 1) | yes | I2 |
| Treat "unknown" from reconciliation as "not sent" | yes | I4 |
| Send for a run that has ended | yes | I7 |
| Engine: fire a timer before its deadline | **no** | caught by engine tests |
| Start a promoted run without the known lead fields | yes | I11 |
| Engine: a message during a send does not open the window | **no** | caught by scenarios |
| Send a reprompt as a private reply | yes | I3 |
| Ignore the account throttle when claiming | yes | I14 |
| Do not record that a message was consumed | yes | I6 |
| Cancel without promoting the next run | yes | I1 |
| A failed public reply fails the run | yes | I15 |
| Remove the cooldown check | yes | I2 |
| Let the account's own comments trigger | yes | I2 |

Why two survive the simulation:

- **Timer before deadline.** The store only lists timers that are already due, so the engine's own check matters only if a run passes one deadline and reaches a later question between a worker listing timers and taking the lock. The simulation interleaves whole transactions and cannot produce that; the engine's unit and property tests do.
- **Window flag during a send.** The flag only chooses between a private reply and an ordinary DM in a situation where both are allowed, so no safety invariant can see the difference. The scenario tests assert the kind and catch it.

The Postgres concurrency tests were checked the same way: removing the conversation lock, removing `SKIP LOCKED`, reverting fix 1 and removing the drain each make them fail.

## What is still not tested

- A platform call that is still in flight when its lease expires (the simulation's version fires after the platform accepted).
- Clock skew between workers, which the lease already assumes away.
- Crash injection against Postgres. The fault-injecting store wrapper is used with the in-memory store in the simulation and in one Postgres scenario.
- The reconciliation poll for missed webhooks, which is not built.
