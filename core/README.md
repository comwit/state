# @comwit/state

**React state for you and your agent.**

State management for React and Next.js, published as **`@comwit/state`**. Keep client state,
server queries, and actions in one domain, then use them through one typed hook.

[Website](https://library.comwit.io) · [Documentation](https://library.comwit.io/state/docs) · [Quickstart](https://library.comwit.io/state/docs/guide/quickstart) · [npm](https://www.npmjs.com/package/@comwit/state)

Used in 1,000+ projects on [comwit.io](https://comwit.io), a Claude Code-powered vibe coding platform
from Korea. Sponsored by [burrr.ai](https://burrr.ai).

## Why comwit?

- **One domain, one hook.** Define a model, add actions, and combine them with `create()`.
- **Client state and server data together.** Reactive values, cached queries, and server hydration
  share the same domain.
- **Direct mutations inside actions.** Update state with ordinary JavaScript; components subscribe
  through selectors.
- **Built for coding agents.** A compact [`llms.txt`](https://library.comwit.io/state/llms.txt) covers setup,
  domain structure, and the core APIs.

## Installation

```bash
npm install @comwit/state
```

Supports **React 18 and 19**. For Next.js, follow the
[App Router setup](https://library.comwit.io/state/docs/guide/quickstart).

### Working with an AI agent

Give Claude Code or your coding agent this prompt:

```text
Set up @comwit/state in this project using https://library.comwit.io/state/llms.txt.
Follow its domain structure and state management patterns.
```

## Quick start

A complete counter in one file:

```tsx
'use client'

import { action, ComwitProvider, create, model } from '@comwit/state'

type CounterState = { count: number }
type CounterActions = { increment(): void; reset(): void }

const counter = model<CounterState>({ count: 0 })

const counterActions = action<CounterActions>(({ state }) => {
  const m = state(counter)

  return {
    increment() {
      m.count += 1
    },
    reset() {
      m.count = 0
    },
  }
})

const useCounter = create<CounterState, CounterActions>(counter, {
  actions: [counterActions],
})

function Counter() {
  const { count, actions } = useCounter((s) => ({ count: s.count, actions: s.actions }))

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={actions.increment}>Add one</button>
      <button onClick={actions.reset}>Reset</button>
    </div>
  )
}

export default function App() {
  return (
    <ComwitProvider>
      <Counter />
    </ComwitProvider>
  )
}
```

Each `ComwitProvider` owns its state, and models initialize only when accessed. As the app grows,
split models, actions, and hooks into [domain folders](https://library.comwit.io/state/docs/guide/structure).

## Beyond client state

| What you need                                              | API / guide                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Render server data with SSR and Suspense                   | [`.suspend(arg)`](https://library.comwit.io/state/docs/guide/nextjs)                                 |
| Fetch and cache data in the browser                        | [`query()` + `.load(arg)`](https://library.comwit.io/state/docs/api/query)                           |
| Seed data a Server Component already fetched (alternative) | [`useDomain.hydrate(...)`](https://library.comwit.io/state/docs/guide/nextjs)                        |
| Restore an exact IndexedDB view without an API request     | [`local()` + `.restore(arg)`](https://library.comwit.io/state/docs/api/local)                        |
| Keep IndexedDB views and revalidate from the server        | [`local.query()` / `local.infinite()`](https://library.comwit.io/state/docs/api/local)               |
| Persist browser-owned preferences                          | [`persist()`](https://library.comwit.io/state/docs/api/persist)                                      |
| Derive values from state                                   | [`computed()`](https://library.comwit.io/state/docs/api/computed)                                    |
| Undo and redo state changes                                | [`$history`](https://library.comwit.io/state/docs/api/history)                                       |
| Add retries, debounce, or shared error handling to actions | [Action decorators](https://library.comwit.io/state/docs/decorators)                                 |

### Queries and Next.js

Read server data with `.suspend(arg)` in the Client Component that renders it, inside `<Suspense>`:

```tsx
'use client'

function ProductDetail({ id }: { id: string }) {
  const product = useProduct((s) => s.detail.suspend(id))
  return product.data ? <h1>{product.data.title}</h1> : null
}
```

```tsx
<Suspense fallback={<ProductSkeleton />}>
  <ProductDetail id={id} />
</Suspense>
```

Pass Next.js `useServerInsertedHTML` to the provider once. The server render runs `queryFn` and
streams the result into the browser cache, so hydration renders it without a second request. There
is no Server Component fetch and no route adapter.

```tsx
'use client'

import { useServerInsertedHTML } from 'next/navigation'

<ComwitProvider useServerInsertedHTML={useServerInsertedHTML}>{children}</ComwitProvider>
```

`queryFn` runs on both server and browser, so call an API with an absolute URL and return JSON data.

Use `.load(arg)` when the component renders its own loading state. It reports `isLoading` during
render and starts the request after commit, never during SSR:

```tsx
const list = useProduct((s) => s.list.load({ page }))
if (list.isLoading) return <Skeleton />
```

Reading query state without `.load()` or `.suspend()` does not start a request.

When `queryFn` cannot run during SSR (database code, Server Functions), await the value in a Server
Component and seed it with `useProduct.hydrate({ detail: { arg: id, data: initialProduct } })`
before the domain hook reads it. See the [Next.js guide](https://library.comwit.io/state/docs/guide/nextjs).

### Slow initial loading

Set `slowLoadingMs: 500` on `query()` or `local.query()` and read `isSlowLoading` through the usual
query state. Existing loading flags, requests, cache freshness, and data delivery keep their timing.
The new flag stays false for fast completion and usable cached data, becomes true for a continuing
initial load, and clears immediately on success/error. No component, effect, or request key is needed.
See the [query guide](https://library.comwit.io/state/docs/api/query#slow-initial-loading) for rendering,
SSR, retries, cleanup, and the supported query variants. This is a query declaration option, not a
model/provider default or a standalone `local()` option.

### URL state

`searchParam()` declares typed URL-backed fields directly in a model. Read them through the same
domain hook and update them through actions.

```bash
npm install @comwit/state@2.4.0
```

See the [URL state reference](https://library.comwit.io/state/docs/api/router) for parsing, defaults,
browser history, and server rendering.

## Documentation

Start at **[library.comwit.io](https://library.comwit.io)**.

- [Quickstart](https://library.comwit.io/state/docs/guide/quickstart) — installation, provider, and your first domain.
- [Project structure](https://library.comwit.io/state/docs/guide/structure) — organize a growing app by domain.
- [AI agent setup](https://library.comwit.io/state/docs/llm-setup) — use the compact guide and detailed references.
- [Release notes](https://library.comwit.io/blog) — changes and migration guides.

## Migrating from `comwit`

Since v2.0.0, the package is named `@comwit/state`. Replace the dependency and update imports:

```diff
- import { model, action } from 'comwit'
+ import { model, action } from '@comwit/state'
```

The rename did not change the API. The deprecated `comwit` package re-exports `@comwit/state` for
compatibility. See the [v2.0.0 migration notes](https://library.comwit.io/blog/v2.0.0-release).

## License

[MIT](./LICENSE)
