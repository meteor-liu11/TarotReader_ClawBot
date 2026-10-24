import http from 'node:http';

const HOST = process.env.PUBLIC_PROXY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PUBLIC_PROXY_PORT ?? 8788);
const UPSTREAM_HOST = process.env.PUBLIC_PROXY_UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.PUBLIC_PROXY_UPSTREAM_PORT ?? 8787);
const PAGES_ORIGIN = String(process.env.PAGES_ORIGIN ?? '').replace(/\/$/, '');

if (!PAGES_ORIGIN || !/^https:\/\//i.test(PAGES_ORIGIN)) {
  throw new Error('PAGES_ORIGIN must be the exact HTTPS origin of the GitHub Pages site.');
}

const id = '[A-Za-z0-9_-]{1,200}';
const routes = [
  ['GET', new RegExp(`^/api/(?:session|credits)/${id}$`)],
  ['GET', new RegExp(`^/api/reading/${id}$`)],
  ['GET', /^\/api\/(?:cards|spreads)$/],
  ['POST', new RegExp(`^/api/(?:shuffle|draw|callback)/${id}$`)],
  ['POST', /^\/api\/redeem$/],
];

function allowedRoute(method, pathname) {
  return routes.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(pathname));
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': PAGES_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/_local-health' && req.method === 'GET') {
    return json(res, 200, { ok: true });
  }

  if (req.headers.origin !== PAGES_ORIGIN) {
    return json(res, 403, { error: 'Origin not allowed' });
  }

  if (req.method === 'OPTIONS') {
    const requestedMethod = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
    const requestedHeaders = String(req.headers['access-control-request-headers'] ?? '')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!allowedRoute(requestedMethod, pathname)
        || requestedHeaders.some((header) => header !== 'content-type')) {
      return json(res, 403, { error: 'Route or request headers not allowed' });
    }
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (!allowedRoute(req.method, pathname)) {
    return json(res, 404, { error: 'Not found' });
  }

  const headers = { host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  for (const name of ['accept', 'content-type', 'content-length']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: `${pathname}${url.search}`,
    headers,
    timeout: 30_000,
  }, (upstreamRes) => {
    const responseHeaders = corsHeaders();
    for (const name of ['content-type', 'cache-control']) {
      if (upstreamRes.headers[name]) responseHeaders[name] = upstreamRes.headers[name];
    }
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('Upstream request timed out')));
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'Local ClawBot service is unavailable.' }, corsHeaders());
    else res.destroy();
  });
  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`Tarot public API proxy listening on ${HOST}:${PORT}; Pages origin=${PAGES_ORIGIN}`);
});
