# Bottleneck: notes for the coding agent

- **Read `docs/PROJECT.md` first.** It is the single project document: status, decisions (D-NNN), review-notes triage, the re-sorted acceptance checklist, Fixed rules, phase plans/summaries and learning notes. The owner wants everything in that one file. Do not create `docs/plans/`, `docs/decisions/` or `docs/how-it-works/` files; add sections to PROJECT.md instead.
- Spec: `docs/spec/Bottleneck-specification-v0.2.pdf` plus `docs/spec/keep-in-mind.md`. PROJECT.md overrides the spec where they differ.
- Git: work on a `phase-N` branch, run `npm run check`, then merge into `main` and push. The owner allows merging to main without a PR.
- Hosting: Vercel builds `main` (config in `vercel.json`).

## Engine rules (enforced by lint and tests)
- `packages/engine/src` is pure: no DOM, Node, network, clock or `Math.random`.
- No `Math.exp/log/pow/sin/...`: use `detmath.ts`. Randomness only via `uniform(seed, stream, entity, index)` from `rng.ts`. Add new `RandomStream` values; never renumber existing ones.
- Iterate in id order, never in Map/Set insertion or hash order.
- If the engine's numbers change on purpose, update `EXPECTED_SELF_CHECK_HASH` and the inline snapshots, and say why in the commit.

## Commands
`npm run check` (everything CI runs) · `npm test` · `npm run dev` · `npm run schema:gen` after editing `/schema`.
