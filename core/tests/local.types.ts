import {
  create,
  local,
  model,
  query,
  type LocalInfinite,
  type LocalQuery,
  type Query,
  type SeededSingleResourceState,
} from '../src'
import type { SelectableResourceState } from '../src/core/query/types'

type Todo = { id: string; title: string; done: boolean }
type TodoSummary = { id: string; title: string }

const todos = local.collection<Todo>({ key: 'todos', version: 1 })
const findTodo = async (id: string): Promise<Todo | null> => ({ id, title: '', done: false })

// An explicitly typed collection is accepted by every local resource (TEntity defaults to any).
const detail = local.query<Todo | null, string>({ source: todos, initialData: null, queryFn: findTodo })
const seeded = local.query<Todo | null, string, TodoSummary>({
  source: todos,
  initialData: null,
  queryFn: findTodo,
  seed: () => null,
})
const list = local.infinite<Todo[], { status: string }>({
  source: todos,
  initialData: [],
  queryFn: async () => ({ data: [], cursor: null, hasMore: false }),
})
const draft = local<Todo | null, string>({ source: todos, initialData: null })
const legacy = local(query<Todo | null, string>({ initialData: null, queryFn: findTodo }), {
  source: todos,
})

// Factory results are the query descriptor plus the load-only brand.
const detailType: LocalQuery<Todo | null, string> = detail
const seededType: LocalQuery<Todo | null, string, TodoSummary> = seeded
const listType: LocalInfinite<Todo[], { status: string }> = list
const asQuery: Query<Todo | null, string> = detail
void [detailType, seededType, listType, asQuery]

const domain = model({ detail, seeded, list, draft, legacy })
const useDomain = create(domain, { actions: [] })

function loadOnlyContract() {
  // `.load()` keeps the query result shapes, including the seeded union.
  const loaded: Todo | null = useDomain((state) => state.detail.load('a')).data
  const paged: Todo[] = useDomain((state) => state.list.load({ status: 'open' })).data
  const restored: Todo | null = useDomain((state) => state.draft.restore('a')).data
  const legacyLoaded: Todo | null = useDomain((state) => state.legacy.load('a')).data
  const seededResult = useDomain((state) => state.seeded.load('a'))
  const union: SeededSingleResourceState<Todo | null, TodoSummary> = seededResult
  if (seededResult.isPartial) {
    const title: string = seededResult.data.title
    const done: boolean | undefined = seededResult.data.done
    void [title, done]
  }
  void [loaded, paged, restored, legacyLoaded, union]

  // `.suspend()` is not available on any local resource.
  // @ts-expect-error local.query() is read with .load()
  useDomain((state) => state.detail.suspend('a'))
  // @ts-expect-error a seeded local.query() is read with .load()
  useDomain((state) => state.seeded.suspend('a'))
  // @ts-expect-error local.infinite() is read with .load()
  useDomain((state) => state.list.suspend({ status: 'open' }))
  // @ts-expect-error standalone local() is read with .restore()
  useDomain((state) => state.draft.suspend('a'))
  // @ts-expect-error the deprecated local(query()) form is read with .load()
  useDomain((state) => state.legacy.suspend('a'))
}

// The selector projection itself has no suspend member for local descriptors.
type Selectable = SelectableResourceState<{ detail: typeof detail; list: typeof list }>
declare const selectable: Selectable
// @ts-expect-error no suspend on a selectable local.query()
selectable.detail.suspend
// @ts-expect-error no suspend on a selectable local.infinite()
selectable.list.suspend
const stillLoads: Todo | null = selectable.detail.load('a').data
void stillLoads

// Plain query() keeps .suspend().
const plain = model({ detail: query<Todo | null, string>({ initialData: null, queryFn: findTodo }) })
const usePlain = create(plain, { actions: [] })
function plainStillSuspends() {
  const value: Todo | null = usePlain((state) => state.detail.suspend('a')).data
  void value
}

void [loadOnlyContract, plainStillSuspends]
