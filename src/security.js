/**
 * Security policy for the gateway: response headers, rate limits, request
 * guards and the rules for what may be cached or passed through from the
 * upstream. Everything tunable is an environment variable with a safe default.
 */

const net = require('net');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const intEnv = (name, fallback) => {
    const value = parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const config = {
    rateLimitWindowMs: intEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    rateLimitMax: intEnv('RATE_LIMIT_MAX', 100),
    // Short-window limit that stops bursts long before the main budget is spent
    burstWindowMs: intEnv('RATE_LIMIT_BURST_WINDOW_MS', 60 * 1000),
    burstMax: intEnv('RATE_LIMIT_BURST_MAX', 30),
    // The encode endpoint does CPU work on caller-supplied data
    encodeMax: intEnv('ENCODE_RATE_LIMIT_MAX', 60),
    maxUrlLength: intEnv('MAX_URL_LENGTH', 2048),
    maxRequestBytes: intEnv('MAX_REQUEST_BYTES', 1024 * 1024),
    // Upstream responses are buffered in memory to be transformed
    maxResponseBytes: intEnv('MAX_RESPONSE_BYTES', 5 * 1024 * 1024),
    upstreamTimeoutMs: intEnv('UPSTREAM_TIMEOUT_MS', 15000),
    // Header the hosting platform sets to the real client address (for example
    // "x-real-ip" on Railway). Only safe when the platform always overwrites it;
    // otherwise clients could forge it. Unset: Express' req.ip (see TRUST_PROXY).
    clientIpHeader: (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
    allowedMethods: (process.env.ALLOWED_METHODS || 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS')
        .split(',').map(m => m.trim().toUpperCase()).filter(Boolean)
};

// Upstream response headers that must not reach the client: they either
// describe the upstream's infrastructure, or instruct the browser to act on
// *this* origin on the upstream's behalf (cookies, reporting, alt-svc, HSTS).
const STRIPPED_RESPONSE_HEADERS = [
    'set-cookie', 'set-cookie2',
    'server', 'via', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version',
    'nel', 'report-to', 'reporting-endpoints', 'alt-svc',
    'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only',
    'public-key-pins', 'expect-ct', 'x-frame-options',
    'access-control-allow-credentials',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
    'cf-ray', 'cf-cache-status', 'x-request-id', 'x-runtime'
];

const securityHeaders = () => [
    helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'none'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'"],
                connectSrc: ["'self'"],
                baseUri: ["'none'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
        frameguard: { action: 'deny' },
        referrerPolicy: { policy: 'no-referrer' },
        crossOriginOpenerPolicy: { policy: 'same-origin' },
        // API responses are meant to be fetched by other origins' agents and apps
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    }),
    (req, res, next) => {
        res.setHeader('Permissions-Policy',
            'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()');
        next();
    }
];

// The address rate limits are keyed on
const clientIp = (req) => {
    if (config.clientIpHeader) {
        const value = String(req.headers[config.clientIpHeader] || '').split(',')[0].trim();
        if (net.isIP(value)) return value;
    }
    return req.ip;
};

const tooMany = (req, res) => {
    res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many requests from this IP, please try again later.'
    });
};

const createLimiters = ({ skip, isEncodePath }) => ({
    // Main per-IP budget
    window: rateLimit({
        windowMs: config.rateLimitWindowMs,
        max: config.rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIp,
        skip,
        handler: tooMany
    }),
    // Burst guard; headers are left to the main limiter
    burst: rateLimit({
        windowMs: config.burstWindowMs,
        max: config.burstMax,
        standardHeaders: false,
        legacyHeaders: false,
        keyGenerator: clientIp,
        skip,
        handler: tooMany
    }),
    encode: rateLimit({
        windowMs: config.rateLimitWindowMs,
        max: config.encodeMax,
        standardHeaders: false,
        legacyHeaders: false,
        keyGenerator: clientIp,
        skip: (req) => !isEncodePath(req),
        handler: tooMany
    })
});

// Cheap rejections before any proxying, caching or parsing happens.
// ALLOWED_METHODS governs what is forwarded to the upstream; the gateway's own
// endpoints enforce their methods themselves (the encode endpoint needs POST
// even on a read-only gateway).
const requestGuards = ({ isGatewayPath, isEncodePath }) => (req, res, next) => {
    if (isGatewayPath(req.path)) {
        // Own pages are read-only and must never fall through to the proxy
        if (!isEncodePath(req) && req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            return res.status(405).json({ error: 'Method Not Allowed', message: 'Allowed methods: GET, HEAD' });
        }
    } else if (!config.allowedMethods.includes(req.method)) {
        res.setHeader('Allow', config.allowedMethods.join(', '));
        return res.status(405).json({ error: 'Method Not Allowed', message: `Allowed methods: ${config.allowedMethods.join(', ')}` });
    }
    if (req.originalUrl.length > config.maxUrlLength) {
        return res.status(414).json({ error: 'URI Too Long', message: `URLs are limited to ${config.maxUrlLength} characters.` });
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxRequestBytes) {
        return res.status(413).json({ error: 'Payload Too Large', message: `Request bodies are limited to ${config.maxRequestBytes} bytes.` });
    }
    return next();
};

// A response fetched with the caller's credentials belongs to that caller
// only; caching it under the URL would serve it to everyone else.
const requestIsCacheable = (req) =>
    req.method === 'GET' &&
    !req.headers.authorization &&
    !req.headers.cookie &&
    !req.headers['proxy-authorization'] &&
    !req.headers['x-api-key'];

const responseIsCacheable = (proxyRes) => {
    const cacheControl = String(proxyRes.headers['cache-control'] || '').toLowerCase();
    return !proxyRes.headers['set-cookie'] && !/\b(private|no-store)\b/.test(cacheControl);
};

const scrubResponseHeaders = (res) => {
    STRIPPED_RESPONSE_HEADERS.forEach(name => res.removeHeader(name));
};

const validateUpstreamUrl = (value) => {
    let url;
    try {
        url = new URL(value);
    } catch (err) {
        throw new Error(`UPSTREAM_URL is not a valid URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`UPSTREAM_URL must be http or https, got ${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new Error('UPSTREAM_URL must not contain credentials');
    }
    return url;
};

module.exports = {
    config,
    clientIp,
    securityHeaders,
    createLimiters,
    requestGuards,
    requestIsCacheable,
    responseIsCacheable,
    scrubResponseHeaders,
    validateUpstreamUrl
};
