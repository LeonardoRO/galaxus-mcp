import { z } from "zod";

// Normalized models the tools work with. The provider maps raw GraphQL
// payloads into these so the rest of the code doesn't care about the wire format.

export const MoneySchema = z.object({
  amount: z.number(),
  currency: z.string().default("CHF"),
});
export type Money = z.infer<typeof MoneySchema>;

export const ProductSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string().nullable().optional(),
  url: z.string().url(),
  price: MoneySchema.nullable().optional(),
  rating: z.number().nullable().optional(),
  ratingCount: z.number().nullable().optional(),
  availability: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const PriceHistorySchema = z.object({
  // where the current price sits vs the recent range: "LOW" / "HIGH" / "AVERAGE"
  position: z.string().nullable().optional(),
  low: MoneySchema.nullable().optional(),
  high: MoneySchema.nullable().optional(),
  hasHistoryOlderThan3Months: z.boolean().optional(),
});
export type PriceHistory = z.infer<typeof PriceHistorySchema>;

export const ProductDetailSchema = ProductSummarySchema.extend({
  description: z.string().nullable().optional(),
  gtin: z.string().nullable().optional(),
  specifications: z.record(z.string(), z.string()).default({}),
  images: z.array(z.string().url()).default([]),
  priceHistory: PriceHistorySchema.nullable().optional(),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

/** Friendly sort keys, mapped to the API's ShopSearchSortOrder enum by the provider. */
export const SortOrderSchema = z
  .enum(["relevance", "price_asc", "price_desc", "rating", "newest"])
  .default("relevance");
export type SortOrder = z.infer<typeof SortOrderSchema>;

export const SearchFiltersSchema = z.object({
  sort: SortOrderSchema.optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  brand: z.string().optional(),
  minRating: z.number().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  /** Opaque pagination cursor from a previous result's `nextCursor`. */
  cursor: z.string().optional(),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

// small price/stock view, for tracking without pulling the whole product
export interface PriceSnapshot {
  id: string;
  name: string;
  url: string;
  price: Money | null;
  availability: string | null;
  priceHistory: PriceHistory | null;
}

export interface CategoryFacets {
  /** If the query maps to a category page, its relative URL. */
  redirectionUrl: string | null;
  brands: string[];
  productTypes: string[];
}

export interface SearchResult {
  products: ProductSummary[];
  total: number | null;
  nextCursor: string | null;
  facets: CategoryFacets;
}

export type Site = "galaxus.ch" | "galaxus.de" | "digitec.ch";

// kept as an interface so the data source can be swapped later if the internal
// API stops being usable. GraphQLProvider is the only implementation right now.
export interface DataProvider {
  readonly name: string;
  searchProducts(query: string, filters: SearchFilters): Promise<SearchResult>;
  getProduct(idOrUrl: string): Promise<ProductDetail>;
  getPriceSnapshot(idOrUrl: string): Promise<PriceSnapshot>;
}
