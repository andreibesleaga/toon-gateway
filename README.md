# TOON Gateway

A NodeJS reverse proxy, with Redis caching, that transforms remote APIs JSON responses into TOON format.

This could be deployed on-cloud or embedded as part of an existing system, and perform as a middleware, transparent gateway, layer, to auto-transform responses from APIs requests which return JSON, to TOON formatted response, to be fetched real-time into existing AI architectures LLMs, or saved for further processing.

You can learn more about TOON at https://toonformat.dev/ (Token-Oriented Object Notation - a compact, human-readable encoding of the JSON data model for AI LLM prompts).

## Live demo

**https://toon-gateway.up.railway.app** - a public instance with a summary, the API docs and a live JSON → TOON converter that calls the gateway's own API. It proxies the [JSONPlaceholder](https://jsonplaceholder.typicode.com) demo API, read-only.

```bash
curl https://toon-gateway.up.railway.app/todos?_limit=3        # upstream JSON, returned as TOON
curl https://toon-gateway.up.railway.app/                      # plain-text usage summary (browsers get the docs page)
curl -X POST https://toon-gateway.up.railway.app/__gateway/encode \
  -H 'Content-Type: application/json' -d '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'
```


## Features

- 🔄 **Automatic JSON to TOON transformation** using official reference implementation
- ✅ **100% TOON Spec v4.1 compliant** (538/538 tests passing)
- ⚡ **Redis-based caching** for improved performance
- 🔒 **Security hardening** with Helmet and rate limiting
- 📊 **Comprehensive logging** with Winston
- 🐳 **Docker support** with docker-compose
- 💪 **Production-ready** with health checks and graceful shutdown

## Quick Start

### Prerequisites

- Node.js 20+, Docker
- Redis (included in docker-compose)

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp env.local .env
# Edit .env with your settings

# Run locally
npm start

# Or run in development mode with auto-reload
npm run dev
```

### Docker Deployment

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

## Configuration

Environment variables in `.env`:

| Variable       | Description            | Default                                |
|----------------|------------------------|----------------------------------------|
| `PORT`         | Server port            | `3000`                                 |
| `UPSTREAM_URL` | Backend API URL        | `https://jsonplaceholder.typicode.com` |
| `REDIS_URL`    | Redis connection URL   | `redis://redis-cache:6379`             |
| `CACHE_TTL`    | Cache TTL in seconds   | `300`                                  |
| `NODE_ENV`     | Environment (prod/dev) | `development`                          |
| `LOG_LEVEL`    | Logging level          | `info`                                 |
| `RATE_LIMIT_MAX` | Requests per IP per window | `100`                            |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window (ms) | `900000`                       |
| `RATE_LIMIT_BURST_MAX` | Requests per IP per burst window | `30`                 |
| `RATE_LIMIT_BURST_WINDOW_MS` | Burst window (ms) | `60000`                       |
| `ENCODE_RATE_LIMIT_MAX` | Conversions per IP per window on `/__gateway/encode` | `60` |
| `ALLOWED_METHODS` | Methods forwarded to the upstream; `GET,HEAD,OPTIONS` makes the gateway read-only | all standard methods |
| `MAX_URL_LENGTH` | Longest request URL accepted (414 above) | `2048`               |
| `MAX_REQUEST_BYTES` | Largest request body accepted (413 above) | `1048576`       |
| `MAX_RESPONSE_BYTES` | Largest upstream response buffered and transformed (502 above) | `5242880` |
| `UPSTREAM_TIMEOUT_MS` | Upstream timeout before a 504 | `15000`                   |
| `TRUST_PROXY` | Proxy hops trusted for the client IP (`X-Forwarded-For`). `1` behind a platform edge or load balancer, `0` when exposed directly | `1` |
| `CLIENT_IP_HEADER` | Header your platform sets to the real client IP (e.g. `x-real-ip` on Railway); rate limits key on it. Only use a header the platform always overwrites | unset (uses `TRUST_PROXY`) |
| `LOG_TO_FILES` | Also write `logs/*.log` | `true` in development, `false` in production |

`REDIS_URL` is optional: without Redis the gateway keeps proxying and transforming, uncached.

## API

### Proxy Endpoints

All requests are proxied to the upstream URL with JSON responses converted to TOON format.

**Example:**
```bash
curl http://localhost:3000/posts/1
```

**Response Headers:**
- `X-Cache: HIT` - Response served from cache
- `X-Cache: MISS` - Response fetched from upstream
- `X-Cache: BYPASS` - Request carried credentials (`Authorization`, `Cookie`, `X-API-Key`), shared cache not used
- `X-Cache: UNAVAILABLE` - Redis is down, response served uncached
- `Content-Type: text/toon; charset=utf-8`

### Health Check

**Endpoint:** `GET /health`

**Response:**
```json
{
  "status": "healthy",
  "uptime": 123.456,
  "redis": "connected",
  "timestamp": "2025-11-19T10:00:00.000Z"
}
```

When Redis is unreachable the gateway still serves requests (uncached), so `/health` answers `200` with `"status": "degraded"` and `"redis": "disconnected"`. Use `/health?strict=1` to get a `503` in that state.

### Gateway endpoints

The gateway's own endpoints live at `/` and under the reserved `/__gateway` prefix, so they cannot collide with upstream paths.

| Endpoint | Description |
|----------|-------------|
| `GET /` | Docs page with a live JSON → TOON converter. Clients that do not ask for `text/html` (curl, agents) get a plain-text usage summary |
| `POST /__gateway/encode` | Converts the JSON request body (max 256 KB) to TOON. Query options: `delimiter=comma\|tab\|pipe`, `indent=1..8` |
| `GET /__gateway/info` | Version, upstream, cache TTL, rate limits and limits of this instance (JSON) |

```bash
curl -X POST 'http://localhost:3000/__gateway/encode?delimiter=pipe' \
  -H 'Content-Type: application/json' \
  -d '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'
```

## TOON Format

The gateway converts JSON to TOON format:

**JSON:**
```json
[
  {"id": 1, "name": "Alice"},
  {"id": 2, "name": "Bob"}
]
```

**TOON:**
```
[2]{id,name}:
  1,Alice
  2,Bob
```

## Architecture

```
Client → TOON Gateway → Redis Cache
              ↓
         Upstream API
              ↓
      JSON → TOON Transform
```

## Security Features

- **Helmet.js** - Security headers
- **Rate Limiting** - 100 requests per 15 minutes per IP, plus a burst limit (30 per minute) and a tighter limit on the encode endpoint; all configurable
- **CORS** protection
- **Content Security Policy**
- **XSS Protection**
- **Strict CSP** - `default-src 'none'`, no inline scripts or styles, `frame-ancestors 'none'`, HSTS, `Permissions-Policy`
- **Cache isolation** - requests with credentials and upstream responses marked `private`/`no-store`/`Set-Cookie` are never stored in the shared cache
- **Upstream header scrubbing** - `Set-Cookie`, `Server`, `Via`, `X-Powered-By`, `NEL`/`Report-To`, `Alt-Svc` and similar are removed from proxied responses
- **Resource limits** - caps on URL length, request body and buffered upstream response size; upstream and client timeouts
- **Method allow-list** - `ALLOWED_METHODS` (set `GET,HEAD,OPTIONS` for a read-only gateway)
- **Container** - runs as a non-root user; `UPSTREAM_URL` is validated at startup

See [SECURITY.md](SECURITY.md) for the full list and how to report a vulnerability.

## Logging

Structured logging with Winston:
- Console output (colorized in development)
- File output in `logs/` directory (development; in production logs go to stdout as JSON, set `LOG_TO_FILES=true` to also write files)
- Error tracking with stack traces
- Request/response logging

## Development

```bash
# Run with auto-reload
npm run dev

# End-to-end tests (local stub upstream, no internet needed)
npm test
REDIS_URL=redis://localhost:6379 npm test   # also runs the cache tests

# Run TOON conformance tests (needs the spec repo, see below)
npm run test:conformance

# Check syntax
node --check src/app.js

# Docker build
docker build -t toon-gateway .
```

## CI/CD

GitHub Actions, each switchable without editing files:

| Workflow | Runs | What it does | Pause automatic runs | Run manually |
|---|---|---|---|---|
| [CI](.github/workflows/ci.yml) | Every push and pull request | End-to-end tests on Node 20/22/24 with Redis, `npm audit`, TOON spec conformance, Docker image build and health check | `gh variable set CI_ENABLED --body false` | `gh workflow run ci.yml` |
| [Deploy](.github/workflows/deploy.yml) | After CI passes on `main` | Deploys the tested commit to Railway, then checks the live health, version and encoder | `gh variable set AUTO_DEPLOY --body false` | `gh workflow run deploy.yml` (add `-f ref=<branch\|tag\|sha>` for another ref) |

CI is permissive by default: only the end-to-end tests on Node 22 (the production runtime) can fail it and block a deploy; Node 20/24, the audit, conformance and the Docker check report warnings. `gh variable set STRICT_CI --body true` makes every check blocking. Without the `RAILWAY_TOKEN` secret, automatic deploys skip with a notice instead of failing.

Undo any switch with `gh variable delete <NAME>`; turn a workflow off entirely with `gh workflow disable <file>` (and back on with `gh workflow enable <file>`). Setup of the `RAILWAY_TOKEN` secret: [DEPLOYMENT.md](DEPLOYMENT.md#automatic-deploys-github-actions).

## TOON Format Conformance

This gateway uses the official [@toon-format/toon](https://www.npmjs.com/package/@toon-format/toon) reference implementation and passes **100% of the TOON v4.1 specification tests** (`@toon-format/toon` 4.1.1 against the spec's `v4.1.1` fixtures):
If running tests, you need to have also downloaded the official spec with fixtures tests (https://github.com/toon-format/spec) into `../spec`, checked out at the tag the library targets: `git -C ../spec checkout v4.1.1` (or point `TOON_SPEC_DIR` at another checkout).

- **179/179 encode tests** (JSON → TOON)
- **359/359 decode tests** (TOON → JSON)
- **538/538 total tests passing**

Conformance testing validates:
- Primitive value encoding/decoding
- Object and array transformations
- Tabular array format for uniform objects, including nested field groups and keyed tabular objects
- List format for non-uniform structures
- Delimiter support (comma, tab, pipe)
- String quoting and escaping rules
- Comment lines
- Strict mode validation
- Whitespace handling

For more information about TOON format, see:
- [TOON Specification](https://github.com/toon-format/spec)
- [Reference Implementation](https://github.com/toon-format/toon)
- [Official Website](https://toonformat.dev)

## Deployment

[DEPLOYMENT.md](DEPLOYMENT.md) covers the live Railway deployment (project layout, variables, redeploying, domains, logs, rollback) and running the gateway on other hosts.

## Production Checklist

- [ ] Update `.env` with production values
- [ ] Set `NODE_ENV=production`
- [ ] Configure Redis persistence if needed
- [ ] Set up monitoring and alerts
- [ ] Review rate limiting settings
- [ ] Enable HTTPS/TLS termination
- [ ] Configure log retention

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT

## Support

For issues and questions, please open an issue on the repository.
