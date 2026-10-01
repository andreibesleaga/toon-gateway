/**
 * Landing page, usage docs and the gateway's own small API.
 *
 * Everything the gateway serves itself lives at "/" or under GATEWAY_PREFIX so
 * it cannot collide with upstream API paths, which are proxied untouched.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { encodeToToon } = require('./toon-codec');
const pkg = require('../package.json');

const GATEWAY_PREFIX = '/__gateway';
const PUBLIC_DIR = path.join(__dirname, '..', 'public'); // static assets, served as-is
const VIEWS_DIR = path.join(__dirname, '..', 'views');   // templates, rendered per request
const REPO_URL = 'https://github.com/andreibesleaga/toon-gateway';
const MAX_ENCODE_BYTES = '256kb';
const DELIMITERS = { comma: ',', tab: '\t', pipe: '|' };

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function createLanding({ upstreamUrl, cacheTtl, security, clientIp, isRedisConnected }) {
    const router = express.Router();
    const windowMinutes = Math.round(security.rateLimitWindowMs / 60000);

    const info = () => ({
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        repository: REPO_URL,
        upstream: upstreamUrl,
        cacheTtlSeconds: cacheTtl,
        cache: isRedisConnected() ? 'connected' : 'disconnected',
        rateLimit: {
            max: security.rateLimitMax,
            windowSeconds: Math.round(security.rateLimitWindowMs / 1000),
            burstMax: security.burstMax,
            burstWindowSeconds: Math.round(security.burstWindowMs / 1000),
            encodeMax: security.encodeMax
        },
        limits: {
            allowedMethods: security.allowedMethods,
            maxUrlLength: security.maxUrlLength,
            maxRequestBytes: security.maxRequestBytes,
            maxResponseBytes: security.maxResponseBytes,
            upstreamTimeoutMs: security.upstreamTimeoutMs
        },
        endpoints: {
            docs: '/',
            health: '/health',
            info: `${GATEWAY_PREFIX}/info`,
            encode: `POST ${GATEWAY_PREFIX}/encode`,
            proxy: '/* (any other path is proxied to the upstream API)'
        }
    });

    // escape is identity for the plain-text variant
    const render = (template, req, escape) => {
        // Host is client-supplied: only echo it back when it looks like a hostname
        const host = /^[a-z0-9.-]+(:\d+)?$/i.test(req.get('host') || '') ? req.get('host') : 'localhost';
        const values = {
            ORIGIN: `${req.protocol}://${host}`,
            UPSTREAM_URL: upstreamUrl,
            CACHE_TTL: cacheTtl,
            RATE_LIMIT_MAX: security.rateLimitMax,
            RATE_LIMIT_WINDOW_MIN: windowMinutes,
            BURST_MAX: security.burstMax,
            BURST_WINDOW_SEC: Math.round(security.burstWindowMs / 1000),
            ENCODE_MAX: security.encodeMax,
            ALLOWED_METHODS: security.allowedMethods.join(', '),
            MAX_RESPONSE_MB: Math.round(security.maxResponseBytes / (1024 * 1024)),
            VERSION: pkg.version,
            REPO_URL,
            PREFIX: GATEWAY_PREFIX
        };
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
            (key in values ? escape(String(values[key])) : match));
    };

    const htmlTemplate = fs.readFileSync(path.join(VIEWS_DIR, 'index.html'), 'utf8');
    const textTemplate = fs.readFileSync(path.join(VIEWS_DIR, 'usage.txt'), 'utf8');

    // Browsers get the docs page; curl, scripts and agents get plain text
    router.get('/', (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Vary', 'Accept');
        // curl and most HTTP libraries send "Accept: */*"; only an explicit
        // text/html (what browsers send) gets the HTML page
        if (/text\/html/i.test(req.get('accept') || '')) {
            return res.type('html').send(render(htmlTemplate, req, escapeHtml));
        }
        return res.type('text/plain').send(render(textTemplate, req, (value) => value));
    });

    router.get('/robots.txt', (req, res) => {
        res.type('text/plain').send(`User-agent: *\nAllow: /$\nDisallow: /\n`);
    });

    router.get('/favicon.ico', (req, res) => res.redirect(301, `${GATEWAY_PREFIX}/favicon.svg`));

    // clientIp is the address rate limiting keys on: if it is not the caller's
    // own IP, CLIENT_IP_HEADER / TRUST_PROXY are wrong for this host.
    // DEBUG_CLIENT_IP=true adds the raw forwarding headers to work out why.
    router.get(`${GATEWAY_PREFIX}/info`, (req, res) => {
        const body = { ...info(), clientIp: clientIp(req) };
        if (process.env.DEBUG_CLIENT_IP === 'true') {
            body.debug = {
                remoteAddress: req.socket.remoteAddress,
                expressIp: req.ip,
                xForwardedFor: req.headers['x-forwarded-for'] || null,
                xRealIp: req.headers['x-real-ip'] || null
            };
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(body);
    });

    // JSON -> TOON conversion of a caller-supplied document.
    // Rate limited by the gateway-wide limiter in app.js (same per-IP budget as the proxy).
    router.post(
        `${GATEWAY_PREFIX}/encode`,
        // strict:false accepts any JSON value (arrays, strings, numbers), not only objects
        express.json({ limit: MAX_ENCODE_BYTES, strict: false, type: ['application/json', 'text/plain'] }),
        (req, res) => {
            const hasBody = req.headers['transfer-encoding'] !== undefined ||
                Number(req.headers['content-length']) > 0;
            if (!hasBody || req.body === undefined) {
                return res.status(400).json({ error: 'Bad Request', message: 'Send a JSON document as the request body.' });
            }

            const options = {};
            if (req.query.delimiter !== undefined) {
                const delimiter = DELIMITERS[req.query.delimiter];
                if (!delimiter) {
                    return res.status(400).json({ error: 'Bad Request', message: 'delimiter must be one of: comma, tab, pipe' });
                }
                options.delimiter = delimiter;
            }
            if (req.query.indent !== undefined) {
                const indent = Number(req.query.indent);
                if (!Number.isInteger(indent) || indent < 1 || indent > 8) {
                    return res.status(400).json({ error: 'Bad Request', message: 'indent must be an integer from 1 to 8' });
                }
                options.indent = indent;
            }
            // TOON v4 removed key folding; the library ignores the option, so a
            // request for it must fail rather than silently return unfolded output
            if (req.query.keyFolding !== undefined && req.query.keyFolding !== 'off') {
                return res.status(400).json({ error: 'Bad Request', message: 'keyFolding is not supported: key folding was removed in TOON v4' });
            }

            try {
                const toonBody = encodeToToon(req.body, options);
                res.setHeader('Cache-Control', 'no-store');
                return res.type('text/toon; charset=utf-8').send(toonBody);
            } catch (err) {
                return res.status(422).json({ error: 'Unprocessable Entity', message: err.message });
            }
        }
    );

    // Malformed or oversized bodies on the encode endpoint
    router.use(`${GATEWAY_PREFIX}/encode`, (err, req, res, next) => {
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ error: 'Payload Too Large', message: `Request body is limited to ${MAX_ENCODE_BYTES}.` });
        }
        if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
            return res.status(400).json({ error: 'Bad Request', message: `Invalid JSON: ${err.message}` });
        }
        return next(err);
    });

    router.all(`${GATEWAY_PREFIX}/encode`, (req, res) => {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ error: 'Method Not Allowed', message: 'Use POST with a JSON body.' });
    });

    router.use(GATEWAY_PREFIX, express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

    // Anything else under the reserved prefix is ours, not the upstream's
    router.use(GATEWAY_PREFIX, (req, res) => {
        res.status(404).json({ error: 'Not Found', message: `Unknown gateway endpoint. See ${GATEWAY_PREFIX}/info` });
    });

    return router;
}

module.exports = { createLanding, GATEWAY_PREFIX };
