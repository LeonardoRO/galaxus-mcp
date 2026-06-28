# galaxus-mcp

An **unofficial** [Model Context Protocol](https://modelcontextprotocol.io) server that lets
AI assistants (Claude, ChatGPT, and any other MCP client) search products and read product
details from [Galaxus](https://www.galaxus.ch) / [Digitec](https://www.digitec.ch).

> ⚠️ **Unofficial / use at your own risk.** Galaxus does not offer a public API. This server
> talks to the same internal GraphQL endpoints their website uses, so there's no stability
> guarantee: Galaxus can change the schema, rotate the persisted-query ids, or block traffic at
> any time. Respect their [Terms of Service](https://www.galaxus.ch/) and `robots.txt`, keep
> request volume low, and don't use this to resell their data. Provided as-is under the MIT
> license with no affiliation to Digitec Galaxus AG.

## Tools

| Tool | Description |
| --- | --- |
| `search_products` | Search the catalog by keyword. Returns name, brand, price (CHF), rating, availability, image, and URL, plus category facets and a `nextCursor` for paging. Supports `sort` (relevance/price_asc/price_desc/rating/newest) and `minPrice` / `maxPrice` / `brand` / `minRating` filters. |
| `get_product` | Full details for a single product by numeric id, slug, or full URL: description, GTIN, specifications, images, and **price history** (current position vs recent low/high). |
| `check_price_availability` | Lightweight price + stock snapshot (incl. price-history position) for one product. Handy for price tracking. |
| `compare_products` | Fetch full details for 2–8 products at once for side-by-side comparison. |
| `list_category` | Browse a category by name, sorted/filterable, with available-brand and product-type facets to help refine. |

## How it works

Galaxus's storefront is a Next.js + Relay app backed by a HotChocolate (.NET) GraphQL server.
Queries are *persisted*: the client sends a hash + variables, not the query text.

- **Search / category** → `POST /graphql/o/<searchQueryHash>/useSearchDataQuery`
- **Product / price** → `POST /graphql/o/<productQueryHash>/productDetailPageQuery`

Both require the headers `X-Dg-Portal` and `X-Dg-Language`. The product *HTML* pages are gated
behind a CAPTCHA for non-browser clients, but the GraphQL endpoint is not, so this server uses
GraphQL for every operation. Search uses `skipRedirect` so category-like terms still return a
product list, supports cursor pagination, and exposes the brand / product-type facets. Every
request goes through a small rate limiter, a short-lived response cache, and a timeout.

## Install

```bash
npm install
npm run build
```

## Use with Claude Code

```bash
claude mcp add galaxus -- node /absolute/path/to/galaxus_mcp/dist/index.js
```

## Use with Claude Desktop / other MCP clients

Add to your client's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "galaxus": {
      "command": "node",
      "args": ["/absolute/path/to/galaxus_mcp/dist/index.js"]
    }
  }
}
```

## Configuration (env vars)

| Variable | Default | Notes |
| --- | --- | --- |
| `GALAXUS_SITE` | `galaxus.ch` | `galaxus.ch`, `galaxus.de`, or `digitec.ch` |
| `GALAXUS_PORTAL` | per-site | `X-Dg-Portal` value (22 = galaxus.ch) |
| `GALAXUS_LANGUAGE` | per-site | `en`, `de`, `fr`, ... |
| `GALAXUS_SEARCH_HASH` | captured | persisted id for `useSearchDataQuery` |
| `GALAXUS_PRODUCT_HASH` | captured | persisted id for `productDetailPageQuery` |
| `GALAXUS_MIN_INTERVAL_MS` | `800` | min delay between requests |
| `GALAXUS_CACHE_TTL_MS` | `60000` | response cache TTL |
| `GALAXUS_TIMEOUT_MS` | `15000` | per-request timeout |
| `GALAXUS_USER_AGENT` | Chrome UA | sent with every request |

## Refreshing the persisted-query ids

If search or product calls start failing (e.g. after a Galaxus deploy), the persisted-query
hashes have likely rotated. To recapture them:

1. Open https://www.galaxus.ch in Chrome with DevTools → **Network**.
2. Search for something, then open a product page.
3. Find the requests to `/graphql/o/<hash>/useSearchDataQuery` and
   `/graphql/o/<hash>/productDetailPageQuery`.
4. Set `GALAXUS_SEARCH_HASH` / `GALAXUS_PRODUCT_HASH` to the new `<hash>` values.

## Project layout

```
src/
  index.ts            MCP server + tool registration
  config.ts           env-driven config (site, portal, hashes, rate limits)
  types.ts            normalized models + DataProvider interface
  http.ts             HTTP client (throttle + cache + timeout)
  providers/
    graphql.ts        internal-GraphQL provider
```

The tools talk to a `DataProvider` interface rather than the GraphQL client directly, so the
data source can be swapped out later if the internal API stops working.

## License

MIT
