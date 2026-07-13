#!/usr/bin/env bun

import { lookup } from "node:dns/promises";

const cdpHost = process.env.CDP_HOST || "host.docker.internal";
const cdpPort = process.env.CDP_PORT || "9222";

const browserContext =
  "IMPORTANT: The browser runs outside this code server, has no file access, and can use localhost only on ports 3000-3002. Never use file:// or any other port.";

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
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    fatalChromeUnavailable();
  }

  if (!response.ok) {
    fatalChromeUnavailable();
  }

  const version = (await response.json()) as { webSocketDebuggerUrl?: string };

  if (!version.webSocketDebuggerUrl) {
    console.error(
      `ERROR: Could not parse WebSocket URL from Chrome at ${cdpHost}:${cdpPort}`,
    );
    process.exit(1);
  }

  const webSocketUrl = new URL(version.webSocketDebuggerUrl);
  webSocketUrl.hostname = (await lookup(cdpHost)).address;
  webSocketUrl.port = cdpPort;

  return webSocketUrl.toString();
};

const webSocketUrl = await getWebSocketUrl();

const rewriteToolDescriptions = async (
  stdout: ReadableStream<Uint8Array>,
) => {
  const decoder = new TextDecoder();
  let buffer = "";

  const writeLine = (line: string) => {
    try {
      const message = JSON.parse(line);
      const tools = message?.result?.tools;

      if (Array.isArray(tools)) {
        for (const tool of tools) {
          tool.description = `${browserContext}\n\n${tool.description || ""}`;
        }
      }

      process.stdout.write(`${JSON.stringify(message)}\n`);
    } catch {
      process.stdout.write(`${line}\n`);
    }
  };

  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      writeLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer) writeLine(buffer);
};

const child = Bun.spawn(
  [
    "bunx",
    "chrome-devtools-mcp@0.26.0",
    "--wsEndpoint",
    webSocketUrl,
    "--usageStatistics=false",
    "--performanceCrux=false",
  ],
  {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
    },
  },
);

const stdoutDone = rewriteToolDescriptions(child.stdout);
const exitCode = await child.exited;
await stdoutDone;
process.exit(exitCode);
