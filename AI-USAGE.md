# What I did myself and where I used AI

## What I did myself

I did not write this code by hand, and I did not hand the task over either. My part was to direct the work: decide what gets built, how it is checked, and what is good enough to send.

- **Set the task and the bar.** I wrote the initial prompt and chose the shape of the answer: a design document backed by a reference implementation, because a claim like "a reply racing a timeout is safe" should be shown, not asserted.
- **Steered by asking questions.** The direction came from what I kept asking for: how the Instagram connection actually behaves, capacity estimates by stage, a test behind every claim that can be tested. Those questions are why the design starts from the platform's limits and not from a generic workflow engine.
- **Controlled the architecture.** The AI proposed; I reviewed each proposal and decided what went in and what stayed.
- **Set up how the AI works.** The work was split into a main session that owns the contracts and sub-agents that implement against written specifications, each reviewed before the next one starts. Project rules the AI has to follow are in `CLAUDE.md`: the engine stays pure, typecheck and tests pass before every commit.
- **Did not take the result on trust.** I had one agent try to break the system, and later a separate session review the finished repo against the brief. Between them they found five real problems, all fixed and all described in `docs/`.
- **Made the scope calls.** What is built, what is only designed, and what is left as an open product question (README sections 12 and 13).

## Where I used AI

I built this with Claude Code. It did the typing and a large share of the design work, under the direction described above. Concretely:

- **Architecture proposal.** I asked for a plan and an architecture. The framing of the problem around two facts (no correlation ID on a typed reply; non-idempotent sends), the Postgres-only choice, the conversation as the unit of locking, the outbox with a delivery policy per message kind, and the `ask` step all came out of that conversation.
- **Platform facts.** The Instagram constraints (one private reply per comment within 7 days, the 24-hour window, 750 private replies an hour) were looked up by the AI in Meta's documentation. The sources are linked in `docs/capacity.md`.
- **Contracts.** The shared types and the store and adapter interfaces were written by the main AI session.
- **Implementation.** Four sub-agents wrote the code against those contracts, each with a written specification: the pure engine, the two stores, the runtime, and the adversarial tests. The main session reviewed each one before the next started.
- **Tests.** All tests were written by AI. The last agent was asked to break the system and found the two bugs described in `docs/testing.md`; it also ran the mutation checks reported there.
- **Review.** I had a separate AI session review the finished repo against the brief. It found three more things, which it then fixed: the worker loop stopped on any error, a message written before the question was counted as a wrong answer, and the capacity estimate did not cover send throughput.
- **Documents.** The README and the files in `docs/` were drafted by AI.
