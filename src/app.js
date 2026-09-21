require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const compression = require('compression');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const { redis, generateKey, isRedisConnected } = require('./cache');
const { initToon, encodeToToon } = require('./toon-codec');
const { createLanding, GATEWAY_PREFIX } = require('./landing');
const security = require('./security');
const winston = require('winston');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Logger Configuration
// Console is always on: container platforms (Railway, Docker, k8s) collect
// stdout/stderr. File logs are kept for local/dev runs, or when explicitly
// requested with LOG_TO_FILES=true.
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(IS_PRODUCTION ? {} : {
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

const LOG_TO_FILES = process.env.LOG_TO_FILES
    ? process.env.LOG_TO_FILES === 'true'
    : !IS_PRODUCTION;

if (LOG_TO_FILES) {
    const logDir = process.env.LOG_DIR || 'logs';
    try {
        fs.mkdirSync(logDir, { recursive: true });
        logger.add(new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }));
        logger.add(new winston.transports.File({ filename: path.join(logDir, 'combined.log') }));
    } catch (err) {
        logger.warn(`File logging disabled, cannot write to ${logDir}: ${err.message}`);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://jsonplaceholder.typicode.com';
security.validateUpstreamUrl(UPSTREAM_URL); // fail fast on a bad target
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '300', 10);

// Behind a platform edge proxy (Railway, a load balancer, nginx) the client IP
// arrives in X-Forwarded-For. Without this, rate limiting would count every
// visitor as the proxy's single IP. Set TRUST_PROXY=0 when exposed directly.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
    ? (/^\d+$/.test(process.env.TRUST_PROXY) ? parseInt(process.env.TRUST_PROXY, 10) : process.env.TRUST_PROXY)
    : 1;
app.set('trust proxy', TRUST_PROXY);

// Paths served by the gateway itself (never proxied or cached)
const isGatewayPath = (reqPath) =>
    reqPath === '/' ||
    reqPath === '/health' ||
    reqPath === '/robots.txt' ||
    reqPath === '/favicon.ico' ||
    reqPath === GATEWAY_PREFIX ||
    reqPath.startsWith(`${GATEWAY_PREFIX}/`);

// Security Middleware: headers, request guards, rate limits (see security.js)
app.use(security.securityHeaders());

// Rate Limiting: proxied traffic and the encode endpoint share one per-IP
// budget plus a burst guard; the docs page, its assets and the health check
// are exempt. The encode endpoint has an additional, tighter limit.
const ENCODE_PATH = `${GATEWAY_PREFIX}/encode`;
const isEncodePath = (req) => req.path === ENCODE_PATH;
app.use(security.requestGuards({ isGatewayPath, isEncodePath }));

const limiters = security.createLimiters({
    skip: (req) => isGatewayPath(req.path) && req.path !== ENCODE_PATH,
    isEncodePath
});

app.use(limiters.burst);
app.use(limiters.window);
app.use(limiters.encode);
// Log the same client address the rate limiter uses
morgan.token('remote-addr', (req) => security.clientIp(req));
app.use(morgan('combined', {
    stream: { write: message => logger.info(message.trim()) },
    // platform health probes would otherwise drown the request log
    skip: (req) => req.path === '/health'
}));
app.use(compression());

// Health Check Endpoint
// Redis is an optional cache: without it the gateway still proxies and
// transforms, so it reports "degraded" with HTTP 200 and stays in rotation.
// Use /health?strict=1 to get a 503 when Redis is unavailable.
app.get('/health', async (req, res) => {
    const redisUp = isRedisConnected();
    const health = {
        status: redisUp ? 'healthy' : 'degraded',
        uptime: process.uptime(),
        redis: redisUp ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    };

    const strict = req.query.strict === '1' || req.query.strict === 'true';
    const statusCode = !redisUp && strict ? 503 : 200;
    res.status(statusCode).json(health);
});

// Landing page, usage docs and gateway metadata
app.use(createLanding({
    upstreamUrl: UPSTREAM_URL,
    cacheTtl: CACHE_TTL,
    security: security.config,
    clientIp: security.clientIp,
    isRedisConnected
}));

// Cache Middleware
const cacheMiddleware = async (req, res, next) => {
    if (req.method !== 'GET') return next();
    
    // Skip cache for health check
    if (req.path === '/health') return next();

    // Requests carrying credentials get a response meant for that caller only
    if (!security.requestIsCacheable(req)) {
        res.setHeader('X-Cache', 'BYPASS');
        return next();
    }
    
    if (!isRedisConnected()) {
        logger.warn('Redis not connected, skipping cache check');
        res.setHeader('X-Cache', 'UNAVAILABLE');
        return next();
    }
    
    const key = generateKey(req);
    try {
        const cachedData = await redis.get(key);
        if (cachedData) {
            logger.debug(`Cache HIT for ${key}`);
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('Content-Type', 'text/toon; charset=utf-8');
            return res.send(cachedData);
        }
        logger.debug(`Cache MISS for ${key}`);
        res.setHeader('X-Cache', 'MISS');
        next();
    } catch (err) {
        logger.error('Cache retrieval error:', err);
        res.setHeader('X-Cache', 'ERROR');
        next();
    }
};

// Proxy Logic
// http-proxy-middleware v3+ takes event handlers under `on`; the legacy
// top-level onProxyRes/onError options are ignored, which with
// selfHandleResponse leaves every request hanging.
const transformResponse = responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    // Upstream headers were copied onto `res` just before this runs
    security.scrubResponseHeaders(res);

    const contentType = proxyRes.headers['content-type'];

    // Detect JSON
    if (contentType && contentType.includes('application/json')) {
        try {
            const rawBody = responseBuffer.toString('utf8');
            const jsonBody = JSON.parse(rawBody);

            logger.debug(`Transforming JSON response for ${req.originalUrl}`);

            // Convert
            const toonBody = encodeToToon(jsonBody);

            // Cache (only if Redis is connected and the response is shareable)
            if (res.statusCode === 200 && isRedisConnected() &&
                security.requestIsCacheable(req) && security.responseIsCacheable(proxyRes)) {
                try {
                    await redis.set(generateKey(req), toonBody, 'EX', CACHE_TTL);
                    logger.debug(`Cached response for ${generateKey(req)}`);
                } catch (cacheErr) {
                    logger.error('Failed to cache response:', cacheErr);
                }
            }

            res.setHeader('Content-Type', 'text/toon; charset=utf-8');
            res.removeHeader('content-length');
            res.removeHeader('etag');

            return toonBody;
        } catch (err) {
            logger.error('Transformation Failed:', err);
            return responseBuffer;
        }
    }
    return responseBuffer;
});

const rejectOversized = (proxyRes, req, res) => {
    proxyRes.destroy();
    if (res.headersSent) return res.destroy();
    logger.warn(`Upstream response over ${security.config.maxResponseBytes} bytes for ${req.originalUrl}`);
    return res.status(502).json({
        error: 'Bad Gateway',
        message: `Upstream response exceeds the ${security.config.maxResponseBytes} byte limit`
    });
};

const proxyOptions = {
    target: UPSTREAM_URL,
    changeOrigin: true,
    selfHandleResponse: true,
    proxyTimeout: security.config.upstreamTimeoutMs,
    timeout: security.config.upstreamTimeoutMs + 5000,
    on: {
        proxyReq: (proxyReq) => {
            // Ask for an uncompressed body so the size cap below measures the
            // real payload; the client still gets compression from this server.
            proxyReq.removeHeader('accept-encoding');
        },
        proxyRes: (proxyRes, req, res) => {
            // Responses are buffered in memory to be transformed: cap them
            const limit = security.config.maxResponseBytes;
            if (Number(proxyRes.headers['content-length']) > limit) {
                return rejectOversized(proxyRes, req, res);
            }
            let received = 0;
            proxyRes.on('data', (chunk) => {
                received += chunk.length;
                if (received > limit && !proxyRes.destroyed) rejectOversized(proxyRes, req, res);
            });
            return transformResponse(proxyRes, req, res);
        },
        error: (err, req, res) => {
            logger.error('Proxy Error:', err);
            // `res` is a raw socket for upgrade requests
            if (!res || typeof res.status !== 'function' || res.headersSent) {
                if (res && typeof res.destroy === 'function') res.destroy();
                return;
            }
            const timedOut = err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT');
            res.status(timedOut ? 504 : 502).json({
                error: timedOut ? 'Gateway Timeout' : 'Bad Gateway',
                message: 'Unable to reach upstream service'
            });
        }
    }
};

app.use('/', cacheMiddleware, createProxyMiddleware(proxyOptions));

// Error Handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: IS_PRODUCTION ? 'An error occurred' : err.message
    });
});

// Graceful Shutdown
let server;

const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    // Do not wait forever on keep-alive or stalled upstream connections
    const forceExit = setTimeout(() => {
        logger.warn('Forcing shutdown after timeout');
        process.exit(0);
    }, 10000);
    forceExit.unref();

    const finish = () => {
        logger.info('Server closed');
        redis.quit().catch(() => {}).finally(() => process.exit(0));
    };

    if (!server) return finish();
    server.close(finish);
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// The TOON reference implementation is ESM-only and loads asynchronously
initToon()
    .then(() => {
        server = app.listen(PORT, () => {
            logger.info(`TOON Gateway running on port ${PORT}`);
            logger.info(`Proxying to: ${UPSTREAM_URL}`);
            logger.info(`Cache TTL: ${CACHE_TTL}s`);
            logger.info(`Security: Helmet + Rate Limiting enabled (${security.config.rateLimitMax} req / ${Math.round(security.config.rateLimitWindowMs / 1000)}s, burst ${security.config.burstMax} / ${Math.round(security.config.burstWindowMs / 1000)}s per IP)`);
            logger.info(`Allowed methods: ${security.config.allowedMethods.join(', ')}`);
        });
        // Slow or stalled clients must not hold sockets open indefinitely
        server.headersTimeout = 15000;
        server.requestTimeout = 30000;
        server.keepAliveTimeout = 65000;
    })
    .catch((err) => {
        logger.error('Failed to load TOON codec:', err);
        process.exit(1);
    });
