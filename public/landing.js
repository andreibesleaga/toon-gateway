/* TOON Gateway landing page. Served as a file because the CSP forbids inline scripts. */
(function () {
    'use strict';

    var PREFIX = '/__gateway';
    var $ = function (id) { return document.getElementById(id); };

    var SAMPLES = {
        users: [
            { id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin', active: true },
            { id: 2, name: 'Bob', email: 'bob@example.com', role: 'user', active: true },
            { id: 3, name: 'Carol', email: 'carol@example.com', role: 'user', active: false },
            { id: 4, name: 'Dan', email: 'dan@example.com', role: 'editor', active: true }
        ],
        order: {
            order: {
                id: 'A-1042',
                placed: '2026-03-14T09:30:00Z',
                customer: { name: 'Ada Lovelace', tier: 'gold' },
                items: [
                    { sku: 'KB-01', title: 'Keyboard', qty: 1, price: 89.5 },
                    { sku: 'MS-07', title: 'Mouse, wireless', qty: 2, price: 24 }
                ],
                tags: ['priority', 'gift'],
                notes: null
            }
        },
        mixed: [
            1,
            'two',
            { kind: 'object', ok: true },
            [3, 4, 5],
            null
        ],
        metrics: {
            service: 'checkout',
            unit: 'ms',
            points: [
                { t: '10:00', p50: 112, p95: 240, errors: 0 },
                { t: '10:05', p50: 118, p95: 251, errors: 2 },
                { t: '10:10', p50: 109, p95: 233, errors: 0 },
                { t: '10:15', p50: 131, p95: 310, errors: 5 },
                { t: '10:20', p50: 115, p95: 246, errors: 1 }
            ]
        }
    };

    /* ---------- service status ---------- */
    function checkHealth() {
        fetch('/health', { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (h) {
                var healthy = h.status === 'healthy';
                $('status-dot').className = 'dot ' + (healthy ? 'ok' : 'warn');
                $('status-text').textContent = healthy
                    ? 'online · cache connected'
                    : 'online · cache unavailable, serving uncached';
            })
            .catch(function () {
                $('status-dot').className = 'dot bad';
                $('status-text').textContent = 'status unavailable';
            });
    }

    /* ---------- tabs ---------- */
    var tabs = [$('tab-encode'), $('tab-proxy')];
    function selectTab(tab) {
        tabs.forEach(function (t) {
            var on = t === tab;
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
            $(t.getAttribute('aria-controls')).hidden = !on;
        });
    }
    tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () { selectTab(tab); });
        tab.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            selectTab(next);
            next.focus();
        });
    });

    /* ---------- JSON -> TOON converter ---------- */
    var jsonIn = $('json-in');
    var lastToon = '';

    function setMsg(text, isError) {
        var el = $('encode-msg');
        el.textContent = text || '';
        el.className = 'msg ' + (isError ? 'err' : 'okc');
    }

    function loadSample(name) {
        jsonIn.value = JSON.stringify(SAMPLES[name], null, 2);
        convert();
    }

    function encodeUrl() {
        var q = [];
        var d = $('opt-delimiter').value;
        var i = $('opt-indent').value;
        var k = $('opt-folding').value;
        if (d !== 'comma') q.push('delimiter=' + d);
        if (i !== '2') q.push('indent=' + i);
        if (k !== 'off') q.push('keyFolding=' + k);
        return PREFIX + '/encode' + (q.length ? '?' + q.join('&') : '');
    }

    function updateCurl(minified) {
        var body = minified.length > 400 ? '@data.json' : "'" + minified.replace(/'/g, "'\\''") + "'";
        var url = location.origin + encodeUrl();
        $('encode-curl').textContent =
            "curl -X POST '" + url + "' \\\n" +
            "  -H 'Content-Type: application/json' \\\n" +
            '  -d ' + body;
    }

    function convert() {
        var raw = jsonIn.value.trim();
        if (!raw) { setMsg('Paste some JSON first.', true); return; }

        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            setMsg('That is not valid JSON: ' + err.message, true);
            return;
        }
        var minified = JSON.stringify(parsed);
        var btn = $('encode-btn');
        btn.disabled = true;
        setMsg('Calling the gateway…');
        var started = performance.now();

        fetch(encodeUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/toon, application/json' },
            body: minified
        })
            .then(function (res) {
                return res.text().then(function (text) { return { res: res, text: text }; });
            })
            .then(function (r) {
                var ms = Math.round(performance.now() - started);
                if (!r.res.ok) {
                    var message = r.text;
                    try { message = JSON.parse(r.text).message || message; } catch (e) { /* plain text error */ }
                    if (r.res.status === 429) message = 'Rate limit reached for your IP. Try again in a few minutes.';
                    setMsg('Gateway returned ' + r.res.status + ': ' + message, true);
                    return;
                }
                lastToon = r.text;
                $('toon-code').textContent = r.text;
                $('copy-btn').disabled = false;
                var saved = minified.length ? Math.round((1 - r.text.length / minified.length) * 100) : 0;
                $('st-json').textContent = minified.length.toLocaleString();
                $('st-toon').textContent = r.text.length.toLocaleString();
                $('st-saved').textContent = (saved > 0 ? saved : 0) + '%';
                $('st-saved').parentNode.className = 'stat' + (saved > 0 ? ' good' : '');
                $('st-time').textContent = ms + ' ms';
                $('stats').hidden = false;
                updateCurl(minified);
                setMsg(saved > 0
                    ? 'Converted by POST ' + encodeUrl() + '. Character counts approximate token savings; exact numbers depend on the tokenizer.'
                    : 'Converted. This shape does not compress: TOON gains most on arrays of uniform objects.');
            })
            .catch(function (err) {
                setMsg('Could not reach the gateway: ' + err.message, true);
            })
            .then(function () { btn.disabled = false; });
    }

    $('encode-form').addEventListener('submit', function (e) { e.preventDefault(); convert(); });
    ['opt-delimiter', 'opt-indent', 'opt-folding'].forEach(function (id) {
        $(id).addEventListener('change', function () { if (jsonIn.value.trim()) convert(); });
    });
    jsonIn.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); convert(); }
    });
    $('format-btn').addEventListener('click', function () {
        try {
            jsonIn.value = JSON.stringify(JSON.parse(jsonIn.value), null, 2);
            setMsg('');
        } catch (err) {
            setMsg('That is not valid JSON: ' + err.message, true);
        }
    });
    $('copy-btn').addEventListener('click', function () {
        var btn = $('copy-btn');
        var done = function (label) {
            btn.textContent = label;
            setTimeout(function () { btn.textContent = 'Copy TOON'; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(lastToon).then(function () { done('Copied'); }, function () { done('Copy failed'); });
        } else {
            done('Select the text to copy');
        }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-sample]'), function (b) {
        b.addEventListener('click', function () { loadSample(b.getAttribute('data-sample')); });
    });

    /* ---------- proxy tester ---------- */
    function isGatewayOwnPath(path) {
        var p = path.split('?')[0];
        return p === '/' || p === '/health' || p.indexOf(PREFIX) === 0;
    }

    function runProxy() {
        var path = $('proxy-path').value.trim();
        var hdrs = $('proxy-hdrs');
        var out = $('proxy-code');
        if (!path) return;
        if (path.charAt(0) !== '/') path = '/' + path;
        // same-origin paths only: never let the field become an absolute or protocol-relative URL
        if (path.indexOf('//') === 0 || path.indexOf('\\') !== -1) {
            hdrs.textContent = 'Enter a path on the upstream API, for example /users';
            return;
        }
        $('proxy-path').value = path;
        if (isGatewayOwnPath(path)) {
            hdrs.textContent = 'That path is served by the gateway itself, not proxied. Try /users or /posts/1.';
            return;
        }

        var btn = $('proxy-btn');
        btn.disabled = true;
        hdrs.textContent = 'Requesting ' + path + ' …';
        var started = performance.now();

        fetch(path, { headers: { Accept: 'application/json' } })
            .then(function (res) {
                return res.text().then(function (text) { return { res: res, text: text }; });
            })
            .then(function (r) {
                var ms = Math.round(performance.now() - started);
                var h = r.res.headers;
                hdrs.innerHTML = '';
                [
                    ['status', r.res.status + ' ' + r.res.statusText],
                    ['content-type', h.get('content-type') || '–'],
                    ['x-cache', h.get('x-cache') || '–'],
                    ['ratelimit-remaining', h.get('ratelimit-remaining') || '–'],
                    ['time', ms + ' ms']
                ].forEach(function (pair, idx) {
                    if (idx) hdrs.appendChild(document.createTextNode('  ·  '));
                    hdrs.appendChild(document.createTextNode(pair[0] + ': '));
                    var b = document.createElement('b');
                    b.textContent = pair[1];
                    hdrs.appendChild(b);
                });
                var text = r.text;
                if (text.length > 20000) text = text.slice(0, 20000) + '\n… (' + (r.text.length - 20000).toLocaleString() + ' more characters)';
                out.textContent = text || '(empty response)';
            })
            .catch(function (err) {
                hdrs.textContent = 'Request failed: ' + err.message;
            })
            .then(function () { btn.disabled = false; });
    }

    $('proxy-form').addEventListener('submit', function (e) { e.preventDefault(); runProxy(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-path]'), function (b) {
        b.addEventListener('click', function () {
            $('proxy-path').value = b.getAttribute('data-path');
            runProxy();
        });
    });

    /* ---------- start ---------- */
    jsonIn.value = JSON.stringify(SAMPLES.users, null, 2);
    updateCurl(JSON.stringify(SAMPLES.users));
    checkHealth();
})();
