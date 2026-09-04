#!/usr/bin/env bun

import {
  readdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const proxyPort = Number(process.env.CHROME_DEVTOOLS_PROXY_PORT || 9222);
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const proxyScript = join(
  homedir(),
  ".config/opencode/mcp/chrome-devtools-proxy/server.ts",
);
const proxyVersion = Bun.hash(await Bun.file(proxyScript).text()).toString(16);

const loadProxyHealth = async () => {
  const response = await fetch(`${proxyUrl}/healthz`);
  if (!response.ok) return undefined;
  return (await response.json()) as {
    ok?: boolean;
    pid?: number;
    version?: string;
  };
};

const ensureProxy = async () => {
  let health: Awaited<ReturnType<typeof loadProxyHealth>>;
  try {
    health = await loadProxyHealth();
  } catch { }

  if (health?.ok && health.version === proxyVersion) return;

  if (health?.ok && Number.isInteger(health.pid)) {
    const commandLine = readFileSync(`/proc/${health.pid}/cmdline`, "utf8").split("\0");
    if (!commandLine.includes(proxyScript)) {
      throw new Error(`Port ${proxyPort} is owned by an unexpected process`);
    }
    process.kill(health.pid!, "SIGTERM");

    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      await Bun.sleep(50);
      try {
        await loadProxyHealth();
      } catch {
        stopped = true;
        break;
      }
    }
    if (!stopped) throw new Error(`Chrome DevTools proxy on port ${proxyPort} did not stop`);
  } else if (health?.ok) {
    throw new Error(`Chrome DevTools proxy on port ${proxyPort} must be restarted`);
  }

  Bun.spawn(["bun", proxyScript], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  }).unref();

  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(50);
    try {
      const health = await loadProxyHealth();
      if (health?.ok && health.version === proxyVersion) return;
    } catch { }
  }

  throw new Error(`Chrome DevTools proxy did not start on port ${proxyPort}`);
};

const pickFreePort = (): number => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() { } },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
};

const installCommand = "npx playwright install chromium";

const loadExtensionPaths = (): string[] | undefined => {
  const configuration = process.env.CHROME_DEVTOOLS_EXTENSIONS;
  if (configuration === undefined) return undefined;

  let configuredPaths: unknown;
  try {
    configuredPaths = JSON.parse(configuration);
  } catch {
    throw new Error(
      "CHROME_DEVTOOLS_EXTENSIONS must be a JSON array of extension directory paths",
    );
  }

  if (
    !Array.isArray(configuredPaths) ||
    configuredPaths.some((extensionPath) => typeof extensionPath !== "string")
  ) {
    throw new Error(
      "CHROME_DEVTOOLS_EXTENSIONS must be a JSON array of extension directory paths",
    );
  }

  return configuredPaths.map((configuredPath) => {
    const expandedPath = configuredPath.startsWith("~/")
      ? join(homedir(), configuredPath.slice(2))
      : configuredPath === "~"
        ? homedir()
        : configuredPath;
    const absolutePath = resolve(expandedPath);

    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
      throw new Error(`Extension directory does not exist: ${absolutePath}`);
    }

    const extensionPath = realpathSync(absolutePath);
    if (extensionPath.includes(",")) {
      throw new Error(`Extension directory path cannot contain a comma: ${extensionPath}`);
    }
    if (!existsSync(join(extensionPath, "manifest.json"))) {
      throw new Error(`Extension directory is missing manifest.json: ${extensionPath}`);
    }

    return extensionPath;
  });
};

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
const extensionPaths = loadExtensionPaths();
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
  } catch { }
};

await register();

const browserContext = `The browser runs headless inside this code server's container. It has access to workspace files (file:// works) and all localhost ports. Each opencode session gets a fresh isolated browser profile. This browser's Chrome DevTools Protocol port is ${debugPort}.`;
const browserStartRequestId = "__opencode_browser_start__";

const rewriteToolDescriptions = async (
  stdout: ReadableStream<Uint8Array>,
) => {
  const decoder = new TextDecoder();
  let buffer = "";

  const writeLine = (line: string) => {
    try {
      const message = JSON.parse(line);
      if (message?.id === browserStartRequestId) {
        if (message.error) {
          console.error(`Failed to start Chromium: ${JSON.stringify(message.error)}`);
        }
        return;
      }
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

const command = [
  "bunx",
  "chrome-devtools-mcp@0.26.0",
  "--executablePath",
  chromiumPath,
  "--headless",
  "--isolated",
  "--viewport",
  "1366x1024",
  "--chromeArg=--no-sandbox",
  "--chromeArg=--disable-dev-shm-usage",
  "--chromeArg=--no-zygote",
  "--chromeArg=--disable-gpu",
  "--chromeArg=--ignore-certificate-errors",
  `--chromeArg=--remote-debugging-port=${debugPort}`,
  "--chromeArg=--remote-allow-origins=*",
  "--usageStatistics=false",
  "--performanceCrux=false",
];

if (extensionPaths) {
  command.push("--categoryExtensions");
  if (extensionPaths.length > 0) {
    command.push(`--chromeArg=--load-extension=${extensionPaths.join(",")}`);
  }
}

const child = Bun.spawn(
  command,
  {
    stdin: "pipe",
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

const forwardInput = async (stdin: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let buffer = "";
  let browserStartRequested = false;

  const writeLine = (line: string) => {
    child.stdin.write(`${line}\n`);

    if (browserStartRequested) return;
    try {
      const message = JSON.parse(line);
      if (message?.method !== "notifications/initialized") return;

      browserStartRequested = true;
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: browserStartRequestId,
          method: "tools/call",
          params: { name: "list_pages", arguments: {} },
        })}\n`,
      );
    } catch { }
  };

  for await (const chunk of stdin) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      writeLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    child.stdin.flush();
  }

  buffer += decoder.decode();
  if (buffer) writeLine(buffer);
  child.stdin.end();
};

let stopping = false;
const stop = async (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(5000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
  await child.exited;
  await unregister();
  process.exit(0);
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

void forwardInput(process.stdin).catch((error) => {
  if (!stopping) console.error(`MCP input forwarding failed: ${error}`);
});
const stdoutDone = rewriteToolDescriptions(child.stdout);
const exitCode = await child.exited;
await stdoutDone;
await unregister();
process.exit(exitCode);
