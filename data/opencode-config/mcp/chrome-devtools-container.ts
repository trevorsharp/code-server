#!/usr/bin/env bun

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

const browserContext = `The browser runs headless inside this code server's container. It has access to workspace files (file:// works) and all localhost ports. Each opencode session gets a fresh isolated browser profile. This session's browser exposes CDP debugging on localhost:${debugPort} — the first time you use a browser tool in a session, tell the user this port so they can monitor the browser from their host machine (SSH tunnel + chrome://inspect).`;

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
    "1280x720",
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

const stdoutDone = rewriteToolDescriptions(child.stdout);
const exitCode = await child.exited;
await stdoutDone;
process.exit(exitCode);
