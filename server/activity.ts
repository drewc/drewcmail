/**
 * What the server is doing right now — sync steps, Gmail pushes, Bridge's syncing,
 * and work queued behind them — for the app's spinner (GET /api/activity).
 */

export type Activity = { id: number; what: string; since: string; detail?: string; waiting?: boolean }

const running = new Map<number, Activity>()
let seq = 0

/** something started (or is waiting its turn); `set` updates what it is doing, `end` removes it */
export function begin(what: string, { waiting = false } = {}) {
  const a: Activity = { id: ++seq, what, since: new Date().toISOString(), ...(waiting ? { waiting } : {}) }
  running.set(a.id, a)
  return {
    set(detail: string) { a.detail = detail },
    end() { running.delete(a.id) },
  }
}

/** run `fn` as an activity */
export async function track<T>(what: string, fn: (set: (detail: string) => void) => Promise<T>): Promise<T> {
  const a = begin(what)
  try { return await fn(a.set) } finally { a.end() }
}

/** oldest first */
export const list = () => [...running.values()]
