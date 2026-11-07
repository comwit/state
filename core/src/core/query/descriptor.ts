import { validateSlowLoadingMs } from './slow-loading'
import {
  RESOURCE_BRAND,
  type AnyResourceDescriptor,
  type InfiniteResourceBuilderOptions,
  type InfiniteResourceDescriptor,
  type RealtimeResourceBuilderOptions,
  type RealtimeResourceDescriptor,
  type ResourceFactory,
  type ResourceInfiniteState,
  type ResourceQueryOptions,
  type ResourceRealtimeState,
  type ResourceSingleState,
  type SingleResourceBuilderOptions,
  type SingleResourceDescriptor,
} from './types'

export function createSingleDescriptor<TData, TArg = void, TSeed = never>(
  opts: SingleResourceBuilderOptions<TData, TArg, TSeed>
): SingleResourceDescriptor<TData, TArg, false, TSeed> {
  validateSlowLoadingMs(opts.slowLoadingMs)
  const {
    initialData,
    suspense,
    streamBatchInterval,
    slowLoadingMs,
    queryFn,
    enabled,
    dependsOn,
    refetchInterval,
    seed,
    ...optionValues
  } = opts as SingleResourceBuilderOptions<TData, TArg, unknown>
  if (seed !== undefined && typeof seed !== 'function') {
    throw new TypeError(
      'query() seed must be a function: (arg, { state, read }) => partial | null'
    )
  }

  const initialState: ResourceSingleState<TData> = {
    data: initialData,
    isLoading: false,
    isSlowLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    error: null,
    // Only a seeded query tracks whether its visible value is partial.
    ...(seed ? { isPartial: false } : {}),
  }

  return {
    ...initialState,
    kind: 'single',
    suspense: suspense ?? false,
    streamBatchInterval,
    slowLoadingMs,
    [RESOURCE_BRAND]: true,
    initialState,
    options: optionValues as Omit<ResourceQueryOptions<TData, unknown>, 'force'>,
    queryFn,
    enabled,
    dependsOn,
    refetchInterval,
    seed: seed as SingleResourceDescriptor<TData, TArg, false, TSeed>['seed'],
  }
}

export function createInfiniteDescriptor<TData, TArg = void>(
  opts: InfiniteResourceBuilderOptions<TData, TArg>
): InfiniteResourceDescriptor<TData, TArg> {
  validateSlowLoadingMs(opts.slowLoadingMs)
  const initialState: ResourceInfiniteState<TData> = {
    data: opts.initialData,
    cursor: null,
    hasMore: false,
    isLoading: false,
    isSlowLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    error: null,
  }

  const {
    initialData: _initialData,
    suspense,
    streamBatchInterval,
    slowLoadingMs,
    queryFn,
    enabled,
    dependsOn,
    refetchInterval,
    ...optionValues
  } = opts as InfiniteResourceBuilderOptions<TData, TArg>

  return {
    ...initialState,
    kind: 'infinite',
    suspense: suspense ?? false,
    streamBatchInterval,
    slowLoadingMs,
    [RESOURCE_BRAND]: true,
    initialState,
    options: optionValues as Omit<ResourceQueryOptions<TData, unknown>, 'force'>,
    queryFn,
    enabled,
    dependsOn,
    refetchInterval,
  }
}

export function createRealtimeDescriptor<TData, TArg = void>(
  opts: RealtimeResourceBuilderOptions<TData, TArg>
): RealtimeResourceDescriptor<TData, TArg> {
  validateSlowLoadingMs(opts.slowLoadingMs)
  const initialState: ResourceRealtimeState<TData> = {
    data: opts.initialData,
    isLoading: false,
    isSlowLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    error: null,
    connectionStatus: 'disconnected',
    isConnected: false,
  }
  const { initialData: _initialData, queryFn, subscribe, slowLoadingMs, ...optionValues } = opts
  return {
    ...initialState,
    kind: 'realtime',
    slowLoadingMs,
    [RESOURCE_BRAND]: true,
    initialState,
    options: optionValues as Omit<ResourceQueryOptions<TData, unknown>, 'force'>,
    queryFn,
    subscribe,
  }
}

export const query: ResourceFactory = Object.assign(
  (opts: SingleResourceBuilderOptions<unknown, unknown, unknown>) => createSingleDescriptor(opts),
  {
    infinite: createInfiniteDescriptor,
    realtime: createRealtimeDescriptor,
  }
) as ResourceFactory

export function isResourceDescriptor(value: unknown): value is AnyResourceDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [RESOURCE_BRAND]?: unknown })[RESOURCE_BRAND] === true
  )
}

export function keepPreviousData<TData, TArg = void>(_: TArg, previousData: TData): TData {
  return previousData
}
