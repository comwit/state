import { action, create, model, query, type Query, type SeededSingleResourceState } from '../src'
import type { BoundResourceState, SelectableResourceState } from '../src/core/query/types'

type Summary = { id: string; title: string }
type Detail = { id: string; title: string; description: string; price: number }
type WithExtraKey = { id: string; title: string; bogus: boolean }
type WithMismatch = { id: string; title: number }

const findDetail = async (id: string): Promise<Detail | null> => ({
  id,
  title: '',
  description: '',
  price: 0,
})

// A seed is declared through the third generic and a function reading the owning model.
const detail = query<Detail | null, string, Summary>({
  initialData: null,
  queryFn: findDetail,
  seed: (id, { state }) => state.list.data.find((item: Summary) => item.id === id),
})
const detailNull = query<Detail | null, string, Summary>({
  initialData: null,
  queryFn: findDetail,
  seed: () => null,
})
const plain = query<Detail | null, string>({ initialData: null, queryFn: findDetail })
const noArg = query<number>({ initialData: 0, queryFn: () => 1 })

// @ts-expect-error a seed may not carry keys the full value lacks
query<Detail | null, string, WithExtraKey>({
  initialData: null,
  queryFn: findDetail,
  seed: () => null,
})
// @ts-expect-error a seed field must keep the full value's type
query<Detail | null, string, WithMismatch>({
  initialData: null,
  queryFn: findDetail,
  seed: () => null,
})
query<Detail | null, string>({
  initialData: null,
  queryFn: findDetail,
  // @ts-expect-error seed requires the third generic
  seed: () => ({ id: 'a', title: 'b' }),
})
query<Detail | null, string, Summary>({
  initialData: null,
  queryFn: findDetail,
  // @ts-expect-error seed is a function, never a value
  seed: { id: 'a', title: 'b' },
})
query<Detail | null, string, Summary>({
  initialData: null,
  queryFn: findDetail,
  // @ts-expect-error a seed returns the declared seed shape
  seed: () => ({ id: 'a' }),
})

// The Query alias carries the seed as its third generic.
const aliased: Query<Detail | null, string, Summary> = detail
const singleAliased: Query.Single<Detail | null, string, Summary> = detail
// @ts-expect-error a seeded query is not a plain Query
const notPlain: Query<Detail | null, string> = detail
void [aliased, singleAliased, notPlain]

const catalog = model({ list: query<Summary[]>({ initialData: [], queryFn: () => [] }), detail, detailNull, plain, noArg, count: 0 })
const useCatalog = create(catalog, { actions: [] })

function selectorContract() {
  const result = useCatalog((state) => state.detail.suspend('a'))
  const partialOrFull: SeededSingleResourceState<Detail | null, Summary> = result
  void partialOrFull

  // Narrowing through the discriminant.
  if (result.isPartial) {
    const id: string = result.data.id
    const description: string | undefined = result.data.description
    // @ts-expect-error detail-only fields are optional while partial
    const required: string = result.data.description
    const notLoading: false = result.isLoading
    const notSuccess: false = result.isSuccess
    const notSlow: false = result.isSlowLoading
    const fetching: boolean = result.isFetching
    void [id, description, required, notLoading, notSuccess, notSlow, fetching]
  } else {
    const full: Detail | null = result.data
    const success: boolean = result.isSuccess
    void [full, success]
  }

  // Narrowing after destructuring.
  const { isPartial, data } = useCatalog((state) => state.detail.load('a'))
  if (isPartial) {
    const title: string = data.title
    const price: number | undefined = data.price
    void [title, price]
  } else {
    const full: Detail | null = data
    void full
  }

  // Passive reads share the union.
  const passive = useCatalog((state) => state.detail)
  if (!passive.isPartial) {
    const full: Detail | null = passive.data
    void full
  }

  // Queries without a seed keep their existing result shape.
  const plainResult = useCatalog((state) => state.plain.suspend('a'))
  const plainData: Detail | null = plainResult.data
  // @ts-expect-error unseeded results do not report isPartial
  plainResult.isPartial
  const loaded = useCatalog((state) => state.plain.load('a'))
  // @ts-expect-error unseeded results do not report isPartial
  loaded.isPartial
  const total: number = useCatalog((state) => state.noArg.load()).data
  const count: number = useCatalog((state) => state.count)
  void [plainData, total, count]
}

// Projections used by model hooks and actions.
type Selectable = SelectableResourceState<{ detail: typeof detail; plain: typeof plain }>
declare const selectable: Selectable
const selectableSeeded: SeededSingleResourceState<Detail | null, Summary> = selectable.detail.load(
  'a'
)
void selectableSeeded

type Bound = BoundResourceState<{ detail: typeof detail; plain: typeof plain }>
declare const bound: Bound
const boundFlag: boolean = bound.detail.isPartial
const boundData: Detail | null = bound.detail.data
// @ts-expect-error the flag is library-owned
bound.detail.isPartial = true
// @ts-expect-error unseeded bound resources do not report isPartial
bound.plain.isPartial
void [boundFlag, boundData]

const catalogActions = action(({ state }) => ({
  reset() {
    // Writing data through actions keeps the full value type.
    state(catalog).detail.data = null
    state(catalog).detail.set({ id: 'a', title: 'A', description: '', price: 1 }, { arg: 'a' })
    const partial: boolean = state(catalog).detail.isPartial
    return partial
  },
}))
void catalogActions

// Hydration still infers the full value for a seeded query.
function hydrationContract() {
  useCatalog.hydrate({
    detail: { arg: 'a', data: { id: 'a', title: 'A', description: '', price: 1 } },
  })
  // @ts-expect-error hydration data is the full value, not the seed
  useCatalog.hydrate({ detail: { arg: 'a', data: { id: 'a', title: 'A' } } })
}

void [selectorContract, hydrationContract]
