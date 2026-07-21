# Contributing to Arkimede

Thanks for your interest in improving Arkimede — a sovereign, multi-tenant AI
platform. Contributions of all kinds are welcome: bug reports, features,
documentation, translations, and skills.

## License of contributions

Arkimede is licensed under **AGPL-3.0-or-later**. Contributions are accepted on an
**inbound = outbound** basis: by opening a pull request you agree that your
contribution is licensed under AGPL-3.0-or-later, the same license as the project.
There is no separate Contributor License Agreement and no copyright assignment —
you keep the copyright to your work.

## Sign your work (Developer Certificate of Origin)

We use the [Developer Certificate of Origin](DCO) (DCO 1.1) — the same lightweight
mechanism the Linux kernel uses. It is **not a CLA**: you assign no copyright and
grant no special rights to anyone. You simply certify, per commit, that you wrote
the change (or otherwise have the right to submit it) and that it may be distributed
under the project's license.

To certify a commit, add a `Signed-off-by` line by committing with `-s`:

```bash
git commit -s -m "fix(sandbox): ..."
```

which appends:

```
Signed-off-by: Jane Doe <jane@example.com>
```

The name and email must match your commit author identity. Forgot it? Amend the last
commit with `git commit --amend -s`, or sign a whole branch with `git rebase --signoff master`.
**Every commit in a pull request must carry the sign-off.**

## Ways to contribute

- **Bug reports / feature requests** — open a [GitHub issue](../../issues). Search
  first to avoid duplicates. Include steps to reproduce, expected vs actual
  behavior, and your environment (OS, Docker version, deployment level).
- **Pull requests** — for anything larger than a trivial fix, open an issue first
  to discuss the approach.
- **Security vulnerabilities** — do **not** open a public issue. Follow
  [SECURITY.md](SECURITY.md) for private disclosure.

## Development setup

Prerequisites: Docker + Docker Compose, and Node.js 20+ for working on a single
service outside containers.

The guided installer brings up the full stack (backend, frontend, executor, and
optionally the isolated broker) and walks you through the security level:

```bash
cp .env.example .env      # then fill in the secrets (see the comments in the file)
./scripts/install.sh
```

To iterate on a single service in watch mode:

```bash
# Backend (NestJS)
cd backend && npm install && npm run start:dev

# Frontend (React + Vite)
cd frontend && npm install && npm run dev
```

## Before opening a pull request

Run the checks locally — the same ones CI expects to pass:

```bash
# Backend: type-check and unit tests
cd backend && npm run typecheck && npm test

# Frontend: type-check + production build
cd frontend && npm run build
```

## Conventions

- **Language.** Code comments and developer-facing docs are written in **English**.
  User-facing UI strings are internationalized (IT/EN) and must keep parity across
  both locale files.
- **Branches.** Do the work on a dedicated branch (`feature/…`, `fix/…`,
  `refactor/…`, `docs/…`), never commit directly to `master`.
- **Commits.** Write clear, imperative commit messages
  (`fix(sandbox): …`, `feat(skills): …`). Keep each commit focused.
- **Database migrations.** Never edit a migration that has already been applied —
  add a new one (`ADD COLUMN IF NOT EXISTS …`). Applied migrations are not re-run.
- **Cross-provider LLM code.** Anything touching the model layer must work across
  all supported providers (Anthropic, OpenAI, Gemini, Ollama, …), not a single one.
- **Skills adapt to the backend**, not the other way around: a skill consumes the
  existing internal APIs; don't change the backend just to make a skill work.

## Pull request checklist

- [ ] Branched from `master`, focused scope
- [ ] Every commit signed off (`git commit -s`) per the [DCO](DCO)
- [ ] `typecheck`, tests and build pass locally
- [ ] Comments/docs in English; UI strings translated (IT/EN) if applicable
- [ ] New DB columns via a new migration (not by editing an old one)
- [ ] No secrets, credentials, or `.env` files committed

By signing off your commits you confirm, under the [DCO](DCO), that the contribution
is yours to submit and may be distributed under AGPL-3.0-or-later.
