# @abliteration/mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents - Claude Code, Claude Desktop, Cursor, Windsurf and any other MCP host - direct access to the [abliteration.org public API](https://abliteration.org/api). Your agent can search the catalog of abliterated and uncensored LLMs, read the M-code method taxonomy, look up authors, datasets and indices, and follow the change streams Hugging Face doesn't offer: delisted models, the 24-month deletion record, README drift history and download anomalies. Every call is billed in credits from your abliteration.org wallet, and every result starts with a `cost: 5 cr · balance: 704 cr` line, so the agent can tell you what it spent.

You need an API key from [abliteration.org/api](https://abliteration.org/api). The key looks like `abl_live_...`.

## Install

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "abliteration": {
      "command": "npx",
      "args": ["-y", "@abliteration/mcp"],
      "env": {
        "ABLITERATION_API_KEY": "abl_live_..."
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add abliteration -e ABLITERATION_API_KEY=abl_live_... -- npx -y @abliteration/mcp
```

### Cursor

Add this to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "abliteration": {
      "command": "npx",
      "args": ["-y", "@abliteration/mcp"],
      "env": {
        "ABLITERATION_API_KEY": "abl_live_..."
      }
    }
  }
}
```

### Windsurf

Add this to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "abliteration": {
      "command": "npx",
      "args": ["-y", "@abliteration/mcp"],
      "env": {
        "ABLITERATION_API_KEY": "abl_live_..."
      }
    }
  }
}
```

You can pass the key as `"args": ["-y", "@abliteration/mcp", "--api-key", "abl_live_..."]` instead of using `env`. The flag wins if both are set.

## Tools

Each tool maps to one API route and takes that route's query parameters, with the same names. The credit cost is listed in each tool's description, so the agent sees it before calling.

### Catalog

| Tool | Route | What it does |
|---|---|---|
| `search_models` | `GET /models` | Search models by method, family, author, license, download range, creation date or delisted state. |
| `get_model` | `GET /models/{id}` | Get the full record for one model, including classification evidence, files, benchmarks and README. |
| `list_methods` | `GET /methods` | List the M-code taxonomy of uncensoring methods, with counts. |
| `get_method` | `GET /methods/{id}` | Get one M-code with its top authors and sample models. |
| `list_authors` | `GET /authors` | List model publishers with model, download and like totals. |
| `get_author` | `GET /authors/{id}` | Get one publisher and their top models. |
| `search_datasets` | `GET /datasets` | Search alignment and uncensoring datasets by category, author or license. |
| `get_dataset` | `GET /datasets/{id}` | Get one dataset with its files and passport. |
| `list_indices` | `GET /indices` | Get all four flagship indices: DAI, Freedom Velocity, Weaponization and F2W Latency. |
| `get_index` | `GET /indices/{id}` | Get one index with its history. |
| `get_timeline` | `GET /timeline` | List curated field events: delistings, takedowns and notable releases. |

### Change streams

| Tool | Route | What it does |
|---|---|---|
| `list_delisted` | `GET /models/delisted` | List models Hugging Face no longer serves. Poll with `since` to get only new removals. |
| `get_deletions_summary` | `GET /models/historical-deletions/summary` | Summarize 24 months of deletions: deletion rate, average lifespan, monthly losses and top casualties. |
| `list_deletions` | `GET /models/historical-deletions/list` | Page through the 24-month deletion record. Filter with `since_month` or `min_peak_downloads`. |
| `list_readme_drifts` | `GET /models/{id}/drifts` | List every README commit for one model with its size delta. Poll with `since_ts`. |
| `get_readme_at` | `GET /models/{id}/readme-at/{commit}` | Get a model's README as it was at one commit. |
| `get_download_anomalies` | `GET /market/anomalies` | List models whose downloads spiked or dropped against a baseline window. |
| `get_download_history` | `GET /models/{id}/download-history` | Get the download timeline for one model. |

Every result has a cost line, then the server's full JSON envelope:

```
cost: 5 cr · balance: 704 cr

{
  "data": [ ... ],
  "cost": 5,
  "credits_remaining": 704,
  "rate_limit_limit": ...,
  "rate_limit_remaining": ...,
  "rate_limit_reset": ...,
  "metering": "billed",
  "request_id": "..."
}
```

## Pricing

The tools spend the same credit wallet as the abliteration.org Research Agent. Most routes cost 1-20 credits. `get_timeline` costs 50 credits. `search_models` gets more expensive for large pages and deep offsets. For the full terms, see [abliteration.org/terms](https://abliteration.org/terms), section 7 ("Credits and payments"). For the per-route price table, see [abliteration.org/api](https://abliteration.org/api#pricing).

## Troubleshooting

**"Invalid or missing ABLITERATION_API_KEY"**: the key is missing, mistyped or revoked. Check the `env` block in your host config, then restart the host. The server still starts without a key, but every tool call returns this message.

**"Out of credits"**: the call costs more credits than your balance. Top up at [abliteration.org/shop/pricing](https://abliteration.org/shop/pricing). The welcome credits you get at signup work only with the Research Agent, not with the API.

**Pointing at a local or staging server**: set `ABLITERATION_API_BASE`:

```json
"env": {
  "ABLITERATION_API_KEY": "abl_test_...",
  "ABLITERATION_API_BASE": "http://localhost:4321/api/v1"
}
```

The bare host (`http://localhost:4321`) also works. That's the form the `abl` CLI uses, and `/api/v1` is added for you.

**Debug logging**: set `DEBUG=abl:*`. Every request, status and timing is logged to stderr, which MCP hosts write to their server log. To log only HTTP traffic, use `DEBUG=abl:http`. Logging never goes to stdout, because stdout carries the MCP protocol.

**Checking the server end to end** (from a checkout, in `mcp/`):

```sh
npm install
npm run build
ABLITERATION_API_KEY=abl_live_... node scripts/smoke.mjs   # one live list_methods call, 5 credits
node scripts/smoke.mjs --offline                           # handshake and tool list only, no key needed
```

## License

MIT © Catyonic OÜ
