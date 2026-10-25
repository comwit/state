# Comwit State

This repository is independently installable and may also be checked out as
`packages/state` in `comwit/comwit`. Keep public package names and APIs stable.

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` and `pnpm typecheck`.
Commit and open PRs in this repository, then update the parent submodule pointer
in a separate parent PR. Never mix another repository's or user's changes.

`core/` owns state, queries, actions and React integration. UI is independent.
