#!/usr/bin/env bun

type JsonRecord = Record<string, unknown>;
type Options = Record<string, string | true>;

interface AuthCookie {
  name: string;
  value: string;
  expires?: string;
}

const URLS = {
  token: 'https://apps.carvanatech.com/edge/authserver/connect/token',
  pb: 'https://apps.carvanatech.com/qe/pbredux',
  authCookies: 'https://apps.carvanatech.com/oec/paymentstesting/api/v1/testazure/auth-cookies'
};
const CONSUMER_USER = 'trevor.sharp@carvana.com';

const HELP = `Usage:
  purchase-ui.ts stage --blueprint-id ID
  purchase-ui.ts login --customer-id ID --host local|testazure --browser-instance ID
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

async function authCookies(customerId: string): Promise<AuthCookie[]> {
  const value = await serviceRequest(URLS.authCookies, {
    method: 'POST',
    body: { customerId, impersonate: false }
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

async function browserTarget(instanceId: string, origin: string): Promise<string> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(instanceId)) throw new CliError('Invalid MCP session ID.');
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:9222/cdp/${instanceId}/json/list`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new CliError('Could not reach the Chrome DevTools MCP proxy.');
  }
  const targets = await responseValue(response);
  if (!response.ok || !Array.isArray(targets)) throw new CliError('MCP session was not found.');
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

async function injectCookies(instanceId: string, cookies: AuthCookie[], origin: string, destination: string): Promise<void> {
  const socket = new WebSocket(await browserTarget(instanceId, origin));
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
  const browserInstance = required(options, 'browserInstance');
  const host = required(options, 'host');
  const target =
    host === 'local'
      ? { origin: 'http://localhost:3001', destination: 'http://localhost:3001/purchase/' }
      : host === 'testazure'
        ? { origin: 'https://testazure.carvana.com', destination: 'https://testazure.carvana.com/purchase' }
        : null;
  if (!target) throw new CliError('--host must be local or testazure.', 2);
  await browserTarget(browserInstance, target.origin);
  const cookies = await authCookies(customerId);
  await injectCookies(browserInstance, cookies, target.origin, target.destination);
  output({ status: 'authenticated', host, destination: target.destination });
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
  if (command === 'login') return login(parseOptions(values, ['customerId', 'host', 'browserInstance']));
  if (command === 'preflight-feature') return preflightFeature(parseOptions(values, ['component', 'branch', 'artifactKey']));
  throw new CliError(`Unknown command: ${command}`, 2);
}

main().catch((error: unknown) => {
  const safe = error instanceof CliError ? error : new CliError('The command failed unexpectedly.');
  process.stderr.write(`${JSON.stringify({ error: safe.message })}\n`);
  process.exitCode = safe.exitCode;
});
