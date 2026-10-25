# Comwit State

Part of [Comwit](https://github.com/comwit/comwit). Independently installable:

```bash
git clone https://github.com/comwit/state.git
cd state
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
```

The public `@comwit/state` package lives in `core/`.

From the parent workspace, edit `packages/state` directly. Commit and push here
first; update the parent's submodule reference in a separate PR afterward.
Docs: https://library.comwit.io/state
