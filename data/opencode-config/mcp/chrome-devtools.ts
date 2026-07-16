#!/usr/bin/env bun

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const proxyPort = Number(process.env.CHROME_DEVTOOLS_PROXY_PORT || 9222);
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const proxyScript = join(
  homedir(),
  ".config/opencode/mcp/chrome-devtools-proxy/server.ts",
);

const ensureProxy = async () => {
  try {
    const response = await fetch(`${proxyUrl}/healthz`);
    if (response.ok) return;
  } catch {}

  Bun.spawn(["bun", proxyScript], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  }).unref();

  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(50);
    try {
      const response = await fetch(`${proxyUrl}/healthz`);
      if (response.ok) return;
    } catch {}
  }

  throw new Error(`Chrome DevTools proxy did not start on port ${proxyPort}`);
};

const pickFreePort = (): number => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
};

const debugPort = pickFreePort();

await ensureProxy();

const instanceId = crypto.randomUUID().slice(0, 8);
const instanceUrl = `${proxyUrl}/api/instances/${instanceId}`;
const registration = {
  id: instanceId,
  port: debugPort,
  pid: process.pid,
  startedAt: new Date().toISOString(),
};

const register = async () => {
  const response = await fetch(`${proxyUrl}/api/instances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  if (!response.ok) throw new Error(`Proxy registration failed: ${response.status}`);
};

const unregister = async () => {
  try {
    await fetch(instanceUrl, { method: "DELETE" });
  } catch {}
};

await register();

const browserContext = `The browser runs headless inside this code server's container. It has access to workspace files (file:// works) and all localhost ports. Each opencode session gets a fresh isolated browser profile. This session is ${instanceId} in the Chrome DevTools dashboard on port ${proxyPort}. The first time you use a browser tool in a session, tell the user they can monitor it from that dashboard.`;

const installCommand = "npx playwright install chromium";

const findChromium = (): string => {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  const cacheDir = join(homedir(), ".cache", "ms-playwright");

  const candidates = existsSync(cacheDir)
    ? readdirSync(cacheDir)
        .filter((entry) => /^chromium-\d+$/.test(entry))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .map((entry) => join(cacheDir, entry, "chrome-linux", "chrome"))
        .filter((path) => existsSync(path))
    : [];

  if (candidates.length === 0) {
    console.error(`ERROR: Chromium not found in ${cacheDir}.

Install it inside the container with:

  ${installCommand}`);
    process.exit(1);
  }

  return candidates[0];
};

const chromiumPath = findChromium();

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
    "--executablePath",
    chromiumPath,
    "--headless",
    "--isolated",
    "--viewport",
    "1920x911",
    "--chromeArg=--no-sandbox",
    "--chromeArg=--disable-dev-shm-usage",
    "--chromeArg=--no-zygote",
    "--chromeArg=--disable-gpu",
    `--chromeArg=--remote-debugging-port=${debugPort}`,
    "--chromeArg=--remote-allow-origins=*",
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
      XDG_CONFIG_HOME: "/tmp/chrome-devtools-mcp-xdg",
      XDG_CACHE_HOME: "/tmp/chrome-devtools-mcp-xdg",
    },
  },
);

let stopping = false;
const stop = async (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  await child.exited;
  await unregister();
  process.exit(0);
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

const stdoutDone = rewriteToolDescriptions(child.stdout);
const exitCode = await child.exited;
await stdoutDone;
await unregister();
process.exit(exitCode);
