// @vitest-environment happy-dom
import React, { Suspense, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { action, ComwitProvider, create, model, query, useAction } from '../src'
import { useStoreRegistry, type StoreRegistry } from '../src/core/provider'
import type { Model } from '../src/core/model'

type Card = { slug: string; title: string }
type Post = { slug: string; title: string; body: string }
type Overview = { blogs: Card[] }

const overview: Overview = { blogs: [{ slug: 'a', title: 'Alpha' }] }
const fullPost = (slug: string): Post => ({ slug, title: 'Alpha', body: `${slug} body` })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function renderAsync(ui: React.ReactElement) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(ui)
  })
  return result
}

type BlogActions = { query(slug: string): Promise<unknown> }

function setup() {
  const requests = new Map<string, ReturnType<typeof deferred<Post | null>>>()
  const request = (slug: string) => {
    if (!requests.has(slug)) requests.set(slug, deferred<Post | null>())
    return requests.get(slug)!
  }
  const loungeQueryFn = vi.fn(async (): Promise<Overview | null> => overview)
  const lounge = model({
    overview: query<Overview | null>({ initialData: null, queryFn: loungeQueryFn }),
  })
  const useLounge = create(lounge, { actions: [] })

  /** What `read(lounge)` handed each seed evaluation. */
  const reads: unknown[] = []
  const queryFn = vi.fn((slug: string) => request(slug).promise)
  const seed = vi.fn((slug: string, { state, read }: { state: any; read: any }) => {
    const other = read(lounge)
    reads.push(other)
    return (
      (state.list.data as Card[]).find((card) => card.slug === slug) ??
      other?.overview.data?.blogs.find((card: Card) => card.slug === slug)
    )
  })
  const blog = model({
    list: query<Card[]>({ initialData: [], queryFn: () => [] }),
    detail: query<Post | null, string, Card>({ initialData: null, queryFn, seed }),
  })
  const blogActions = action(({ state }) => ({
    query(slug: string) {
      return state(blog).detail.query(slug)
    },
  }))
  const useBlog = create<typeof blog extends Model<infer T> ? T : never, BlogActions>(blog, {
    actions: [blogActions],
  })

  /** Registers (and hydrates) the lounge model without any component observing it. */
  function Hydrated({ children }: { children: ReactNode }) {
    useLounge.hydrate({ overview: { data: overview } })
    return <>{children}</>
  }

  let registry: StoreRegistry | undefined
  let observe: ReturnType<typeof vi.spyOn> | undefined
  /** Rendered first, so the spy sees every later `observe` call in this provider. */
  function Probe() {
    const current = useStoreRegistry()
    if (registry !== current) {
      registry = current
      observe = vi.spyOn(current, 'observe')
    }
    return null
  }

  function PostView({ slug, mode }: { slug: string; mode: 'suspend' | 'load' | 'passive' }) {
    const post = useBlog((state) =>
      mode === 'suspend'
        ? state.detail.suspend(slug)
        : mode === 'load'
          ? state.detail.load(slug)
          : state.detail
    )
    return (
      <>
        <div data-testid="title">{post.data ? post.data.title : 'none'}</div>
        <div data-testid="flags">
          {[
            `partial:${String(post.isPartial)}`,
            `loading:${String(post.isLoading)}`,
            `fetching:${String(post.isFetching)}`,
            `success:${String(post.isSuccess)}`,
          ].join(' ')}
        </div>
      </>
    )
  }

  function Trigger({ slug }: { slug: string }) {
    const actions = useBlog((state) => state.actions)
    return <button onClick={() => void actions.query(slug)}>query</button>
  }

  return {
    lounge,
    blog,
    request,
    reads,
    loungeQueryFn,
    queryFn,
    seed,
    Hydrated,
    Probe,
    PostView,
    Trigger,
    registryObserve: () => observe!,
    registry: () => registry!,
  }
}

const flags = () => screen.getByTestId('flags').textContent
const title = () => screen.getByTestId('title').textContent

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('query seed read(model)', () => {
  test('.suspend(slug) paints a seed read from another model on the selector path', async () => {
    const { lounge, request, loungeQueryFn, queryFn, Hydrated, Probe, PostView, registryObserve } =
      setup()

    await renderAsync(
      <ComwitProvider>
        <Probe />
        <Hydrated>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <PostView slug="a" mode="suspend" />
          </Suspense>
        </Hydrated>
      </ComwitProvider>
    )

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(title()).toBe('Alpha')
    expect(flags()).toBe('partial:true loading:false fetching:true success:false')
    expect(queryFn).toHaveBeenCalledOnce()
    // Reading the lounge never loaded or observed it.
    expect(loungeQueryFn).not.toHaveBeenCalled()
    expect(registryObserve().mock.calls.map(([m]) => m)).not.toContain(lounge)

    await act(async () => {
      request('a').resolve(fullPost('a'))
      await request('a').promise
    })
    await waitFor(() => expect(flags()).toBe('partial:false loading:false fetching:false success:true'))
    expect(loungeQueryFn).not.toHaveBeenCalled()
  })

  test('.load(slug) paints the cross-model seed instead of isLoading', async () => {
    const { request, loungeQueryFn, Hydrated, PostView } = setup()

    await renderAsync(
      <ComwitProvider>
        <Hydrated>
          <PostView slug="a" mode="load" />
        </Hydrated>
      </ComwitProvider>
    )
    expect(title()).toBe('Alpha')
    expect(flags()).toBe('partial:true loading:false fetching:true success:false')

    await act(async () => {
      request('a').resolve(fullPost('a'))
      await request('a').promise
    })
    await waitFor(() => expect(flags()).toContain('partial:false'))
    expect(loungeQueryFn).not.toHaveBeenCalled()
  })

  test('an imperative .query(slug) paints the cross-model seed on the accessor path', async () => {
    const { request, loungeQueryFn, queryFn, Hydrated, PostView, Trigger } = setup()

    await renderAsync(
      <ComwitProvider>
        <Hydrated>
          <PostView slug="a" mode="passive" />
          <Trigger slug="a" />
        </Hydrated>
      </ComwitProvider>
    )
    expect(title()).toBe('none')
    expect(queryFn).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByText('query'))
    })
    expect(title()).toBe('Alpha')
    expect(flags()).toBe('partial:true loading:false fetching:true success:false')
    expect(queryFn).toHaveBeenCalledOnce()
    expect(loungeQueryFn).not.toHaveBeenCalled()

    await act(async () => {
      request('a').resolve(fullPost('a'))
      await request('a').promise
    })
    await waitFor(() => expect(flags()).toBe('partial:false loading:false fetching:false success:true'))
  })

  test.each(['suspend', 'load'] as const)(
    'read() of an unregistered model is undefined and does not create it (%s)',
    async (mode) => {
      const { lounge, request, reads, seed, PostView, Probe, registry } = setup()
      const instance = vi.spyOn(lounge, 'instance')

      await renderAsync(
        <ComwitProvider>
          <Probe />
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <PostView slug="a" mode={mode} />
          </Suspense>
        </ComwitProvider>
      )

      // No seed: the key loads exactly as an unseeded one would.
      expect(seed).toHaveBeenCalled()
      expect(reads.every((value) => value === undefined)).toBe(true)
      if (mode === 'suspend') {
        expect(screen.getByTestId('fallback')).toBeDefined()
      } else {
        expect(title()).toBe('none')
        expect(flags()).toBe('partial:false loading:true fetching:true success:false')
      }
      expect(instance).not.toHaveBeenCalled()
      expect(registry().peek(lounge)).toBeUndefined()

      await act(async () => {
        request('a').resolve(fullPost('a'))
        await request('a').promise
      })
      await waitFor(() => expect(title()).toBe('Alpha'))
      expect(instance).not.toHaveBeenCalled()
    }
  )

  test('the read snapshot is read-only and carries no load/query methods', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { reads, loungeQueryFn, Hydrated, PostView } = setup()

    await renderAsync(
      <React.StrictMode>
        <ComwitProvider>
          <Hydrated>
            <PostView slug="a" mode="load" />
          </Hydrated>
        </ComwitProvider>
      </React.StrictMode>
    )
    expect(title()).toBe('Alpha')

    const snapshot = reads.find((value) => value !== undefined) as {
      overview: Record<string, unknown> & { data: Overview }
    }
    expect(snapshot).toBeDefined()
    expect(snapshot.overview.data).toEqual(overview)
    expect(snapshot.overview.load).toBeUndefined()
    expect(snapshot.overview.query).toBeUndefined()
    expect(snapshot.overview.set).toBeUndefined()
    expect(() => {
      snapshot.overview.data = { blogs: [] }
    }).toThrow()
    expect(() => {
      snapshot.overview.data.blogs[0] = { slug: 'z', title: 'Z' }
    }).toThrow()
    expect(loungeQueryFn).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('read() does not mark the other model as read, so its own hydration still initializes it', async () => {
    const { lounge, request, Hydrated, PostView, registry, Probe } = setup()
    // The lounge exists but nothing has rendered it yet.
    function Register() {
      useStoreRegistry().get(lounge)
      return null
    }

    await renderAsync(
      <ComwitProvider>
        <Probe />
        <Register />
        <PostView slug="a" mode="load" />
      </ComwitProvider>
    )
    // The seed peeked at the lounge (initialData: null → no seed) without reading it for React.
    expect(registry().peek(lounge)?.hasReadSnapshot()).toBe(false)
    expect(flags()).toContain('loading:true')
    void Hydrated
    void request
  })

  test('seeds are not subscribed to the model they read', async () => {
    const { lounge, request, Hydrated, PostView } = setup()
    const loungeActions = action(({ state }) => ({
      rename() {
        const data = state(lounge).overview.data
        if (data) data.blogs[0].title = 'Alpha (renamed)'
      },
    }))
    function Rename() {
      const actions = useAction<{ rename(): void }>([loungeActions])
      return <button onClick={() => actions.rename()}>rename</button>
    }

    await renderAsync(
      <ComwitProvider>
        <Hydrated>
          <PostView slug="a" mode="load" />
          <Rename />
        </Hydrated>
      </ComwitProvider>
    )
    expect(title()).toBe('Alpha')

    await act(async () => {
      fireEvent.click(screen.getByText('rename'))
    })
    // The painted seed is a detached copy evaluated when the key was read.
    expect(title()).toBe('Alpha')
    void request
  })
})
