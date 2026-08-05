/**
 * Minimal concurrency limiter (pLimit-style).
 *
 * Returns a function that wraps an async callable; calls beyond the
 * concurrency limit are queued and run as earlier ones complete. Order
 * of completion is not guaranteed; order of start respects the queue.
 */

export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (concurrency < 1) {
    throw new Error("pLimit: concurrency must be at least 1")
  }
  let active = 0
  const queue: Array<() => void> = []

  const next = () => {
    if (queue.length > 0) {
      const run = queue.shift()!
      run()
    }
  }

  return function limited<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1
        fn().then(
          (value) => {
            resolve(value)
            active -= 1
            next()
          },
          (error) => {
            reject(error)
            active -= 1
            next()
          },
        )
      }

      if (active < concurrency) {
        run()
      } else {
        queue.push(run)
      }
    })
  }
}

/**
 * Run `fn` over every item with at most `concurrency` in flight, preserving
 * result order. Rejects fast on the first failure.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency)
  return Promise.all(
    items.map((item, index) => limit(() => fn(item, index))),
  )
}