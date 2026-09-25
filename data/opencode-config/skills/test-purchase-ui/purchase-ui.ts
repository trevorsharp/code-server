#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
type Options = Record<string, string | true>;

interface AuthCookie {
  name: string;
  value: string;
  expires?: string;
}

interface ProxyRoute {
  path: string;
  target: string;
}

interface ProxyState {
  controlKey: string;
  logFile: string;
  pid?: number;
  port: number;
  proxyUrl: string;
  routes: ProxyRoute[];
}

interface HttpsState {
  backendRoutes: ProxyRoute[];
  certFile: string;
  checkoutUrl: string;
  keyFile: string;
  logFile: string;
  pid?: number;
  port: number;
  secureUrl: string;
}

const URLS = {
  token: 'https://apps.carvanatech.com/edge/authserver/connect/token',
  pb: 'https://apps.carvanatech.com/qe/pbredux',
  authCookies: 'https://apps.carvanatech.com/oec/paymentstesting/api/v1/testazure/auth-cookies'
};
const CONSUMER_USER = 'trevor.sharp@carvana.com';
const API_AUDIENCE = 'https://carvana-auth-test.azurewebsites.net/identity/resources';
const IMPERSONATOR_USER_ID = '3d83057c-1dfa-449b-82df-82d83766f965';

const HELP = `Usage:
  purchase-ui.ts stage --blueprint-id ID
  purchase-ui.ts login --customer-id ID --host local|local-https|testazure --browser-port PORT [--secure-port PORT] [--proxy-url URL] [--impersonate]
  purchase-ui.ts proxy start --port PORT --route PATH=URL [--route PATH=URL ...]
  purchase-ui.ts proxy status --port PORT
  purchase-ui.ts proxy stop --port PORT
  purchase-ui.ts https start [--port PORT] [--checkout-url URL] [--proxy-url URL]
  purchase-ui.ts https status [--port PORT]
  purchase-ui.ts https stop [--port PORT]
  purchase-ui.ts preflight-feature --component verifx --branch BRANCH
  purchase-ui.ts preflight-feature --component checkout --artifact-key KEY
`;

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function parseOptions(values: string[], allowed: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag.startsWith('--')) throw new CliError(`Unexpected argument: ${flag}`, 2);
    const name = flag.slice(2).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    if (!allowed.includes(name)) throw new CliError(`Unknown option: ${flag}`, 2);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) options[name] = true;
    else {
      options[name] = value;
      index += 1;
    }
  }
  return options;
}

function required(options: Options, name: string): string {
  const value = options[name];
  if (!value || value === true) {
    const flag = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    throw new CliError(`--${flag} is required.`, 2);
  }
  return value;
}

async function responseValue(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

let serviceToken: string | undefined;

async function authenticate(): Promise<string> {
  if (serviceToken) return serviceToken;

  let response: Response;
  try {
    response = await fetch(URLS.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'payments-testing',
        client_secret: process.env.PAYMENTS_TESTING_AUTH_CLIENT_SECRET!,
        scope: 'qeService'
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new CliError('Could not reach the TEST auth server.');
  }

  const value = record(await responseValue(response));
  const token = value?.access_token;
  if (!response.ok || typeof token !== 'string') {
    throw new CliError(`TEST service authentication failed with HTTP ${response.status}.`);
  }

  serviceToken = token;
  return token;
}

async function customerApiJwt(customerId: string, impersonate: boolean): Promise<string> {
  const clientSecret = process.env.PAYMENTS_TESTING_AUTH_CLIENT_SECRET;
  if (!clientSecret) throw new CliError('PAYMENTS_TESTING_AUTH_CLIENT_SECRET is required.');

  let response: Response;
  try {
    const body = new URLSearchParams({
      grant_type: impersonate ? 'impersonate' : 'trusted',
      client_id: 'payments-testing',
      client_secret: clientSecret,
      scope: 'carvana_com',
      id: customerId
    });
    if (impersonate) body.set('impersonator_id', IMPERSONATOR_USER_ID);

    response = await fetch(URLS.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new CliError('Could not reach the TEST auth server for the customer API JWT.');
  }

  const value = record(await responseValue(response));
  const jwt = value?.access_token;
  if (!response.ok || typeof jwt !== 'string') {
    throw new CliError(`Customer API JWT authentication failed with HTTP ${response.status}.`);
  }

  let payload: JsonRecord;
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error();
    payload = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString())) ?? {};
  } catch {
    throw new CliError('TEST auth server returned an invalid customer API JWT.');
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(API_AUDIENCE)) throw new CliError('Customer API JWT has an unexpected audience.');
  if (payload.sub !== customerId || payload.user_id !== customerId) {
    throw new CliError('Customer API JWT does not match the requested customer.');
  }
  if (
    impersonate &&
    (String(payload.is_impersonating).toLowerCase() !== 'true' || payload.impersonating_user !== IMPERSONATOR_USER_ID)
  ) {
    throw new CliError('Customer API JWT does not contain the expected impersonation claims.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new CliError('Customer API JWT is expired or has no expiration.');
  }

  return jwt;
}

async function serviceRequest(
  url: string,
  {
    method = 'GET',
    body,
    consumerUser,
    timeoutMs = 30_000
  }: {
    method?: string;
    body?: unknown;
    consumerUser?: string;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const token = await authenticate();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(consumerUser ? { 'Consumer-Source': 'opencode-ui-testing', 'Consumer-User': consumerUser } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new CliError('The TEST request could not be completed.');
  }

  const value = await responseValue(response);
  if (!response.ok) throw new CliError(`TEST API returned HTTP ${response.status}.`);
  return value;
}

async function authCookies(customerId: string, impersonate: boolean): Promise<AuthCookie[]> {
  const value = await serviceRequest(URLS.authCookies, {
    method: 'POST',
    body: { customerId, impersonate }
  });
  if (!Array.isArray(value)) throw new CliError('PaymentsTesting returned an unexpected response.');
  const cookies = value.map(cookie => {
    const item = record(cookie) ?? {};
    return {
      name: item.key ?? item.Key,
      value: item.value ?? item.Value,
      expires: item.expires ?? item.Expires
    };
  });
  const names = ['CVAccessToken', 'CVRefreshToken', 'CVIdToken'];
  if (names.some(name => !cookies.some(cookie => cookie.name === name && typeof cookie.value === 'string'))) {
    throw new CliError('PaymentsTesting did not return the required auth cookies.');
  }
  return cookies
    .filter(cookie => names.includes(String(cookie.name)) && typeof cookie.value === 'string')
    .map(cookie => ({
      name: String(cookie.name),
      value: String(cookie.value),
      ...(typeof cookie.expires === 'string' ? { expires: cookie.expires } : {})
    }));
}

function proxyPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new CliError('Proxy port must be between 1 and 65535.', 2);
  return port;
}

function proxyStatePath(port: number): string {
  return `/tmp/purchase-ui-proxy-${port}.json`;
}

function httpsStatePath(port: number): string {
  return `/tmp/purchase-ui-https-${port}.json`;
}

function processIsRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProxyState(port: number): Promise<ProxyState | null> {
  try {
    const state = JSON.parse(await readFile(proxyStatePath(port), 'utf8')) as ProxyState;
    return state.port === port && typeof state.controlKey === 'string' && Array.isArray(state.routes) ? state : null;
  } catch {
    return null;
  }
}

async function readHttpsState(port: number): Promise<HttpsState | null> {
  try {
    const state = JSON.parse(await readFile(httpsStatePath(port), 'utf8')) as HttpsState;
    return state.port === port && typeof state.secureUrl === 'string' && Array.isArray(state.backendRoutes) ? state : null;
  } catch {
    return null;
  }
}

function localHttpUrl(value: string, option: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${option} must be a valid URL.`, 2);
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.username || url.password) {
    throw new CliError(`${option} must be a loopback HTTP URL without credentials.`, 2);
  }
  return url.href.replace(/\/$/, '');
}

async function waitForHttps(secureUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const process = Bun.spawn(['curl', '-skf', '--max-time', '1', `${secureUrl}/_purchase-ui-https/health`], {
      stdout: 'ignore',
      stderr: 'ignore'
    });
    if ((await process.exited) === 0) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function generateCertificate(port: number, keyFile: string, certFile: string): Promise<void> {
  const process = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost.carvana.com',
      '-addext',
      'subjectAltName=DNS:localhost.carvana.com,DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certFile
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  if ((await process.exited) !== 0) throw new CliError(`Could not generate the HTTPS certificate for port ${port}.`);
  await chmod(keyFile, 0o600);
}

async function startHttps(values: string[]): Promise<void> {
  const options = parseOptions(values, ['port', 'checkoutUrl', 'proxyUrl']);
  const port = proxyPort(options.port === true || !options.port ? '443' : options.port);
  const existingState = await readHttpsState(port);
  if (existingState && processIsRunning(existingState.pid)) throw new CliError(`HTTPS port ${port} is already running.`);

  const checkoutUrl = localHttpUrl(options.checkoutUrl === true || !options.checkoutUrl ? 'http://127.0.0.1:3001' : options.checkoutUrl, '--checkout-url');
  const proxyUrlValue = options.proxyUrl;
  let backendRoutes: ProxyRoute[] = [];
  if (proxyUrlValue) {
    if (proxyUrlValue === true) throw new CliError('--proxy-url requires a value.', 2);
    const proxyUrl = localHttpUrl(proxyUrlValue, '--proxy-url');
    const proxyState = await readProxyState(proxyPort(new URL(proxyUrl).port || '80'));
    if (!proxyState || !processIsRunning(proxyState.pid) || proxyState.proxyUrl !== proxyUrl) {
      throw new CliError(`Local backend proxy is not running at ${proxyUrl}.`);
    }
    backendRoutes = proxyState.routes.map(route => ({ path: route.path, target: proxyUrl }));
  }

  const stateFile = httpsStatePath(port);
  const keyFile = `/tmp/purchase-ui-https-${port}-key.pem`;
  const certFile = `/tmp/purchase-ui-https-${port}-cert.pem`;
  const logFile = `/tmp/purchase-ui-https-${port}.log`;
  const secureUrl = `https://localhost.carvana.com${port === 443 ? '' : `:${port}`}`;
  await generateCertificate(port, keyFile, certFile);
  const state: HttpsState = { backendRoutes, certFile, checkoutUrl, keyFile, logFile, port, secureUrl };
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await chmod(stateFile, 0o600);

  const logDescriptor = openSync(logFile, 'a');
  const gatewayScript = fileURLToPath(new URL('./https-gateway.ts', import.meta.url));
  const child = spawn(process.execPath, [gatewayScript, '--state-file', stateFile], {
    detached: true,
    stdio: ['ignore', logDescriptor, logDescriptor]
  });
  closeSync(logDescriptor);
  child.unref();
  if (!child.pid) {
    await unlink(stateFile).catch(() => undefined);
    throw new CliError('HTTPS gateway could not be started.');
  }

  state.pid = child.pid;
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  if (!(await waitForHttps(secureUrl))) {
    process.kill(child.pid, 'SIGTERM');
    await unlink(stateFile).catch(() => undefined);
    throw new CliError(`HTTPS gateway did not become ready. Check ${logFile}.`);
  }
  output({ status: 'started', secureUrl, pid: child.pid, checkoutUrl, backendRoutes, certFile, logFile });
}

async function httpsStatus(values: string[]): Promise<void> {
  const options = parseOptions(values, ['port']);
  const port = proxyPort(options.port === true || !options.port ? '443' : options.port);
  const state = await readHttpsState(port);
  if (!state || !processIsRunning(state.pid)) {
    output({ status: 'stopped', port });
    return;
  }
  output({ status: (await waitForHttps(state.secureUrl)) ? 'ready' : 'unhealthy', ...state });
}

async function stopHttps(values: string[]): Promise<void> {
  const options = parseOptions(values, ['port']);
  const port = proxyPort(options.port === true || !options.port ? '443' : options.port);
  const stateFile = httpsStatePath(port);
  const state = await readHttpsState(port);
  if (state && processIsRunning(state.pid)) process.kill(state.pid!, 'SIGTERM');
  await unlink(stateFile).catch(() => undefined);
  output({ status: 'stopped', port });
}

async function httpsCommand(values: string[]): Promise<void> {
  const [action, ...options] = values;
  if (action === 'start') return startHttps(options);
  if (action === 'status') return httpsStatus(options);
  if (action === 'stop') return stopHttps(options);
  throw new CliError('HTTPS action must be start, status, or stop.', 2);
}

function parseProxyRoutes(values: string[]): { port: number; routes: ProxyRoute[] } {
  let port: number | undefined;
  const routes: ProxyRoute[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new CliError(`${flag} requires a value.`, 2);
    if (flag === '--port') port = proxyPort(value);
    else if (flag === '--route') {
      const separator = value.indexOf('=');
      if (separator < 1) throw new CliError('--route must use PATH=URL.', 2);
      const path = value.slice(0, separator).replace(/\/$/, '');
      const target = value.slice(separator + 1).replace(/\/$/, '');
      if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
        throw new CliError('Proxy route paths must begin with / and cannot contain a query or fragment.', 2);
      }
      let targetUrl: URL;
      try {
        targetUrl = new URL(target);
      } catch {
        throw new CliError(`Invalid proxy route target: ${target}`, 2);
      }
      if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) {
        throw new CliError('Proxy route targets must be HTTP(S) URLs without credentials.', 2);
      }
      if (routes.some(route => route.path === path)) throw new CliError(`Duplicate proxy route: ${path}`, 2);
      routes.push({ path, target });
    } else throw new CliError(`Unknown option: ${flag}`, 2);
    index += 1;
  }

  if (!port) throw new CliError('--port is required.', 2);
  if (!routes.length) throw new CliError('At least one --route is required.', 2);
  return { port, routes };
}

async function waitForProxy(proxyUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${proxyUrl}/_purchase-ui-proxy/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {}
    await Bun.sleep(100);
  }
  return false;
}

async function startProxy(values: string[]): Promise<void> {
  const { port, routes } = parseProxyRoutes(values);
  const existingState = await readProxyState(port);
  if (existingState && processIsRunning(existingState.pid)) throw new CliError(`Proxy port ${port} is already running.`);

  const stateFile = proxyStatePath(port);
  const logFile = `/tmp/purchase-ui-proxy-${port}.log`;
  const proxyUrl = `http://127.0.0.1:${port}`;
  const state: ProxyState = {
    controlKey: crypto.randomUUID(),
    logFile,
    port,
    proxyUrl,
    routes
  };
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await chmod(stateFile, 0o600);

  const logDescriptor = openSync(logFile, 'a');
  const proxyScript = fileURLToPath(new URL('./local-proxy.ts', import.meta.url));
  const child = spawn(process.execPath, [proxyScript, '--state-file', stateFile], {
    detached: true,
    stdio: ['ignore', logDescriptor, logDescriptor]
  });
  closeSync(logDescriptor);
  child.unref();
  if (!child.pid) {
    await unlink(stateFile).catch(() => undefined);
    throw new CliError('Local backend proxy could not be started.');
  }

  state.pid = child.pid;
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  if (!(await waitForProxy(proxyUrl))) {
    process.kill(child.pid, 'SIGTERM');
    await unlink(stateFile).catch(() => undefined);
    throw new CliError(`Local backend proxy did not become ready. Check ${logFile}.`);
  }

  output({ status: 'started', proxyUrl, pid: child.pid, routes, logFile });
}

async function proxyStatus(values: string[]): Promise<void> {
  const options = parseOptions(values, ['port']);
  const port = proxyPort(required(options, 'port'));
  const state = await readProxyState(port);
  if (!state || !processIsRunning(state.pid)) {
    output({ status: 'stopped', port });
    return;
  }

  const ready = await waitForProxy(state.proxyUrl);
  output({ status: ready ? 'ready' : 'unhealthy', proxyUrl: state.proxyUrl, pid: state.pid, routes: state.routes, logFile: state.logFile });
}

async function stopProxy(values: string[]): Promise<void> {
  const options = parseOptions(values, ['port']);
  const port = proxyPort(required(options, 'port'));
  const stateFile = proxyStatePath(port);
  const state = await readProxyState(port);
  if (state && processIsRunning(state.pid)) process.kill(state.pid!, 'SIGTERM');
  await unlink(stateFile).catch(() => undefined);
  output({ status: 'stopped', port });
}

async function proxyCommand(values: string[]): Promise<void> {
  const [action, ...options] = values;
  if (action === 'start') return startProxy(options);
  if (action === 'status') return proxyStatus(options);
  if (action === 'stop') return stopProxy(options);
  throw new CliError('Proxy action must be start, status, or stop.', 2);
}

async function registerProxyTokens(proxyUrlValue: string, cookies: AuthCookie[], jwt: string): Promise<void> {
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxyUrlValue);
  } catch {
    throw new CliError('--proxy-url must be a valid URL.', 2);
  }
  if (
    proxyUrl.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '::1'].includes(proxyUrl.hostname) ||
    (proxyUrl.pathname !== '/' && proxyUrl.pathname !== '') ||
    proxyUrl.search ||
    proxyUrl.hash
  ) {
    throw new CliError('--proxy-url must be an HTTP loopback origin without a path, query, or fragment.', 2);
  }
  const port = proxyPort(proxyUrl.port || '80');
  const state = await readProxyState(port);
  if (!state || !processIsRunning(state.pid) || state.proxyUrl !== proxyUrl.origin) {
    throw new CliError(`Local backend proxy is not running at ${proxyUrl.origin}.`);
  }

  const accessCookie = cookies.find(cookie => cookie.name === 'CVAccessToken')?.value;
  if (!accessCookie) throw new CliError('PaymentsTesting did not return the proxy registration token.');
  let phantomToken = accessCookie;
  try {
    const parsed = record(JSON.parse(accessCookie));
    if (typeof parsed?.access_token === 'string') phantomToken = parsed.access_token;
  } catch {}

  let response: Response;
  try {
    response = await fetch(`${proxyUrl.origin}/_purchase-ui-proxy/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Purchase-UI-Proxy-Key': state.controlKey
      },
      body: JSON.stringify({ phantomToken, jwt }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new CliError('Local backend proxy token registration failed.');
  }
  if (!response.ok) throw new CliError(`Local backend proxy rejected token registration with HTTP ${response.status}.`);
}

async function stage(options: Options): Promise<void> {
  const blueprintId = required(options, 'blueprintId');

  const blueprint = record(
    await serviceRequest(`${URLS.pb}/api/v1/blueprints/${encodeURIComponent(blueprintId)}`, { consumerUser: CONSUMER_USER })
  );
  const attributes = record(blueprint?.workflow_attributes ?? blueprint?.workflowAttributes);
  const inputData = record(attributes?.input_data);
  if (typeof attributes?.stage !== 'string' || !inputData) {
    throw new CliError('Blueprint does not contain runnable workflow attributes.');
  }
  if (attributes.stage.toLowerCase() === 'completesale') {
    throw new CliError('The completesale stage is not supported.');
  }
  if (attributes.endpoint_overrides !== undefined && (!Array.isArray(attributes.endpoint_overrides) || attributes.endpoint_overrides.length)) {
    throw new CliError('Blueprint endpoint overrides are not supported.');
  }

  const workflow = {
    ...structuredClone(attributes),
    stage: attributes.stage,
    input_data: inputData,
    request_id: crypto.randomUUID(),
    consumer_type: 'mcp',
    consumer_metadata: null,
    endpoint_overrides: [],
    enable_performance_tracking: false
  };
  const requirements = record(
    await serviceRequest(`${URLS.pb}/api/v1/workflow/requirements`, {
      method: 'POST',
      body: workflow,
      consumerUser: CONSUMER_USER
    })
  );
  const rtg = record(requirements?.rtg);
  const summary = record(requirements?.summary);
  if (
    !requirements ||
    !['success', 'warning'].includes(String(requirements.status)) ||
    rtg?.eligible !== true ||
    (summary?.can_proceed !== undefined && summary.can_proceed !== true) ||
    (requirements.errors !== undefined && (!Array.isArray(requirements.errors) || requirements.errors.length > 0))
  ) {
    throw new CliError('PB Redux requirements do not allow this workflow.');
  }

  const workflowResponse = await serviceRequest(`${URLS.pb}/api/v1/workflow`, {
    method: 'POST',
    body: workflow,
    consumerUser: CONSUMER_USER,
    timeoutMs: 600_000
  });

  const response = record(workflowResponse);
  const results = record(response?.results);
  const shapingInfo = record(results?._shaping_info);
  const data = record(results?.data);
  const customerId = record(data?.customer_details)?.user_id;
  const purchaseId = record(data?.purchase_details)?.purchase_id;
  const requestId = response?.request_id;
  if (
    results?.status !== 'success' ||
    shapingInfo?.consumer_type !== 'mcp' ||
    typeof customerId !== 'string' ||
    typeof requestId !== 'string' ||
    (purchaseId != null && !['string', 'number'].includes(typeof purchaseId))
  ) {
    throw new CliError('PB Redux returned an unexpected workflow result.');
  }

  output({
    customerId,
    ...(purchaseId == null ? {} : { purchaseId: String(purchaseId) }),
    requestId
  });
}

async function browserTarget(browserPort: string, origin: string): Promise<string> {
  const port = Number(browserPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new CliError('Browser port must be between 1 and 65535.', 2);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new CliError('Could not reach the Chrome DevTools MCP browser.');
  }
  const targets = await responseValue(response);
  if (!response.ok || !Array.isArray(targets)) throw new CliError('Chrome returned an unexpected target list.');
  const target =
    targets.find(target => record(target)?.type === 'page' && String(record(target)?.url).startsWith(origin)) ??
    targets.find(target => record(target)?.type === 'page');
  const webSocketUrl = record(target)?.webSocketDebuggerUrl;
  if (typeof webSocketUrl !== 'string') throw new CliError('The MCP browser has no page target.');
  const url = new URL(webSocketUrl);
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new CliError('MCP returned a non-local browser target.');
  }
  return url.href;
}

async function injectCookies(browserPort: string, cookies: AuthCookie[], origin: string, destination: string): Promise<void> {
  const socket = new WebSocket(await browserTarget(browserPort, origin));
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 1;

  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    let response: JsonRecord | null;
    try {
      response = record(JSON.parse(event.data));
    } catch {
      return;
    }
    const id = response?.id;
    if (typeof id !== 'number') return;
    const command = pending.get(id);
    if (!command) return;
    pending.delete(id);
    clearTimeout(command.timer);
    if (response.error) command.reject(new CliError(`Chrome rejected ${command.method}.`));
    else command.resolve(record(response.result) ?? {});
  });
  socket.addEventListener('close', () => {
    for (const pendingCommand of pending.values()) {
      clearTimeout(pendingCommand.timer);
      pendingCommand.reject(new CliError('Chrome disconnected during a CDP command.'));
    }
    pending.clear();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new CliError('Chrome connection timed out.'));
    }, 10_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new CliError('Could not connect to Chrome.'));
      },
      { once: true }
    );
  });

  const command = (method: string, params: JsonRecord = {}): Promise<JsonRecord> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CliError(`${method} timed out.`));
      }, 15_000);
      pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  try {
    await command('Network.enable');
    const result = await command('Network.setCookies', {
      cookies: cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        url: origin,
        path: '/',
        secure: origin.startsWith('https:'),
        httpOnly: false,
        sameSite: 'Lax',
        ...(cookie.expires && Number.isFinite(Date.parse(cookie.expires)) ? { expires: Date.parse(cookie.expires) / 1000 } : {})
      }))
    });
    if (result.success === false) throw new CliError('Chrome rejected auth cookies.');
    await command('Page.navigate', { url: destination });
  } finally {
    socket.close();
  }
}

async function login(options: Options): Promise<void> {
  const customerId = required(options, 'customerId');
  const browserPort = required(options, 'browserPort');
  const host = required(options, 'host');
  const proxyUrl = options.proxyUrl;
  const securePort = options.securePort;
  const impersonate = options.impersonate === true;
  if (options.impersonate !== undefined && options.impersonate !== true) {
    throw new CliError('--impersonate does not accept a value.', 2);
  }
  if (proxyUrl === true) throw new CliError('--proxy-url requires a value.', 2);
  if (proxyUrl && !['local', 'local-https'].includes(host)) {
    throw new CliError('--proxy-url is only for testing a local UI against local backends.', 2);
  }
  const target =
    host === 'local'
      ? { origin: 'http://localhost:3001', destination: 'http://localhost:3001/purchase/' }
      : host === 'local-https'
        ? (() => {
            const port = proxyPort(securePort === true || !securePort ? '443' : securePort);
            const origin = `https://localhost.carvana.com${port === 443 ? '' : `:${port}`}`;
            return { origin, destination: `${origin}/purchase/` };
          })()
      : host === 'testazure'
        ? { origin: 'https://testazure.carvana.com', destination: 'https://testazure.carvana.com/purchase' }
        : null;
  if (!target) throw new CliError('--host must be local, local-https, or testazure.', 2);
  await browserTarget(browserPort, target.origin);
  const [cookies, apiJwt] = await Promise.all([
    authCookies(customerId, impersonate),
    proxyUrl ? customerApiJwt(customerId, impersonate) : Promise.resolve(undefined)
  ]);
  if (proxyUrl && apiJwt) await registerProxyTokens(proxyUrl, cookies, apiJwt);
  await injectCookies(browserPort, cookies, target.origin, target.destination);
  output({ status: 'authenticated', host, destination: target.destination, impersonate, ...(proxyUrl ? { proxyRegistered: proxyUrl } : {}) });
}

async function preflightFeature(options: Options): Promise<void> {
  const component = required(options, 'component');
  let key: string;
  let url: string;
  if (component === 'verifx') {
    key = required(options, 'branch').replace(/[^a-zA-Z0-9]/g, '-');
    url = `https://static.fastly.carvanatech.com/purchase-verifications-module/features/assets-manifest-${key}.json`;
  } else if (component === 'checkout') {
    key = required(options, 'artifactKey');
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new CliError('Invalid Checkout artifact key.', 2);
    url = `https://assets.fastly.carvanatech.com/acquisition/purchase-ui/features/index-${key}.html`;
  } else {
    throw new CliError('--component must be checkout or verifx.', 2);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new CliError('Feature artifact could not be reached.');
  }
  await response.body?.cancel();
  if (!response.ok) throw new CliError(`Feature artifact returned HTTP ${response.status}.`);
  output({ component, key, url, status: response.status, contentType: response.headers.get('content-type') });
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command, ...values] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || values.includes('--help') || values.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'stage') return stage(parseOptions(values, ['blueprintId']));
  if (command === 'login') return login(parseOptions(values, ['customerId', 'host', 'browserPort', 'securePort', 'proxyUrl', 'impersonate']));
  if (command === 'proxy') return proxyCommand(values);
  if (command === 'https') return httpsCommand(values);
  if (command === 'preflight-feature') return preflightFeature(parseOptions(values, ['component', 'branch', 'artifactKey']));
  throw new CliError(`Unknown command: ${command}`, 2);
}

main().catch((error: unknown) => {
  const safe = error instanceof CliError ? error : new CliError('The command failed unexpectedly.');
  process.stderr.write(`${JSON.stringify({ error: safe.message })}\n`);
  process.exitCode = safe.exitCode;
});
