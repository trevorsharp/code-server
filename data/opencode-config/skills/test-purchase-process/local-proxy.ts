#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

interface ProxyRoute {
  path: string;
  target: string;
}

interface ProxyState {
  controlKey: string;
  pid?: number;
  port: number;
  proxyUrl: string;
  routes: ProxyRoute[];
}

interface TokenRegistration {
  jwt: string;
  expiresAt: number;
}

const stateFileIndex = process.argv.indexOf('--state-file');
const stateFile = stateFileIndex >= 0 ? process.argv[stateFileIndex + 1] : undefined;
if (!stateFile) throw new Error('--state-file is required');

const state = JSON.parse(await readFile(stateFile, 'utf8')) as ProxyState;
if (!state.controlKey || !Number.isInteger(state.port) || !Array.isArray(state.routes)) {
  throw new Error('Proxy state is invalid');
}

const registrations = new Map<string, TokenRegistration>();
const routes = [...state.routes].sort((left, right) => right.path.length - left.path.length);

const tokenHash = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('hex');
};

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get('authorization');
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
};

const corsHeaders = (request: Request): Headers => {
  const headers = new Headers({
    'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') || 'Authorization, Content-Type, correlation-id',
    Vary: 'Origin'
  });
  return headers;
};

const withCors = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request)) headers.set(name, value);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const registerToken = async (request: Request): Promise<Response> => {
  if (request.headers.get('x-purchase-ui-proxy-key') !== state.controlKey) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { phantomToken?: unknown; jwt?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid registration body' }, { status: 400 });
  }
  if (typeof body.phantomToken !== 'string' || typeof body.jwt !== 'string') {
    return Response.json({ error: 'phantomToken and jwt are required' }, { status: 400 });
  }

  let expiresAt: number;
  try {
    const payload = JSON.parse(Buffer.from(body.jwt.split('.')[1], 'base64url').toString()) as { exp?: unknown };
    if (typeof payload.exp !== 'number') throw new Error();
    expiresAt = payload.exp;
  } catch {
    return Response.json({ error: 'JWT expiration could not be read' }, { status: 400 });
  }
  if (expiresAt <= Math.floor(Date.now() / 1000)) {
    return Response.json({ error: 'JWT is expired' }, { status: 400 });
  }

  registrations.set(await tokenHash(body.phantomToken), { jwt: body.jwt, expiresAt });
  return Response.json({ status: 'registered', expiresAt });
};

const proxyRequest = async (request: Request, route: ProxyRoute, jwt: string): Promise<Response> => {
  const requestUrl = new URL(request.url);
  const target = new URL(route.target);
  const suffix = requestUrl.pathname.slice(route.path.length) || '/';
  target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix}`;
  target.search = requestUrl.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.delete('accept-encoding');
  headers.set('authorization', `Bearer ${jwt}`);

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000)
    });
    return withCors(request, response);
  } catch {
    return withCors(request, Response.json({ error: 'Local backend could not be reached' }, { status: 502 }));
  }
};

Bun.serve({
  hostname: '127.0.0.1',
  port: state.port,
  async fetch(request) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === '/_purchase-ui-proxy/health') {
      return Response.json({ status: 'ready', port: state.port, routes, registrations: registrations.size });
    }
    if (requestUrl.pathname === '/_purchase-ui-proxy/tokens' && request.method === 'POST') {
      return registerToken(request);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

    const route = routes.find(candidate => requestUrl.pathname === candidate.path || requestUrl.pathname.startsWith(`${candidate.path}/`));
    if (!route) return withCors(request, Response.json({ error: 'No local backend route is configured' }, { status: 404 }));

    const phantomToken = bearerToken(request);
    if (!phantomToken) return withCors(request, Response.json({ error: 'Bearer token is required' }, { status: 401 }));

    const key = await tokenHash(phantomToken);
    const registration = registrations.get(key);
    if (!registration || registration.expiresAt <= Math.floor(Date.now() / 1000)) {
      registrations.delete(key);
      return withCors(
        request,
        Response.json({ error: 'Token is not registered; rerun login with --proxy-url' }, { status: 401 })
      );
    }

    return proxyRequest(request, route, registration.jwt);
  }
});

process.stdout.write(`Local purchase backend proxy listening on ${state.proxyUrl}\n`);
