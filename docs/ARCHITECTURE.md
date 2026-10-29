# Architecture

How the TOON Gateway is put together. For configuration and endpoints see the [README](../README.md); for hosting see [DEPLOYMENT.md](../DEPLOYMENT.md); for the security measures see [SECURITY.md](../SECURITY.md).

## System context

The gateway sits between a client and one fixed upstream API (`UPSTREAM_URL`). It returns the upstream's JSON as TOON and keeps successful responses in Redis. Redis is optional: without it the gateway still proxies and converts, uncached.

```mermaid
flowchart LR
    client["Client<br/>(browser, curl, LLM agent)"]
    gateway["TOON Gateway<br/>(Node.js, src/app.js)"]
    redis[("Redis cache<br/>(optional)")]
    upstream["Upstream JSON API<br/>(UPSTREAM_URL)"]

    client -->|HTTP request| gateway
    gateway -->|TOON response| client
    gateway <-->|"get / set, TTL CACHE_TTL"| redis
    gateway -->|"forwarded request (GET, HEAD, ...)"| upstream
    upstream -->|JSON response| gateway
```

## Modules

Each box is a file in `src/` (or a folder served by `src/landing.js`). `src/app.js` wires the others together; the order of `app.use` calls in it is the order a request passes through them.

```mermaid
flowchart TB
    subgraph app["src/app.js"]
        health["GET /health"]
        cachemw["cacheMiddleware"]
        proxy["proxy + handleProxyResponse"]
    end
    security["src/security.js<br/>headers, rate limits, request guards,<br/>cacheability rules, header scrubbing"]
    landing["src/landing.js<br/>GET /, /__gateway/info,<br/>POST /__gateway/encode, static assets"]
    cache["src/cache.js<br/>ioredis client, cache keys"]
    codec["src/toon-codec.js<br/>loads @toon-format/toon"]
    assets["views/ and public/<br/>templates and static files"]

    app --> security
    app --> landing
    app --> cache
    app --> codec
    landing --> codec
    landing --> assets
    cachemw --> cache
    proxy --> cache
    proxy --> codec
    proxy --> security
```

| File | Responsibility |
|---|---|
| `src/app.js` | Express app, logging (Winston, Morgan), `/health`, the cache middleware, the proxy and its response handler, error handler, graceful shutdown |
| `src/security.js` | Helmet headers and the Permissions-Policy, the three rate limiters, request guards (method allow-list, URL length, body size), the client-IP rule, what may be cached, which upstream headers are removed, `UPSTREAM_URL` validation |
| `src/landing.js` | The gateway's own endpoints under `/` and `/__gateway`: docs page (`views/index.html`, `views/usage.txt`), `GET /__gateway/info`, `POST /__gateway/encode`, `public/` assets |
| `src/cache.js` | The Redis connection, its connected/disconnected state, and the SHA-256 cache key |
| `src/toon-codec.js` | Loads the ESM-only `@toon-format/toon` once at startup; `encodeToToon` and `decodeFromToon` |
| `public/`, `views/` | Static assets (`landing.css`, `landing.js`, `favicon.svg`) and the two page templates |

## Request flow for a proxied GET

```mermaid
sequenceDiagram
    participant C as Client
    participant S as security.js (headers, guards, limiters)
    participant K as cacheMiddleware + cache.js
    participant P as proxy (app.js)
    participant U as Upstream
    participant T as toon-codec.js

    C->>S: GET /posts/1
    S-->>C: 405 / 414 / 413 / 429 when a guard or limit trips
    S->>K: request passes
    alt request carries credentials
        K->>P: X-Cache: BYPASS
    else Redis not connected
        K->>P: X-Cache: UNAVAILABLE
    else key found
        K-->>C: cached TOON, X-Cache: HIT
    else key not found
        K->>P: X-Cache: MISS
    end
    P->>U: forwarded request (without Accept-Encoding)
    U-->>P: response, buffered up to MAX_RESPONSE_BYTES
    P->>T: JSON body (decoded first if compressed)
    T-->>P: TOON text
    P->>K: store (status 200, shareable response, Redis connected)
    P-->>C: text/toon, upstream headers scrubbed, gateway security headers restored
```

Non-JSON responses pass through unchanged. Paths handled by the gateway itself (`/`, `/health`, `/robots.txt`, `/favicon.ico`, `/__gateway/...`) are never proxied or cached.
