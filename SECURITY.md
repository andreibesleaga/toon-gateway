# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: https://github.com/andreibesleaga/toon-gateway/security/advisories/new. Do not open a public issue for a vulnerability. You should get a reply within a few days.

## What the gateway does

| Area | Measure |
|---|---|
| Response headers | Applied to every response, including proxied ones, where they override whatever the upstream sent. Helmet with a strict CSP (`default-src 'none'`, scripts, styles, images and connections from `'self'` only, no inline code, `base-uri 'none'`, `frame-ancestors 'none'`), HSTS for one year, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a deny-all `Permissions-Policy`, no `X-Powered-By` |
| Rate limiting | Per client IP: a window budget (`RATE_LIMIT_MAX`, 100 per 15 min), a burst guard (`RATE_LIMIT_BURST_MAX`, 30 per minute) and a separate limit on the CPU-bound encode endpoint (`ENCODE_RATE_LIMIT_MAX`, 60 per window). Every `429` carries `Retry-After`. The docs page and `/health` are exempt so monitoring cannot lock anyone out |
| Client IP | `CLIENT_IP_HEADER` (a platform-set header such as `X-Real-IP`) or `TRUST_PROXY` (hop count for `X-Forwarded-For`) decide which address limits are keyed on, so they apply to the real client and cannot be bypassed by forging a header. `/__gateway/info` reports the address in use; verified against forged headers on the live deployment |
| Fixed upstream | The target is `UPSTREAM_URL` only, validated at startup (http/https, no embedded credentials). No request parameter can change it, so the gateway cannot be used to reach arbitrary hosts (SSRF) |
| Method allow-list | `ALLOWED_METHODS`; `GET,HEAD,OPTIONS` makes a public gateway read-only. The gateway's own pages accept only `GET`/`HEAD`, and unknown paths under `/__gateway` are never forwarded |
| Resource limits | URL length (`MAX_URL_LENGTH`), request body (`MAX_REQUEST_BYTES`), encode body (256 KB) and buffered upstream response (`MAX_RESPONSE_BYTES`, enforced while the response streams in, and again on the decompressed size if an upstream sends a compressed body anyway, so a compression bomb cannot expand past it). Upstream timeout (`UPSTREAM_TIMEOUT_MS`) and server header, request and keep-alive timeouts against slow clients |
| Shared cache | Requests carrying `Authorization`, `Cookie`, `Proxy-Authorization` or `X-API-Key` are neither served from nor written to the cache (`X-Cache: BYPASS`). Upstream responses with `Set-Cookie` or `Cache-Control: private`/`no-store` are not cached. Cache keys are SHA-256 hashes, so clients cannot choose key names |
| Upstream headers | `Set-Cookie`, `Server`, `Via`, `X-Powered-By`, `NEL`, `Report-To`, `Reporting-Endpoints`, `Alt-Svc`, and the upstream's own HSTS, CSP and frame policy are removed from proxied responses, so the upstream cannot set cookies, enable reporting or change transport policy on the gateway's origin |
| Errors | In production, responses never include stack traces or internal messages |
| Container | Non-root user, production dependencies only, image health check |
| Dependencies | `npm audit` reports no known vulnerabilities and CI fails on any high-severity advisory; Dependabot security updates are enabled and Dependabot keeps the CI actions current |
| Tests | CI runs an end-to-end suite against a local stub upstream covering these measures (headers, limits, cache isolation, header scrubbing, timeouts, size caps) on every push and pull request |

## What it does not do

- **No authentication.** Anyone who can reach the gateway can use it. Put it behind your own auth or a private network when the upstream is not public.
- **Rate-limit state is in memory**, per process. It resets on restart and is not shared between replicas; with several replicas, move the limiter to a shared store.
- **Query strings are logged** with the request line. Do not pass secrets in URLs.
- **Forwarded credentials reach the upstream.** `Authorization` and similar request headers are passed through unchanged, which is what a gateway in front of your own API needs.
