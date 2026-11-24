import { subscribe } from './proxy'
import { silent } from './silent'
import { debounce } from '../utils'
import type { FieldPlugin, PluginBag } from './plugin'

const PERSIST_BRAND = Symbol('comwit-persist')

export type PersistAdapter<T = unknown> = {
  get(key: string): T | null
  set(key: string, value: T): void
  remove(key: string): void
  subscribe?(key: string, callback: (value: T) => void): () => void
}

export type PersistOptions<T> = {
  key: string
  defaultValue: T
  storage?: 'localStorage' | 'sessionStorage' | PersistAdapter<T>
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  /**
   * Delay before a change is written to storage, in ms. The in-memory value updates
   * immediately; only the storage write waits. `0` or `false` writes on every change.
   * Defaults to the provider's `defaultOptions.persist.debounceMs` (300ms).
   */
  debounceMs?: number | false
}

export type PersistDescriptor<T = unknown> = {
  [PERSIST_BRAND]: true
  key: string
  defaultValue: T
  adapter: PersistAdapter<T>
  serialize: (value: T) => string
  deserialize: (raw: string) => T
  debounceMs?: number | false
}

export type PersistDefaults = {
  /**
   * Delay before persisted changes are written to storage, in ms. `0` or `false`
   * writes on every change. Default 300.
   */
  debounceMs?: number | false
}

export const DEFAULT_PERSIST_DEBOUNCE_MS = 300

function isBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.localStorage !== 'undefined' &&
    typeof window.localStorage.getItem === 'function'
  )
}

function createWebStorageAdapter<T>(
  storageKey: 'localStorage' | 'sessionStorage',
  serialize: (value: T) => string,
  deserialize: (raw: string) => T
): PersistAdapter<T> {
  const adapter: PersistAdapter<T> = {
    get(key: string): T | null {
      if (!isBrowser()) return null
      try {
        const raw = window[storageKey].getItem(key)
        if (raw === null) return null
        return deserialize(raw)
      } catch {
        return null
      }
    },
    set(key: string, value: T): void {
      if (!isBrowser()) return
      try {
        window[storageKey].setItem(key, serialize(value))
      } catch {
        // quota exceeded or other storage error
      }
    },
    remove(key: string): void {
      if (!isBrowser()) return
      try {
        window[storageKey].removeItem(key)
      } catch {}
    },
  }

  if (storageKey === 'localStorage') {
    adapter.subscribe = (key: string, callback: (value: T) => void): (() => void) => {
      if (!isBrowser()) return () => {}
      const handler = (e: StorageEvent) => {
        if (e.key !== key || e.storageArea !== window.localStorage) return
        if (e.newValue === null) return
        try {
          callback(deserialize(e.newValue))
        } catch {}
      }
      window.addEventListener('storage', handler)
      return () => window.removeEventListener('storage', handler)
    }
  }

  return adapter
}

export function persist<T>(options: PersistOptions<T>): PersistDescriptor<T> {
  const serialize = options.serialize ?? ((v: T) => JSON.stringify(v))
  const deserialize = options.deserialize ?? ((raw: string) => JSON.parse(raw) as T)

  let adapter: PersistAdapter<T>
  if (!options.storage || options.storage === 'localStorage') {
    adapter = createWebStorageAdapter<T>('localStorage', serialize, deserialize)
  } else if (options.storage === 'sessionStorage') {
    adapter = createWebStorageAdapter<T>('sessionStorage', serialize, deserialize)
  } else {
    adapter = options.storage
  }

  return {
    [PERSIST_BRAND]: true,
    key: options.key,
    defaultValue: options.defaultValue,
    adapter,
    serialize,
    deserialize,
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
  }
}

export function isPersistDescriptor(value: unknown): value is PersistDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [PERSIST_BRAND]?: unknown })[PERSIST_BRAND] === true
  )
}

// --- Binding logic ---

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj
  for (const k of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[k]
  }
  return current
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const next = current[keys[i]]
    if (next === null || next === undefined || typeof next !== 'object') return
    current = next as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}

type PersistBinding = {
  /** Start listening for values written by other tabs. Idempotent. */
  attach(): void
  /** Stop listening for values written by other tabs. Idempotent. */
  detach(): void
  /** Write a pending local change now instead of after the debounce. */
  flush(): void
}

type PersistRegistryState = {
  /**
   * One entry per bound store (keyed by model). A store reads storage and registers its
   * writer and cross-tab listener once, however many components bind it through `state()`.
   */
  bindings: Map<symbol | object, PersistBinding[]>
  /** False while the provider is unmounted; cross-tab listeners are detached meanwhile. */
  active: boolean
  /** Removes the page-leave listeners that flush pending writes; null when not listening. */
  stopPageLeave: (() => void) | null
}

function createPersistRegistryState(): PersistRegistryState {
  return { bindings: new Map(), active: true, stopPageLeave: null }
}

function flushAll(registryState: PersistRegistryState): void {
  for (const bindings of registryState.bindings.values()) {
    for (const binding of bindings) binding.flush()
  }
}

/**
 * Write pending changes when the page may be discarded. `pagehide` and a hidden
 * `visibilitychange` are the last reliable moments on mobile; `beforeunload` covers
 * desktop browsers that skip them. Storage writes are synchronous, so they land in time.
 */
function listenPageLeave(registryState: PersistRegistryState): void {
  if (registryState.stopPageLeave || typeof window === 'undefined') return
  if (typeof window.addEventListener !== 'function') return
  const flush = () => flushAll(registryState)
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  registryState.stopPageLeave = () => {
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', flush)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

function resolveDebounceMs(
  descriptor: PersistDescriptor,
  defaults: PersistDefaults | undefined
): number {
  const value = descriptor.debounceMs ?? defaults?.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
  return value === false ? 0 : Math.max(0, value)
}

export function bindPersistState(
  proxy: Record<string, unknown>,
  bag: PluginBag,
  registryState: PersistRegistryState,
  defaults?: PersistDefaults,
  modelKey?: symbol
): void {
  const bindingKey = modelKey ?? proxy
  // Hydrating again would replace a local edit whose debounced write is still pending.
  if (registryState.bindings.has(bindingKey)) return

  const bindings: PersistBinding[] = []
  // Values that come from storage are not local edits, so no field writes them back.
  let applyingStored = false

  for (const [path, value] of bag) {
    const descriptor = value as PersistDescriptor
    const { key, adapter, defaultValue } = descriptor

    // Hydrate from storage
    const stored = adapter.get(key)
    applyingStored = true
    try {
      silent(() => {
        if (stored !== null) {
          setNestedValue(proxy, path, stored)
        } else {
          setNestedValue(proxy, path, defaultValue)
        }
      })
    } finally {
      applyingStored = false
    }

    // Subscribe to proxy changes and write back. The proxy already holds the new value;
    // only the storage write is delayed, so bursts (zoom, scroll, drag) write once.
    const write = () => {
      adapter.set(key, getNestedValue(proxy, path))
    }
    const debounceMs = resolveDebounceMs(descriptor, defaults)
    const writeBack: { (): void; cancel(): void; flush(): void } =
      debounceMs > 0
        ? debounce(write, debounceMs)
        : Object.assign(write, { cancel() {}, flush() {} })

    subscribe(proxy, () => {
      if (!applyingStored) writeBack()
    })

    // Cross-tab sync
    let unsubStorage: (() => void) | null = null
    const binding: PersistBinding = {
      attach() {
        if (unsubStorage || !adapter.subscribe) return
        unsubStorage = adapter.subscribe(key, (newValue) => {
          // The other tab wrote last; drop the superseded local write.
          writeBack.cancel()
          applyingStored = true
          try {
            setNestedValue(proxy, path, newValue)
          } finally {
            applyingStored = false
          }
        })
      },
      detach() {
        unsubStorage?.()
        unsubStorage = null
      },
      flush() {
        writeBack.flush()
      },
    }
    if (registryState.active) binding.attach()
    bindings.push(binding)
  }

  registryState.bindings.set(bindingKey, bindings)
  if (registryState.active) listenPageLeave(registryState)
}

/** Provider committed (again): listen for other tabs. */
export function activatePersist(registryState: PersistRegistryState): void {
  registryState.active = true
  if (registryState.bindings.size > 0) listenPageLeave(registryState)
  for (const bindings of registryState.bindings.values()) {
    for (const binding of bindings) binding.attach()
  }
}

/** Provider unmounted: write pending changes and stop listening for other tabs. */
export function deactivatePersist(registryState: PersistRegistryState): void {
  registryState.active = false
  registryState.stopPageLeave?.()
  registryState.stopPageLeave = null
  for (const bindings of registryState.bindings.values()) {
    for (const binding of bindings) {
      binding.flush()
      binding.detach()
    }
  }
}

// --- Plugin definition ---

export const persistPlugin: FieldPlugin = {
  name: 'persist',

  detect(value: unknown, path: string, bag: PluginBag) {
    if (!isPersistDescriptor(value)) return null
    if (!path) throw new Error('persist() entry must be assigned to a model field')
    bag.set(path, value)
    return { initialValue: value.defaultValue }
  },

  createRegistryState(_defaults?: Record<string, unknown>): PersistRegistryState {
    return createPersistRegistryState()
  },

  bindState(
    proxy: object,
    bag: PluginBag,
    registryState: unknown,
    defaults?: Record<string, unknown>,
    modelKey?: symbol
  ): object {
    if (bag.size === 0) return proxy
    bindPersistState(
      proxy as Record<string, unknown>,
      bag,
      registryState as PersistRegistryState,
      defaults as PersistDefaults | undefined,
      modelKey
    )
    return proxy
  },

  activate(registryState: unknown): void {
    activatePersist(registryState as PersistRegistryState)
  },

  deactivate(registryState: unknown): void {
    deactivatePersist(registryState as PersistRegistryState)
  },
}
