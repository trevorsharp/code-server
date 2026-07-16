#!/usr/bin/env bun

import { existsSync } from "node:fs";

type Instance = {
  id: string;
  port: number;
  pid: number;
  startedAt: string;
};

type SocketData = {
  upstream: WebSocket;
  downstream?: Bun.ServerWebSocket<SocketData>;
  pending: Array<string | Uint8Array>;
};

const port = Number(process.env.CHROME_DEVTOOLS_PROXY_PORT || 9222);
const instances = new Map<string, Instance>();
const dashboard = Bun.file(`${import.meta.dir}/index.html`);

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

const externalOrigin = (request: Request) => {
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto") || url.protocol.slice(0, -1);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  return { protocol, host };
};

const rewriteWebSocketUrl = (value: string, instanceId: string, request: Request) => {
  const upstream = new URL(value);
  const { protocol, host } = externalOrigin(request);
  upstream.protocol = protocol === "https" ? "wss:" : "ws:";
  upstream.host = host;
  upstream.pathname = `/cdp/${instanceId}${upstream.pathname}`;
  return upstream.toString();
};

const rewriteFrontendUrl = (
  webSocketDebuggerUrl: string | undefined,
  instanceId: string,
  request: Request,
) => {
  if (!webSocketDebuggerUrl) return undefined;

  const { protocol, host } = externalOrigin(request);
  const websocketPath = new URL(webSocketDebuggerUrl).pathname;
  const websocketTarget = `${host}/cdp/${instanceId}${websocketPath}`;
  const frontend = new URL(
    `/cdp/${instanceId}/devtools/inspector.html`,
    `${protocol}://${host}`,
  );
  frontend.searchParams.set(protocol === "https" ? "wss" : "ws", websocketTarget);
  return frontend.toString();
};

const rewriteCdpPayload = (value: unknown, instanceId: string, request: Request): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteCdpPayload(entry, instanceId, request));
  }

  if (!value || typeof value !== "object") return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      rewriteCdpPayload(entry, instanceId, request),
    ]),
  ) as Record<string, unknown>;

  const websocketUrl =
    typeof value.webSocketDebuggerUrl === "string"
      ? value.webSocketDebuggerUrl
      : undefined;

  if (websocketUrl) {
    result.webSocketDebuggerUrl = rewriteWebSocketUrl(
      websocketUrl,
      instanceId,
      request,
    );
  }

  if (typeof value.devtoolsFrontendUrl === "string") {
    result.devtoolsFrontendUrl = rewriteFrontendUrl(
      websocketUrl,
      instanceId,
      request,
    );
  }

  return result;
};

const loadInstance = async (instance: Instance, request: Request) => {
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/json/list`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) throw new Error(`CDP returned ${response.status}`);
    const rewrittenTargets = rewriteCdpPayload(
      await response.json(),
      instance.id,
      request,
    ) as Array<Record<string, unknown>>;
    const targets = rewrittenTargets
      .filter(
        (target) => target.type === "page" && target.url !== "about:blank",
      )
      .map((target) => ({
        ...target,
        inspectUrl:
          typeof target.devtoolsFrontendUrl === "string"
            ? target.devtoolsFrontendUrl
            : undefined,
      }));
    return { ...instance, online: true, targets };
  } catch {
    return { ...instance, online: false, targets: [] };
  }
};

const instanceFromPath = (pathname: string) => {
  const match = pathname.match(/^\/cdp\/([^/]+)(\/.*)?$/);
  if (!match) return undefined;
  return {
    instance: instances.get(decodeURIComponent(match[1])),
    upstreamPath: match[2] || "/",
  };
};

const server = Bun.serve<SocketData>({
  hostname: "0.0.0.0",
  port,
  async fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname === "/") return new Response(dashboard);
    if (url.pathname === "/healthz") return json({ ok: true });

    if (url.pathname === "/api/instances" && request.method === "GET") {
      const active = await Promise.all(
        [...instances.values()]
          .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
          .map((instance) => loadInstance(instance, request)),
      );
      return json(active);
    }

    if (url.pathname === "/api/instances" && request.method === "POST") {
      try {
        const instance = (await request.json()) as Instance;
        if (
          !/^[a-zA-Z0-9-]{1,64}$/.test(instance.id) ||
          !Number.isInteger(instance.port) ||
          instance.port < 1 ||
          instance.port > 65535 ||
          !Number.isInteger(instance.pid) ||
          instance.pid < 1
        ) {
          return json({ error: "Invalid instance" }, 400);
        }

        instances.set(instance.id, {
          ...instance,
          startedAt: instance.startedAt || new Date().toISOString(),
        });
        return json({ ok: true }, 201);
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
    }

    const deleteMatch = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      instances.delete(decodeURIComponent(deleteMatch[1]));
      return new Response(null, { status: 204 });
    }

    const route = instanceFromPath(url.pathname);
    if (!route?.instance) return new Response("Not found", { status: 404 });

    const upstreamUrl = new URL(
      `${route.upstreamPath}${url.search}`,
      `http://127.0.0.1:${route.instance.port}`,
    );

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const socketData = {
        upstream: undefined,
        pending: [],
      } as unknown as SocketData;
      const upstream = new WebSocket(upstreamUrl.toString().replace(/^http/, "ws"));
      socketData.upstream = upstream;

      upstream.addEventListener("open", () => {
        for (const message of socketData.pending) upstream.send(message);
        socketData.pending.length = 0;
      });
      upstream.addEventListener("message", async (event) => {
        if (!socketData.downstream) return;
        if (event.data instanceof Blob) {
          socketData.downstream.send(await event.data.arrayBuffer());
        } else {
          socketData.downstream.send(event.data);
        }
      });
      upstream.addEventListener("close", (event) => {
        const code = [1005, 1006, 1015].includes(event.code) ? 1000 : event.code;
        socketData.downstream?.close(code || 1000, event.reason);
      });
      upstream.addEventListener("error", () => socketData.downstream?.close(1011));

      if (bunServer.upgrade(request, { data: socketData })) return;
      upstream.close();
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    if (url.pathname.includes("/json")) {
      const contentType = upstreamResponse.headers.get("content-type") || "";
      if (contentType.includes("json")) {
        const payload = rewriteCdpPayload(
          await upstreamResponse.json(),
          route.instance.id,
          request,
        );
        return json(payload, upstreamResponse.status);
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  },
  websocket: {
    open(socket) {
      socket.data.downstream = socket;
    },
    message(socket, message) {
      if (socket.data.upstream.readyState === WebSocket.OPEN) {
        socket.data.upstream.send(message);
      } else {
        socket.data.pending.push(
          typeof message === "string" ? message : new Uint8Array(message),
        );
      }
    },
    close(socket) {
      socket.data.upstream.close();
    },
  },
});

setInterval(() => {
  for (const [instanceId, instance] of instances) {
    if (!existsSync(`/proc/${instance.pid}`)) instances.delete(instanceId);
  }
}, 5000).unref();

console.log(`Chrome DevTools proxy listening on ${server.url}`);
