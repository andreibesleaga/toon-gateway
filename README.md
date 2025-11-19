# TOON Gateway 🚀

A high-performance NodeJS reverse proxy that transforms JSON responses into TOON format with Redis caching.

This could be deployed on-cloud and perform as a middleware layer to auto-transform responses from APIs which return JSON, to TOON formatted response.


## Features

- 🔄 **Automatic JSON to TOON transformation** using official reference implementation
- ✅ **100% TOON Spec v2.0 compliant** (340/340 tests passing)
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
- **Rate Limiting** - 100 requests per 15 minutes per IP
- **CORS** protection
- **Content Security Policy**
- **XSS Protection**

## Logging

Structured logging with Winston:
- Console output (colorized in development)
- File output in `logs/` directory
- Error tracking with stack traces
- Request/response logging

## Development

```bash
# Run with auto-reload
npm run dev

# Run TOON conformance tests
npm test

# Check syntax
node --check src/app.js

# Docker build
docker build -t toon-gateway .
```

## TOON Format Conformance

This gateway uses the official [@toon-format/toon](https://www.npmjs.com/package/@toon-format/toon) reference implementation and passes **100% of the TOON v2.0 specification tests**:

- **144/144 encode tests** (JSON → TOON)
- **196/196 decode tests** (TOON → JSON)
- **340/340 total tests passing**

Conformance testing validates:
- Primitive value encoding/decoding
- Object and array transformations
- Tabular array format for uniform objects
- List format for non-uniform structures
- Delimiter support (comma, tab, pipe)
- String quoting and escaping rules
- Key folding and path expansion
- Strict mode validation
- Whitespace handling

For more information about TOON format, see:
- [TOON Specification](https://github.com/toon-format/spec)
- [Reference Implementation](https://github.com/toon-format/toon)
- [Official Website](https://toonformat.dev)

## Production Checklist

- [ ] Update `.env` with production values
- [ ] Set `NODE_ENV=production`
- [ ] Configure Redis persistence if needed
- [ ] Set up monitoring and alerts
- [ ] Review rate limiting settings
- [ ] Enable HTTPS/TLS termination
- [ ] Configure log retention

## License

MIT

## Support

For issues and questions, please open an issue on the repository.
