#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

interface ProxyRoute {
  path: string;
  target: string;
}

interface HttpsState {
  backendRoutes: ProxyRoute[];
  certFile: string;
  checkoutUrl: string;
  keyFile: string;
  port: number;
  secureUrl: string;
}

const stateFileIndex = process.argv.indexOf('--state-file');
const stateFile = stateFileIndex >= 0 ? process.argv[stateFileIndex + 1] : undefined;
if (!stateFile) throw new Error('--state-file is required');

const state = JSON.parse(await readFile(stateFile, 'utf8')) as HttpsState;
if (!Number.isInteger(state.port) || !state.checkoutUrl || !Array.isArray(state.backendRoutes)) {
  throw new Error('HTTPS state is invalid');
}

const routes = [
  ...state.backendRoutes,
  { path: '/', target: state.checkoutUrl }
].sort((left, right) => right.path.length - left.path.length);

const proxyRequest = async (request: Request, route: ProxyRoute): Promise<Response> => {
  const requestUrl = new URL(request.url);
  const target = new URL(route.target);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.delete('accept-encoding');

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000)
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('content-length');
    responseHeaders.delete('content-encoding');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch {
    return Response.json({ error: 'HTTPS upstream could not be reached' }, { status: 502 });
  }
};

Bun.serve({
  hostname: '0.0.0.0',
  port: state.port,
  tls: {
    key: await Bun.file(state.keyFile).text(),
    cert: await Bun.file(state.certFile).text()
  },
  async fetch(request) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === '/_purchase-ui-https/health') {
      return Response.json({ status: 'ready', port: state.port, routes });
    }
    if (requestUrl.pathname === '/verifx' || requestUrl.pathname.startsWith('/verifx/')) {
      return Response.json({ error: 'VerificationsUI is not exposed through the HTTPS gateway' }, { status: 404 });
    }
    const route = routes.find(candidate => candidate.path === '/' || requestUrl.pathname === candidate.path || requestUrl.pathname.startsWith(`${candidate.path}/`));
    return proxyRequest(request, route!);
  }
});

process.stdout.write(`Local purchase HTTPS gateway listening on ${state.secureUrl}\n`);
