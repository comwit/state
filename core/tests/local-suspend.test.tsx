// @vitest-environment happy-dom
import React, { Component, Suspense, type ReactNode } from 'react'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ComwitProvider, local, model, query, useModel } from '../src'

type Todo = { id: string; title: string }

const todos = local.collection<Todo>({ key: 'suspend-todos', version: 1 })

class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { message: error.message }
  }
  render() {
    return this.state.message ? (
      <div data-testid="error">{this.state.message}</div>
    ) : (
      this.props.children
    )
  }
}

function Provider({ children }: { children: ReactNode }) {
  return (
    <ComwitProvider
      defaultOptions={{
        local: { database: `local-suspend-${crypto.randomUUID()}`, indexedDB: new IDBFactory() },
      }}
    >
      <Boundary>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>{children}</Suspense>
      </Boundary>
    </ComwitProvider>
  )
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('local resources reject .suspend()', () => {
  const domain = model({
    detail: local.query<Todo | null, string>({
      source: todos,
      initialData: null,
      queryFn: async (id) => ({ id, title: id }),
    }),
    list: local.infinite<Todo[], { status: string }>({
      source: todos,
      initialData: [],
      queryFn: async () => ({ data: [], cursor: null, hasMore: false }),
    }),
    draft: local<Todo | null, string>({ source: todos, initialData: null }),
    legacy: local(query<Todo | null, string>({ initialData: null, queryFn: async () => null }), {
      source: todos,
    }),
  })

  test.each([
    ['local.query()', 'detail', (state: any) => state.detail.suspend('a')],
    ['local.infinite()', 'list', (state: any) => state.list.suspend({ status: 'open' })],
    ['local()', 'draft', (state: any) => state.draft.suspend('a')],
    ['local(query())', 'legacy', (state: any) => state.legacy.suspend('a')],
  ] as const)('%s throws a clear error instead of suspending', async (_label, path, select) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    function View() {
      useModel(domain, select)
      return <div data-testid="view">rendered</div>
    }

    await act(async () => {
      render(
        <Provider>
          <View />
        </Provider>
      )
    })

    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.queryByTestId('view')).toBeNull()
    expect(screen.getByTestId('error').textContent).toBe(
      `[comwit] .suspend() is not available on "${path}": local resources are read with ` +
        '.load() (local.query(), local.infinite()) or .restore() (local())'
    )
    consoleError.mockRestore()
  })

  test('.load() on the same local.query() still works', async () => {
    function View() {
      const detail = useModel(domain, (state) => state.detail.load('a'))
      return <div data-testid="view">{detail.data ? detail.data.title : 'none'}</div>
    }

    await act(async () => {
      render(
        <Provider>
          <View />
        </Provider>
      )
    })
    expect(screen.queryByTestId('error')).toBeNull()
    expect(screen.getByTestId('view')).toBeDefined()
  })
})
