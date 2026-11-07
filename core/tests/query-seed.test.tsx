// @vitest-environment happy-dom
import React, { Component, Suspense, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { action, ComwitProvider, create, model, query, useAction, useModel } from '../src'
import type { Model } from '../src/core/model'

type Summary = { id: string; title: string }
type Detail = { id: string; title: string; description: string }

const summaries: Summary[] = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta' },
]
const fullDetail = (id: string): Detail => ({
  id,
  title: summaries.find((item) => item.id === id)?.title ?? id.toUpperCase(),
  description: `${id} description`,
})

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
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    return this.state.error ? this.props.fallback : this.props.children
  }
}

type CatalogActions = {
  open(detail: Detail): void
  fill(items: Summary[]): void
  refetch(): Promise<unknown>
  query(id: string): Promise<unknown>
}

function setup(options: { staleTime?: number; items?: Summary[] } = {}) {
  const requests = new Map<string, ReturnType<typeof deferred<Detail | null>>>()
  const request = (id: string) => {
    if (!requests.has(id)) requests.set(id, deferred<Detail | null>())
    return requests.get(id)!
  }
  /** Forget a settled request so the next `queryFn` call gets a fresh deferred. */
  const reset = (id: string) => {
    requests.delete(id)
  }
  const queryFn = vi.fn((id: string) => request(id).promise)
  const seed = vi.fn((id: string, { state }: { state: any }) =>
    (state.list.data as Summary[]).find((item) => item.id === id)
  )
  const catalog = model({
    list: query<Summary[]>({
      initialData: options.items ?? summaries,
      queryFn: () => summaries,
    }),
    detail: query<Detail | null, string, Summary>({
      initialData: null,
      staleTime: options.staleTime,
      queryFn,
      seed,
    }),
  })
  const catalogActions = action(({ state }) => ({
    open(detail: Detail) {
      state(catalog).detail.set(detail, { arg: detail.id })
    },
    fill(items: Summary[]) {
      state(catalog).list.set(items)
    },
    refetch() {
      return state(catalog).detail.refetch()
    },
    query(id: string) {
      return state(catalog).detail.query(id)
    },
  }))
  const useCatalog = create<
    typeof catalog extends Model<infer T> ? T : never,
    CatalogActions
  >(catalog, { actions: [catalogActions] })

  function Flags({
    value,
  }: {
    value: {
      isPartial?: boolean
      isLoading: boolean
      isFetching: boolean
      isSuccess: boolean
      isError: boolean
      isSlowLoading: boolean
    }
  }) {
    return (
      <div data-testid="flags">
        {[
          `partial:${String(value.isPartial)}`,
          `loading:${String(value.isLoading)}`,
          `fetching:${String(value.isFetching)}`,
          `success:${String(value.isSuccess)}`,
          `error:${String(value.isError)}`,
          `slow:${String(value.isSlowLoading)}`,
        ].join(' ')}
      </div>
    )
  }

  function Detail({ id, mode = 'suspend' }: { id: string; mode?: 'suspend' | 'load' }) {
    const detail = useCatalog((state) =>
      mode === 'suspend' ? state.detail.suspend(id) : state.detail.load(id)
    )
    return (
      <>
        <div data-testid={`title-${id}`}>{detail.data ? detail.data.title : 'none'}</div>
        <div data-testid={`description-${id}`}>
          {detail.data ? (detail.data.description ?? 'bones') : 'none'}
        </div>
        <Flags value={detail} />
      </>
    )
  }

  return { catalog, catalogActions, useCatalog, request, reset, queryFn, seed, Detail }
}

const flags = () => screen.getByTestId('flags').textContent

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('query seed', () => {
  test('.suspend(id) paints the seed in the first commit and upgrades after commit', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { request, queryFn, Detail } = setup()

    await renderAsync(
      <React.StrictMode>
        <ComwitProvider>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Detail id="a" />
          </Suspense>
        </ComwitProvider>
      </React.StrictMode>
    )

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(screen.getByTestId('description-a').textContent).toBe('bones')
    expect(flags()).toBe(
      'partial:true loading:false fetching:true success:false error:false slow:false'
    )
    // The upgrade started after commit, not during render.
    expect(queryFn).toHaveBeenCalledOnce()
    expect(queryFn).toHaveBeenCalledWith('a', expect.anything())

    await act(async () => {
      request('a').resolve(fullDetail('a'))
      await request('a').promise
    })

    await waitFor(() => expect(screen.getByTestId('description-a').textContent).toBe('a description'))
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
    expect(queryFn).toHaveBeenCalledOnce()
    // The seed never wrote to the store during render.
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('.load(id) reports the seed instead of isLoading', async () => {
    const { request, queryFn, Detail } = setup()

    await renderAsync(
      <ComwitProvider>
        <Detail id="a" mode="load" />
      </ComwitProvider>
    )

    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(flags()).toBe(
      'partial:true loading:false fetching:true success:false error:false slow:false'
    )
    expect(queryFn).toHaveBeenCalledOnce()

    await act(async () => {
      request('a').resolve(fullDetail('a'))
      await request('a').promise
    })
    await waitFor(() => expect(screen.getByTestId('description-a').textContent).toBe('a description'))
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
  })

  test('without a seed or cache .suspend(id) still suspends', async () => {
    const { request, queryFn, Detail } = setup({ items: [] })

    await renderAsync(
      <ComwitProvider>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <Detail id="a" />
        </Suspense>
      </ComwitProvider>
    )

    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(queryFn).toHaveBeenCalledOnce()

    await act(async () => {
      request('a').resolve(fullDetail('a'))
      await request('a').promise
    })
    await waitFor(() => expect(screen.getByTestId('title-a').textContent).toBe('Alpha'))
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
    expect(queryFn).toHaveBeenCalledOnce()
  })

  test('a full value from .set() wins over the seed and is never downgraded', async () => {
    const { request, queryFn, useCatalog, Detail } = setup({ staleTime: 60_000 })

    function Opener({ children }: { children: ReactNode }) {
      const actions = useCatalog((state) => state.actions)
      const [ready, setReady] = React.useState(false)
      React.useLayoutEffect(() => {
        actions.open({ id: 'a', title: 'Alpha (full)', description: 'set' })
        setReady(true)
      }, [actions])
      return ready ? <>{children}</> : null
    }

    await renderAsync(
      <ComwitProvider>
        <Opener>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Detail id="a" />
          </Suspense>
        </Opener>
      </ComwitProvider>
    )

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha (full)')
    expect(screen.getByTestId('description-a').textContent).toBe('set')
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
    // Fresh under staleTime: no upgrade request for a full value.
    expect(queryFn).not.toHaveBeenCalled()
    void request
  })

  test('a hydrated value is a full value and wins over the seed', async () => {
    const { queryFn, useCatalog, Detail } = setup({ staleTime: 60_000 })

    function Hydrated({ children }: { children: ReactNode }) {
      useCatalog.hydrate({
        detail: { arg: 'a', data: { id: 'a', title: 'Alpha (server)', description: 'hydrated' } },
      })
      return <>{children}</>
    }

    await renderAsync(
      <ComwitProvider>
        <Hydrated>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Detail id="a" />
          </Suspense>
        </Hydrated>
      </ComwitProvider>
    )

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha (server)')
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
    expect(queryFn).not.toHaveBeenCalled()
  })

  test('a fetched full value stays full when a later reader mounts', async () => {
    const { request, queryFn, Detail } = setup({ staleTime: 60_000 })

    function App({ second }: { second: boolean }) {
      return (
        <ComwitProvider>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Detail id="a" />
          </Suspense>
          {second && (
            <Suspense fallback={<div data-testid="fallback-2">loading</div>}>
              <Detail id="a" />
            </Suspense>
          )}
        </ComwitProvider>
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      rerender = render(<App second={false} />).rerender
    })
    expect(queryFn).toHaveBeenCalledOnce()
    await act(async () => {
      request('a').resolve(fullDetail('a'))
      await request('a').promise
    })
    await waitFor(() => expect(screen.getByTestId('description-a').textContent).toBe('a description'))

    await act(async () => {
      rerender(<App second />)
    })
    expect(screen.queryByTestId('fallback-2')).toBeNull()
    const descriptions = screen.getAllByTestId('description-a').map((node) => node.textContent)
    expect(descriptions).toEqual(['a description', 'a description'])
    for (const node of screen.getAllByTestId('flags')) {
      expect(node.textContent).toContain('partial:false')
    }
    expect(queryFn).toHaveBeenCalledOnce()
  })

  test('staleTime does not block the upgrade of a seeded key', async () => {
    const field = setup({ staleTime: 60_000 })
    await renderAsync(
      <ComwitProvider>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <field.Detail id="a" />
        </Suspense>
      </ComwitProvider>
    )
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(flags()).toContain('partial:true')
    expect(field.queryFn).toHaveBeenCalledOnce()
    cleanup()

    const provider = setup()
    await renderAsync(
      <ComwitProvider defaultOptions={{ query: { staleTime: 60_000 } }}>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <provider.Detail id="a" />
        </Suspense>
      </ComwitProvider>
    )
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(flags()).toContain('partial:true')
    expect(provider.queryFn).toHaveBeenCalledOnce()
  })

  test('a rejected upgrade keeps the seed with isError and isPartial, and refetch() retries it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { request, reset, queryFn, useCatalog, Detail } = setup()

    function Retry() {
      const actions = useCatalog((state) => state.actions)
      return <button onClick={() => void actions.refetch()}>retry</button>
    }

    await renderAsync(
      <ComwitProvider>
        <ErrorBoundary fallback={<div data-testid="boundary">failed</div>}>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Detail id="a" />
            <Retry />
          </Suspense>
        </ErrorBoundary>
      </ComwitProvider>
    )

    await act(async () => {
      request('a').reject(new Error('offline'))
      await request('a').promise.catch(() => {})
    })

    await waitFor(() => expect(flags()).toContain('error:true'))
    // The seed stays painted: no boundary, no fallback.
    expect(screen.queryByTestId('boundary')).toBeNull()
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(flags()).toBe(
      'partial:true loading:false fetching:false success:false error:true slow:false'
    )
    expect(queryFn).toHaveBeenCalledOnce()

    // refetch() on a partial key runs the upgrade again, still without suspending.
    reset('a')
    await act(async () => {
      fireEvent.click(screen.getByText('retry'))
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(flags()).toBe(
      'partial:true loading:false fetching:true success:false error:false slow:false'
    )

    await act(async () => {
      request('a').resolve(fullDetail('a'))
      await request('a').promise
    })
    await waitFor(() => expect(screen.getByTestId('description-a').textContent).toBe('a description'))
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
    consoleError.mockRestore()
  })

  test('an upgrade that resolves null discards the seed as not found', async () => {
    const { request, Detail } = setup()

    await renderAsync(
      <ComwitProvider>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <Detail id="a" />
        </Suspense>
      </ComwitProvider>
    )
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')

    await act(async () => {
      request('a').resolve(null)
      await request('a').promise
    })

    await waitFor(() => expect(screen.getByTestId('title-a').textContent).toBe('none'))
    expect(flags()).toBe(
      'partial:false loading:false fetching:false success:true error:false slow:false'
    )
  })

  test('changing the argument never shows another key’s seed', async () => {
    const { request, queryFn, Detail } = setup()

    function App() {
      const [id, setId] = React.useState('a')
      return (
        <ComwitProvider>
          <button onClick={() => setId('b')}>b</button>
          <button onClick={() => setId('c')}>c</button>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Detail id={id} />
          </Suspense>
        </ComwitProvider>
      )
    }

    await renderAsync(<App />)
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(queryFn).toHaveBeenCalledTimes(1)

    // Another seeded key paints its own seed, not the previous key's.
    await act(async () => {
      fireEvent.click(screen.getByText('b'))
    })
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-b').textContent).toBe('Beta')
    expect(flags()).toContain('partial:true')
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(queryFn).toHaveBeenLastCalledWith('b', expect.anything())

    await act(async () => {
      request('b').resolve(fullDetail('b'))
      await request('b').promise
    })
    await waitFor(() => expect(screen.getByTestId('description-b').textContent).toBe('b description'))
    expect(flags()).toContain('partial:false')

    // A key with no seed and no cache suspends instead of reusing a seed.
    await act(async () => {
      fireEvent.click(screen.getByText('c'))
    })
    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(queryFn).toHaveBeenCalledTimes(3)
    await act(async () => {
      request('c').resolve(fullDetail('c'))
      await request('c').promise
    })
    await waitFor(() => expect(screen.getByTestId('title-c').textContent).toBe('C'))
  })

  test('leaving a seeded key for an unseeded .load(id) resets to initialData', async () => {
    const { request, queryFn, Detail } = setup()

    function App() {
      const [id, setId] = React.useState('a')
      return (
        <ComwitProvider>
          <button onClick={() => setId('c')}>c</button>
          <Detail id={id} mode="load" />
        </ComwitProvider>
      )
    }

    await renderAsync(<App />)
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(flags()).toContain('partial:true')

    await act(async () => {
      fireEvent.click(screen.getByText('c'))
    })
    expect(screen.getByTestId('title-c').textContent).toBe('none')
    expect(flags()).toBe(
      'partial:false loading:true fetching:true success:false error:false slow:false'
    )
    expect(queryFn).toHaveBeenCalledTimes(2)
    void request
  })

  test('two readers with different ids each see only their own seed', async () => {
    const { request, Detail } = setup()

    await renderAsync(
      <ComwitProvider>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <Detail id="a" />
          <Detail id="b" />
        </Suspense>
      </ComwitProvider>
    )

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(screen.getByTestId('title-b').textContent).toBe('Beta')

    await act(async () => {
      request('a').resolve(fullDetail('a'))
      request('b').resolve(fullDetail('b'))
      await Promise.all([request('a').promise, request('b').promise])
    })

    // Whatever upgraded, no reader shows the other key's value.
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(screen.getByTestId('title-b').textContent).toBe('Beta')
    expect(screen.getByTestId('description-b').textContent).toBe('b description')
  })

  test.each(['suspend', 'load'] as const)(
    'a key mounted after another key’s failed upgrade never inherits that key’s seed (%s)',
    async (mode) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { request, Detail } = setup({
      items: [...summaries, { id: 'c', title: 'Gamma' }],
    })

    function App({ ids }: { ids: string[] }) {
      return (
        <ComwitProvider>
          <Suspense fallback={<div data-testid="fallback">loading</div>}>
            {ids.map((id) => (
              <Detail key={id} id={id} mode={mode} />
            ))}
          </Suspense>
        </ComwitProvider>
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      rerender = render(<App ids={['a']} />).rerender
    })
    await act(async () => {
      request('a').reject(new Error('offline'))
      await request('a').promise.catch(() => {})
    })
    await waitFor(() => expect(screen.getByTestId('flags').textContent).toContain('error:true'))

    // Key b is created while the proxy still shows a's errored seed, then key c takes over.
    await act(async () => {
      rerender(<App ids={['a', 'b']} />)
    })
    await act(async () => {
      rerender(<App ids={['a', 'b', 'c']} />)
    })

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')
    expect(screen.getByTestId('title-b').textContent).toBe('Beta')
    expect(screen.getByTestId('title-c').textContent).toBe('Gamma')
    consoleError.mockRestore()
    }
  )

  test('the seed is read from a read-only model snapshot during render', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const states: unknown[] = []
    const catalog = model({
      list: query<Summary[]>({ initialData: summaries, queryFn: () => summaries }),
      detail: query<Detail | null, string, Summary>({
        initialData: null,
        queryFn: (id) => Promise.resolve(fullDetail(id)),
        seed: (id, { state }) => {
          states.push(state)
          return state.list.data.find((item: Summary) => item.id === id)
        },
      }),
    })

    function View() {
      const detail = useModel(catalog, (state) => state.detail.suspend('a'))
      return <div data-testid="title">{detail.data?.title}</div>
    }

    await renderAsync(
      <React.StrictMode>
        <ComwitProvider>
          <Suspense fallback={null}>
            <View />
          </Suspense>
        </ComwitProvider>
      </React.StrictMode>
    )

    expect(screen.getByTestId('title').textContent).toBe('Alpha')
    expect(states.length).toBeGreaterThan(0)
    // Render-time reads happen through the frozen selector snapshot, so writes throw.
    const rendered = states[0] as { list: { data: Summary[] } }
    expect(() => {
      ;(rendered.list.data as Summary[])[0] = { id: 'z', title: 'Z' }
    }).toThrow()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('the committed seed is a detached copy of its list row', async () => {
    const { catalog, useCatalog, Detail } = setup()
    const mutations = action(({ state }) => ({
      mutateDetail() {
        const data = state(catalog).detail.data
        if (data) data.title = 'Mutated'
      },
    }))

    function List() {
      const titles = useCatalog((state) => state.list.data.map((item) => item.title).join(','))
      return <div data-testid="list">{titles}</div>
    }
    function Mutator() {
      const actions = useAction<{ mutateDetail(): void }>([mutations])
      return <button onClick={() => actions.mutateDetail()}>mutate</button>
    }

    await renderAsync(
      <ComwitProvider>
        <Suspense fallback={null}>
          <Detail id="a" />
          <List />
          <Mutator />
        </Suspense>
      </ComwitProvider>
    )
    expect(screen.getByTestId('title-a').textContent).toBe('Alpha')

    await act(async () => {
      fireEvent.click(screen.getByText('mutate'))
    })
    // Editing the seeded detail must not write through to the list row it was derived from.
    expect(screen.getByTestId('title-a').textContent).toBe('Mutated')
    expect(screen.getByTestId('list').textContent).toBe('Alpha,Beta')
  })
})
