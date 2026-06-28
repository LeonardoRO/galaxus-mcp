import type { Config } from "../config.js";
import { HttpClient } from "../http.js";
import {
  ProductDetailSchema,
  ProductSummarySchema,
  type CategoryFacets,
  type DataProvider,
  type PriceHistory,
  type PriceSnapshot,
  type ProductDetail,
  type ProductSummary,
  type SearchFilters,
  type SearchResult,
  type SortOrder,
} from "../types.js";

/** Map friendly sort keys to the API's ShopSearchSortOrder enum. */
const SORT_MAP: Record<SortOrder, string> = {
  relevance: "RELEVANCE",
  price_asc: "LOWEST_PRICE",
  price_desc: "HIGHEST_PRICE",
  rating: "RATING",
  newest: "NEWEST",
};

// Talks to Galaxus's internal GraphQL endpoints (Relay persisted queries on a
// HotChocolate backend):
//   search:  POST /graphql/o/<searchQueryHash>/useSearchDataQuery
//   product: POST /graphql/o/<productQueryHash>/productDetailPageQuery
// Both need the X-Dg-Portal / X-Dg-Language headers; body is { query: null, variables }.
// The product HTML pages hit a captcha for non-browser clients, the graphql
// endpoint doesn't, so everything goes through graphql.
export class GraphQLProvider implements DataProvider {
  readonly name = "graphql";
  private readonly http: HttpClient;

  constructor(private readonly config: Config) {
    this.http = new HttpClient(config);
  }

  private get base(): string {
    return `https://${this.config.host}`;
  }

  private gqlHeaders(): Record<string, string> {
    return {
      "X-Dg-Portal": this.config.portal,
      "X-Dg-Language": this.config.language,
      origin: this.base,
      referer: `${this.base}/`,
    };
  }

  async searchProducts(query: string, filters: SearchFilters): Promise<SearchResult> {
    const url = `${this.base}/graphql/o/${this.config.searchQueryHash}/useSearchDataQuery`;
    const sort = SORT_MAP[filters.sort ?? "relevance"];
    const variables: Record<string, unknown> = {
      query,
      first: filters.limit,
      sortOrder: sort,
      // without skipRedirect, category-ish terms (e.g. "ssd") come back with
      // products:null and a redirect instead of actual results
      searchQueryConfig: { skipAutoFilterPrediction: false, skipRedirect: true },
    };
    if (filters.cursor) variables.after = filters.cursor;

    const cacheKey = `search:${this.config.portal}:${query}:${sort}:${filters.limit}:${filters.cursor ?? ""}`;
    const res = await this.http.postJson<GqlSearchResponse>(
      url,
      { query: null, variables },
      { headers: this.gqlHeaders(), cacheKey },
    );

    const search = res.data?.shopSearch;
    const products = search?.products;
    if (!products) {
      const detail = res.errors ? `: ${JSON.stringify(res.errors).slice(0, 200)}` : "";
      throw new Error(`Galaxus search returned no product connection${detail}`);
    }

    const summaries = (products.edges ?? [])
      .map((e) => this.toSummary(e?.node))
      .filter((p): p is ProductSummary => p !== null);

    return {
      products: applyClientFilters(summaries, filters),
      total: products.totalCount ?? null,
      nextCursor: products.pageInfo?.hasNextPage ? products.pageInfo.endCursor ?? null : null,
      facets: extractFacets(search),
    };
  }

  async getProduct(idOrUrl: string): Promise<ProductDetail> {
    const node = await this.fetchProductNode(idOrUrl);
    const detail = this.toDetail(node);
    if (!detail) throw new Error(`Product data for "${idOrUrl}" was missing required fields`);
    return detail;
  }

  async getPriceSnapshot(idOrUrl: string): Promise<PriceSnapshot> {
    const node = await this.fetchProductNode(idOrUrl);
    const summary = this.toSummary(node);
    if (!summary) throw new Error(`Product data for "${idOrUrl}" was missing required fields`);
    return {
      id: summary.id,
      name: summary.name,
      url: summary.url,
      price: summary.price ?? null,
      availability: summary.availability ?? null,
      priceHistory: extractPriceHistory(node),
    };
  }

  private async fetchProductNode(idOrUrl: string): Promise<GqlProductNode> {
    const path = this.resolveProductPath(idOrUrl);
    const url = `${this.base}/graphql/o/${this.config.productQueryHash}/productDetailPageQuery`;
    const variables = {
      slug: path,
      path,
      offer: null,
      shopArea: "RETAIL",
      // sectorId is required but sector 1 works for any product (the core
      // fields resolve regardless of which sector it actually belongs to)
      sectorId: "U2VjdG9yCmkx",
      tagIds: [],
      isSSR: false,
      zipCodeInput: null,
      hasTrustLevelLowAndIsNotEProcurement: true,
      shouldLoadInstallmentLimit: false,
      adventCalendarEnabled: false,
      olderThan3MonthTimestamp: threeMonthsAgoIso(),
    };

    const res = await this.http.postJson<GqlProductResponse>(
      url,
      { query: null, variables },
      { headers: this.gqlHeaders(), cacheKey: `product:${this.config.portal}:${path}` },
    );

    const node = res.data?.product;
    // there are usually partial errors on user-scoped fields (resale,
    // installments etc) but those are fine as long as we got the product back
    if (!node) {
      const detail = res.errors ? `: ${JSON.stringify(res.errors).slice(0, 200)}` : "";
      throw new Error(`No product found for "${idOrUrl}"${detail}`);
    }
    return node;
  }

  /** Accept a full URL, a site-relative slug, or a bare numeric product id. */
  private resolveProductPath(idOrUrl: string): string {
    const v = idOrUrl.trim();
    if (/^https?:\/\//i.test(v)) {
      try {
        return new URL(v).pathname;
      } catch {
        /* fall through */
      }
    }
    if (v.startsWith("/")) return v;
    return `/${this.config.language}/product/${v}`;
  }

  private toSummary(node: GqlProductNode | undefined | null): ProductSummary | null {
    if (!node || node.databaseId == null || !node.name) return null;
    const path = node.relativeUrl ?? "";
    const candidate = {
      id: String(node.databaseId),
      name: node.name,
      brand: node.brand?.name ?? null,
      url: path.startsWith("http") ? path : `${this.base}${path}`,
      price: node.price ? { amount: node.price.amountInclusive, currency: node.price.currency ?? "CHF" } : null,
      rating: node.ratingSummary?.averageRating ?? null,
      ratingCount: node.ratingSummary?.ratingCount ?? null,
      availability: node.availability?.mail?.classification ?? null,
      imageUrl: this.imageUrl(firstImage(node)) ?? null,
    };
    const parsed = ProductSummarySchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  private toDetail(node: GqlProductNode): ProductDetail | null {
    const summary = this.toSummary(node);
    if (!summary) return null;
    const candidate = {
      ...summary,
      description: node.description ?? null,
      gtin: node.gtin ?? null,
      specifications: extractSpecifications(node),
      images: collectImages(node).map((rel) => this.imageUrl(rel)).filter((u): u is string => !!u),
      priceHistory: extractPriceHistory(node),
    };
    const parsed = ProductDetailSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  /** Image nodes expose a relativeUrl like "/im/productimages/..."; absolutize it. */
  private imageUrl(rel: string | undefined): string | undefined {
    if (!rel) return undefined;
    if (rel.startsWith("http")) return rel;
    return `${this.base}${rel}`;
  }
}

// the API already sorts/ranks; we just narrow the page it returned.
// NOTE: this filters client-side so a page can come back with fewer than `limit`
// items. Ideally we'd pass these as real API filters (productFilters) instead.
function applyClientFilters(products: ProductSummary[], f: SearchFilters): ProductSummary[] {
  return products.filter((p) => {
    if (f.minPrice != null && (p.price?.amount ?? Infinity) < f.minPrice) return false;
    if (f.maxPrice != null && (p.price?.amount ?? -Infinity) > f.maxPrice) return false;
    if (f.brand && (p.brand ?? "").toLowerCase() !== f.brand.toLowerCase()) return false;
    if (f.minRating != null && (p.rating ?? 0) < f.minRating) return false;
    return true;
  });
}

// --- field extraction --------------------------------------------------------

function threeMonthsAgoIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString();
}

function extractFacets(search: GqlShopSearch): CategoryFacets {
  return {
    redirectionUrl: search.redirectionUrl ?? null,
    brands: (search.brands?.edges ?? []).map((e) => e?.node?.name).filter((n): n is string => !!n),
    productTypes: (search.productTypes?.edges ?? []).map((e) => e?.node?.name).filter((n): n is string => !!n),
  };
}

function firstImage(node: GqlProductNode): string | undefined {
  const edges = node.galleryImages?.edges ?? node.previewImages?.edges ?? [];
  return imageRel(edges[0]);
}

function collectImages(node: GqlProductNode): string[] {
  const edges = node.galleryImages?.edges ?? node.previewImages?.edges ?? [];
  return edges.map(imageRel).filter((u): u is string => typeof u === "string");
}

function imageRel(edge: { node?: { relativeUrl?: string; url?: string } } | undefined): string | undefined {
  return edge?.node?.relativeUrl ?? edge?.node?.url;
}

function extractSpecifications(node: GqlProductNode): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const edge of node.specificationGroups?.edges ?? []) {
    for (const spec of edge?.node?.specifications ?? []) {
      const value = specValue(spec?.value);
      if (spec?.title && value) specs[spec.title] = value;
    }
  }
  return specs;
}

function specValue(value: GqlSpecValue | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value.text === "string") return value.text;
  if (value.name) return value.name;
  if (value.value != null && value.unit) return `${value.value} ${value.unit}`;
  if (value.value != null) return String(value.value);
  return undefined;
}

function extractPriceHistory(node: GqlProductNode): PriceHistory | null {
  const ph = node.priceHistory;
  if (!ph?.summary) return null;
  const f = ph.summary.fluctuation;
  return {
    position: ph.summary.type ?? null,
    low: f?.low ? { amount: f.low.amountInclusive, currency: f.low.currency ?? "CHF" } : null,
    high: f?.high ? { amount: f.high.amountInclusive, currency: f.high.currency ?? "CHF" } : null,
    hasHistoryOlderThan3Months: ph.hasHistoryOlderThan3Months ?? undefined,
  };
}

// --- raw GraphQL response shapes (only the parts we read) --------------------

interface GqlShopSearch {
  redirectionUrl?: string;
  products?: {
    edges?: { node?: GqlProductNode }[];
    totalCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  };
  brands?: { edges?: { node?: { name?: string } }[] };
  productTypes?: { edges?: { node?: { name?: string } }[] };
}

interface GqlSearchResponse {
  data?: { shopSearch?: GqlShopSearch };
  errors?: unknown[];
}

interface GqlProductResponse {
  data?: { product?: GqlProductNode };
  errors?: unknown[];
}

interface GqlSpecValue {
  text?: string;
  name?: string;
  value?: string | number;
  unit?: string;
}

interface GqlMoney {
  amountInclusive: number;
  amountExclusive?: number;
  currency?: string;
}

interface GqlProductNode {
  databaseId?: number;
  name?: string;
  relativeUrl?: string;
  description?: string;
  gtin?: string;
  brand?: { name?: string } | null;
  price?: GqlMoney | null;
  ratingSummary?: { averageRating?: number; ratingCount?: number } | null;
  availability?: { mail?: { classification?: string } } | null;
  previewImages?: { edges?: { node?: { relativeUrl?: string; url?: string } }[] };
  galleryImages?: { edges?: { node?: { relativeUrl?: string; url?: string } }[] };
  specificationGroups?: {
    edges?: { node?: { name?: string; specifications?: { title?: string; value?: GqlSpecValue }[] } }[];
  };
  priceHistory?: {
    summary?: {
      type?: string;
      fluctuation?: { low?: GqlMoney; high?: GqlMoney };
    } | null;
    hasHistoryOlderThan3Months?: boolean;
  } | null;
}
