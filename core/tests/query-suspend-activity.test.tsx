// @vitest-environment happy-dom
import React, { Activity, Suspense, createContext, useContext, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { action, ComwitProvider, model, query, useAction, useModel } from '../src'
import type { Model } from '../src/core/model'
import { useStoreRegistry, type StoreRegistry } from '../src/core/provider'
import { bindResourceState, serializeQueryArg } from '../src/core/query'
import type {
  QueryBindingRegistry,
  ResourceDescriptorMap,
  ResourceRuntimeState,
} from '../src/core/query/types'

/**
 * Pages kept alive by Next.js `cacheComponents` stay mounted in a hidden `<Activity>`. Each page
 * calls `suspend(id)` / `load(id)` once at the top (the owner); its children read the query
 * without an id (followers). Followers resolve per component, so a hidden page keeps rendering
 * its own item while another page drives the model field (comwit/state#5).
 */

type Post = { id: string; title: string; likes: number }

/** A render that suspends through React 19 `use()` must run inside an awaited act. */
async function renderAsync(ui: React.ReactElement) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(ui)
  })
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const key = (arg: unknown) => serializeQueryArg(arg)

/** A context change reaches hidden `<Activity>` children, like a layout re-render would. */
const Bump = createContext(0)

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function runtimeOf(registry: StoreRegistry, m: Model<any>, field: string): ResourceRuntimeState {
  const queries = registry.pluginStates.get('query') as QueryBindingRegistry
  const store = registry.get(m)
  const controller = bindResourceState(
    store.proxy,
    m.pluginBags.get('query') as ResourceDescriptorMap,
    undefined,
    queries,
    m.key
  ) as Record<string, object>
  return queries.boundResourceRuntime.get(controller[field])!
}

type PostActions = {
  like(): void
  current(): Post | null
  open(id: string): Promise<unknown>
  set(post: Post): void
}

function setupPosts(
  fetch: (id: string) => Promise<Post>,
  options: { staleTime?: number; gcTime?: number } = {}
) {
  const queryFn = vi.fn(fetch)
  const posts = model({
    detail: query<Post | null, string>({ initialData: null, queryFn, ...options }),
  })
  const postActions = action(({ state }) => ({
    like() {
      const data = state(posts).detail.data
      if (data) data.likes += 1
    },
    current(): Post | null {
      return state(posts).detail.data
    },
    open(id: string) {
      return state(posts).detail.query(id)
    },
    set(post: Post) {
      state(posts).detail.set(post, { arg: post.id })
    },
  }))

  const log: string[] = []
  let registry!: StoreRegistry
  let actions!: PostActions

  /** Exposes the provider registry and the actions to the test body. */
  function Probe() {
    registry = useStoreRegistry()
    actions = useAction<PostActions>([postActions])
    return null
  }

  /** Follower: reads the detail without an id. */
  function Title({ name }: { name: string }) {
    useContext(Bump)
    const title = useModel(posts, (s) => s.detail.data?.title ?? 'pending')
    log.push(`${name}:${title}`)
    return <span data-testid={name}>{title}</span>
  }

  /** Owner page with `suspend(id)`. */
  function SuspendPage({ id, follower = `title-${id}` }: { id: string; follower?: string }) {
    useContext(Bump)
    const detail = useModel(posts, (s) => s.detail.suspend(id))
    const title = detail.data?.title ?? 'pending'
    log.push(`page-${id}:${title}`)
    return (
      <section>
        <h1 data-testid={`h-${id}`}>{title}</h1>
        <Title name={follower} />
      </section>
    )
  }

  /** Owner page with `load(id)`. */
  function LoadPage({ id, follower = `title-${id}` }: { id: string; follower?: string }) {
    useContext(Bump)
    const detail = useModel(posts, (s) => s.detail.load(id))
    const title = detail.data?.title ?? 'pending'
    log.push(`page-${id}:${title}`)
    return (
      <section>
        <h1 data-testid={`h-${id}`}>{title}</h1>
        <Title name={follower} />
      </section>
    )
  }

  /** Kept-alive routes: every visited page stays mounted; only the shown one is visible. */
  function Routes({
    show,
    pages,
    Page,
    bump = 0,
    children,
  }: {
    show: string
    pages: string[]
    Page: React.ComponentType<{ id: string }>
    bump?: number
    children?: React.ReactNode
  }) {
    return (
      <ComwitProvider>
        <Probe />
        <Bump.Provider value={bump}>
          {pages.map((id) => (
            <Activity key={id} mode={show === id ? 'visible' : 'hidden'}>
              <Suspense fallback={<p data-testid={`fallback-${id}`}>loading {id}</p>}>
                <Page id={id} />
              </Suspense>
            </Activity>
          ))}
          {children}
        </Bump.Provider>
      </ComwitProvider>
    )
  }

  const rendersOf = (name: string) =>
    log.filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1))

  return {
    posts,
    queryFn,
    log,
    rendersOf,
    Title,
    SuspendPage,
    LoadPage,
    Routes,
    runtime: () => runtimeOf(registry, posts, 'detail'),
    actions: () => actions,
  }
}

const immediate = async (id: string): Promise<Post> => ({ id, title: id, likes: 0 })

describe('per-component pinned keys for argument-less reads', () => {
  test('a hidden page re-rendering still renders its own item in its followers', async () => {
    const t = setupPosts(immediate)
    const view = await renderAsync(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
    expect(screen.getByTestId('title-a').textContent).toBe('a')

    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    expect(screen.getByTestId('h-b').textContent).toBe('b')
    expect(screen.getByTestId('title-b').textContent).toBe('b')
    expect(t.runtime().activeKey).toBe(key('b'))
    expect(t.runtime().stagedKey).toBeUndefined()

    // The hidden page re-renders from a context change; its followers keep their key, and its
    // owner re-rendering with an unchanged key does not touch stagedKey.
    t.log.length = 0
    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.SuspendPage} bump={1} />)
    })
    expect(t.rendersOf('title-a')).toEqual(['a'])
    expect(t.rendersOf('page-a')).toEqual(['a'])
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.runtime().stagedKey).toBeUndefined()
    expect(t.runtime().activeKey).toBe(key('b'))
  })

  test('followers under a suspend owner render its item in their first render, without an extra render', async () => {
    const request = deferred<Post>()
    const t = setupPosts(() => request.promise)
    await renderAsync(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
    expect(screen.getByTestId('fallback-a')).toBeDefined()
    expect(t.rendersOf('title-a')).toEqual([])

    await act(async () => {
      request.resolve({ id: 'a', title: 'a', likes: 0 })
      await request.promise
    })
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.rendersOf('title-a')).toEqual(['a'])
  })

  test('followers under a load owner with a cached entry show the item in the first render', async () => {
    const t = setupPosts(immediate)
    const view = await renderAsync(<t.Routes show="none" pages={[]} Page={t.LoadPage} />)
    await act(async () => {
      t.actions().set({ id: 'a', title: 'a', likes: 0 })
      t.actions().set({ id: 'b', title: 'b', likes: 0 })
    })
    expect(t.runtime().activeKey).toBe(key('b'))

    await act(async () => {
      view.rerender(<t.Routes show="a" pages={['a']} Page={t.LoadPage} />)
    })
    expect(t.rendersOf('title-a')[0]).toBe('a')
    expect(t.rendersOf('page-a')[0]).toBe('a')
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.runtime().activeKey).toBe(key('a'))
  })

  test('hiding A and confirming b in the same commit never re-pins A', async () => {
    const t = setupPosts(immediate)
    const view = await renderAsync(<t.Routes show="b" pages={['b']} Page={t.SuspendPage} />)
    await act(async () => {
      view.rerender(<t.Routes show="a" pages={['b', 'a']} Page={t.SuspendPage} />)
    })
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.runtime().activeKey).toBe(key('a'))

    // B is cached, so showing it again hides A and confirms 'b' in one commit.
    t.log.length = 0
    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['b', 'a']} Page={t.SuspendPage} />)
    })
    expect(t.runtime().activeKey).toBe(key('b'))
    expect(screen.getByTestId('title-b').textContent).toBe('b')
    expect(t.rendersOf('title-a').every((title) => title === 'a')).toBe(true)

    t.log.length = 0
    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['b', 'a']} Page={t.SuspendPage} bump={1} />)
    })
    expect(t.rendersOf('title-a')).toEqual(['a'])
    expect(screen.getByTestId('title-a').textContent).toBe('a')
  })

  test('showing A again never renders b, and its owner restores the field with edits made before leaving', async () => {
    const t = setupPosts(immediate, { staleTime: 60_000 })
    const view = await renderAsync(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
    await act(async () => {
      t.actions().like()
    })
    expect(t.actions().current()).toMatchObject({ id: 'a', likes: 1 })

    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    expect(t.actions().current()).toMatchObject({ id: 'b', likes: 0 })
    // The outgoing field was written back into entry 'a'.
    expect(t.runtime().cacheEntries.get(key('a'))?.state.data).toMatchObject({ likes: 1 })

    t.log.length = 0
    await act(async () => {
      view.rerender(<t.Routes show="a" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    expect(t.rendersOf('title-a').every((title) => title === 'a')).toBe(true)
    expect(t.rendersOf('page-a').every((title) => title === 'a')).toBe(true)
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.runtime().activeKey).toBe(key('a'))
    expect(t.actions().current()).toMatchObject({ id: 'a', likes: 1 })
    expect(t.queryFn).toHaveBeenCalledTimes(2)
  })

  test('an owner changing its key in place re-pins its followers through the layout confirm', async () => {
    const t = setupPosts(immediate)
    const Current = createContext('a')
    function Page() {
      return <t.SuspendPage id={useContext(Current)} follower="title" />
    }
    const view = await renderAsync(
      <Current.Provider value="a">
        <t.Routes show="none" pages={[]} Page={Page} />
      </Current.Provider>
    )
    await act(async () => {
      t.actions().set({ id: 'b', title: 'b', likes: 0 })
      t.actions().set({ id: 'a', title: 'a', likes: 0 })
    })
    await act(async () => {
      view.rerender(
        <Current.Provider value="a">
          <t.Routes show="page" pages={['page']} Page={Page} />
        </Current.Provider>
      )
    })
    expect(screen.getByTestId('title').textContent).toBe('a')

    // The follower's pin is confirmed 'a', which the passive fallback never overwrites; only the
    // owner's layout confirm moves it to 'b', before paint.
    t.log.length = 0
    await act(async () => {
      view.rerender(
        <Current.Provider value="b">
          <t.Routes show="page" pages={['page']} Page={Page} />
        </Current.Provider>
      )
    })
    expect(screen.getByTestId('title').textContent).toBe('b')
    expect(screen.getByTestId('h-b').textContent).toBe('b')
    expect(t.runtime().activeKey).toBe(key('b'))
    expect(t.rendersOf('title').at(-1)).toBe('b')
  })

  test('a follower mounted later, and one rendered before its owner, both pin the committed key', async () => {
    const t = setupPosts(immediate)
    function Late() {
      const [shown, setShown] = useState(false)
      return (
        <>
          <button onClick={() => setShown(true)}>mount</button>
          {shown && <t.Title name="late" />}
        </>
      )
    }
    const view = await renderAsync(
      <t.Routes show="a" pages={['a']} Page={t.SuspendPage}>
        <Late />
      </t.Routes>
    )
    await act(async () => {
      screen.getByText('mount').click()
    })
    expect(t.rendersOf('late')).toEqual(['a'])

    // An earlier sibling renders before the owner stages 'c', so its first pin is the active key;
    // the owner's layout confirm re-pins it before paint.
    await act(async () => {
      await t.actions().open('c')
      await t.actions().open('a')
    })
    t.log.length = 0
    function EarlyThenOwner() {
      return (
        <>
          <t.Title name="early" />
          <t.LoadPage id="c" />
        </>
      )
    }
    await act(async () => {
      view.rerender(
        <t.Routes show="a" pages={['a']} Page={t.SuspendPage}>
          <Late />
          <EarlyThenOwner />
        </t.Routes>
      )
    })
    expect(t.rendersOf('early')).toEqual(['a', 'c'])
    expect(screen.getByTestId('early').textContent).toBe('c')
    expect(t.runtime().activeKey).toBe(key('c'))
  })

  test('a fetch that settles after another key was activated fills its own entry', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<Post>>>()
    const request = (id: string) => {
      if (!requests.has(id)) requests.set(id, deferred<Post>())
      return requests.get(id)!
    }
    const t = setupPosts((id) => request(id).promise)
    const view = await renderAsync(<t.Routes show="a" pages={['a']} Page={t.LoadPage} />)
    expect(screen.getByTestId('title-a').textContent).toBe('pending')

    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.LoadPage} />)
    })
    await act(async () => {
      request('b').resolve({ id: 'b', title: 'b', likes: 0 })
      await request('b').promise
    })
    expect(screen.getByTestId('title-b').textContent).toBe('b')

    // 'a' settles while 'b' is active: it lands in entry 'a' and leaves the field on 'b'.
    await act(async () => {
      request('a').resolve({ id: 'a', title: 'a', likes: 0 })
      await request('a').promise
    })
    expect(t.runtime().cacheEntries.get(key('a'))?.hasQueried).toBe(true)
    expect(t.actions().current()).toMatchObject({ id: 'b' })

    t.log.length = 0
    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.LoadPage} bump={1} />)
    })
    expect(t.rendersOf('title-a')).toEqual(['a'])

    t.log.length = 0
    await act(async () => {
      view.rerender(<t.Routes show="a" pages={['a', 'b']} Page={t.LoadPage} bump={1} />)
    })
    expect(t.rendersOf('title-a').every((title) => title === 'a')).toBe(true)
    expect(screen.getByTestId('h-a').textContent).toBe('a')
    expect(t.actions().current()).toMatchObject({ id: 'a' })
  })

  test('a pinned entry on a hidden page survives gcTime while an unpinned one is evicted', async () => {
    vi.useFakeTimers()
    try {
      const t = setupPosts(immediate, { gcTime: 500 })
      const view = await renderAsync(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
      expect(screen.getByTestId('title-a').textContent).toBe('a')

      // Nothing observes the model while A is hidden; an action adds an entry nobody pins.
      await act(async () => {
        view.rerender(<t.Routes show="none" pages={['a']} Page={t.SuspendPage} />)
      })
      await act(async () => {
        await t.actions().open('c')
      })
      await act(async () => {
        view.rerender(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
      })
      await act(async () => {
        view.rerender(<t.Routes show="none" pages={['a']} Page={t.SuspendPage} />)
      })
      expect(t.runtime().cacheEntries.has(key('a'))).toBe(true)
      expect(t.runtime().cacheEntries.has(key('c'))).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(t.runtime().cacheEntries.has(key('a'))).toBe(true)
      expect(t.runtime().cacheEntries.has(key('c'))).toBe(false)

      await act(async () => {
        view.rerender(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
      })
      expect(screen.queryByTestId('fallback-a')).toBeNull()
      expect(screen.getByTestId('title-a').textContent).toBe('a')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a suspend owner shown again while its own background refresh is still pending re-activates its key', async () => {
    const queue = new Map<string, Array<ReturnType<typeof deferred<Post>>>>()
    const next = (id: string) => {
      const d = deferred<Post>()
      if (!queue.has(id)) queue.set(id, [])
      queue.get(id)!.push(d)
      return d
    }
    const t = setupPosts((id) => next(id).promise)
    const view = await renderAsync(<t.Routes show="a" pages={['a']} Page={t.SuspendPage} />)
    await act(async () => {
      queue.get('a')![0].resolve({ id: 'a', title: 'a', likes: 0 })
      await queue.get('a')![0].promise
    })
    expect(screen.getByTestId('title-a').textContent).toBe('a')

    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    await act(async () => {
      queue.get('b')![0].resolve({ id: 'b', title: 'b', likes: 0 })
      await queue.get('b')![0].promise
    })
    expect(t.runtime().activeKey).toBe(key('b'))

    // Back to A: its owner confirms 'a' and starts a background refresh that stays pending.
    await act(async () => {
      view.rerender(<t.Routes show="a" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    expect(t.runtime().activeKey).toBe(key('a'))
    expect(queue.get('a')).toHaveLength(2)

    await act(async () => {
      view.rerender(<t.Routes show="b" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    expect(t.runtime().activeKey).toBe(key('b'))

    // Back to A again while A's refresh is still in flight: the owner's activation must not hide
    // behind the in-flight dedupe, or actions on the visible page would edit B's item.
    await act(async () => {
      view.rerender(<t.Routes show="a" pages={['a', 'b']} Page={t.SuspendPage} />)
    })
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.runtime().activeKey).toBe(key('a'))
    expect(t.actions().current()?.id).toBe('a')
    expect(queue.get('a')).toHaveLength(2)

    // The pending refresh lands in the field once it settles.
    await act(async () => {
      queue.get('a')![1].resolve({ id: 'a', title: 'a fresh', likes: 0 })
      await queue.get('a')![1].promise
    })
    expect(screen.getByTestId('title-a').textContent).toBe('a fresh')
    expect(t.actions().current()?.title).toBe('a fresh')
  })

  test('a page mounted hidden and never shown leaves no stale stagedKey for later followers', async () => {
    const t = setupPosts(immediate)
    function Late({ name }: { name: string }) {
      const [shown, setShown] = useState(false)
      return (
        <>
          <button onClick={() => setShown(true)}>mount {name}</button>
          {shown && <t.Title name={name} />}
        </>
      )
    }
    // 'p' is mounted hidden from the start (a prerendered route) and never shown.
    await renderAsync(
      <t.Routes show="a" pages={['a', 'p']} Page={t.SuspendPage}>
        <Late name="late-1" />
        <Late name="late-2" />
      </t.Routes>
    )
    expect(screen.getByTestId('title-a').textContent).toBe('a')
    expect(t.runtime().activeKey).toBe(key('a'))

    // The first follower mounted afterwards may pin the stale stage once; it repairs itself and
    // clears the stage, so it misleads nobody else.
    await act(async () => {
      screen.getByText('mount late-1').click()
    })
    expect(screen.getByTestId('late-1').textContent).toBe('a')
    expect(t.runtime().stagedKey).toBeUndefined()

    t.log.length = 0
    await act(async () => {
      screen.getByText('mount late-2').click()
    })
    expect(t.rendersOf('late-2')).toEqual(['a'])
  })

  test('without an owner, followers read the active key as before', async () => {
    const t = setupPosts(immediate)
    await renderAsync(
      <t.Routes show="none" pages={[]} Page={t.SuspendPage}>
        <t.Title name="free" />
      </t.Routes>
    )
    expect(screen.getByTestId('free').textContent).toBe('pending')
    await act(async () => {
      await t.actions().open('a')
    })
    expect(screen.getByTestId('free').textContent).toBe('a')
    await act(async () => {
      await t.actions().open('b')
    })
    expect(screen.getByTestId('free').textContent).toBe('b')
  })
})

describe('argument-less load() follows the current key', () => {
  type ListActions = { goto(page: number): Promise<unknown> }

  function setupCatalog() {
    const queryFn = vi.fn(async (params: { page: number } | undefined) => [
      `page-${params?.page ?? 1}`,
    ])
    const catalog = model({
      list: query<string[], { page: number } | undefined>({ initialData: [], queryFn }),
    })
    const catalogActions = action(({ state }) => ({
      goto(page: number) {
        return state(catalog).list.query({ page })
      },
    }))
    const log: string[] = []
    let actions!: ListActions
    let registry!: StoreRegistry

    function Probe() {
      registry = useStoreRegistry()
      actions = useAction<ListActions>([catalogActions])
      return null
    }
    function Items({ name }: { name: string }) {
      const items = useModel(catalog, (s) => s.list.data.join(',') || 'pending')
      log.push(`${name}:${items}`)
      return <span data-testid={name}>{items}</span>
    }
    function Pager() {
      const [page, setPage] = useState<number | null>(null)
      // A child owner: once the user paginates, it chooses the key for the whole page.
      useModel(catalog, (s) => (page === null ? null : s.list.load({ page }).isFetching))
      return <button onClick={() => setPage(2)}>page 2</button>
    }
    /** An argument-less `load()` beside an owner: it follows that owner's key, never its own. */
    function Ensure() {
      useModel(catalog, (s) => s.list.load().isFetching)
      return null
    }
    function OwnedPage() {
      const list = useModel(catalog, (s) => s.list.load({ page: 1 }))
      log.push(`page:${list.data.join(',') || 'pending'}`)
      return (
        <section>
          <h1 data-testid="h">{list.data.join(',') || 'pending'}</h1>
          <Ensure />
          <Items name="items" />
        </section>
      )
    }
    function ListPage({ pager }: { pager: boolean }) {
      // Top-level `load()` with defaults in queryFn: loads the current key, never chooses one.
      const list = useModel(catalog, (s) => s.list.load())
      log.push(`page:${list.data.join(',') || 'pending'}`)
      return (
        <section>
          <h1 data-testid="h">{list.data.join(',') || 'pending'}</h1>
          <Items name="items" />
          {pager && <Pager />}
        </section>
      )
    }
    function App({
      show,
      pager = false,
      owned = false,
    }: {
      show: boolean
      pager?: boolean
      owned?: boolean
    }) {
      return (
        <ComwitProvider>
          <Probe />
          <Activity mode={show ? 'visible' : 'hidden'}>
            {owned ? <OwnedPage /> : <ListPage pager={pager} />}
          </Activity>
        </ComwitProvider>
      )
    }
    return {
      App,
      queryFn,
      log,
      rendersOf: (name: string) =>
        log.filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1)),
      actions: () => actions,
      runtime: () => runtimeOf(registry, catalog, 'list'),
    }
  }

  test('load({ page: 2 }) from a child re-pins every visible follower; after an action moved on, showing the page again resumes the page it last showed', async () => {
    const t = setupCatalog()
    const view = await renderAsync(<t.App show pager />)
    expect(screen.getByTestId('h').textContent).toBe('page-1')
    expect(screen.getByTestId('items').textContent).toBe('page-1')
    expect(t.queryFn).toHaveBeenCalledWith(undefined, expect.any(Object))

    await act(async () => {
      screen.getByText('page 2').click()
    })
    expect(screen.getByTestId('h').textContent).toBe('page-2')
    expect(screen.getByTestId('items').textContent).toBe('page-2')
    expect(t.runtime().activeKey).toBe(key({ page: 2 }))

    // Hidden and shown again, the top-level `load()` keeps the current page instead of reloading
    // the default one.
    await act(async () => {
      view.rerender(<t.App show={false} pager />)
    })
    t.log.length = 0
    await act(async () => {
      view.rerender(<t.App show pager />)
    })
    expect(screen.getByTestId('h').textContent).toBe('page-2')
    expect(screen.getByTestId('items').textContent).toBe('page-2')
    expect(t.log.every((line) => line.endsWith(':page-2'))).toBe(true)
    expect(t.queryFn.mock.calls.filter(([params]) => params === undefined)).toHaveLength(1)
    expect(t.runtime().activeKey).toBe(key({ page: 2 }))

    // An action moves the page on while the child owner still renders `load({ page: 2 })`.
    await act(async () => {
      await t.actions().goto(3)
    })
    expect(screen.getByTestId('h').textContent).toBe('page-3')
    expect(screen.getByTestId('items').textContent).toBe('page-3')

    // Shown again, the child owner's effect re-runs with its unchanged key. It resumes page 3,
    // the page its component last showed, instead of flipping the page back to page 2.
    for (let cycle = 0; cycle < 2; cycle++) {
      await act(async () => {
        view.rerender(<t.App show={false} pager />)
      })
      t.log.length = 0
      t.queryFn.mockClear()
      await act(async () => {
        view.rerender(<t.App show pager />)
      })
      expect(screen.getByTestId('h').textContent).toBe('page-3')
      expect(screen.getByTestId('items').textContent).toBe('page-3')
      expect(t.log.every((line) => line.endsWith(':page-3'))).toBe(true)
      expect(t.queryFn).not.toHaveBeenCalledWith({ page: 2 }, expect.any(Object))
      expect(t.runtime().activeKey).toBe(key({ page: 3 }))
    }
  })

  test('an argument-less load() beside a mounting owner follows that owner from the first render and fetches nothing of its own', async () => {
    const t = setupCatalog()
    await renderAsync(<t.App show owned />)
    // Pending until the owner's fetch lands, then its page: the argument-less load() beside it
    // never moved the field to the `undefined` key in between.
    expect([...new Set(t.rendersOf('items'))]).toEqual(['pending', 'page-1'])
    expect(screen.getByTestId('h').textContent).toBe('page-1')
    expect(t.runtime().activeKey).toBe(key({ page: 1 }))
    expect(t.queryFn).toHaveBeenCalledTimes(1)
    expect(t.queryFn).toHaveBeenCalledWith({ page: 1 }, expect.any(Object))
  })

  test('load({ page: 3 }) from an action re-pins every visible follower, and the page keeps it when shown again', async () => {
    const t = setupCatalog()
    const view = await renderAsync(<t.App show />)
    expect(screen.getByTestId('items').textContent).toBe('page-1')

    await act(async () => {
      await t.actions().goto(3)
    })
    expect(screen.getByTestId('h').textContent).toBe('page-3')
    expect(screen.getByTestId('items').textContent).toBe('page-3')
    expect(t.runtime().activeKey).toBe(key({ page: 3 }))

    await act(async () => {
      view.rerender(<t.App show={false} />)
    })
    t.log.length = 0
    await act(async () => {
      view.rerender(<t.App show />)
    })
    expect(screen.getByTestId('h').textContent).toBe('page-3')
    expect(screen.getByTestId('items').textContent).toBe('page-3')
    expect(t.log.every((line) => line.endsWith(':page-3'))).toBe(true)
    expect(t.queryFn.mock.calls.filter(([params]) => params === undefined)).toHaveLength(1)
    expect(t.runtime().activeKey).toBe(key({ page: 3 }))
  })
})
