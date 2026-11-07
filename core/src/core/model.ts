import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react'
import { createProxy, snapshot, subscribe } from './proxy'
import { getPlugins, type PluginBag } from './plugin'
import { useStoreRegistry } from './provider'
import { isEqual } from '../utils'
import {
  canonicalPath,
  getPathValue,
  setPathValue,
  sameSearchParamAccess,
  SEARCH_PARAM_PLUGIN_NAME,
} from './router'
import { isSilent } from './silent'
import { COMPUTED_PLUGIN_NAME, createComputedProxy, getComputedSnapshot } from './computed'
import {
  createHistoryController,
  normalizeHistoryOptions,
  type HistoryApi,
  type HistoryConfig,
  type HistoryController,
  type HistoryOptions,
} from './history'
import { bindResourceState } from './query/bind'
import { hydrateQueryResources } from './query/hydrate'
import {
  activateQuerySelectorOwners,
  commitQuerySelectorSuspenseLoads,
  createQueryFollowContext,
  createQuerySelectorState,
  prepareQuerySelectorSuspense,
  querySelectorLoadKey,
  recordQuerySelectorSuspense,
  runQuerySelectorLoads,
  type QueryFollowContext,
  type QuerySelectorLoad,
} from './query/select'
import { QUERY_PLUGIN_NAME } from './query/plugin'
import type {
  QueryActivationListener,
  QueryBindingRegistry,
  QueryCacheKey,
  QueryDefaultOptions,
  QueryHydrationEntries,
  ResourceDescriptorMap,
  ResourceRuntimeState,
  SelectableResourceState,
} from './query/types'

const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type StoreEntry<T extends object = any> = {
  proxy: T
  getSnapshot(): T
  /** Fixed bootstrap snapshot for SSR and selectively hydrated descendants. */
  getServerSnapshot?(): T
  /** Include an unobserved query hydration seed in the bootstrap snapshot. */
  refreshServerSnapshot?(): void
  /** Register an immutable SSR view without changing the mounted client proxy. */
  prepareSearchParam(
    field: PropertyKey,
    seed: { ready: boolean; value: unknown }
  ): { ready: boolean; value: unknown }
  /**
   * The current snapshot without marking the model as read, so a model another model's `seed`
   * peeks at can still be initialized by its own first hydration or streamed result.
   */
  peekSnapshot(): T
  hasReadSnapshot(): boolean
  subscribe(listener: () => void): () => void
  history?: HistoryController
}

export type ModelOptions<T extends object, D extends object = {}> = {
  derive?: (state: T) => { [K in keyof D]: () => D[K] }
  rules?: { [K in keyof T]?: (value: T[K]) => true | string }
  onObserve?: (state: T) => void | (() => void)
  history?: HistoryConfig
}

export type ValidationState<T> = {
  errors: { [K in keyof T]?: string | null }
  isValid: boolean
}

export function model<T extends object>(initial: T): Model<T>
export function model<T extends object, D extends object>(
  initial: T,
  options: ModelOptions<T, D> & { history: true | HistoryOptions }
): Model<T & Readonly<D> & { $validation: ValidationState<T>; $history: HistoryApi }>
export function model<T extends object, D extends object>(
  initial: T,
  options: ModelOptions<T, D>
): Model<T & Readonly<D> & { $validation: ValidationState<T> }>
export function model<T extends object, D extends object = {}>(
  initial: T,
  options?: ModelOptions<T, D>
): Model<T & Readonly<D>> {
  const pluginBags = new Map<string, PluginBag>()
  const plugins = getPlugins()

  for (const plugin of plugins) {
    pluginBags.set(plugin.name, new Map())
  }

  const template = normalize(initial as Record<string, unknown>, '', pluginBags)
  const cloneState = () => structuredClone(template) as T

  const m: Model<T & Readonly<D>> = {
    key: Symbol(),
    pluginBags,
    onObserve: options?.onObserve as Model<T & Readonly<D>>['onObserve'],
    instance(initialValues): StoreEntry<T & Readonly<D>> {
      const initialState = cloneState()
      for (const [field, value] of initialValues ?? []) {
        if (Object.prototype.hasOwnProperty.call(initialState, field))
          Reflect.set(initialState, field, structuredClone(value))
        else if (typeof field === 'string')
          setPathValue(initialState, field, structuredClone(value))
        else throw new Error('Model initialization requires an own state field')
      }
      const p = createProxy(initialState)
      const historyOptions = normalizeHistoryOptions(options?.history)
      const history = historyOptions ? createHistoryController(p, historyOptions) : null

      const deriveFactory = options?.derive
      const rules = options?.rules
      let derivedGetters: Record<string, () => unknown> | null = null
      let derivedKeys: Set<string> | null = null

      if (deriveFactory) {
        derivedGetters = deriveFactory(p as T) as Record<string, () => unknown>
        derivedKeys = new Set(Object.keys(derivedGetters))
      }

      const computedBag = pluginBags.get(COMPUTED_PLUGIN_NAME)
      const hasComputed = computedBag != null && computedBag.size > 0
      const hasHistory = history != null
      const hasExtensions = derivedGetters != null || rules != null || hasComputed || hasHistory

      let computedProxyRef: object | null = null
      let snapshotRead = false
      const serverFields = new Map<PropertyKey, { ready: boolean; value: unknown }>()
      let readServerSnapshot!: () => T & Readonly<D>
      let publicProxy: unknown = p
      if (hasComputed) {
        computedProxyRef = createComputedProxy(p as object, computedBag!)
        publicProxy = computedProxyRef
      }
      if (derivedGetters || rules) {
        const base = publicProxy as object
        publicProxy = new Proxy(base, {
          get(target, prop, receiver) {
            if (prop === '$history' && history) {
              return history.getApi()
            }
            if (typeof prop === 'string' && derivedKeys?.has(prop)) {
              return derivedGetters![prop]()
            }
            if (prop === '$validation' && rules) {
              return computeValidation(p as Record<string, unknown>, rules)
            }
            return Reflect.get(target, prop, receiver)
          },
          set(target, prop, value, receiver) {
            if (typeof prop === 'string' && derivedKeys?.has(prop)) {
              throw new Error(`Cannot set derived field "${prop}"`)
            }
            if (prop === '$validation') {
              throw new Error('Cannot set $validation')
            }
            if (prop === '$history') {
              throw new Error('Cannot set $history')
            }
            return Reflect.set(target, prop, value, receiver)
          },
        })
      } else if (history) {
        const base = publicProxy as object
        publicProxy = new Proxy(base, {
          get(target, prop, receiver) {
            if (prop === '$history') {
              return history.getApi()
            }
            return Reflect.get(target, prop, receiver)
          },
          set(target, prop, value, receiver) {
            if (prop === '$history') {
              throw new Error('Cannot set $history')
            }
            return Reflect.set(target, prop, value, receiver)
          },
        })
      }

      const readSnapshot = () => {
        if (!hasExtensions) return snapshot(p) as T & Readonly<D>

        const base = snapshot(p)
        const result: Record<string, unknown> = { ...(base as object) }

        if (hasComputed) {
          getComputedSnapshot(result, computedProxyRef!, computedBag!)
        }

        if (derivedGetters) {
          for (const [key, getter] of Object.entries(derivedGetters)) {
            result[key] = getter()
          }
        }

        if (rules) {
          result.$validation = computeValidation(p as Record<string, unknown>, rules)
        }

        if (history) {
          result.$history = history.getApi()
        }

        return Object.freeze(result) as T & Readonly<D>
      }
      let serverSnapshot = initialValues ? readSnapshot() : undefined
      let serverRaw: T | undefined
      const buildServerSnapshot = () => {
        serverRaw ??= snapshot(p) as T
        const values = new Map<PropertyKey, unknown>(Object.entries(serverRaw))
        for (const [field, seed] of serverFields) {
          if (seed.ready) values.set(field, seed.value)
        }
        return m.instance(values).getSnapshot()
      }
      readServerSnapshot = () =>
        (serverSnapshot ??= serverFields.size > 0 ? buildServerSnapshot() : readSnapshot())

      return {
        proxy: publicProxy as T & Readonly<D>,
        history: history ?? undefined,
        getSnapshot() {
          snapshotRead = true
          return readSnapshot()
        },
        getServerSnapshot() {
          const result =
            serverFields.size > 0 || initialValues ? readServerSnapshot() : readSnapshot()
          serverSnapshot ??= result
          snapshotRead = true
          return result
        },
        refreshServerSnapshot() {
          serverRaw = snapshot(p) as T
          serverSnapshot = serverFields.size > 0 ? buildServerSnapshot() : readSnapshot()
        },
        prepareSearchParam(field, seed) {
          const existing = serverFields.get(field)
          if (existing) return existing
          if (
            typeof field !== 'string' ||
            [...pluginBags].some(
              ([name, bag]) =>
                name !== SEARCH_PARAM_PLUGIN_NAME &&
                [...bag.keys()].some(
                  (path) =>
                    canonicalPath(path) === field || canonicalPath(path).startsWith(`${field}.`)
                )
            )
          ) {
            throw new Error('Invalid searchParam() model field')
          }
          const baseline = readServerSnapshot()
          const selected =
            seed.ready && !snapshotRead
              ? { ready: true, value: structuredClone(seed.value) }
              : { ready: false, value: getPathValue(baseline, String(field)) }
          serverFields.set(field, selected)
          if (selected.ready) serverSnapshot = buildServerSnapshot()
          return selected
        },
        peekSnapshot() {
          return readSnapshot()
        },
        hasReadSnapshot() {
          return snapshotRead
        },
        subscribe(listener) {
          const unsubProxy = subscribe(p, () => {
            if (!isSilent()) listener()
          })
          const unsubHistory = history?.subscribe(listener)
          return () => {
            unsubProxy()
            unsubHistory?.()
          }
        },
      }
    },
  }

  return m
}

function computeValidation<T extends object>(
  proxy: Record<string, unknown>,
  rules: { [K in keyof T]?: (value: T[K]) => true | string }
): ValidationState<T> {
  const errors: Record<string, string | null> = {}
  let isValid = true
  for (const [field, validator] of Object.entries(rules)) {
    if (!validator) continue
    const value = proxy[field]
    const result = (validator as (v: unknown) => true | string)(value)
    if (result === true) {
      errors[field] = null
    } else {
      errors[field] = typeof result === 'string' ? result : `Invalid ${field}`
      isValid = false
    }
  }
  return { errors, isValid } as ValidationState<T>
}

export type Model<T extends object> = {
  key: symbol
  pluginBags: Map<string, PluginBag>
  onObserve?: (state: T) => void | (() => void)
  /** Initial values are copied before the proxy, history, and derived state are created. */
  instance(initialValues?: ReadonlyMap<PropertyKey, unknown>): StoreEntry<T>
}

export function useModel<T extends object>(m: Model<T>): T
export function useModel<T extends object, R>(
  m: Model<T>,
  selector: (state: SelectableResourceState<T>) => R
): R
export function useModel<T extends object, R>(
  m: Model<T>,
  selector?: (state: SelectableResourceState<T>) => R
): T | R {
  if (process.env.NODE_ENV !== 'production' && !selector) {
    console.warn(
      '[comwit] useModel() without a selector subscribes to the entire state tree, ' +
        'which may cause unnecessary re-renders. Consider using a selector: ' +
        'useModel(model, s => s.field)'
    )
  }

  const registry = useStoreRegistry()
  // Identifies this selector across SSR and hydration so streamed `.suspend()` results can be
  // matched without a serializable model identity.
  const hookId = useId()
  const store = registry.get(m)
  const queryBag = m.pluginBags.get(QUERY_PLUGIN_NAME) as ResourceDescriptorMap | undefined
  const queryRegistry = registry.pluginStates.get(QUERY_PLUGIN_NAME) as
    QueryBindingRegistry | undefined
  const queryDefaults = registry.pluginDefaults.get(QUERY_PLUGIN_NAME) as
    QueryDefaultOptions | undefined

  const queryController = useMemo(() => {
    if (!queryBag?.size || !queryRegistry) return store.proxy as object
    return bindResourceState(store.proxy, queryBag, queryDefaults, queryRegistry, m.key) as object
  }, [m.key, queryBag, queryDefaults, queryRegistry, store])

  const prevRef = useRef<unknown>(null)
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const queryLoadsRef = useRef<QuerySelectorLoad[]>([])
  // Per-component pins for argument-less query reads, and the keys this component's owners
  // confirmed. They outlive a hidden <Activity> (effects are torn down, refs are not).
  const followRef = useRef<QueryFollowContext | null>(null)
  if (followRef.current === null) followRef.current = createQueryFollowContext()
  const follow = followRef.current
  const followedRef = useRef<ResourceRuntimeState[]>([])
  const [, rerender] = useReducer((count: number) => count + 1, 0)

  const lifecycle = registry.getLifecycle(m)

  const subscribe = useCallback(
    (listener: () => void) => {
      lifecycle.subscriberCount++
      if (lifecycle.subscriberCount === 1) {
        notifySubscriberChange(m, registry, true)
        if (m.onObserve) {
          const result = m.onObserve(store.proxy)
          lifecycle.cleanup = typeof result === 'function' ? result : null
        }
      }
      const unsubProxy = store.subscribe(listener)
      return () => {
        unsubProxy()
        lifecycle.subscriberCount--
        if (lifecycle.subscriberCount === 0) {
          if (lifecycle.cleanup) {
            lifecycle.cleanup()
            lifecycle.cleanup = null
          }
          notifySubscriberChange(m, registry, false)
        }
      }
    },
    [store, lifecycle, m, registry]
  )

  const readSelectedSnapshot = useCallback(
    (server: boolean) => {
      const readRaw = () =>
        server && store.getServerSnapshot ? store.getServerSnapshot() : store.getSnapshot()
      const select = (raw: T, loads: QuerySelectorLoad[], mayInitialize: boolean) => {
        follow.followed = new Set()
        const selectable =
          queryBag?.size && queryRegistry
            ? createQuerySelectorState(
                raw,
                queryController,
                queryBag,
                queryRegistry,
                loads,
                hookId,
                mayInitialize,
                follow
              )
            : raw
        return selectorRef.current
          ? selectorRef.current(selectable as SelectableResourceState<T>)
          : selectable
      }

      // Argument-less reads may pin a key only while this selector runs (the equality check
      // below walks the same proxies). Reads outside a selector resolve without pinning.
      follow.collecting = true
      try {
        // Like useHydrateModel: a model nobody has read yet may be initialized before its first
        // snapshot. The selector learns which streamed `.suspend()` keys apply, so it runs first.
        const mayInitialize = !store.hasReadSnapshot()
        let loads: QuerySelectorLoad[] = []
        let next = select(readRaw(), loads, mayInitialize)
        if (loads.some((load) => load.initialized)) {
          // The restored result is already in the proxy; re-read so passive fields of this same
          // selector observe it in the hydrating render.
          store.refreshServerSnapshot?.()
          loads = []
          next = select(readRaw(), loads, false)
        }
        queryLoadsRef.current = loads
        followedRef.current = [...follow.followed]

        if (
          prevRef.current !== null &&
          isEqual(prevRef.current, next) &&
          sameSearchParamAccess(prevRef.current, next)
        ) {
          return prevRef.current as R
        }

        prevRef.current = next
        return next as R
      } finally {
        follow.collecting = false
      }
    },
    [follow, hookId, queryBag, queryController, queryRegistry, store]
  )

  const getSnapshot = useCallback(() => readSelectedSnapshot(false), [readSelectedSnapshot])
  const getServerSnapshot = useCallback(() => readSelectedSnapshot(true), [readSelectedSnapshot])

  const result = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useCommitEffect(() => registry.observe(m), [registry, m])
  const queryLoads = queryLoadsRef.current
  const selectorLoadKey = querySelectorLoadKey(queryLoads)
  const followed = followedRef.current
  const followedKey = followed
    .map((runtime) => runtime.path)
    .sort()
    .join('\u0000')

  // Followers hear confirms while visible. Layout effects run child-first, so a follower below
  // its owner is subscribed before the owner confirms and re-pins before paint; hiding a page
  // removes these listeners in the mutation phase, before the shown page's owner confirms.
  // Declared before the owner effect so a component that owns and follows the same runtime
  // hears its own confirm.
  useCommitEffect(() => {
    if (followed.length === 0) return
    const offs = followed.map((runtime) => {
      const listener: QueryActivationListener = (key) => {
        const pin = follow.pins.get(runtime)
        const changed = pin?.key !== key
        if (pin) {
          pin.key = key
          pin.confirmed = true
        } else {
          follow.pins.set(runtime, { key, confirmed: true })
        }
        if (changed) rerender()
      }
      runtime.listeners.add(listener)
      return () => runtime.listeners.delete(listener)
    })
    return () => offs.forEach((off) => off())
  }, [followedKey])

  useCommitEffect(() => {
    if (!queryRegistry || queryLoads.length === 0) return
    for (const load of queryLoads) {
      load.resume = undefined
      if (!load.owner) continue
      const runtime = queryRegistry.boundResourceRuntime.get(load.controller)
      if (!runtime || follow.owned.get(runtime) !== load.key) continue
      // Re-running with the key this owner already confirmed (a kept-alive page shown again,
      // StrictMode): resume the key the page last showed instead of re-asserting the render
      // key. While the page was visible a confirm from elsewhere (an action, a child owner) may
      // have moved its pins; re-asserting would flip the page back to content it no longer
      // renders. Mount and a key change assert the owner's key as before.
      const pinned = follow.pins.get(runtime)?.key
      const entry = pinned === undefined ? undefined : runtime.cacheEntries.get(pinned)
      if (pinned !== undefined && pinned !== load.key && entry) {
        load.resume = { key: pinned, arg: entry.arg }
      }
    }
    // Owners confirm here, ahead of their fetch: `load(key)` before its passive fetch,
    // `suspend(key)` before `commitSuspend` and its in-flight dedupe.
    activateQuerySelectorOwners(queryLoads)
    commitQuerySelectorSuspenseLoads(queryLoads, queryRegistry)
    for (const load of queryLoads) {
      if (!load.owner) continue
      const runtime = queryRegistry.boundResourceRuntime.get(load.controller)
      if (runtime) follow.owned.set(runtime, load.key as QueryCacheKey)
    }
  }, [queryRegistry, selectorLoadKey])

  // Pins that missed the confirm (owner is an earlier sibling, or this follower mounted in a
  // later commit) settle on the committed key. Confirmed pins are never overwritten: a page shown
  // again keeps its key until its own owner re-confirms.
  useEffect(() => {
    for (const runtime of followed) {
      const pin = follow.pins.get(runtime)
      if (!pin || pin.confirmed) continue
      // A pin still equal to `stagedKey` after this commit's layout phase was staged by a tree
      // that never committed (a page mounted hidden, a discarded render): nobody confirmed it.
      // Clear the stale stage so it misleads no later follower.
      if (
        runtime.stagedKey !== undefined &&
        runtime.stagedKey === pin.key &&
        runtime.activeKey !== pin.key
      ) {
        runtime.stagedKey = undefined
        runtime.stagedArg = undefined
      }
      const changed = pin.key !== runtime.activeKey
      pin.key = runtime.activeKey
      pin.confirmed = true
      if (changed) rerender()
    }
  }, [followedKey])

  useEffect(() => {
    if (!queryRegistry || queryLoads.length === 0) return
    runQuerySelectorLoads(queryLoads, queryRegistry)
  }, [queryRegistry, selectorLoadKey])

  if (queryRegistry) {
    prepareQuerySelectorSuspense(queryLoads, queryRegistry)
    // Every suspend key is resolved once prepare returns; on the server, stream them ahead of
    // the HTML this render produces.
    recordQuerySelectorSuspense(queryLoads, queryRegistry, hookId)
  }

  // Run plugin onRender hooks
  const plugins = getPlugins()
  for (const plugin of plugins) {
    const bag = m.pluginBags.get(plugin.name)
    if (bag && bag.size > 0 && plugin.onRender) {
      const registryState = registry.pluginStates.get(plugin.name)
      plugin.onRender(bag, registryState)
    }
  }

  return result
}

/** Initialize resolved query values before this model's first external-store snapshot. */
export function useHydrateModel<T extends object>(
  m: Model<T>,
  entries: QueryHydrationEntries<T> | null | undefined
): void {
  const registry = useStoreRegistry()
  const queryBag = m.pluginBags.get(QUERY_PLUGIN_NAME) as ResourceDescriptorMap | undefined
  const queryRegistry = registry.pluginStates.get(QUERY_PLUGIN_NAME) as
    QueryBindingRegistry | undefined
  let hydration:
    | {
        controller: object
        descriptors: ResourceDescriptorMap
        entries: QueryHydrationEntries<T>
        mayInitialize: boolean
      }
    | undefined

  if (entries != null && queryBag?.size && queryRegistry) {
    const store = registry.get(m)
    const queryDefaults = registry.pluginDefaults.get(QUERY_PLUGIN_NAME) as
      QueryDefaultOptions | undefined
    const controller = bindResourceState(store.proxy, queryBag, queryDefaults, queryRegistry, m.key)

    hydration = {
      controller,
      descriptors: queryBag,
      entries,
      mayInitialize: !store.hasReadSnapshot(),
    }
    hydrateQueryResources({ ...hydration, phase: 'render' })
    if (hydration.mayInitialize) store.refreshServerSnapshot?.()
  }

  useCommitEffect(() => {
    if (!hydration) return
    hydrateQueryResources({ ...hydration, phase: 'commit' })
  })
}

function notifySubscriberChange(
  m: Model<any>,
  registry: ReturnType<typeof useStoreRegistry>,
  hasObservers: boolean
): void {
  const plugins = getPlugins()
  for (const plugin of plugins) {
    if (!plugin.onSubscriberChange) continue
    const bag = m.pluginBags.get(plugin.name)
    if (!bag || bag.size === 0) continue
    const registryState = registry.pluginStates.get(plugin.name)
    plugin.onSubscriberChange(m.key, bag, registryState, hasObservers)
  }
}

function normalize(value: unknown, path: string, pluginBags: Map<string, PluginBag>): unknown {
  const plugins = getPlugins()
  for (const plugin of plugins) {
    const bag = pluginBags.get(plugin.name)
    if (!bag) continue
    const result = plugin.detect(value, path, bag)
    if (result !== null) {
      return result.initialValue
    }
  }

  if (!value || typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, `${path}[${index}]`, pluginBags))
  }

  // Preserve native objects (Date, File, Blob, Map, Set, etc.)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const nextPath = path ? `${path}.${key}` : key
    out[key] = normalize((value as Record<string, unknown>)[key], nextPath, pluginBags)
  }

  return out
}
