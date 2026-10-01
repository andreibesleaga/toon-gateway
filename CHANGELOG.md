# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/).

## 1.1.1 - 2026-10-01

### Fixed
- Proxied responses were missing the gateway's own security headers (HSTS, CSP, `X-Frame-Options`), and an upstream could override others such as `Referrer-Policy`. The gateway's headers now always win.
- An upstream response over `MAX_RESPONSE_BYTES` sent without `Content-Length` (streamed) crashed the gateway process. Upstream bodies are now buffered by the gateway itself with the cap enforced while streaming.
- `429` responses from the burst and encode limiters had no `Retry-After`.
- An upstream's own `X-Cache` header replaced the gateway's.

### Added
- Compressed upstream bodies (gzip, deflate, br) are decoded before conversion, with the decompressed size capped.
- End-to-end test suite (`npm test`) against a local stub upstream; the conformance runner moved to `npm run test:conformance` and accepts `TOON_SPEC_DIR`.
- GitHub Actions: CI on every push and pull request (tests on Node 20/22/24 with Redis, audit, spec conformance, Docker image check) and Deploy to Railway after CI passes on `main`. Permissive by default (only the Node 22 tests block; `STRICT_CI=true` makes every check blocking), automatic runs pausable with `CI_ENABLED=false` / `AUTO_DEPLOY=false`, both runnable by hand, deploy of any ref on demand, and deploys skip cleanly until `RAILWAY_TOKEN` is set. Dependabot updates for the actions.

## 1.1.0 - 2026-10-01

Live at https://toon-gateway.up.railway.app.

### Added
- Docs landing page at `/` with a live JSON → TOON converter and a proxy tester; non-browser clients get a plain-text usage summary.
- `POST /__gateway/encode` to convert a JSON body to TOON (`delimiter`, `indent` options) and `GET /__gateway/info` for instance metadata.
- Security hardening: strict CSP and security headers, burst and encode-specific rate limits, method allow-list, URL/body/response size caps, upstream and client timeouts, credential-aware caching, upstream header scrubbing, non-root container. See [SECURITY.md](SECURITY.md).
- Configuration: `RATE_LIMIT_*`, `ENCODE_RATE_LIMIT_MAX`, `ALLOWED_METHODS`, `MAX_*`, `UPSTREAM_TIMEOUT_MS`, `CLIENT_IP_HEADER`, `TRUST_PROXY`, `LOG_TO_FILES`.
- [DEPLOYMENT.md](DEPLOYMENT.md) (Railway and other hosts) and [SECURITY.md](SECURITY.md).

### Changed
- `@toon-format/toon` 1.4.0 → 4.1.1 (TOON spec v4.1, 538/538 conformance tests). Rows with nested objects and objects of uniform objects now encode as tables, so many API responses get smaller. Key folding was removed by TOON v4.
- `/health` returns 200 with `"status": "degraded"` when Redis is down (the gateway keeps serving uncached); `?strict=1` restores the 503.
- Production logs go to stdout as JSON; file logs are for development or `LOG_TO_FILES=true`.
- Docker image on Node 22, `npm ci`, with a health check; `package-lock.json` is committed.

### Fixed
- Proxied requests hung and were never transformed: `http-proxy-middleware` v4 ignores the old `onProxyRes`/`onError` options.
- Startup crash on Node 20: the ESM-only TOON library is now loaded with `import()`.
- Rate limiting counted every client behind a proxy as one IP.

### Security
- Fixes GHSA-p95v-992w-h6c3 (prototype pollution when decoding TOON) by upgrading `@toon-format/toon`.

## 1.0.0

Initial release: reverse proxy converting JSON API responses to TOON, with Redis caching, Helmet and rate limiting.
