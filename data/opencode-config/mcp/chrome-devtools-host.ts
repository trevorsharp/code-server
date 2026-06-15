#!/usr/bin/env bun

const cdpHost = process.env.CDP_HOST || 'host.docker.internal';
const cdpPort = process.env.CDP_PORT || '9222';

const chromeCommand = `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
  --remote-debugging-port=9222 \\
  --remote-allow-origins=* \\
  --no-first-run --no-default-browser-check \\
  --user-data-dir=/tmp/chrome-testing-automation`;

const fatalChromeUnavailable = (): never => {
  console.error(`ERROR: Chrome not reachable at ${cdpHost}:${cdpPort}.

Start it on the Mac host with:

  ${chromeCommand}`);
  process.exit(1);
};

const getWebSocketUrl = async () => {
  let response: Response;

  try {
    response = await fetch(`http://${cdpHost}:${cdpPort}/json/version`, {
      headers: { Host: `localhost:${cdpPort}` },
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    fatalChromeUnavailable();
  }

  if (!response.ok) {
    fatalChromeUnavailable();
  }

  const version = (await response.json()) as { webSocketDebuggerUrl?: string };

  if (!version.webSocketDebuggerUrl) {
    console.error(`ERROR: Could not parse WebSocket URL from Chrome at ${cdpHost}:${cdpPort}`);
    process.exit(1);
  }

  const webSocketUrl = new URL(version.webSocketDebuggerUrl);
  webSocketUrl.hostname = cdpHost;
  webSocketUrl.port = cdpPort;

  return webSocketUrl.toString();
};

const webSocketUrl = await getWebSocketUrl();
const child = Bun.spawn(
  [
    'bunx',
    'chrome-devtools-mcp@0.26.0',
    '--wsEndpoint',
    webSocketUrl,
    '--usageStatistics=false',
    '--performanceCrux=false'
  ],
  {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1'
    }
  }
);

process.exit(await child.exited);
