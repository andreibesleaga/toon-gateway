/**
 * End-to-end tests: real gateway processes in front of a local stub upstream.
 * No internet access is needed. Redis is optional: set REDIS_URL to run the
 * cache tests (REQUIRE_REDIS=1 makes a missing Redis a failure, as in CI).
 *
 *   npm test
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');

const APP = path.join(__dirname, '..', 'src', 'app.js');
const RUN = `${process.pid}-${Date.now()}`; // keeps cache keys unique per run
const REDIS_URL = process.env.REDIS_URL || '';
const needsRedis = { skip: REDIS_URL ? false : 'REDIS_URL not set' };

if (!REDIS_URL && process.env.REQUIRE_REDIS === '1') {
    throw new Error('REQUIRE_REDIS=1 but REDIS_URL is not set');
}

// ---------- helpers ----------

const freePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
    });
});

function request(base, urlPath, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, base);
        const req = http.request(url, { method, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error(`timeout: ${method} ${urlPath}`)));
        if (body !== undefined) req.write(body);
        req.end();
    });
}

const postJson = (base, urlPath, value, extraHeaders = {}) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    return request(base, urlPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders },
        body
    });
};

async function startGateway(env) {
    const port = await freePort();
    const child = spawn(process.execPath, [APP], {
        env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            LOG_LEVEL: 'error',
            LOG_TO_FILES: 'false',
            PORT: String(port),
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`gateway exited early:\n${output}`);
        try {
            const res = await request(base, '/health');
            // an instance pointed at the real Redis must also have connected to it
            const redisReady = !(REDIS_URL && env.REDIS_URL === REDIS_URL) || JSON.parse(res.body).redis === 'connected';
            if (res.status === 200 && redisReady) break;
        } catch (err) { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error(`gateway did not become ready:\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
    }
    return { base, child, output: () => output };
}

const stopGateway = (gw) => new Promise((resolve) => {
    if (!gw || gw.child.exitCode !== null) return resolve(gw && gw.child.exitCode);
    gw.child.once('exit', (code) => resolve(code));
    gw.child.kill('SIGTERM');
});

// ---------- stub upstream ----------

const hits = {};
const received = {};
const todos = [
    { userId: 1, id: 1, title: 'one', completed: false },
    { userId: 1, id: 2, title: 'two', completed: true }
];

const upstream = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://stub');
    hits[pathname] = (hits[pathname] || 0) + 1;
    received[pathname] = req.headers;
    const json = (status, value, headers = {}) => {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
        res.end(body);
    };
    if (pathname.startsWith('/todos')) return json(200, todos);
    if (pathname === '/nested') return json(200, [{ id: 1, geo: { lat: 1.5, lng: 2.5 } }, { id: 2, geo: { lat: 3, lng: 4 } }]);
    if (pathname === '/leaky') {
        return json(200, { ok: true }, {
            'set-cookie': 'session=secret; Path=/',
            server: 'upstream-server/1.0',
            via: '1.1 upstream-proxy',
            'x-powered-by': 'UpstreamFramework',
            nel: '{"report_to":"x"}',
            'report-to': '{"group":"x"}',
            'alt-svc': 'h3=":443"',
            'strict-transport-security': 'max-age=1',
            'content-security-policy': 'default-src *',
            'x-frame-options': 'ALLOWALL',
            'referrer-policy': 'unsafe-url',
            'x-upstream-custom': 'kept'
        });
    }
    if (pathname.startsWith('/private')) return json(200, { secret: 1 }, { 'cache-control': 'private' });
    if (pathname === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('plain upstream text');
    }
    if (pathname === '/echo-headers') return json(200, { ok: true });
    if (pathname === '/big') return json(200, { data: 'x'.repeat(5000) });
    if (pathname === '/big-stream') {
        res.writeHead(200, { 'content-type': 'application/json' }); // chunked, no length
        res.write('{"data":"');
        for (let i = 0; i < 10; i++) res.write('y'.repeat(500));
        return res.end('"}');
    }
    if (pathname === '/gzip') {
        const body = zlib.gzipSync(JSON.stringify([{ a: 1 }, { a: 2 }])); // ignores the identity request
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length });
        return res.end(body);
    }
    if (pathname === '/bomb') {
        const body = zlib.gzipSync(JSON.stringify({ d: 'z'.repeat(200000) })); // ~200 KB from a few hundred bytes
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length });
        return res.end(body);
    }
    if (pathname === '/upstream-cache-header') return json(200, [1], { 'x-cache': 'HIT from upstream-cdn' });
    if (pathname === '/slow') return undefined; // never answers
    if (req.method === 'POST' && pathname === '/posts') {
        let body = '';
        req.on('data', (c) => { body += c; });
        return req.on('end', () => json(201, { ...JSON.parse(body || '{}'), id: 101 }));
    }
    return json(404, { error: 'not found' });
});

let UPSTREAM;
let main;      // default settings, Redis when available
let strict;    // read-only, tiny limits, no Redis
let deadEnd;   // upstream unreachable

before(async () => {
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    const closedPort = await freePort();
    // limits high enough that the suite itself is never throttled
    main = await startGateway({
        UPSTREAM_URL: UPSTREAM,
        REDIS_URL: REDIS_URL || `redis://127.0.0.1:${closedPort}`,
        CACHE_TTL: '60',
        RATE_LIMIT_MAX: '1000',
        RATE_LIMIT_BURST_MAX: '1000'
    });
    strict = await startGateway({
        UPSTREAM_URL: UPSTREAM,
        REDIS_URL: `redis://127.0.0.1:${closedPort}`,
        ALLOWED_METHODS: 'GET,HEAD,OPTIONS',
        RATE_LIMIT_BURST_MAX: '3',
        MAX_RESPONSE_BYTES: '1000',
        UPSTREAM_TIMEOUT_MS: '500',
        CLIENT_IP_HEADER: 'x-real-ip'
    });
    deadEnd = await startGateway({ UPSTREAM_URL: `http://127.0.0.1:${closedPort}`, REDIS_URL: `redis://127.0.0.1:${closedPort}` });
});

after(async () => {
    await Promise.all([stopGateway(main), stopGateway(strict), stopGateway(deadEnd)]);
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
});

// A fresh client address per test keeps the strict instance's buckets apart
let ipCounter = 0;
const ip = () => ({ 'x-real-ip': `198.51.100.${++ipCounter}` });

// ---------- tests ----------

describe('gateway pages', () => {
    test('browsers get the docs page with every placeholder rendered', async () => {
        const res = await request(main.base, '/', { headers: { accept: 'text/html' } });
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /^text\/html/);
        assert.doesNotMatch(res.body, /\{\{\w+\}\}/);
        assert.match(res.body, /__gateway\/landing\.js/);
    });

    test('non-browser clients get the plain-text summary', async () => {
        const res = await request(main.base, '/', { headers: { accept: '*/*' } });
        assert.match(res.headers['content-type'], /^text\/plain/);
        assert.match(res.body, /^TOON Gateway v\d+\.\d+\.\d+/);
        assert.doesNotMatch(res.body, /\{\{\w+\}\}/);
    });

    test('static assets are served, templates are not', async () => {
        assert.equal((await request(main.base, '/__gateway/landing.js')).status, 200);
        assert.equal((await request(main.base, '/__gateway/landing.css')).status, 200);
        assert.equal((await request(main.base, '/__gateway/favicon.svg')).status, 200);
        assert.equal((await request(main.base, '/__gateway/index.html')).status, 404);
        assert.equal((await request(main.base, '/__gateway/usage.txt')).status, 404);
        assert.equal((await request(main.base, '/__gateway/nope')).status, 404);
    });

    test('info reports the package version and the client address', async () => {
        const info = JSON.parse((await request(strict.base, '/__gateway/info', { headers: { 'x-real-ip': '203.0.113.5' } })).body);
        assert.equal(info.version, require('../package.json').version);
        assert.equal(info.upstream, UPSTREAM);
        assert.equal(info.clientIp, '203.0.113.5');
        assert.equal(info.debug, undefined);
    });

    test('gateway pages never fall through to the upstream', async () => {
        assert.equal((await request(main.base, '/', { method: 'POST' })).status, 405);
        assert.equal((await request(main.base, '/health', { method: 'DELETE' })).status, 405);
        assert.equal(hits['/'], undefined);
    });
});

describe('health', () => {
    test('healthy with Redis', needsRedis, async () => {
        const body = JSON.parse((await request(main.base, '/health')).body);
        assert.equal(body.status, 'healthy');
        assert.equal(body.redis, 'connected');
    });

    test('degraded but 200 without Redis; strict mode returns 503', async () => {
        const res = await request(strict.base, '/health');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body).status, 'degraded');
        assert.equal((await request(strict.base, '/health?strict=1')).status, 503);
    });
});

describe('POST /__gateway/encode', () => {
    test('encodes uniform arrays as a table', async () => {
        const res = await postJson(main.base, '/__gateway/encode', [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /^text\/toon; charset=utf-8/);
        assert.equal(res.body, '[2]{id,name}:\n  1,Alice\n  2,Bob');
    });

    test('encodes nested rows as grouped columns (TOON v4)', async () => {
        const res = await postJson(main.base, '/__gateway/encode', [{ id: 1, g: { x: 1 } }, { id: 2, g: { x: 2 } }]);
        assert.equal(res.body, '[2]{id,g{x}}:\n  1,1\n  2,2');
    });

    test('accepts any JSON value, not only objects', async () => {
        assert.equal((await postJson(main.base, '/__gateway/encode', '"hello"')).body, 'hello');
        assert.equal((await postJson(main.base, '/__gateway/encode', '42')).body, '42');
    });

    test('applies delimiter and indent options', async () => {
        const pipe = await postJson(main.base, '/__gateway/encode?delimiter=pipe', [{ a: 1 }, { a: 2 }]);
        assert.equal(pipe.body.split('\n')[0], '[2|]{a}:');
        const indent = await postJson(main.base, '/__gateway/encode?indent=4', { a: { b: 1 } });
        assert.equal(indent.body, 'a:\n    b: 1');
    });

    test('rejects bad input with 400', async () => {
        assert.equal((await postJson(main.base, '/__gateway/encode', '{oops')).status, 400);
        assert.equal((await request(main.base, '/__gateway/encode', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 0 } })).status, 400);
        assert.equal((await postJson(main.base, '/__gateway/encode?delimiter=semicolon', [1])).status, 400);
        assert.equal((await postJson(main.base, '/__gateway/encode?indent=99', [1])).status, 400);
    });

    test('key folding (removed in TOON v4) is refused, not silently ignored', async () => {
        const res = await postJson(main.base, '/__gateway/encode?keyFolding=safe', [1]);
        assert.equal(res.status, 400);
        assert.match(JSON.parse(res.body).message, /removed in TOON v4/);
        assert.equal((await postJson(main.base, '/__gateway/encode?keyFolding=off', [1])).status, 200);
    });

    test('limits the body size and the method', async () => {
        const big = `[${'1,'.repeat(150000)}1]`;
        assert.equal((await postJson(main.base, '/__gateway/encode', big)).status, 413);
        assert.equal((await request(main.base, '/__gateway/encode')).status, 405);
    });

    test('works on a read-only gateway', async () => {
        assert.equal((await postJson(strict.base, '/__gateway/encode', [1], ip())).status, 200);
    });
});

describe('proxy', () => {
    test('converts JSON responses to TOON', async () => {
        const res = await request(main.base, `/todos?run=${RUN}-a`);
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /^text\/toon; charset=utf-8/);
        assert.equal(res.body, '[2]{userId,id,title,completed}:\n  1,1,one,false\n  1,2,two,true');
    });

    test('passes non-JSON responses through unchanged', async () => {
        const res = await request(main.base, '/text');
        assert.match(res.headers['content-type'], /^text\/plain/);
        assert.equal(res.body, 'plain upstream text');
    });

    test('keeps the upstream status code', async () => {
        assert.equal((await request(main.base, '/missing')).status, 404);
        const created = await postJson(main.base, '/posts', { title: 't' });
        assert.equal(created.status, 201);
        assert.match(created.body, /^title: t\nid: 101$/);
    });

    test('removes upstream headers that would act on the gateway origin', async () => {
        const res = await request(main.base, '/leaky');
        for (const name of ['set-cookie', 'via', 'x-powered-by', 'nel', 'report-to', 'alt-svc']) {
            assert.equal(res.headers[name], undefined, `${name} leaked`);
        }
        assert.notEqual(res.headers.server, 'upstream-server/1.0');
        assert.equal(res.headers['x-upstream-custom'], 'kept');
    });

    test('keeps the gateway security headers on proxied responses, overriding the upstream', async () => {
        const res = await request(main.base, '/leaky');
        assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
        assert.match(res.headers['content-security-policy'], /^default-src 'none'/);
        assert.equal(res.headers['x-frame-options'], 'DENY');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.match(res.headers['permissions-policy'], /camera=\(\)/);
    });

    test('forwards credentials to the upstream and asks it for an uncompressed body', async () => {
        await request(main.base, '/echo-headers', { headers: { authorization: 'Bearer abc', 'accept-encoding': 'gzip' } });
        assert.equal(received['/echo-headers'].authorization, 'Bearer abc');
        assert.equal(received['/echo-headers']['accept-encoding'], undefined);
    });

    test('caches GETs: MISS, then HIT without contacting the upstream', needsRedis, async () => {
        const p = `/todos/cached?run=${RUN}`;
        assert.equal((await request(main.base, p)).headers['x-cache'], 'MISS');
        const second = await request(main.base, p);
        assert.equal(second.headers['x-cache'], 'HIT');
        assert.match(second.body, /^\[2\]\{userId,id,title,completed\}:/);
        assert.equal(hits['/todos/cached'], 1);
    });

    test('never caches credentialed requests', needsRedis, async () => {
        const p = `/todos/creds?run=${RUN}`;
        const auth = { authorization: 'Bearer x' };
        assert.equal((await request(main.base, p, { headers: auth })).headers['x-cache'], 'BYPASS');
        assert.equal((await request(main.base, p, { headers: { cookie: 'a=b' } })).headers['x-cache'], 'BYPASS');
        assert.equal((await request(main.base, p)).headers['x-cache'], 'MISS'); // nothing was stored
    });

    test('never caches private upstream responses', needsRedis, async () => {
        const p = `/private?run=${RUN}`;
        assert.equal((await request(main.base, p)).headers['x-cache'], 'MISS');
        assert.equal((await request(main.base, p)).headers['x-cache'], 'MISS');
    });

    test('serves uncached when Redis is unavailable', async () => {
        const res = await request(strict.base, '/todos', { headers: ip() });
        assert.equal(res.status, 200);
        assert.equal(res.headers['x-cache'], 'UNAVAILABLE');
    });

    test('answers 502 when the upstream is unreachable', async () => {
        const res = await request(deadEnd.base, '/todos');
        assert.equal(res.status, 502);
        assert.equal(JSON.parse(res.body).error, 'Bad Gateway');
    });

    test('answers 504 when the upstream is too slow', async () => {
        const res = await request(strict.base, '/slow', { headers: ip() });
        assert.equal(res.status, 504);
    });

    test('refuses upstream responses over the size cap and keeps running', async () => {
        assert.equal((await request(strict.base, '/big', { headers: ip() })).status, 502);
        assert.equal((await request(strict.base, '/big-stream', { headers: ip() })).status, 502);
        // a streamed oversized response used to crash the process
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(strict.child.exitCode, null, `gateway exited:\n${strict.output()}`);
        assert.equal((await request(strict.base, '/health')).status, 200);
    });

    test('decodes a compressed upstream body before converting it', async () => {
        const res = await request(main.base, '/gzip');
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-encoding'], undefined);
        assert.equal(res.body, '[2]{a}:\n  1\n  2');
    });

    test('caps the decompressed size, not only the compressed one', async () => {
        assert.equal((await request(strict.base, '/bomb', { headers: ip() })).status, 502);
        assert.equal(strict.child.exitCode, null);
    });

    test("the upstream cannot overwrite the gateway's X-Cache", async () => {
        const res = await request(strict.base, '/upstream-cache-header', { headers: ip() });
        assert.equal(res.headers['x-cache'], 'UNAVAILABLE');
    });

    test('HEAD requests return headers and no body', async () => {
        const res = await request(main.base, `/todos?run=${RUN}-head`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(res.body, '');
    });
});

describe('security', () => {
    test('sets strict security headers', async () => {
        const h = (await request(main.base, '/', { headers: { accept: 'text/html' } })).headers;
        assert.match(h['content-security-policy'], /^default-src 'none';script-src 'self';style-src 'self'/);
        assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
        assert.equal(h['strict-transport-security'], 'max-age=31536000; includeSubDomains');
        assert.equal(h['x-frame-options'], 'DENY');
        assert.equal(h['x-content-type-options'], 'nosniff');
        assert.equal(h['referrer-policy'], 'no-referrer');
        assert.match(h['permissions-policy'], /camera=\(\)/);
        assert.equal(h['x-powered-by'], undefined);
    });

    test('rejects methods outside the allow-list', async () => {
        assert.equal((await request(main.base, '/posts/1', { method: 'TRACE' })).status, 405);
        assert.equal((await postJson(strict.base, '/posts', {}, ip())).status, 405);
        assert.equal((await request(strict.base, '/posts/1', { method: 'DELETE', headers: ip() })).status, 405);
    });

    test('rejects oversized URLs and request bodies', async () => {
        assert.equal((await request(main.base, `/posts?x=${'a'.repeat(3000)}`)).status, 414);
        const res = await request(main.base, '/posts', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 } })
            .catch((err) => ({ status: err.code })); // server may answer and close before the body is sent
        assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(res.status), `got ${res.status}`);
    });

    test('rate limits bursts per client with a JSON 429', async () => {
        const client = ip();
        for (let i = 0; i < 3; i++) assert.equal((await request(strict.base, '/todos', { headers: client })).status, 200);
        const limited = await request(strict.base, '/todos', { headers: client });
        assert.equal(limited.status, 429);
        assert.equal(JSON.parse(limited.body).error, 'Too Many Requests');
        const retryAfter = Number(limited.headers['retry-after']);
        assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${limited.headers['retry-after']}`);
        // another client is unaffected; docs and health are never limited
        assert.equal((await request(strict.base, '/todos', { headers: ip() })).status, 200);
        assert.equal((await request(strict.base, '/', { headers: client })).status, 200);
        assert.equal((await request(strict.base, '/health', { headers: client })).status, 200);
    });

    test('exposes the remaining budget in standard headers', async () => {
        const h = (await request(main.base, '/todos')).headers;
        assert.equal(h['ratelimit-limit'], '1000');
        assert.ok(Number(h['ratelimit-remaining']) < 1000);
    });

    test('refuses an invalid UPSTREAM_URL at startup', async () => {
        await assert.rejects(startGateway({ UPSTREAM_URL: 'ftp://example.com' }), /exited early/);
        await assert.rejects(startGateway({ UPSTREAM_URL: 'https://user:pass@example.com' }), /exited early/);
    });
});

describe('lifecycle', () => {
    test('shuts down cleanly on SIGTERM', async () => {
        const gw = await startGateway({ UPSTREAM_URL: UPSTREAM, REDIS_URL: 'redis://127.0.0.1:1' });
        const started = Date.now();
        assert.equal(await stopGateway(gw), 0);
        assert.ok(Date.now() - started < 5000, 'took longer than 5 s');
    });
});
