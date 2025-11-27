/**
 * Bulletproof Async Timeout Utilities
 *
 * Provides timeout wrappers for ALL async operations to prevent
 * indefinite hangs that can cause WhatsApp instances to get stuck.
 *
 * Part of the "Defense in Depth" architecture - Layer 1
 */

/**
 * Custom error class for timeout exceptions
 */
export class TimeoutError extends Error {
  public readonly operation: string;
  public readonly timeoutMs: number;
  public readonly timestamp: Date;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.timestamp = new Date();
  }
}

/**
 * Default timeout values (in milliseconds)
 */
export const TIMEOUT_DEFAULTS = {
  DB_QUERY: 5000, // 5 seconds for database queries
  REDIS: 3000, // 3 seconds for Redis operations
  WEBSOCKET_CLOSE: 2000, // 2 seconds for WebSocket close
  HTTP_REQUEST: 10000, // 10 seconds for HTTP requests
  FFMPEG: 30000, // 30 seconds for media processing
  STATE_CHANGE: 5000, // 5 seconds for state transitions
  GENERIC: 10000, // 10 seconds default
} as const;

/**
 * Wraps any promise with a timeout using Promise.race()
 *
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operationName Name for logging/debugging
 * @returns The promise result or throws TimeoutError
 *
 * @example
 * const result = await withTimeout(
 *   prisma.instance.findUnique({ where: { id } }),
 *   5000,
 *   'findInstance'
 * );
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Wraps a database query with 5 second timeout
 *
 * @example
 * const instance = await withDbTimeout(
 *   prisma.instance.findUnique({ where: { id } }),
 *   'findInstance'
 * );
 */
export function withDbTimeout<T>(promise: Promise<T>, operationName: string): Promise<T> {
  return withTimeout(promise, TIMEOUT_DEFAULTS.DB_QUERY, `DB:${operationName}`);
}

/**
 * Wraps a Redis operation with 3 second timeout
 *
 * @example
 * const cached = await withRedisTimeout(
 *   redis.get('key'),
 *   'getCachedValue'
 * );
 */
export function withRedisTimeout<T>(promise: Promise<T>, operationName: string): Promise<T> {
  return withTimeout(promise, TIMEOUT_DEFAULTS.REDIS, `Redis:${operationName}`);
}

/**
 * Wraps a WebSocket operation with 2 second timeout
 *
 * @example
 * await withWsTimeout(
 *   closeWebSocket(socket),
 *   'closeConnection'
 * );
 */
export function withWsTimeout<T>(promise: Promise<T>, operationName: string): Promise<T> {
  return withTimeout(promise, TIMEOUT_DEFAULTS.WEBSOCKET_CLOSE, `WS:${operationName}`);
}

/**
 * Wraps an HTTP request with 10 second timeout
 *
 * @example
 * const response = await withHttpTimeout(
 *   axios.get(url),
 *   'fetchProxyStatus'
 * );
 */
export function withHttpTimeout<T>(promise: Promise<T>, operationName: string): Promise<T> {
  return withTimeout(promise, TIMEOUT_DEFAULTS.HTTP_REQUEST, `HTTP:${operationName}`);
}

/**
 * Wraps an FFmpeg operation with 30 second timeout
 *
 * @example
 * const buffer = await withFfmpegTimeout(
 *   processAudio(input),
 *   'convertToMp4'
 * );
 */
export function withFfmpegTimeout<T>(promise: Promise<T>, operationName: string): Promise<T> {
  return withTimeout(promise, TIMEOUT_DEFAULTS.FFMPEG, `FFmpeg:${operationName}`);
}

/**
 * Creates a cancellable promise that can be aborted
 *
 * @param executor The async operation
 * @param timeoutMs Timeout in milliseconds
 * @param operationName Name for logging
 * @returns Object with promise and cancel function
 *
 * @example
 * const { promise, cancel } = createCancellablePromise(
 *   async (signal) => {
 *     // Check signal.aborted periodically
 *     const result = await fetchData();
 *     if (signal.aborted) throw new Error('Cancelled');
 *     return result;
 *   },
 *   5000,
 *   'fetchData'
 * );
 *
 * // Later, if needed:
 * cancel();
 */
export function createCancellablePromise<T>(
  executor: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operationName: string,
): { promise: Promise<T>; cancel: () => void } {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;

  const promise = new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);

    executor(controller.signal)
      .then((result) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      });
  });

  return {
    promise,
    cancel: () => {
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
}

/**
 * Retry an operation with exponential backoff and timeout per attempt
 *
 * @param operation The async operation to retry
 * @param options Retry options
 * @returns The operation result
 *
 * @example
 * const result = await retryWithTimeout(
 *   () => connectToServer(),
 *   {
 *     maxAttempts: 3,
 *     timeoutMs: 5000,
 *     backoffMs: 1000,
 *     operationName: 'connectServer'
 *   }
 * );
 */
export async function retryWithTimeout<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts: number;
    timeoutMs: number;
    backoffMs: number;
    maxBackoffMs?: number;
    operationName: string;
  },
): Promise<T> {
  const { maxAttempts, timeoutMs, backoffMs, maxBackoffMs = 30000, operationName } = options;

  let lastError: Error | undefined;
  let currentBackoff = backoffMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(operation(), timeoutMs, `${operationName}:attempt${attempt}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts) {
        // Wait before retry with exponential backoff
        await new Promise((resolve) => setTimeout(resolve, currentBackoff));
        currentBackoff = Math.min(currentBackoff * 2, maxBackoffMs);
      }
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxAttempts} attempts`);
}

/**
 * Execute multiple promises with individual timeouts
 * Returns results for successful ones, null for failed/timed out
 *
 * @example
 * const [result1, result2] = await executeWithTimeouts([
 *   { promise: fetchA(), timeoutMs: 5000, name: 'fetchA' },
 *   { promise: fetchB(), timeoutMs: 3000, name: 'fetchB' },
 * ]);
 */
export async function executeWithTimeouts<T>(
  operations: Array<{
    promise: Promise<T>;
    timeoutMs: number;
    name: string;
  }>,
): Promise<Array<T | null>> {
  const results = await Promise.allSettled(
    operations.map(({ promise, timeoutMs, name }) => withTimeout(promise, timeoutMs, name)),
  );

  return results.map((result) => (result.status === 'fulfilled' ? result.value : null));
}
