import type { Config } from "./config.js";

// serializes requests with a min interval, times them out, and caches responses
// by key for a short TTL. No deps on purpose.
export class HttpClient {
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  // TODO: this never evicts expired entries, only ignores them on read. Fine for
  // a long-running server with bounded queries, revisit if memory grows.
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly config: Config) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.lastRequestAt + this.config.minRequestIntervalMs - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /** Run fn serialized behind the throttle gate. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.throttle()).then(fn);
    // keep the chain alive regardless of individual failures
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async postJson<T>(url: string, body: unknown, opts?: { cacheKey?: string; headers?: Record<string, string> }): Promise<T> {
    if (opts?.cacheKey) {
      const hit = this.cache.get(opts.cacheKey);
      if (hit && Date.now() - hit.at < this.config.cacheTtlMs) return hit.value as T;
    }

    const result = await this.serialize(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": this.config.userAgent,
            accept: "application/json",
            ...opts?.headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}: ${text.slice(0, 300)}`);
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    });

    if (opts?.cacheKey) this.cache.set(opts.cacheKey, { at: Date.now(), value: result });
    return result;
  }

  async getText(url: string, opts?: { cacheKey?: string; headers?: Record<string, string> }): Promise<string> {
    if (opts?.cacheKey) {
      const hit = this.cache.get(opts.cacheKey);
      if (hit && Date.now() - hit.at < this.config.cacheTtlMs) return hit.value as string;
    }

    const result = await this.serialize(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            "user-agent": this.config.userAgent,
            accept: "text/html,application/xhtml+xml",
            "accept-language": `${this.config.language},en;q=0.8`,
            ...opts?.headers,
          },
          redirect: "follow",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    });

    if (opts?.cacheKey) this.cache.set(opts.cacheKey, { at: Date.now(), value: result });
    return result;
  }
}
