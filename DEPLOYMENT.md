# Deployment

How the public instance is deployed on Railway, how to operate it, and how to run the gateway anywhere else.

## Live instance

| | |
|---|---|
| URL | https://toon-gateway.up.railway.app |
| Docs page + live converter | https://toon-gateway.up.railway.app/ |
| Health | https://toon-gateway.up.railway.app/health |
| Instance info | https://toon-gateway.up.railway.app/__gateway/info |
| Environment | `production` |
| Services | `toon-gateway` (this repo, built from the `Dockerfile`) and `Redis` (Railway managed, private network only) |
| Source repo | https://github.com/andreibesleaga/toon-gateway |

The instance uses `toon-gateway.up.railway.app`. The app never hard-codes its hostname (the docs page renders the host it is reached on), so the domain can be changed at any time:

```bash
railway domain list --service toon-gateway
railway domain update toon-gateway.up.railway.app --domain <new-label> --service toon-gateway
railway domain yourdomain.example --service toon-gateway     # custom domain, prints the DNS records to add
```

## Layout

```
Internet ──HTTPS──> Railway edge ──> toon-gateway (Node 22, port 3000)
                                          │  private network
                                          ├──> Redis  (REDIS_URL = ${{Redis.REDIS_URL}})
                                          └──> UPSTREAM_URL (https://jsonplaceholder.typicode.com)
```

Redis has no public endpoint. TLS terminates at the Railway edge; the app adds HSTS.

## Service variables

Set on the `toon-gateway` service. Everything not listed uses the defaults in the [README](README.md#configuration).

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | JSON logs on stdout, no error details in responses |
| `PORT` | `3000` | Must equal the domain's target port. Railway otherwise injects its own `PORT` and the domain answers 502 |
| `UPSTREAM_URL` | `https://jsonplaceholder.typicode.com` | The demo API this instance fronts |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | Reference to the Redis service, resolved by Railway; the password never lives in the repo |
| `CACHE_TTL` | `300` | |
| `LOG_LEVEL` | `info` | |
| `ALLOWED_METHODS` | `GET,HEAD,OPTIONS` | A public, unauthenticated proxy should be read-only. `POST /__gateway/encode` is unaffected |
| `CLIENT_IP_HEADER` | `x-real-ip` | Railway puts the real client address in `X-Real-IP` and overwrites anything the client sends. See [Client IP](#client-ip-and-rate-limiting) |
| `TRUST_PROXY` | `1` | Makes Express treat the connection as HTTPS behind the edge |

```bash
railway variable list --service toon-gateway
railway variable set CACHE_TTL=600 --service toon-gateway      # triggers a redeploy
```

To put the gateway in front of another API, change `UPSTREAM_URL` and, if that API needs writes, `ALLOWED_METHODS`.

Build and deploy settings live on the Railway service, not in a file: builder `DOCKERFILE`, healthcheck path `/health` (60 s timeout), restart policy `ON_FAILURE` with 10 retries. `railway.json` is deprecated by Railway (no longer read after 2026-12-01) and is intentionally absent.

## Deploying a new version

The service is deployed from a local checkout with the Railway CLI:

```bash
npm i -g @railway/cli && railway login
cd toon-gateway
railway link --project toon-gateway --environment production --service toon-gateway
railway up --service toon-gateway --detach -m "what changed"
railway deployment list --service toon-gateway      # wait for SUCCESS
curl https://toon-gateway.up.railway.app/health
```

A deployment only replaces the running one after `/health` answers 200, so a broken build never takes the site down.

To deploy automatically on every push to `main` instead, connect the repo once in the Railway dashboard: service `toon-gateway` → Settings → Source → Connect Repo → `andreibesleaga/toon-gateway`, branch `main`. Until the changes in this working tree are pushed, GitHub `main` is older than what is running.

## Operating

```bash
railway logs --service toon-gateway --lines 200          # runtime logs (JSON)
railway logs --service toon-gateway --build              # last build
railway deployment list --service toon-gateway           # history and status
railway redeploy --service toon-gateway                  # rebuild and restart the current version
railway metrics --service toon-gateway --since 1h        # CPU, memory, HTTP
```

Rollback: Railway dashboard → service → Deployments → a previous successful deployment → Redeploy.

Flush the cache (for example after changing `UPSTREAM_URL`): Railway dashboard → Redis → Data → delete the `toon_cache:*` keys, or wait `CACHE_TTL` seconds.

If Redis is down the gateway keeps serving uncached, `/health` reports `degraded` with HTTP 200 and responses carry `X-Cache: UNAVAILABLE`.

### Verifying a deployment

```bash
B=https://toon-gateway.up.railway.app
curl -s $B/health                                  # {"status":"healthy","redis":"connected",...}
curl -si "$B/todos?_limit=3" | grep -i x-cache     # MISS, then HIT on the second call
curl -s -X POST $B/__gateway/encode -H 'Content-Type: application/json' -d '[{"a":1},{"a":2}]'
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $B/posts/1      # 405 on the read-only instance
curl -s $B/__gateway/info | grep clientIp          # must be YOUR public IP, see below
```

### Client IP and rate limiting

Rate limits are per client IP, and behind a proxy the app only sees the proxy's address, so the real one has to come from a header. Get this wrong in one direction and every visitor shares a single bucket (one abuser locks everyone out); in the other, a client can forge its address and escape the limit.

On Railway, measured on this deployment (2026-09-21): the edge sends `X-Real-IP: <client>` and `X-Forwarded-For: <client>, <railway hop>`, and replaces whatever the client sent in either header. `TRUST_PROXY=1` alone therefore resolves to Railway's own hop, not the visitor. `CLIENT_IP_HEADER=x-real-ip` is the correct setting, and forged `X-Real-IP` / `X-Forwarded-For` values were confirmed to have no effect.

`GET /__gateway/info` returns `clientIp`, the address the limiter uses for the caller. It must equal your own public IP (`curl https://api.ipify.org`). If it does not, set `DEBUG_CLIENT_IP=true`, read the `debug` block in the same response to see the forwarding headers, fix `CLIENT_IP_HEADER` or `TRUST_PROXY`, then remove `DEBUG_CLIENT_IP`.

Only set `CLIENT_IP_HEADER` to a header your platform always overwrites. If clients can set it themselves, they can pick their own rate-limit bucket.

## Cost

Two small always-on services (Node app, Redis with a 5 GB volume) on Railway usage-based pricing. To stop paying for the demo: Railway dashboard → project `toon-gateway` → Settings → Delete project.

## Running elsewhere

Any host that runs a container works. The image listens on `PORT` (default 3000), runs as a non-root user and has a built-in `HEALTHCHECK`.

```bash
docker-compose up -d                       # gateway + Redis on http://localhost:3000

docker build -t toon-gateway .
docker run -p 3000:3000 \
  -e UPSTREAM_URL=https://api.example.com \
  -e REDIS_URL=redis://your-redis:6379 \
  toon-gateway
```

Without Docker: Node.js 20 or newer, `npm install --omit=dev`, `NODE_ENV=production node src/app.js`.

Behind your own reverse proxy or load balancer set `TRUST_PROXY` to the number of hops (or `CLIENT_IP_HEADER` to the header your proxy sets) and verify it with `clientIp` as above. Exposed directly to the internet, set `TRUST_PROXY=0`.
