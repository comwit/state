// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import React, { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { action, ComwitProvider, create, model, persist, type PersistAdapter } from '../src'

function createSpyAdapter<T>(initial?: T) {
  const store = new Map<string, T>()
  if (initial !== undefined) store.set('n', initial)
  const listeners = new Set<(value: T) => void>()
  const adapter = {
    store,
    listeners,
    get: vi.fn((key: string) => (store.has(key) ? (store.get(key) as T) : null)),
    set: vi.fn((key: string, value: T) => {
      store.set(key, value)
    }),
    remove: vi.fn((key: string) => {
      store.delete(key)
    }),
    subscribe: vi.fn((_key: string, callback: (value: T) => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }),
  } satisfies PersistAdapter<T> & Record<string, unknown>
  return adapter
}

function setup(
  storage: PersistAdapter<number> | 'localStorage',
  options?: { debounceMs?: number | false }
) {
  const prefs = model<{ n: number }>({
    n: persist({
      key: 'n',
      defaultValue: 0,
      storage,
      ...options,
    }) as unknown as number,
  })
  // The factory binds the model eagerly, as class-style actions with field initializers do.
  const usePrefs = create(prefs, {
    actions: [
      action(({ state }) => {
        const s = state(prefs)
        return {
          inc() {
            s.n += 1
          },
        }
      }),
    ],
  })

  function Reader({ id }: { id: number }) {
    const n = usePrefs((s) => s.n)
    return <span data-testid={`reader-${id}`}>{n}</span>
  }

  function App({ readers = 0 }: { readers?: number }) {
    const p = usePrefs((s) => ({ n: s.n, actions: s.actions }))
    const [late, setLate] = useState(false)
    return (
      <>
        <button
          onClick={() => {
            p.actions.inc()
            setLate(true)
          }}
        >
          {p.n}
        </button>
        {late ? <Reader id={0} /> : null}
        {Array.from({ length: readers }, (_, i) => (
          <Reader key={i} id={i + 1} />
        ))}
      </>
    )
  }

  return { App, Reader }
}

// Node 25 exposes its own global `localStorage`, which shadows the DOM one; pin an in-memory Storage.
class MemoryStorage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value))
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  clear() {
    this.items.clear()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('persist() inside a provider', () => {
  test('a consumer mounted within the debounce window keeps the fresh edit', () => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('reader-0').textContent).toBe('1')
    expect(screen.getByRole('button').textContent).toBe('1')

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(adapter.store.get('n')).toBe(1)
    expect(screen.getByRole('button').textContent).toBe('1')
  })

  test('an edit over a stored value survives a late consumer', () => {
    const adapter = createSpyAdapter<number>(5)
    const { App } = setup(adapter)
    render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )
    expect(screen.getByRole('button').textContent).toBe('5')

    fireEvent.click(screen.getByRole('button'))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByTestId('reader-0').textContent).toBe('6')
    expect(adapter.store.get('n')).toBe(6)
  })

  test('reads storage, registers the writer and the listener once per provider', () => {
    const adapter = createSpyAdapter<number>(3)
    const { App } = setup(adapter)
    const view = render(
      <ComwitProvider>
        <App readers={10} />
      </ComwitProvider>
    )
    for (let i = 0; i < 5; i++) {
      view.rerender(
        <ComwitProvider>
          <App readers={i % 2 === 0 ? 0 : 10} />
        </ComwitProvider>
      )
    }

    expect(adapter.get).toHaveBeenCalledTimes(1)
    expect(adapter.subscribe).toHaveBeenCalledTimes(1)
    expect(adapter.listeners.size).toBe(1)

    fireEvent.click(screen.getByRole('button'))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenLastCalledWith('n', 4)

    view.unmount()
    expect(adapter.listeners.size).toBe(0)
  })

  test('removes the window storage listener when the provider unmounts', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { App } = setup('localStorage')
    const view = render(
      <StrictMode>
        <ComwitProvider>
          <App readers={5} />
        </ComwitProvider>
      </StrictMode>
    )
    const storageAdds = () => add.mock.calls.filter(([type]) => type === 'storage').length
    const storageRemoves = () => remove.mock.calls.filter(([type]) => type === 'storage').length
    expect(storageAdds() - storageRemoves()).toBe(1)

    view.unmount()
    expect(storageAdds() - storageRemoves()).toBe(0)
    add.mockRestore()
    remove.mockRestore()
  })

  test('a pending write is flushed when the provider unmounts', () => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    const view = render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )
    fireEvent.click(screen.getByRole('button'))
    view.unmount()
    expect(adapter.store.get('n')).toBe(1)
  })

  test('a storage event from another tab updates every consumer', () => {
    const { App } = setup('localStorage')
    render(
      <StrictMode>
        <ComwitProvider>
          <App readers={2} />
        </ComwitProvider>
      </StrictMode>
    )
    expect(screen.getByRole('button').textContent).toBe('0')

    act(() => {
      window.localStorage.setItem('n', '7')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'n',
          newValue: '7',
          storageArea: window.localStorage,
        })
      )
    })
    expect(screen.getByRole('button').textContent).toBe('7')
    expect(screen.getByTestId('reader-1').textContent).toBe('7')

    // An external value is applied, not echoed back as a local edit.
    const setItem = vi.spyOn(window.localStorage, 'setItem')
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })
})

describe('persist() write timing', () => {
  function clickTimes(count: number) {
    for (let i = 0; i < count; i++) fireEvent.click(screen.getByRole('button'))
  }

  test('memory updates at once; a burst of edits writes storage once after 300ms', () => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )
    clickTimes(5)
    expect(screen.getByRole('button').textContent).toBe('5')
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(adapter.set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenLastCalledWith('n', 5)
  })

  test.each([
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    ['beforeunload', () => window.dispatchEvent(new Event('beforeunload'))],
    [
      'visibilitychange to hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        delete (document as { visibilityState?: unknown }).visibilityState
      },
    ],
  ])('a pending write is flushed on %s', (_name, leave) => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )
    clickTimes(3)
    expect(adapter.set).not.toHaveBeenCalled()
    leave()
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.store.get('n')).toBe(3)

    // Nothing is left pending afterwards.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })

  test('visibilitychange back to visible does not write', () => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )
    clickTimes(1)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(adapter.set).not.toHaveBeenCalled()
  })

  test('page-leave listeners are removed when the provider unmounts', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    const view = render(
      <StrictMode>
        <ComwitProvider>
          <App />
        </ComwitProvider>
      </StrictMode>
    )
    const net = (type: string) =>
      add.mock.calls.filter(([t]) => t === type).length -
      remove.mock.calls.filter(([t]) => t === type).length
    expect(net('pagehide')).toBe(1)
    expect(net('beforeunload')).toBe(1)
    view.unmount()
    expect(net('pagehide')).toBe(0)
    expect(net('beforeunload')).toBe(0)
    add.mockRestore()
    remove.mockRestore()
  })

  test.each([0, false] as const)('persist({ debounceMs: %s }) writes on every change', (value) => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter, { debounceMs: value })
    render(
      <ComwitProvider>
        <App />
      </ComwitProvider>
    )
    clickTimes(3)
    expect(adapter.set).toHaveBeenCalledTimes(3)
    expect(adapter.set).toHaveBeenLastCalledWith('n', 3)
  })

  test('provider defaultOptions.persist.debounceMs sets the delay', () => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter)
    render(
      <ComwitProvider defaultOptions={{ persist: { debounceMs: 1000 } }}>
        <App />
      </ComwitProvider>
    )
    clickTimes(2)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(adapter.set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })

  test('a persist() delay overrides the provider default', () => {
    const adapter = createSpyAdapter<number>()
    const { App } = setup(adapter, { debounceMs: 50 })
    render(
      <ComwitProvider defaultOptions={{ persist: { debounceMs: false } }}>
        <App />
      </ComwitProvider>
    )
    clickTimes(2)
    expect(adapter.set).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })
})
