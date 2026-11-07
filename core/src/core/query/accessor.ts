import { isProxy, snapshot } from '../proxy'
import { isEqual } from '../../utils'
import { DEFAULT_GC_TIME } from './registry'
import { createSlowLoadingClock } from './slow-loading'
import {
  RESOURCE_ACTIVATE,
  RESOURCE_LIFECYCLE,
  RESOURCE_HYDRATE,
  RESOURCE_QUERY_OPTION_KEYS,
  RESOURCE_SUSPEND_COMMIT,
  RESOURCE_SUSPEND_PLACEHOLDER,
  RESOURCE_SUSPEND_PREPARE,
  RESOURCE_SUSPEND_RESTORE,
  RESOURCE_SUSPEND_STREAM,
  type AnyResourceDescriptor,
  type ConnectionStatus,
  type InfiniteResourceDescriptor,
  type PlaceholderData,
  type QueryActivateOptions,
  type QueryBindingRegistry,
  type QueryCacheEntry,
  type QueryCacheKey,
  type QueryDefaultOptions,
  type QueryMode,
  type QuerySeed,
  type QuerySeedRead,
  type RealtimeResourceDescriptor,
  type ResourceBaseState,
  type ResourceContext,
  type ResourceDataLike,
  type ResourceInfiniteState,
  type ResourceLifecycleBinding,
  type ResourceQueryOptions,
  type ResourceRealtimeState,
  type ResourceRuntimeState,
  type ResourceSingleState,
  type ResourceSetOptions,
  type SingleResourceDescriptor,
  type SubscribeCallbacks,
} from './types'
import type { StreamedSuspendResult } from './stream'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResourceQueryCallOptions(
  value: unknown
): value is ResourceQueryOptions<unknown, unknown> {
  if (!isRecord(value)) return false
  for (const key of Object.keys(value)) {
    if (RESOURCE_QUERY_OPTION_KEYS.has(key)) return true
  }
  return false
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Unknown error'
}

function resolveGcTime(options: QueryDefaultOptions): number {
  if (typeof options.gcTime === 'number') return options.gcTime
  return DEFAULT_GC_TIME
}

export function mergeResult(state: ResourceDataLike, result: unknown, appendData = false) {
  if (result === undefined) return

  if (Array.isArray(result)) {
    state.data = result
    return
  }

  if (isRecord(result)) {
    const hasData = 'data' in result
    // Query results cannot supply these library-owned derived flags.
    const { isSlowLoading: _slowLoading, isPartial: _partial, ...patch } = result

    if (
      appendData &&
      hasData &&
      Array.isArray(state.data) &&
      Array.isArray((result as { data?: unknown }).data)
    ) {
      const next: ResourceDataLike = {
        ...patch,
        data: [...state.data, ...(result as { data: unknown[] }).data],
      }
      Object.assign(state, next)
      return
    }

    if (hasData) {
      Object.assign(state, patch)
      return
    }

    state.data = result
    return
  }

  state.data = result
}

function contextFor<TState>(state: TState) {
  return { state: snapshot(state as ResourceDataLike) as Readonly<TState> }
}

/**
 * Evaluate a single query's declared `seed` for one key against the owning model's state.
 * Returns `undefined` when the descriptor has no seed or the model holds nothing for the key.
 * Only `query()` and `local.query()` declare one; infinite, realtime and standalone `local()`
 * resources never carry a `seed`.
 *
 * `read(other)` hands the seed another model's current snapshot through
 * `registry.peekModelSnapshot`, which the provider binds to its store map: it never creates,
 * observes or marks that model as read, so a model nothing has registered yet reads as
 * `undefined` and the key loads normally. The snapshot is the plain frozen state, not a bound
 * controller or selector, so it exposes no `.load()`/`.query()` and rejects writes.
 */
export function readResourceSeed(
  descriptor: AnyResourceDescriptor,
  arg: unknown,
  modelState: object | undefined,
  registry: QueryBindingRegistry
): unknown {
  if (descriptor.kind !== 'single') return undefined
  const seed = (descriptor as { seed?: QuerySeed<unknown, unknown> }).seed
  if (typeof seed !== 'function' || modelState === undefined) return undefined
  const read = ((model: object) => registry.peekModelSnapshot?.(model)) as QuerySeedRead
  return seed(arg, { state: modelState, read }) ?? undefined
}

/**
 * A seed read from the live model proxy may be (or contain) a proxied list item. Writing that
 * reference into the resource would alias the detail with its list row, so detach it first.
 */
function detachProxies(value: unknown): unknown {
  if (isProxy(value)) return snapshot(value as object)
  if (Array.isArray(value)) return value.map(detachProxies)
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const out: Record<PropertyKey, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      out[key] = detachProxies(Reflect.get(value, key))
    }
    return out
  }
  return value
}

function materializeSeed(seed: unknown): unknown {
  return structuredClone(detachProxies(seed))
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in (value as Record<symbol, unknown>)
  )
}

function parseQueryArgs(args: unknown[]) {
  if (args.length === 1 && isResourceQueryCallOptions(args[0])) {
    return {
      hasArg: false,
      arg: undefined,
      options: args[0] as ResourceQueryOptions<unknown, unknown>,
    }
  }

  if (args.length === 0) {
    return {
      hasArg: false,
      arg: undefined,
      options: undefined,
    }
  }

  return {
    hasArg: true,
    arg: args[0],
    options: args[1] as ResourceQueryOptions<unknown, unknown> | undefined,
  }
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    return value.map((item) => stableSerialize(item, seen))
  }

  if (seen.has(value as object)) {
    return '[Circular]'
  }
  seen.add(value as object)

  const source = value as Record<string, unknown>
  const keys = Object.keys(source).sort()
  const out: Record<string, unknown> = {}

  for (const key of keys) {
    out[key] = stableSerialize(source[key], seen)
  }

  seen.delete(value as object)
  return out
}

export function serializeQueryArg(arg: unknown) {
  try {
    const serialized = JSON.stringify(stableSerialize(arg))
    return serialized === undefined ? '__undefined__' : serialized
  } catch {
    return `__unserializable__:${String(arg)}`
  }
}

export function serializeResourceArg(descriptor: AnyResourceDescriptor, arg: unknown): string {
  const serialize = descriptor.serializeArg as ((value: unknown) => string) | undefined
  if (!serialize) return serializeQueryArg(arg)
  const result = serialize(arg)
  if (typeof result !== 'string') {
    throw new Error('resource serializeArg must return a string')
  }
  return result
}

function cloneRuntime(path: string): ResourceRuntimeState {
  return {
    path,
    lastArg: undefined,
    activeKey: undefined,
    stagedKey: undefined,
    listeners: new Set(),
    pinHolders: new Set(),
    fetchId: 0,
    cacheEntries: new Map(),
    gcTime: DEFAULT_GC_TIME,
    gcTimers: new Map(),
  }
}

function createCacheEntry(
  state: ResourceDataLike,
  key: QueryCacheKey,
  arg: unknown
): QueryCacheEntry {
  return {
    key,
    arg,
    hasQueried: false,
    lastFetchedAt: 0,
    cursorHistory: [],
    state: snapshot(state) as ResourceDataLike,
    fetchSeq: 0,
  }
}

/**
 * Whether a mounted component (visible or kept alive in a hidden `<Activity>`) still pins this
 * key. Holders are weak: an unmounted component releases its pins once collected, while a
 * hidden page, whose effects are torn down but whose fiber stays alive, keeps them.
 */
export function isKeyPinned(runtime: ResourceRuntimeState, key: QueryCacheKey): boolean {
  let pinned = false
  for (const holder of runtime.pinHolders) {
    const pins = holder.deref()
    if (!pins) {
      runtime.pinHolders.delete(holder)
      continue
    }
    if (pins.get(runtime)?.key === key) pinned = true
  }
  return pinned
}

function applyCachedState(target: ResourceDataLike, cached: QueryCacheEntry) {
  // snapshot() is intentionally frozen. Clone it before placing it back into
  // the mutable proxy or nested optimistic edits would hit read-only objects.
  Object.assign(target, structuredClone(cached.state))
  if ('isSlowLoading' in target) target.isSlowLoading = false
  target.isLoading = false
  target.isFetching = false
}

function updateCachedState(entry: QueryCacheEntry, source: ResourceDataLike) {
  const cached = snapshot(source) as ResourceDataLike
  entry.state = cached.isSlowLoading ? Object.freeze({ ...cached, isSlowLoading: false }) : cached
}

function deepFreezePlain<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value

  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreezePlain(Reflect.get(value, key), seen)
  }
  return Object.freeze(value)
}

function immutableResourceState(source: ResourceDataLike): ResourceDataLike {
  return deepFreezePlain(structuredClone(source)) as ResourceDataLike
}

/**
 * Schedules eviction for every cache entry on every runtime owned by the
 * given model key. Called by the query plugin when the model's observer
 * count transitions to 0. Subsequent calls are idempotent — existing
 * timers are left in place.
 */
export function scheduleModelGc(registry: QueryBindingRegistry, modelKey: symbol) {
  registry.unobservedModels.add(modelKey)
  const runtimes = registry.runtimesByModel.get(modelKey)
  if (!runtimes) return
  for (const runtime of runtimes) {
    runtime.slowLoading?.pause()
    for (const [key] of runtime.cacheEntries) {
      scheduleEntryGc(runtime, key)
    }
  }
}

function scheduleEntryGc(runtime: ResourceRuntimeState, key: QueryCacheKey) {
  if (runtime.gcTimers.has(key)) return
  const timer = setTimeout(() => {
    runtime.gcTimers.delete(key)
    // A hidden page still pins this entry; try again after another gcTime.
    if (isKeyPinned(runtime, key)) {
      scheduleEntryGc(runtime, key)
      return
    }
    runtime.cacheEntries.delete(key)
    if (runtime.activeKey === key) {
      if (runtime.activate) runtime.activate(undefined, undefined, { commit: true })
      else {
        runtime.slowLoading?.reset()
        runtime.activeKey = undefined
        runtime.lastArg = undefined
      }
    }
  }, runtime.gcTime)
  runtime.gcTimers.set(key, timer)
}

/**
 * Cancels all pending GC timers across every runtime owned by the model.
 * Called by the query plugin when the model gains its first observer
 * (subscriber count transitions from 0 to 1).
 */
export function cancelModelGc(registry: QueryBindingRegistry, modelKey: symbol) {
  registry.unobservedModels.delete(modelKey)
  const runtimes = registry.runtimesByModel.get(modelKey)
  if (!runtimes) return
  for (const runtime of runtimes) {
    runtime.slowLoading?.resume()
    for (const timer of runtime.gcTimers.values()) {
      clearTimeout(timer)
    }
    runtime.gcTimers.clear()
  }
}

function applyPlaceholderData<TData, TArg>(
  state: ResourceBaseState<TData>,
  arg: TArg,
  placeholderData?: PlaceholderData<TData, TArg>
) {
  if (placeholderData === undefined) return

  if (typeof placeholderData === 'function') {
    state.data = (placeholderData as (queryArg: TArg, previousData: TData) => TData)(
      arg,
      state.data
    )
    return
  }

  state.data = placeholderData as TData
}

function normalizeDescriptorOptions<TData, TArg>(
  descriptor: AnyResourceDescriptor,
  defaultOptions: QueryDefaultOptions | undefined,
  callOptions: unknown
) {
  const descriptorOptions = descriptor.options as Omit<
    ResourceQueryOptions<TData, unknown>,
    'force'
  >
  const merged: ResourceQueryOptions<TData, TArg> = {
    ...(defaultOptions as Omit<
      ResourceQueryOptions<TData, unknown>,
      'force'
    > as ResourceQueryOptions<TData, TArg>),
    ...(descriptorOptions as ResourceQueryOptions<TData, TArg>),
    ...((isResourceQueryCallOptions(callOptions) ? callOptions : {}) as ResourceQueryOptions<
      TData,
      TArg
    >),
  }

  return merged
}

export function createResourceAccessor(
  state: ResourceDataLike,
  descriptor: AnyResourceDescriptor,
  path: string,
  defaults: QueryDefaultOptions | undefined,
  registry: QueryBindingRegistry,
  modelState?: object,
  modelKey?: symbol
): ResourceDataLike {
  if (registry.boundResourceValue.has(state)) {
    return registry.boundResourceValue.get(state) as ResourceDataLike
  }

  const runtime = registry.boundResourceRuntime.get(state) ?? cloneRuntime(path)
  runtime.path = path
  runtime.gcTime = resolveGcTime({
    ...(defaults ?? {}),
    ...(descriptor.options as QueryDefaultOptions),
  })
  registry.boundResourceRuntime.set(state, runtime)
  if (descriptor.slowLoadingMs !== undefined && !runtime.slowLoading) {
    runtime.slowLoading = createSlowLoadingClock(
      state,
      descriptor.slowLoadingMs,
      modelKey === undefined || !registry.unobservedModels.has(modelKey)
    )
  }

  const lifecycleBindings = (descriptor[RESOURCE_LIFECYCLE] ?? [])
    .map((factory) => factory.bind({ state, descriptor, path, runtime, registry }))
    .filter((binding): binding is ResourceLifecycleBinding => binding !== undefined)

  const runInternal = <T>(callback: () => T): T => {
    const visit = (index: number): T => {
      const binding = lifecycleBindings[index]
      if (!binding) return callback()
      return binding.runInternal ? binding.runInternal(() => visit(index + 1)) : visit(index + 1)
    }
    return visit(0)
  }

  const activateLifecycle = (key: string, arg: unknown) => {
    for (const binding of lifecycleBindings) binding.activate?.(key, arg)
  }

  const beginLifecycleRequests = () => lifecycleBindings.map((binding) => binding.beginRequest?.())

  /** Only a query declared with `seed` carries `isPartial`; other resources keep their shape. */
  const tracksPartial = 'isPartial' in descriptor.initialState

  /** The key's seed as a detached, writable value, or `undefined` when the model has none. */
  const readSeed = (arg: unknown): unknown => {
    if (!tracksPartial) return undefined
    const seed = readResourceSeed(descriptor, arg, modelState, registry)
    return seed === undefined ? undefined : materializeSeed(seed)
  }

  /** Show a key's seed on the proxy: initial flags, the partial value, `isPartial: true`. */
  const paintSeed = (seed: unknown) => {
    runInternal(() => {
      Object.assign(state, descriptor.initialState)
      state.data = seed
      state.isPartial = true
    })
  }

  const applyRemoteResult = (result: unknown, appendData: boolean, requestTokens: unknown[]) => {
    const shouldReconcile = lifecycleBindings.some((binding) => binding.afterApply)
    const previousState = shouldReconcile
      ? (snapshot(state) as Readonly<ResourceDataLike>)
      : undefined

    runInternal(() => mergeResult(state, result, appendData))
    // Any applied remote value is the key's full value; it replaces a seed for good.
    if (tracksPartial && result !== undefined) state.isPartial = false
    runtime.slowLoading?.sync()

    if (!previousState) return
    lifecycleBindings.forEach((binding, index) =>
      binding.afterApply?.({
        previousState,
        result,
        appendData,
        requestToken: requestTokens[index],
      })
    )
  }

  const commitLifecycleSuccess = async (
    entry: QueryCacheEntry,
    fetchedAt: number,
    requestTokens: unknown[]
  ) => {
    await Promise.all(
      lifecycleBindings.map((binding, index) =>
        binding.afterSuccess?.({
          entry,
          fetchedAt,
          requestToken: requestTokens[index],
        })
      )
    )
  }

  if (modelKey !== undefined) {
    let set = registry.runtimesByModel.get(modelKey)
    if (!set) {
      set = new Set()
      registry.runtimesByModel.set(modelKey, set)
    }
    set.add(runtime)
  }

  const getActiveEntry = () => {
    if (!runtime.activeKey) return
    return runtime.cacheEntries.get(runtime.activeKey)
  }

  const passesGates = () => {
    if (descriptor.enabled && modelState && !descriptor.enabled(modelState)) return false
    if (descriptor.dependsOn && modelState) {
      const dep = descriptor.dependsOn(modelState)
      if (dep && typeof dep === 'object' && 'isSuccess' in dep) {
        if (!dep.isSuccess) return false
      } else if (dep === null || dep === undefined) {
        return false
      }
    }
    return true
  }

  const resolvePlaceholderData = (override?: PlaceholderData<unknown, unknown>) =>
    override !== undefined
      ? override
      : normalizeDescriptorOptions<unknown, unknown>(descriptor, defaults, undefined)
          .placeholderData

  const notifyListeners = (key: QueryCacheKey | undefined) => {
    for (const listener of [...runtime.listeners]) listener(key)
  }

  /** Get or create the entry for a key, record its argument and cancel a pending eviction. */
  const ensureEntry = (key: QueryCacheKey, arg: unknown): QueryCacheEntry => {
    let entry = runtime.cacheEntries.get(key)
    if (!entry) {
      entry = createCacheEntry(state, key, arg)
      runtime.cacheEntries.set(key, entry)
    } else {
      const pending = runtime.gcTimers.get(key)
      if (pending !== undefined) {
        clearTimeout(pending)
        runtime.gcTimers.delete(key)
      }
    }
    entry.arg = arg
    return entry
  }

  /**
   * The only way `activeKey` changes. Every writer (`executeQuery`, `commitSuspend`,
   * `setResource`, `hydrateResource`, `activateStagedEntry`, the gc reset) goes through here so
   * the model field, the entry cache and follower pins stay consistent:
   *
   * 1. the outgoing key's committed field is written back into its entry, so edits made through
   *    actions survive the switch (hidden pages and revisits read the entry);
   * 2. `activeKey` moves and the entry is mirrored into the field: its cached state once queried,
   *    otherwise the key's seed, else the initial / `placeholderData` state a fresh fetch starts
   *    from;
   * 3. with `commit`, `stagedKey` is cleared and subscribed followers are confirmed with the key.
   *
   * Re-activating the key that is already active leaves the field alone (a request may be in
   * flight) and only confirms. Render-time activations (`activateStagedEntry`) stop after step 2;
   * the owner's commit confirms.
   */
  const activate = (
    key: QueryCacheKey | undefined,
    arg: unknown,
    options: QueryActivateOptions = {}
  ): QueryCacheEntry | undefined => {
    const commit = options.commit !== false
    const outgoing = getActiveEntry()
    let entry: QueryCacheEntry | undefined

    if (key !== undefined && key !== runtime.activeKey) {
      if (outgoing && outgoing.hasQueried && !outgoing.suspendNeedsCommit) {
        updateCachedState(outgoing, state)
      }
      runtime.slowLoading?.reset()
      runtime.lastArg = arg
      runtime.activeKey = key
      // Adapters may invalidate the whole entry cache here (a `local` scope change), so the
      // entry is looked up only afterwards.
      activateLifecycle(key, arg)
      const next = ensureEntry(key, arg)
      entry = next

      if (next.hasQueried) {
        runInternal(() => applyCachedState(state, next))
      } else {
        const seed = readSeed(arg)
        if (seed !== undefined) {
          // A key without a full result shows its seed from the first commit; the fetch that
          // follows upgrades it in the background.
          paintSeed(seed)
        } else {
          // The state a fetch for this key starts from: `isLoading` until its first result, with
          // the previous item kept visible only through `placeholderData`. The fetch itself sets
          // `isFetching` when it starts, so a gated key never looks like it is requesting.
          const placeholderData = resolvePlaceholderData(options.placeholderData)
          runInternal(() => {
            // A seed on the field belongs to the key that showed it; never leave it under
            // another key, not even as the previous data a placeholder starts from.
            if (placeholderData === undefined || state.isPartial === true) {
              Object.assign(state, structuredClone(descriptor.initialState))
            }
            applyPlaceholderData(state as ResourceBaseState<unknown>, arg as never, placeholderData)
            state.isLoading = !state.isSuccess
            state.isError = false
            state.error = null
            state.isFetching = false
          })
        }
      }
    } else if (key !== undefined) {
      runtime.lastArg = arg
      activateLifecycle(key, arg)
      entry = ensureEntry(key, arg)
    } else if (runtime.activeKey !== undefined) {
      runtime.slowLoading?.reset()
      runtime.activeKey = undefined
      runtime.lastArg = undefined
    }

    if (commit) {
      if (key !== undefined) runtime.stagedKey = undefined
      notifyListeners(key)
    }
    return entry
  }
  runtime.activate = activate

  /** Selector owners confirm their key in the layout phase, before any fetch runs. */
  const activateOwner = (arg: unknown, key: QueryCacheKey) => {
    activate(key, arg)
  }

  /** Land a settled request in its entry only: its key stopped being active while it ran. */
  const settleEntry = (entry: QueryCacheEntry, result: unknown, appendData: boolean) => {
    const next = structuredClone(
      entry.hasQueried ? entry.state : descriptor.initialState
    ) as ResourceDataLike
    mergeResult(next, result, appendData)
    next.isLoading = false
    next.isFetching = false
    next.isSuccess = true
    next.isError = false
    next.error = null
    if ('isSlowLoading' in next) next.isSlowLoading = false

    entry.state = immutableResourceState(next)
    entry.hasQueried = true
    entry.lastFetchedAt = Date.now()
    entry.lastResult = result
    entry.suspendFetched = false

    if (descriptor.kind === 'infinite') {
      const history = entry.cursorHistory
      const nextCursor = (next as ResourceInfiniteState<unknown>).cursor
      if (appendData && history[history.length - 1] !== nextCursor) history.push(nextCursor)
      else if (!appendData) entry.cursorHistory = [nextCursor]
    }
  }

  const settleEntryError = (entry: QueryCacheEntry, error: unknown) => {
    const next = structuredClone(
      entry.hasQueried ? entry.state : descriptor.initialState
    ) as ResourceDataLike
    next.isLoading = false
    next.isFetching = false
    next.isError = true
    next.error = normalizeError(error)
    next.isSuccess =
      entry.hasQueried && lifecycleBindings.some((binding) => binding.preserveSuccessOnError)
    if ('isSlowLoading' in next) next.isSlowLoading = false
    entry.state = immutableResourceState(next)
  }

  function clearRefetchInterval() {
    if (runtime.refetchIntervalId != null) {
      clearInterval(runtime.refetchIntervalId)
      runtime.refetchIntervalId = undefined
    }
  }

  function scheduleRefetchInterval() {
    clearRefetchInterval()
    const ri = descriptor.refetchInterval
    if (ri === undefined || ri === false) return
    let ms: number | false
    if (typeof ri === 'function') {
      const error = state.isError ? new Error(state.error as string) : undefined
      ms = (ri as (data: unknown, error?: Error) => number | false)(state.data, error)
    } else {
      ms = ri
    }
    if (ms === false || ms <= 0) return
    runtime.refetchIntervalId = setInterval(() => {
      const result = refetch()
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch(() => {})
      }
    }, ms)
  }

  const executeQuery = async (
    arg: unknown,
    rawOptions: ResourceQueryOptions<unknown, unknown> | undefined,
    hasArg: boolean,
    mode: QueryMode,
    isRefetch = false
  ): Promise<unknown> => {
    if (!passesGates()) return

    const activeEntryBefore = getActiveEntry()
    // A refetch needs an active key with a result; a key still showing its seed upgrades instead.
    if (isRefetch && !activeEntryBefore?.hasQueried && state.isPartial !== true) {
      return
    }

    const effectiveOptions = normalizeDescriptorOptions<unknown, unknown>(
      descriptor,
      defaults,
      rawOptions
    )

    const staleTime =
      typeof effectiveOptions.staleTime === 'number' ? effectiveOptions.staleTime : 0
    runtime.gcTime = resolveGcTime(effectiveOptions)
    const now = Date.now()

    const queryArg = isRefetch ? activeEntryBefore?.arg : hasArg ? arg : runtime.lastArg
    const queryKey = serializeResourceArg(descriptor, queryArg)
    const entry = activate(queryKey, queryArg, {
      placeholderData: effectiveOptions.placeholderData as
        | PlaceholderData<unknown, unknown>
        | undefined,
    }) as QueryCacheEntry

    const currentFetchId = ++runtime.fetchId
    const fetchSeq = ++entry.fetchSeq
    /** Still the newest request for this key, with its entry still cached. */
    const isCurrent = () =>
      runtime.cacheEntries.get(queryKey) === entry && entry.fetchSeq === fetchSeq
    /** The model field mirrors this key, so results also apply to it. */
    const isActive = () => runtime.activeKey === queryKey

    // A key without a full result paints its seed while the upgrade runs, whatever staleTime says.
    // Read once here: a durable restore below may turn the key into a full value first.
    let seed = entry.hasQueried ? undefined : readSeed(queryArg)

    // Lifecycle adapters may restore an exact durable view before the remote driver runs.
    if (lifecycleBindings.length > 0 && !entry.resourceHydrated && !entry.hasQueried) {
      // A key change already reset the field, applied `placeholderData` or painted the seed in
      // `activate()`; the seed shows synchronously, before the durable view is even read.
      if (seed !== undefined) paintSeed(seed)

      state.isError = false
      state.error = null
      state.isLoading = seed === undefined && !state.isSuccess
      state.isFetching = true
      runtime.slowLoading?.sync()

      let hydrated
      for (const binding of lifecycleBindings) {
        hydrated = await binding.hydrate?.()
        if (hydrated) break
      }
      if (runtime.fetchId !== currentFetchId) return
      entry.resourceHydrated = true

      if (hydrated) {
        runtime.slowLoading?.reset()
        runInternal(() => {
          state.data = hydrated.data
          Object.assign(state, hydrated.state)
          state.isLoading = false
          state.isFetching = false
          state.isSuccess = true
          state.isError = false
          state.error = null
          // A restored durable view is the key's full value: it replaces the seed like a fetch.
          if (tracksPartial) state.isPartial = false
        })
        entry.hasQueried = true
        entry.lastFetchedAt = hydrated.fetchedAt
        entry.cursorHistory = [...(hydrated.cursorHistory ?? [])]
        entry.lastResult =
          hydrated.lastResult ??
          (descriptor.kind === 'infinite'
            ? { data: hydrated.data, ...hydrated.state }
            : hydrated.data)
        updateCachedState(entry, state)
        seed = undefined
      }
    }

    const shouldFetch =
      isRefetch ||
      !entry.hasQueried ||
      effectiveOptions.force === true ||
      staleTime === 0 ||
      now - entry.lastFetchedAt >= staleTime

    if (!shouldFetch && entry.hasQueried) {
      runtime.slowLoading?.reset()
      runInternal(() => applyCachedState(state, entry))
      return entry.lastResult
    }

    if (entry.hasQueried) {
      runtime.slowLoading?.reset()
      runInternal(() => applyCachedState(state, entry))
    }

    // A key change already reset the field or applied `placeholderData` in `activate()`. A key
    // without a full result shows its seed while the upgrade runs (also when the same key
    // refetches its seed).
    if (seed !== undefined) paintSeed(seed)

    if (descriptor.kind === 'infinite' && mode !== 'restore') {
      const infiniteHistory = entry.cursorHistory
      const currentCursor = (state as ResourceInfiniteState<unknown>).cursor

      if (mode === 'replace') {
        if (infiniteHistory.length === 0) {
          infiniteHistory.push(currentCursor)
        } else {
          infiniteHistory.length = 1
          infiniteHistory[0] = currentCursor
        }
      } else if (
        mode === 'append' &&
        infiniteHistory[infiniteHistory.length - 1] !== currentCursor
      ) {
        infiniteHistory.push(currentCursor)
      }
    }

    state.isError = false
    state.error = null
    // A fresh key (reset by `activate()`) loads; a key that already has data, keeps the previous
    // result through placeholderData, or shows its seed (a background upgrade) only fetches.
    state.isLoading = seed === undefined && !state.isSuccess
    state.isFetching = true
    runtime.slowLoading?.sync()

    // Track suspense promise for initial loads (not refetches)
    if (descriptor.suspense && state.isLoading && !isRefetch) {
      let resolvePromise!: () => void
      const promise = new Promise<unknown>((resolve) => {
        resolvePromise = resolve as () => void
      })
      registry.suspense.set(path, { promise, error: null })
      // Store resolver on the state object for later cleanup
      ;(registry.suspense.get(path) as any).__resolve = resolvePromise
    }

    // Abort any active stream before starting a new query
    if (runtime.streamAbortController) {
      runtime.streamAbortController.abort()
      runtime.streamAbortController = undefined
    }

    const requestTokens = beginLifecycleRequests()

    try {
      let result: unknown

      if (descriptor.kind === 'single' || descriptor.kind === 'realtime') {
        const typedDescriptor = descriptor as SingleResourceDescriptor<unknown, unknown>
        result = await typedDescriptor.queryFn(
          queryArg as unknown,
          contextFor(state) as ResourceContext<ResourceSingleState<unknown>>
        )
      } else {
        const typedDescriptor = descriptor as InfiniteResourceDescriptor<unknown, unknown>
        result = await typedDescriptor.queryFn(
          queryArg as unknown,
          contextFor(state) as ResourceContext<ResourceInfiniteState<unknown>>
        )
      }

      // A newer request, `.set()` or hydration for this key replaced this one.
      if (!isCurrent()) {
        return result
      }

      // Handle AsyncIterable (streaming) results. Chunks apply to the live field, so a stream
      // keeps the runtime-wide guard: any newer operation on the resource ends it.
      if (isAsyncIterable(result)) {
        if (runtime.fetchId !== currentFetchId || !isActive()) {
          return result
        }
        // Mark as queried so refetch() works during streaming
        entry.hasQueried = true

        const abortController = new AbortController()
        runtime.streamAbortController = abortController
        const batchInterval = descriptor.streamBatchInterval

        let lastYield: unknown
        try {
          let lastBatchTime = 0
          for await (const chunk of result) {
            if (abortController.signal.aborted || runtime.fetchId !== currentFetchId) {
              return lastYield
            }

            // Apply batch interval coalescing
            if (batchInterval && batchInterval > 0) {
              const now = Date.now()
              const elapsed = now - lastBatchTime
              if (elapsed < batchInterval && lastBatchTime > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, batchInterval - elapsed))
                if (abortController.signal.aborted || runtime.fetchId !== currentFetchId) {
                  return lastYield
                }
              }
              lastBatchTime = Date.now()
            }

            lastYield = chunk
            applyRemoteResult(chunk, false, requestTokens)
          }
        } catch (streamError) {
          if (abortController.signal.aborted) {
            return lastYield
          }
          throw streamError
        } finally {
          if (runtime.streamAbortController === abortController) {
            runtime.streamAbortController = undefined
          }
        }

        runtime.slowLoading?.reset()
        state.isSuccess = true
        entry.lastFetchedAt = Date.now()
        entry.lastResult = lastYield
        entry.suspendFetched = false
        await commitLifecycleSuccess(entry, entry.lastFetchedAt, requestTokens)
        updateCachedState(entry, state)

        scheduleRefetchInterval()
        return lastYield
      }

      // The key stopped being active while the request ran: the result still lands in its own
      // entry so a hidden page, or the page shown again, reads it instead of staying pending.
      // Lifecycle adapters persist through the active view, so they only see active results.
      if (!isActive()) {
        settleEntry(entry, result, descriptor.kind === 'infinite' && mode === 'append')
        return result
      }

      // Non-streaming path (original behavior)
      if (descriptor.kind === 'single' || descriptor.kind === 'realtime') {
        applyRemoteResult(result, false, requestTokens)
      } else {
        applyRemoteResult(result, mode === 'append', requestTokens)
      }

      runtime.slowLoading?.reset()
      state.isSuccess = true
      entry.hasQueried = true
      entry.lastFetchedAt = Date.now()
      entry.lastResult = result
      entry.suspendFetched = false

      if (descriptor.kind === 'infinite' && mode !== 'restore') {
        const infiniteHistory = entry.cursorHistory
        const nextCursor = (state as ResourceInfiniteState<unknown>).cursor

        if (mode === 'append' && infiniteHistory[infiniteHistory.length - 1] !== nextCursor) {
          infiniteHistory.push(nextCursor)
        } else if (mode === 'replace' && infiniteHistory.length > 0) {
          infiniteHistory[infiniteHistory.length - 1] = nextCursor
        }
      }

      await commitLifecycleSuccess(entry, entry.lastFetchedAt, requestTokens)
      updateCachedState(entry, state)

      if (descriptor.kind === 'realtime') {
        startSubscription()
      }

      scheduleRefetchInterval()

      return result
    } catch (error) {
      if (!isCurrent()) {
        throw error
      }
      if (!isActive()) {
        settleEntryError(entry, error)
        throw error
      }
      runtime.slowLoading?.reset()
      state.isError = true
      state.isSuccess =
        entry.hasQueried && lifecycleBindings.some((binding) => binding.preserveSuccessOnError)
      state.error = normalizeError(error)

      // Store error in suspense state for ErrorBoundary
      if (descriptor.suspense) {
        const suspenseEntry = registry.suspense.get(path)
        if (suspenseEntry) {
          suspenseEntry.error = error instanceof Error ? error : new Error(normalizeError(error))
          // Don't re-throw — let checkSuspense throw it during render
          scheduleRefetchInterval()
          return
        }
      }

      scheduleRefetchInterval()
      throw error
    } finally {
      if (isCurrent() && isActive()) {
        runtime.slowLoading?.reset()
        state.isLoading = false
        state.isFetching = false

        // Resolve suspense promise so React can re-render
        if (descriptor.suspense) {
          const suspenseEntry = registry.suspense.get(path)
          if (suspenseEntry) {
            const resolve = (suspenseEntry as any).__resolve as (() => void) | undefined
            if (resolve) resolve()
            // Only clean up if no error — error entries are cleaned up in checkSuspense
            if (!suspenseEntry.error) {
              registry.suspense.delete(path)
            }
          }
        }
      }
    }
  }

  /**
   * A resource nobody has queried yet has no visible value to protect, so its first `.suspend()`
   * result becomes the observable proxy state as soon as it is known. Passive `state.field.data`
   * readers in the same server render, or in a boundary hydrating later, then match the result
   * instead of showing `initialData` until commit. Keys staged over an already-active resource
   * keep waiting for `commitSuspend`, so an abandoned transition never replaces the current screen.
   */
  const activateStagedEntry = (entry: QueryCacheEntry, key: QueryCacheKey, queryArg: unknown) => {
    runtime.fetchId++
    entry.fetchSeq++
    // Render-time: mirror only; the owner's commit clears `stagedKey` and confirms followers.
    activate(key, queryArg, { commit: false })
  }

  /**
   * With `placeholderData`, a `.suspend()` key that has no result yet does not suspend while the
   * resource already shows another key's result: the selector keeps that data visible and the key
   * loads after commit like `.load()`. Returns the placeholder option in that case.
   */
  const readSuspendPlaceholder = (key: QueryCacheKey) => {
    if (runtime.activeKey === undefined || runtime.activeKey === key) return
    if (!getActiveEntry()?.hasQueried || runtime.cacheEntries.get(key)?.hasQueried) return
    const { placeholderData } = normalizeDescriptorOptions<unknown, unknown>(
      descriptor,
      defaults,
      undefined
    )
    return placeholderData === undefined ? undefined : { placeholderData }
  }

  /** True while a key loads behind the previous result instead of suspending. */
  const keepsPreviousResult = (key: QueryCacheKey) => {
    if (readSuspendPlaceholder(key)) return true
    // After commit the key is active and fetching, with the placeholder still visible.
    return (
      runtime.activeKey === key &&
      !runtime.cacheEntries.get(key)?.hasQueried &&
      state.isFetching === true &&
      state.isLoading === false
    )
  }

  /**
   * Prepare an initial query for selector `.suspend()` without touching the
   * observable resource proxy. Cache entries live outside the proxy, so a
   * discarded concurrent render cannot leak a new active value into the
   * currently committed screen.
   */
  const prepareSuspend = (
    arg: unknown,
    hasArg: boolean,
    key: QueryCacheKey,
    controller: object,
    seeded = false
  ): Promise<unknown> | undefined => {
    const queryArg = hasArg ? arg : undefined
    let entry = runtime.cacheEntries.get(key)
    if (!entry) {
      entry = createCacheEntry(state, key, queryArg)
      entry.state = immutableResourceState(descriptor.initialState)
      runtime.cacheEntries.set(key, entry)
    }
    entry.arg = queryArg

    if (entry.hasQueried) return
    if (entry.suspendError) throw entry.suspendError
    if (entry.suspendPromise) return entry.suspendPromise
    // The selector painted this key's seed: it upgrades after commit like `.load()`, never
    // suspends, and stays painted if that upgrade fails.
    if (seeded) return
    if (keepsPreviousResult(key)) return

    // Reuse an effect/direct query that was already started for this exact
    // controller and key. It began after a previous commit, so it is safe to
    // observe from Suspense without creating a competing request.
    const existingPromise = registry.selectorLoads.get(controller)?.get(key)
    if (existingPromise) return existingPromise

    if (descriptor.enabled && modelState && !descriptor.enabled(modelState)) return
    if (descriptor.dependsOn && modelState) {
      const dependency = descriptor.dependsOn(modelState)
      if (
        dependency && typeof dependency === 'object' && 'isSuccess' in dependency
          ? !dependency.isSuccess
          : dependency == null
      ) {
        return
      }
    }

    const contextState = immutableResourceState(descriptor.initialState)

    let result: unknown
    let promise: Promise<unknown>
    try {
      if (descriptor.kind === 'single' || descriptor.kind === 'realtime') {
        const typedDescriptor = descriptor as SingleResourceDescriptor<unknown, unknown>
        result = typedDescriptor.queryFn(queryArg, {
          state: contextState as Readonly<ResourceSingleState<unknown>>,
        })
      } else {
        const typedDescriptor = descriptor as InfiniteResourceDescriptor<unknown, unknown>
        result = typedDescriptor.queryFn(queryArg, {
          state: contextState as Readonly<ResourceInfiniteState<unknown>>,
        })
      }

      if (isAsyncIterable(result)) {
        promise = Promise.reject(
          new Error(`[comwit] .suspend() does not support streaming resource "${path}"`)
        )
      } else {
        promise = Promise.resolve(result)
      }
    } catch (error) {
      promise = Promise.reject(error)
    }

    entry.suspendPromise = promise
    entry.suspendError = undefined
    entry.suspendNeedsCommit = false

    let pending = registry.selectorLoads.get(controller)
    if (!pending) {
      pending = new Map()
      registry.selectorLoads.set(controller, pending)
    }
    pending.set(key, promise)

    const stagedEntry = entry
    promise.then(
      (queryResult) => {
        if (stagedEntry.suspendPromise !== promise) return

        if (isAsyncIterable(queryResult)) {
          stagedEntry.suspendPromise = undefined
          stagedEntry.suspendError = new Error(
            `[comwit] .suspend() does not support streaming resource "${path}"`
          )
          stagedEntry.state = immutableResourceState({
            ...structuredClone(descriptor.initialState),
            isLoading: false,
            isFetching: false,
            isSuccess: false,
            isError: true,
            error: stagedEntry.suspendError.message,
          })
          return
        }

        try {
          const nextState = structuredClone(descriptor.initialState) as ResourceDataLike
          mergeResult(nextState, queryResult, false)
          nextState.isLoading = false
          nextState.isFetching = false
          nextState.isSuccess = true
          nextState.isError = false
          nextState.error = null

          stagedEntry.state = immutableResourceState(nextState)
          stagedEntry.hasQueried = true
          stagedEntry.lastFetchedAt = Date.now()
          stagedEntry.lastResult = queryResult
          stagedEntry.suspendPromise = undefined
          stagedEntry.suspendError = undefined
          stagedEntry.suspendNeedsCommit = true
          stagedEntry.suspendFetched = true

          if (descriptor.kind === 'infinite') {
            stagedEntry.cursorHistory = [(nextState as ResourceInfiniteState<unknown>).cursor]
          }
          if (runtime.activeKey === undefined) activateStagedEntry(stagedEntry, key, queryArg)
        } catch (error) {
          stagedEntry.suspendPromise = undefined
          stagedEntry.suspendError =
            error instanceof Error ? error : new Error(normalizeError(error))
        }
      },
      (error) => {
        if (stagedEntry.suspendPromise !== promise) return
        stagedEntry.suspendPromise = undefined
        stagedEntry.suspendError = error instanceof Error ? error : new Error(normalizeError(error))
        stagedEntry.state = immutableResourceState({
          ...structuredClone(descriptor.initialState),
          isLoading: false,
          isFetching: false,
          isSuccess: false,
          isError: true,
          error: normalizeError(error),
        })
      }
    )

    promise
      .catch(() => {})
      .finally(() => {
        if (pending?.get(key) === promise) pending.delete(key)
      })

    return promise
  }

  /**
   * Seed a `.suspend()` key from a result the server resolved and streamed into
   * this document. It runs while the selector reads its snapshot and never calls `queryFn`.
   * Like `hydrate()`, a model whose snapshot has not been read yet (`mayInitialize`) and whose
   * resource was never queried is initialized right away so the hydrating render matches the
   * server HTML; returns whether that happened so the hook re-reads its snapshot. Otherwise only
   * the non-observable key cache is touched and the entry activates after commit.
   */
  const restoreSuspend = (
    arg: unknown,
    hasArg: boolean,
    key: QueryCacheKey,
    hookId: string,
    mayInitialize = false
  ): boolean => {
    const stream = registry.suspendStream
    if (!stream) return false
    const existing = runtime.cacheEntries.get(key)
    if (existing?.hasQueried || existing?.suspendPromise) return false

    const streamed = stream.take(hookId, path, key)
    if (!streamed) return false
    const untouched = runtime.activeKey === undefined && runtime.cacheEntries.size === 0

    const queryArg = hasArg ? arg : undefined
    const entry = existing ?? createCacheEntry(state, key, queryArg)
    entry.arg = queryArg

    const nextState = structuredClone(descriptor.initialState) as ResourceDataLike
    mergeResult(nextState, streamed.result, false)
    nextState.isLoading = false
    nextState.isFetching = false
    nextState.isSuccess = true
    nextState.isError = false
    nextState.error = null

    entry.state = immutableResourceState(nextState)
    entry.hasQueried = true
    // Server clocks may run ahead; never record a fetch time in the browser's future.
    entry.lastFetchedAt = Math.min(streamed.fetchedAt, Date.now())
    entry.lastResult = streamed.result
    entry.suspendPromise = undefined
    entry.suspendError = undefined
    entry.suspendNeedsCommit = true
    entry.suspendFetched = false
    if (descriptor.kind === 'infinite') {
      entry.cursorHistory = [(nextState as ResourceInfiniteState<unknown>).cursor]
    }
    runtime.cacheEntries.set(key, entry)

    if (!mayInitialize || !untouched) return false
    activateStagedEntry(entry, key, queryArg)
    return true
  }

  /** Server: expose a render-resolved result so the provider can stream it to the browser. */
  const readSuspendStream = (key: QueryCacheKey): StreamedSuspendResult | undefined => {
    const entry = runtime.cacheEntries.get(key)
    if (!entry?.hasQueried || !entry.suspendFetched) return undefined
    return { fetchedAt: entry.lastFetchedAt, result: entry.lastResult }
  }

  /** Apply a render-staged value only after the selecting tree commits. */
  const commitSuspend = async (
    arg: unknown,
    hasArg: boolean,
    key: QueryCacheKey,
    seeded = false
  ): Promise<unknown> => {
    const queryArg = hasArg ? arg : undefined
    const entry = runtime.cacheEntries.get(key)
    // Decided against the previous active key, so read it before this key takes over.
    const placeholder = entry?.hasQueried ? undefined : readSuspendPlaceholder(key)
    // The owner confirms its key in the layout phase whatever the entry holds, so followers that
    // pinned the staged key settle before paint even when the request is gated or still pending.
    activate(key, queryArg)

    if (!entry?.hasQueried) {
      // A seeded key upgrades now; a key kept behind placeholder data loads now. Both keep the
      // painted value visible.
      return seeded || placeholder
        ? executeQuery(queryArg, undefined, hasArg, 'replace', false)
        : Promise.resolve()
    }

    if (!entry.suspendNeedsCommit) {
      // A previously committed cache hit remains visible while its normal
      // stale-time refresh runs in the background.
      return executeQuery(queryArg, undefined, hasArg, 'replace', false)
    }

    runtime.slowLoading?.reset()
    runtime.fetchId++
    entry.fetchSeq++

    if (lifecycleBindings.length > 0) {
      // Durable restoration is intentionally skipped during render. Once the
      // tree commits, reconcile the remote result against the live local cache
      // and persist/fan out through the normal lifecycle hooks.
      const requestTokens = beginLifecycleRequests()
      applyRemoteResult(entry.lastResult, false, requestTokens)
      state.isLoading = false
      state.isFetching = false
      state.isSuccess = true
      state.isError = false
      state.error = null
      entry.resourceHydrated = true
      updateCachedState(entry, state)
      await commitLifecycleSuccess(entry, entry.lastFetchedAt, requestTokens)
      updateCachedState(entry, state)
    } else {
      runInternal(() => applyCachedState(state, entry))
    }
    entry.suspendNeedsCommit = false

    if (descriptor.kind === 'realtime') startSubscription()
    scheduleRefetchInterval()

    return entry.lastResult
  }

  const queryFn = (...rawArgs: unknown[]) => {
    const parsed = parseQueryArgs(rawArgs)
    return executeQuery(parsed.arg, parsed.options, parsed.hasArg, 'replace', false)
  }

  const refetch = () => {
    const active = getActiveEntry()
    if (!active) return Promise.resolve()
    // Refetching a key that still shows its seed runs the upgrade (e.g. a retry after an error).
    if (!active.hasQueried && state.isPartial !== true) return Promise.resolve()
    return executeQuery(active.arg, undefined, true, 'replace', true)
  }

  const nextFetch = (...rawArgs: unknown[]) => {
    if (descriptor.kind !== 'infinite') return
    if (!(state as ResourceInfiniteState<unknown>).hasMore) return
    const active = getActiveEntry()
    const inputArg = rawArgs[0]

    const effectiveArg = inputArg !== undefined ? inputArg : (active?.arg ?? runtime.lastArg)
    const hasArg = inputArg !== undefined || active !== undefined

    return executeQuery(effectiveArg, { force: true }, hasArg, 'append', false)
  }

  const previousFetch = (...rawArgs: unknown[]) => {
    const parsed = parseQueryArgs(rawArgs)
    if (descriptor.kind !== 'infinite') return
    const active = getActiveEntry()
    if (!active) return

    if (active.cursorHistory.length < 2) {
      return active.lastResult
    }

    active.cursorHistory.pop()
    const effectiveArg = parsed.hasArg ? parsed.arg : active.arg
    return executeQuery(effectiveArg, parsed.options, true, 'restore', false)
  }

  const startSubscription = () => {
    if (descriptor.kind !== 'realtime') return
    const realtimeDescriptor = descriptor as RealtimeResourceDescriptor<unknown, unknown>
    const realtimeState = state as unknown as ResourceRealtimeState<unknown>

    // Clean up existing subscription
    if (runtime.subscriptionCleanup) {
      runtime.subscriptionCleanup()
      runtime.subscriptionCleanup = undefined
    }

    realtimeState.connectionStatus = 'connecting'
    realtimeState.isConnected = false

    const callbacks: SubscribeCallbacks<unknown> = {
      update: (updater: (prev: unknown) => unknown) => {
        state.data = updater(state.data)
      },
      set: (data: unknown) => {
        state.data = data
      },
      refetch: () => {
        return queryFn() as unknown as void
      },
      onStatus: (status: ConnectionStatus) => {
        realtimeState.connectionStatus = status
        realtimeState.isConnected = status === 'connected'
      },
      onError: (error: unknown) => {
        runtime.slowLoading?.reset()
        state.isError = true
        state.error = normalizeError(error)
      },
    }

    const cleanup = realtimeDescriptor.subscribe(callbacks)
    runtime.subscriptionCleanup = cleanup
  }

  const unsubscribe = () => {
    if (runtime.subscriptionCleanup) {
      runtime.subscriptionCleanup()
      runtime.subscriptionCleanup = undefined
    }
    if (descriptor.kind === 'realtime') {
      const realtimeState = state as unknown as ResourceRealtimeState<unknown>
      realtimeState.connectionStatus = 'disconnected'
      realtimeState.isConnected = false
    }
  }

  const setResource = (next: unknown, options?: ResourceSetOptions<unknown>): unknown => {
    const setArg =
      options && Object.prototype.hasOwnProperty.call(options, 'arg')
        ? options.arg
        : runtime.lastArg
    const key = serializeResourceArg(descriptor, setArg)

    // A server initializer must win over an IndexedDB restore or request that
    // started before it. Advancing the generations invalidates either pending result.
    runtime.slowLoading?.reset()
    runtime.fetchId++
    const entry = activate(key, setArg) as QueryCacheEntry
    entry.fetchSeq++

    const stateKeys = new Set([
      'data',
      'isLoading',
      'isSlowLoading',
      'isFetching',
      'isSuccess',
      'isError',
      'error',
      'cursor',
      'hasMore',
    ])
    const nextKeys = isRecord(next) ? Object.keys(next) : []
    const isStatePatch =
      nextKeys.length > 0 &&
      nextKeys.some((key) => stateKeys.has(key)) &&
      nextKeys.every((key) => stateKeys.has(key))

    if (isStatePatch) {
      const { isSlowLoading: _slowLoading, ...patch } = next as ResourceDataLike
      Object.assign(state, patch)
    } else {
      state.data = next
    }

    state.isLoading = false
    state.isFetching = false
    state.isSuccess = true
    state.isError = false
    state.error = null
    // `.set()` always means the full value.
    if (tracksPartial) state.isPartial = false

    entry.hasQueried = true
    entry.resourceHydrated = true
    entry.lastFetchedAt = Date.now()
    entry.lastResult = state.data
    entry.suspendFetched = false
    updateCachedState(entry, state)

    return next
  }

  /**
   * Initialize one resolved server value before React reads this model's first
   * external-store snapshot. This is deliberately separate from the public
   * proxy/action surface; observed entries are applied only during commit.
   */
  const hydrateResource = (
    arg: unknown,
    hasArg: boolean,
    key: QueryCacheKey,
    data: unknown,
    mayInitialize: boolean,
    phase: 'render' | 'commit'
  ): boolean => {
    if (descriptor.kind === 'realtime' || descriptor.selectorMethod === 'restore') return false

    const existing = runtime.cacheEntries.get(key)
    const isSameActiveEntry =
      existing?.hasQueried === true &&
      runtime.activeKey === key &&
      isEqual(existing.state.data, data)

    if (phase === 'render') {
      if (isSameActiveEntry) return true

      // A brand-new, unread model can be initialized before its first
      // useSyncExternalStore snapshot. Existing observable state is deferred
      // to the layout commit of the render that requested the hydration.
      if (!mayInitialize || runtime.activeKey !== undefined || runtime.cacheEntries.size > 0) {
        return false
      }
    } else if (isSameActiveEntry) {
      if (existing.hydrationNeedsCommit) {
        existing.hydrationNeedsCommit = false
        if (lifecycleBindings.length > 0) {
          const requestTokens = beginLifecycleRequests()
          void commitLifecycleSuccess(existing, existing.lastFetchedAt, requestTokens)
            .then(() => {
              updateCachedState(existing, state)
            })
            .catch(() => {})
        }
      }
      return true
    }

    const queryArg = hasArg ? arg : undefined
    const fetchedAt = Date.now()
    const nextState = structuredClone(descriptor.initialState) as ResourceDataLike
    nextState.data = structuredClone(data)
    nextState.isLoading = false
    nextState.isFetching = false
    nextState.isSuccess = true
    nextState.isError = false
    nextState.error = null

    const entry = existing ?? createCacheEntry(state, key, queryArg)
    entry.arg = queryArg
    entry.hasQueried = true
    entry.resourceHydrated = true
    entry.lastFetchedAt = fetchedAt
    entry.lastResult = data
    entry.state = immutableResourceState(nextState)
    entry.suspendPromise = undefined
    entry.suspendError = undefined
    entry.suspendNeedsCommit = false
    entry.suspendFetched = false
    entry.hydrationNeedsCommit = lifecycleBindings.length > 0
    if (descriptor.kind === 'infinite') {
      entry.cursorHistory = [(nextState as ResourceInfiniteState<unknown>).cursor]
    }

    runtime.slowLoading?.reset()
    runtime.fetchId++
    entry.fetchSeq++
    // Observed entries confirm after commit; a render-time initialization only mirrors. The
    // hydrated entry is installed afterwards: a lifecycle adapter may clear the cache during
    // activation (a `local` scope change), and the server value must survive that.
    activate(key, queryArg, { commit: phase === 'commit' })
    runtime.cacheEntries.set(key, entry)
    runInternal(() => Object.assign(state, structuredClone(nextState)))

    if (phase === 'commit' && entry.hydrationNeedsCommit) {
      entry.hydrationNeedsCommit = false
      const requestTokens = beginLifecycleRequests()
      void commitLifecycleSuccess(entry, fetchedAt, requestTokens)
        .then(() => {
          updateCachedState(entry, state)
        })
        .catch(() => {})
    }
    return true
  }

  const baseBound = new Proxy(state, {
    get(target, prop) {
      if (prop === RESOURCE_HYDRATE) return hydrateResource
      if (prop === RESOURCE_ACTIVATE) return activateOwner
      if (prop === RESOURCE_SUSPEND_PREPARE) return prepareSuspend
      if (prop === RESOURCE_SUSPEND_COMMIT) return commitSuspend
      if (prop === RESOURCE_SUSPEND_RESTORE) return restoreSuspend
      if (prop === RESOURCE_SUSPEND_STREAM) return readSuspendStream
      if (prop === RESOURCE_SUSPEND_PLACEHOLDER) return readSuspendPlaceholder
      if (prop === 'query') return queryFn
      if (descriptor.selectorMethod && prop === descriptor.selectorMethod) return queryFn
      if (prop === 'refetch') return refetch
      if (prop === 'unsubscribe') {
        if (descriptor.kind === 'realtime') return unsubscribe
        return undefined
      }
      if (prop === 'nextFetch') {
        if (descriptor.kind === 'infinite') return nextFetch
        return undefined
      }
      if (prop === 'previousFetch') {
        if (descriptor.kind === 'infinite') return previousFetch
        return undefined
      }
      if (prop === 'set') {
        return setResource
      }

      return Reflect.get(target, prop)
    },
  })

  const bound = lifecycleBindings.reduce(
    (controller, binding) => binding.decorateController?.(controller) ?? controller,
    baseBound as ResourceDataLike
  )

  registry.boundResourceValue.set(state, bound)
  registry.boundResourceRuntime.set(bound, runtime)
  return bound
}
