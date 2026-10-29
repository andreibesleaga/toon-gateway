# AGENTS.md

Short guide for people and coding agents working in this repository. The [README](README.md) is the main reference; this file only points to it and lists the rules that are easy to miss.

## What this is

A Node.js reverse proxy (Express) that converts the JSON responses of one upstream API into TOON, with an optional Redis cache. Version in `package.json`; history in [CHANGELOG.md](CHANGELOG.md).

## Layout

| Path | Contents |
|---|---|
| `src/` | The application: `app.js` (wiring, proxy, cache middleware), `security.js`, `landing.js`, `cache.js`, `toon-codec.js` |
| `public/`, `views/` | Static assets and page templates of the docs page |
| `test/gateway.test.js` | End-to-end tests against a local stub upstream |
| `test-conformance.js` | TOON spec conformance runner |
| `.github/workflows/` | `ci.yml` and `deploy.yml` (explained in the README, section CI/CD) |
| `docs/ARCHITECTURE.md` | Diagrams of the system, modules and request flow |

## Commands

```bash
npm ci                         # install from the lock file
npm test                       # end-to-end tests; cache tests are skipped without REDIS_URL
REDIS_URL=redis://localhost:6379 npm test   # also runs the cache tests
TOON_SPEC_DIR=<path to a toon-format/spec checkout at the tag the library targets> npm run test:conformance
npm start                      # run (copy env.local to .env first)
```

## Rules

- Everything the gateway serves itself lives at `/` or under `/__gateway`, so it cannot collide with upstream paths. Keep it that way.
- The upstream is fixed by `UPSTREAM_URL`; no request parameter may change it.
- A new environment variable goes into the configuration table in the README and, when it affects hosting, into [DEPLOYMENT.md](DEPLOYMENT.md).
- A change to a security measure goes into [SECURITY.md](SECURITY.md) in the same change.
- Tests do not use the internet; the only network use is the conformance run, which needs a local copy of the spec.
- Do not commit `.env`, `logs/` or `node_modules/`.
