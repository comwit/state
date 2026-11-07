import { model, query, useModel } from '../src'

/**
 * An argument-less `load()` / `suspend()` is typed only when `queryFn` accepts `undefined`: with
 * nothing active yet it owns the `undefined` key and calls `queryFn(undefined)`. A query keyed by
 * a required argument keeps its single signature; children read `.data` without a method.
 */

type Post = { id: string; title: string }

const catalog = model({
  list: query<string[], { page: number } | undefined>({
    initialData: [],
    queryFn: async (params) => [`page-${params?.page ?? 1}`],
  }),
  detail: query<Post | null, string>({
    initialData: null,
    queryFn: async (id) => ({ id, title: id }),
  }),
})

declare function expectType<T>(value: T): void

export function Followers() {
  const list = useModel(catalog, (s) => s.list.load())
  expectType<string[]>(list.data)

  const page = useModel(catalog, (s) => s.list.load({ page: 2 }))
  expectType<string[]>(page.data)

  const suspended = useModel(catalog, (s) => s.list.suspend())
  expectType<string[]>(suspended.data)

  const detail = useModel(catalog, (s) => s.detail.load('a'))
  expectType<Post | null>(detail.data)

  const current = useModel(catalog, (s) => s.detail.data)
  expectType<Post | null>(current)

  // @ts-expect-error a required argument has no argument-less load()
  useModel(catalog, (s) => s.detail.load())
  // @ts-expect-error a required argument has no argument-less suspend()
  useModel(catalog, (s) => s.detail.suspend())
}
