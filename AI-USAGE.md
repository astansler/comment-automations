# What I did myself and where I used AI

> **Draft, to be completed by me before submitting.** The AI section below is an accurate record of the session that produced this repo. The "myself" section must only list things that are true.

## Where I used AI

I built this with Claude Code, and it did most of the typing and a large share of the design work. Concretely:

- **Architecture proposal.** I asked for a plan and an architecture. The framing of the problem around two facts (no correlation ID on a typed reply; non-idempotent sends), the Postgres-only choice, the conversation as the unit of locking, the outbox with a delivery policy per message kind, and the `ask` step all came out of that conversation.
- **Platform facts.** The Instagram constraints (one private reply per comment within 7 days, the 24-hour window, 750 private replies an hour) were looked up by the AI in Meta's documentation. The sources are linked in `docs/capacity.md`.
- **Contracts.** The shared types and the store and adapter interfaces were written by the main AI session.
- **Implementation.** Four sub-agents wrote the code against those contracts, each with a written specification: the pure engine, the two stores, the runtime, and the adversarial tests. The main session reviewed each one before the next started.
- **Tests.** All tests were written by AI. The last agent was asked to break the system and found the two bugs described in `docs/testing.md`; it also ran the mutation checks reported there.
- **Documents.** The README and the files in `docs/` were drafted by AI.

## What I did myself

<!--
Fill in truthfully. Candidates, only if they are true by the time this is sent:
- Set the direction: asked for capacity estimates by stage, for how the Instagram
  connection works, for everything to be tested, for a reference implementation.
- Read every file in src/ and can explain each decision without notes.
- Decisions I made or changed after reviewing the draft (list them, with why).
- Positions on the open product questions in README section 13.
- Anything I disagreed with and changed.
-->

## How I worked with it

<!-- One short paragraph in my own words: what I checked, what I did not take on trust, what I would do differently. -->
