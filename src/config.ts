import type { Site } from "./types.js";

export interface Config {
  site: Site;
  /** Web host for page fetches, derived from site. */
  host: string;
  /** X-Dg-Portal header value. Identifies the storefront/locale to the API. */
  portal: string;
  /** X-Dg-Language header + URL language segment, e.g. "en", "de", "fr". */
  language: string;
  /**
   * Persisted-query id for the search operation (useSearchDataQuery).
   * Galaxus rotates these on deploy; override via env when it goes stale.
   * See README "Refreshing the search query id".
   */
  searchQueryHash: string;
  /** Persisted-query id for the product-detail operation (productDetailPageQuery). */
  productQueryHash: string;
  /** min delay between outbound requests, ms */
  minRequestIntervalMs: number;
  /** Per-request timeout, ms. */
  requestTimeoutMs: number;
  /** Simple in-memory cache TTL for product/search responses, ms. */
  cacheTtlMs: number;
  /** User-Agent sent with requests. */
  userAgent: string;
}

/** Default API portal id per site (captured from the live storefronts). */
const SITE_DEFAULTS: Record<Site, { host: string; portal: string; language: string }> = {
  "galaxus.ch": { host: "www.galaxus.ch", portal: "22", language: "en" },
  "galaxus.de": { host: "www.galaxus.de", portal: "26", language: "de" },
  "digitec.ch": { host: "www.digitec.ch", portal: "25", language: "en" },
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const site = (process.env.GALAXUS_SITE as Site) ?? "galaxus.ch";
  const defaults = SITE_DEFAULTS[site] ?? SITE_DEFAULTS["galaxus.ch"];
  return {
    site,
    host: process.env.GALAXUS_HOST ?? defaults.host,
    portal: process.env.GALAXUS_PORTAL ?? defaults.portal,
    language: process.env.GALAXUS_LANGUAGE ?? defaults.language,
    // Captured 2026-06-28 from galaxus.ch (useSearchDataQuery).
    searchQueryHash:
      process.env.GALAXUS_SEARCH_HASH ?? "40b905aec285355e21e4b85ae1af61bd",
    // Captured 2026-06-28 from galaxus.ch (productDetailPageQuery).
    productQueryHash:
      process.env.GALAXUS_PRODUCT_HASH ?? "b250b1da346175e0fdb47d7ed9d5c2fa",
    minRequestIntervalMs: envNumber("GALAXUS_MIN_INTERVAL_MS", 800),
    requestTimeoutMs: envNumber("GALAXUS_TIMEOUT_MS", 15000),
    cacheTtlMs: envNumber("GALAXUS_CACHE_TTL_MS", 60_000),
    userAgent:
      process.env.GALAXUS_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
}
