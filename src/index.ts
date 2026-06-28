#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { GraphQLProvider } from "./providers/graphql.js";
import { SearchFiltersSchema, SortOrderSchema, type DataProvider } from "./types.js";

const config = loadConfig();
const provider: DataProvider = new GraphQLProvider(config);

const server = new McpServer({ name: "galaxus-mcp", version: "0.1.0" });

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const sortDescription =
  "Sort order: relevance (default), price_asc, price_desc, rating, newest";

server.registerTool(
  "search_products",
  {
    title: "Search Galaxus products",
    description:
      "Search the Galaxus / Digitec catalog by keyword. Returns matching products with price (CHF), rating, availability, and URL, plus a nextCursor for pagination.",
    inputSchema: {
      query: z.string().min(1).describe("Search keywords, e.g. 'nvme ssd 2tb'"),
      sort: SortOrderSchema.optional().describe(sortDescription),
      minPrice: z.number().optional().describe("Minimum price in CHF"),
      maxPrice: z.number().optional().describe("Maximum price in CHF"),
      brand: z.string().optional().describe("Filter to an exact brand name"),
      minRating: z.number().optional().describe("Minimum average rating (0-5)"),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional().describe("nextCursor from a previous result, to page further"),
    },
  },
  async ({ query, ...rest }) => {
    const filters = SearchFiltersSchema.parse(rest);
    return json(await provider.searchProducts(query, filters));
  },
);

server.registerTool(
  "get_product",
  {
    title: "Get Galaxus product details",
    description:
      "Fetch full details for a single product by its numeric id, slug, or full product URL: description, GTIN, specifications, images, rating, availability, and price history.",
    inputSchema: {
      idOrUrl: z.string().min(1).describe("Galaxus product id, slug, or full product URL"),
    },
  },
  async ({ idOrUrl }) => json(await provider.getProduct(idOrUrl)),
);

server.registerTool(
  "check_price_availability",
  {
    title: "Check price & availability",
    description:
      "Lightweight price + stock snapshot for one product (id, slug, or URL), including price-history position (whether the current price is low/high vs the recent range). Ideal for price tracking.",
    inputSchema: {
      idOrUrl: z.string().min(1).describe("Galaxus product id, slug, or full product URL"),
    },
  },
  async ({ idOrUrl }) => json(await provider.getPriceSnapshot(idOrUrl)),
);

server.registerTool(
  "compare_products",
  {
    title: "Compare Galaxus products",
    description:
      "Fetch full details for several products at once (by id, slug, or URL) for side-by-side comparison. Returns one detail object per input.",
    inputSchema: {
      idsOrUrls: z
        .array(z.string().min(1))
        .min(2)
        .max(8)
        .describe("2-8 product ids, slugs, or URLs to compare"),
    },
  },
  async ({ idsOrUrls }) => {
    const results = await Promise.all(
      idsOrUrls.map(async (ref) => {
        try {
          return { ref, product: await provider.getProduct(ref) };
        } catch (err) {
          return { ref, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return json(results);
  },
);

server.registerTool(
  "list_category",
  {
    title: "Browse a Galaxus category",
    description:
      "Browse products in a category by name (e.g. 'ssd', 'office chair'), sorted and filterable. Returns products plus facets (available brands and product types) to help refine, and a nextCursor for paging.",
    inputSchema: {
      category: z.string().min(1).describe("Category or product-type name, e.g. 'mechanical keyboard'"),
      sort: SortOrderSchema.optional().describe(sortDescription),
      minPrice: z.number().optional().describe("Minimum price in CHF"),
      maxPrice: z.number().optional().describe("Maximum price in CHF"),
      brand: z.string().optional().describe("Filter to an exact brand name"),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.string().optional().describe("nextCursor from a previous result, to page further"),
    },
  },
  async ({ category, ...rest }) => {
    const filters = SearchFiltersSchema.parse({ ...rest, sort: rest.sort ?? "relevance" });
    const result = await provider.searchProducts(category, filters);
    return json({
      category,
      total: result.total,
      brands: result.facets.brands,
      productTypes: result.facets.productTypes,
      nextCursor: result.nextCursor,
      products: result.products,
    });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`galaxus-mcp running (site=${config.site}, provider=${provider.name})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
