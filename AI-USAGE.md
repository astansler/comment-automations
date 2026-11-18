# What I did myself and where I used AI

## What I did myself

- **The initial prompt.** I wrote the prompt that set the task for the AI session.
- **Control of the architecture.** The architecture was proposed by the AI. I reviewed it and controlled what went in and what stayed.

Everything else was done with AI, as listed below.

## Where I used AI

I built this with Claude Code. It did the typing and a large share of the design work. Concretely:

- **Architecture proposal.** I asked for a plan and an architecture. The framing of the problem around two facts (no correlation ID on a typed reply; non-idempotent sends), the Postgres-only choice, the conversation as the unit of locking, the outbox with a delivery policy per message kind, and the `ask` step all came out of that conversation.
- **Platform facts.** The Instagram constraints (one private reply per comment within 7 days, the 24-hour window, 750 private replies an hour) were looked up by the AI in Meta's documentation. The sources are linked in `docs/capacity.md`.
- **Contracts.** The shared types and the store and adapter interfaces were written by the main AI session.
- **Implementation.** Four sub-agents wrote the code against those contracts, each with a written specification: the pure engine, the two stores, the runtime, and the adversarial tests. The main session reviewed each one before the next started.
- **Tests.** All tests were written by AI. The last agent was asked to break the system and found the two bugs described in `docs/testing.md`; it also ran the mutation checks reported there.
- **Review.** I had a separate AI session review the finished repo against the brief. It found three more things, which it then fixed: the worker loop stopped on any error, a message written before the question was counted as a wrong answer, and the capacity estimate did not cover send throughput.
- **Documents.** The README and the files in `docs/` were drafted by AI.
