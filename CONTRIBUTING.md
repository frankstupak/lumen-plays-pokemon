# Contributing

Thanks for taking a look. This document covers how to build the project, how to
get a change reviewed, and how the commit history is expected to read.

## AI assistance disclosure

Most of this codebase is written by an AI agent (Claude, running under the
Lumen Industries automation fleet) working from tickets, under human review.
Commits carry an `Assisted-by:` footer to say so. The maintainer is accountable
for every line that lands: if a change cannot be explained and justified, it
does not get merged. Contributions from humans are welcome on the same terms.

## Build and test

Requires Node 20+ and a legally-obtained Pokémon Blue ROM at `roms/pokeblue.gb`
(never committed — see the README).

```bash
npm install
npm run verify     # symbol table + ROM integrity gate
npm run build      # tsc type-check
npx tsc --noEmit   # same check without emitting
npm run p1         # end-to-end gate: boot through Route 1
```

Capability-level acceptance probes live in `src/probe_*.ts` and run with
`npx tsx src/probe_<name>.ts`. A change to a subsystem is expected to keep that
subsystem's probe passing, and to add a probe when it adds a capability.

`npm test` is currently a placeholder that exits non-zero; `npm run build` plus
the relevant probes are the real gate.

## Branches

One logical change per branch, named `<type>/<short-kebab-slug>`:

```
feat/notepad-eviction
fix/whiteout-recovery
docs/readme-quickstart
chore/deps-bump
```

Branches are short-lived — hours, not weeks — and are deleted when their pull
request merges. `main` is always deployable and is never force-pushed.

## Commit messages

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <imperative summary, lowercase, no trailing period>

Why this change exists, what was wrong before, and the tradeoff that was made.
Wrap at 72 characters.

Refs: <issue or ticket>
Assisted-by: Claude (Anthropic) via Lumen Industries automation
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci`
`chore` `revert`. A breaking change is `feat(api)!:` plus a `BREAKING CHANGE:`
footer describing the migration.

Issue and ticket references belong in the `Refs:` footer, never in the subject
line — the subject should mean something to a reader who has never seen this
project's tracker. Status, progress, and coordination notes are not commits.

## Pull requests

Every change arrives through a pull request, including the maintainer's own.
Keep them under roughly 400 changed lines; past about 1000, split them.

The title is the Conventional Commit subject. The body follows the template:
What, Why, How, Testing, Risk / rollback. Describe the code and the defect —
not the person who wrote it. Pull requests merge by squash, so the title
becomes the commit on `main`.

## Code style

- TypeScript, one coherent codebase under `src/`, no borrowed harness code
  (see `docs/DOCTRINE.md` for the originality rules this project holds itself
  to).
- Deterministic logic goes in tools; the model is for judgment only.
- Game state is read from emulator RAM, never from pixels.

## License

By contributing, you agree that your contributions are licensed under the ISC
License that covers this project.

## History note

Commits before
[`2f1bb4a`](https://github.com/frankstupak/lumen-plays-pokemon/commit/2f1bb4a77ceebd301e5573c92a8837c6cf07b7aa)
predate the Conventional Commits standard adopted for this project and include
internal ticket references and status notes in their subject lines. They are
left as-is rather than rewritten — published history does not get rewritten
here. Everything from that commit onward follows the format described above.
