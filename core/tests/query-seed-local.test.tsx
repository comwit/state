// @vitest-environment happy-dom
import React, { type ReactNode } from 'react'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ComwitProvider, create, local, model, query, useModel } from '../src'
import { bindResourceState, createQueryBindingRegistry } from '../src/core/query'

type Summary = { id: string; title: string }
type Detail = { id: string; title: string; description: string }

const summaries: Summary[] = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta' },
]
const stored: Detail = { id: 'a', title: 'Alpha (stored)', description: 'stored' }
const network: Detail = { id: 'a', title: 'Alpha (network)', description: 'network' }

const details = local.collection<Detail>({ key: 'seeded-details', version: 1 })

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

function localDefaults(factory: IDBFactory, database: string) {
  return { local: { database, indexedDB: factory } }
}

/**
 * Write the full row for `detail.id` the way an earlier session would have: a model with the
 * same collection and field path fetches it through a provider-less accessor. Awaiting the query
 * awaits the IndexedDB commit, so the row is durable when this resolves.
 */
async function populate(factory: IDBFactory, database: string, detail: Detail) {
  const earlier = model({
    detail: local.query<Detail | null, string>({
      source: details,
      initialData: null,
      queryFn: () => detail,
    }),
  })
  const store = earlier.instance()
  const bound = bindResourceState(
    store.proxy,
    earlier.pluginBags.get('query')!,
    undefined,
    createQueryBindingRegistry(localDefaults(factory, database)),
    earlier.key
  ) as any
  await bound.detail.query(detail.id)
}

function setup(options: {
  factory: IDBFactory
  database: string
  staleTime?: number
  items?: Summary[]
  /** Seed from another model instead of the owning list. */
  readFrom?: ReturnType<typeof model<{ cards: Summary[] }>>
}) {
  const requests = new Map<string, ReturnType<typeof deferred<Detail | null>>>()
  const request = (id: string) => {
    if (!requests.has(id)) requests.set(id, deferred<Detail | null>())
    return requests.get(id)!
  }
  const queryFn = vi.fn((id: string) => request(id).promise)
  const seed = vi.fn((id: string, { state, read }: { state: any; read: any }) => {
    const cards: Summary[] = options.readFrom
      ? (read(options.readFrom)?.cards ?? [])
      : state.list.data
    return cards.find((item) => item.id === id)
  })
  const catalog = model({
    list: query<Summary[]>({
      initialData: options.items ?? summaries,
      queryFn: () => summaries,
    }),
    detail: local.query<Detail | null, string, Summary>({
      source: details,
      initialData: null,
      staleTime: options.staleTime,
      queryFn,
      seed,
    }),
  })
  const useCatalog = create(catalog, { actions: [] })

  /** Every rendered state, in order (one entry per render). */
  const frames: string[] = []
  function Detail({ id }: { id: string }) {
    const detail = useCatalog((state) => state.detail.load(id))
    const frame = [
      detail.data ? detail.data.title : 'none',
      detail.data ? (detail.data.description ?? 'bones') : 'none',
      `partial:${String(detail.isPartial)}`,
      `loading:${String(detail.isLoading)}`,
      `fetching:${String(detail.isFetching)}`,
      `success:${String(detail.isSuccess)}`,
    ].join('|')
    frames.push(frame)
    return <div data-testid="frame">{frame}</div>
  }
  function Provider({ children }: { children: ReactNode }) {
    return (
      <ComwitProvider defaultOptions={localDefaults(options.factory, options.database)}>
        {children}
      </ComwitProvider>
    )
  }

  return { catalog, request, queryFn, seed, frames, Detail, Provider }
}

const frame = () => screen.getByTestId('frame').textContent
const SEED_FRAME = 'Alpha|bones|partial:true|loading:false|fetching:true|success:false'
const STORED_FRAME = 'Alpha (stored)|stored|partial:false|loading:false|fetching:true|success:true'
const STORED_FRESH_FRAME =
  'Alpha (stored)|stored|partial:false|loading:false|fetching:false|success:true'
const NETWORK_FRAME =
  'Alpha (network)|network|partial:false|loading:false|fetching:false|success:true'
/** The value each frame showed, adjacent repeats collapsed. */
const shown = (frames: string[]) =>
  frames.map((f) => f.split('|')[1]).filter((value, index, all) => all[index - 1] !== value)

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('local.query() seed', () => {
  test('(a) .load(id) shows the seed, then the restored row as a full value, then the network', async () => {
    const factory = new IDBFactory()
    const database = `seed-local-a-${crypto.randomUUID()}`
    await populate(factory, database, stored)
    const { request, queryFn, frames, Detail, Provider } = setup({ factory, database })

    await renderAsync(
      <Provider>
        <Detail id="a" />
      </Provider>
    )

    // The seed is painted synchronously, before IndexedDB has answered; never isLoading.
    expect(frames[0]).toBe(SEED_FRAME)

    // The restored row is the key's full value, revalidating in the background.
    await waitFor(() => expect(frame()).toBe(STORED_FRAME))
    expect(queryFn).toHaveBeenCalledOnce()
    expect(queryFn).toHaveBeenCalledWith('a', expect.anything())

    await act(async () => {
      request('a').resolve(network)
      await request('a').promise
    })
    await waitFor(() => expect(frame()).toBe(NETWORK_FRAME))

    expect(shown(frames)).toEqual(['bones', 'stored', 'network'])
    expect(frames.some((f) => f.includes('loading:true'))).toBe(false)
    // Once full, the key never went back to partial.
    expect(frames.lastIndexOf(SEED_FRAME)).toBeLessThan(frames.indexOf(STORED_FRAME))
  })

  test('(b) without a stored row the seed stays until the network result', async () => {
    const factory = new IDBFactory()
    const database = `seed-local-b-${crypto.randomUUID()}`
    const { request, queryFn, frames, Detail, Provider } = setup({ factory, database })

    await renderAsync(
      <Provider>
        <Detail id="a" />
      </Provider>
    )
    expect(frames[0]).toBe(SEED_FRAME)

    // The IndexedDB miss settles and the network request starts: the seed is still what shows.
    await waitFor(() => expect(queryFn).toHaveBeenCalledOnce())
    expect(frame()).toBe(SEED_FRAME)

    await act(async () => {
      request('a').resolve(network)
      await request('a').promise
    })
    await waitFor(() => expect(frame()).toBe(NETWORK_FRAME))
    expect(shown(frames)).toEqual(['bones', 'network'])
    expect(frames.some((f) => f.includes('loading:true'))).toBe(false)
  })

  test('(c) a key already restored in this provider never shows its seed again', async () => {
    const factory = new IDBFactory()
    const database = `seed-local-c-${crypto.randomUUID()}`
    await populate(factory, database, stored)
    const { queryFn, seed, frames, Detail, Provider } = setup({
      factory,
      database,
      staleTime: 60_000,
    })

    function App() {
      const [open, setOpen] = React.useState(true)
      return (
        <Provider>
          <button onClick={() => setOpen((value) => !value)}>toggle</button>
          {open && <Detail id="a" />}
        </Provider>
      )
    }

    await renderAsync(<App />)
    expect(frames[0]).toBe(SEED_FRAME)
    // Fresh under staleTime: the restored row is final and no network request runs.
    await waitFor(() => expect(frame()).toBe(STORED_FRESH_FRAME))
    expect(queryFn).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByText('toggle'))
    })
    expect(screen.queryByTestId('frame')).toBeNull()
    const before = frames.length
    seed.mockClear()

    await act(async () => {
      fireEvent.click(screen.getByText('toggle'))
    })
    // The remounted reader is full from its first frame; the seed is not even consulted.
    expect(frames.length).toBeGreaterThan(before)
    expect(frames.slice(before).every((f) => f === STORED_FRESH_FRAME)).toBe(true)
    expect(seed).not.toHaveBeenCalled()
    expect(queryFn).not.toHaveBeenCalled()
  })

  test('the accessor paints the seed synchronously before the durable read', async () => {
    const factory = new IDBFactory()
    const database = `seed-local-accessor-${crypto.randomUUID()}`
    await populate(factory, database, stored)
    const { catalog, request } = setup({ factory, database })

    const store = catalog.instance()
    const bound = bindResourceState(
      store.proxy,
      catalog.pluginBags.get('query')!,
      undefined,
      createQueryBindingRegistry(localDefaults(factory, database)),
      catalog.key
    ) as any

    const promise = bound.detail.query('a')
    expect(bound.detail.data).toEqual({ id: 'a', title: 'Alpha' })
    expect(bound.detail.isPartial).toBe(true)
    expect(bound.detail.isLoading).toBe(false)
    expect(bound.detail.isFetching).toBe(true)

    await vi.waitFor(() => expect(bound.detail.data?.description).toBe('stored'))
    expect(bound.detail.isPartial).toBe(false)
    expect(bound.detail.isSuccess).toBe(true)
    expect(bound.detail.isFetching).toBe(true)

    request('a').resolve(network)
    await promise
    expect(bound.detail.data).toEqual(network)
    expect(bound.detail.isPartial).toBe(false)
    expect(bound.detail.isFetching).toBe(false)
  })

  test('a local.query() seed may read another model', async () => {
    const factory = new IDBFactory()
    const database = `seed-local-read-${crypto.randomUUID()}`
    const lounge = model({ cards: summaries })
    const { request, frames, Detail, Provider } = setup({
      factory,
      database,
      items: [],
      readFrom: lounge,
    })
    function Lounge() {
      useModel(lounge, (state) => state.cards.length)
      return null
    }

    await renderAsync(
      <Provider>
        <Lounge />
        <Detail id="a" />
      </Provider>
    )
    expect(frames[0]).toBe(SEED_FRAME)

    await act(async () => {
      request('a').resolve(network)
      await request('a').promise
    })
    await waitFor(() => expect(frame()).toBe(NETWORK_FRAME))
    expect(shown(frames)).toEqual(['bones', 'network'])
  })

  test('local.query() still rejects a seed that is not a function', () => {
    expect(() =>
      local.query<Detail | null, string, Summary>({
        source: details,
        initialData: null,
        queryFn: () => null,
        seed: { id: 'a', title: 'A' } as never,
      })
    ).toThrow(TypeError)
  })
})
