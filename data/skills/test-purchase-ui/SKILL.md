---
name: test-purchase-ui
description: Stage TEST purchases from PB Redux blueprints, log test users into local CheckoutUI or testazure through Chrome DevTools MCP, proxy local UI calls to selected local backends, and configure CheckoutUI or VerificationsUI testazure feature overrides.
---

# Test Purchase UI

Executable: [`purchase-ui.ts`](./purchase-ui.ts). Resolve the linked file relative to this skill before running it.

## Stage A Blueprint

Use the user-provided blueprint ID unchanged:

```bash
purchase-ui.ts stage --blueprint-id <id>
```

The command fetches the blueprint, runs its requirements gate, executes the workflow once, and returns `customerId`, optional `purchaseId`, and `requestId`.

## Log In

1. Call Chrome DevTools MCP `list_pages` to initialize this session's browser.
2. Use the port shown in the Chrome DevTools tool description as `--browser-port`.
3. Run one of:

```bash
purchase-ui.ts login --customer-id <id> --host local --browser-port <port>
purchase-ui.ts login --customer-id <id> --host testazure --browser-port <port>
```

`local` navigates to `http://localhost:3001/purchase/`. `testazure` navigates to `https://testazure.carvana.com/purchase`. Continue browser work through Chrome DevTools MCP after login.

Add `--impersonate` when the browser and local backend proxy should authenticate as someone impersonating the customer.

## Local UI With Local Backends

Use the local backend proxy only when a local CheckoutUI or VerificationsUI must call one or more locally running backend services and those calls fail because the browser sends a phantom access token. Do not use it for testazure, for a local UI calling TEST backends, or merely because the UI is running locally.

The proxy is independent of service names and ports. Configure only the backends that are running locally:

```bash
purchase-ui.ts proxy start \
  --port <proxy-port> \
  --route /oec/<service-a>=http://localhost:<service-a-port> \
  --route /oec/<service-b>=http://localhost:<service-b-port>
```

Each route strips its matched prefix. For example, `/oec/purchasepayments/api/v1/payment-method/summary` with `/oec/purchasepayments=http://localhost:5274` forwards to `http://localhost:5274/api/v1/payment-method/summary`.

Point only the selected API variables in the UI's local environment file at the proxy. Example:

```text
PURCHASE_PAYMENTS_API_URL=http://127.0.0.1:<proxy-port>/oec/purchasepayments
```

Register the staged customer's phantom-token/JWT pair while logging into the local UI:

```bash
purchase-ui.ts login \
  --customer-id <id> \
  --host local \
  --browser-port <port> \
  --proxy-url http://127.0.0.1:<proxy-port>
```

The proxy keeps token mappings in memory, binds only to loopback, and does not log tokens. Run the login command again for each customer and after restarting the proxy.

Add `--impersonate` to the login command to register an impersonated customer API JWT.

Check or stop it with:

```bash
purchase-ui.ts proxy status --port <proxy-port>
purchase-ui.ts proxy stop --port <proxy-port>
```

## HTTPS Testing

For secure-context features, keep both development servers on HTTP. The HTTPS gateway terminates TLS only for CheckoutUI. VerificationsUI remains an independent HTTP server and is not routed or rewritten through the gateway.

Start CheckoutUI on `http://127.0.0.1:3001` and VerificationsUI on `http://127.0.0.1:3002`, then run:

```bash
purchase-ui.ts https start
```

When the local backend proxy is in use, expose its configured routes through the same secure origin:

```bash
purchase-ui.ts https start --proxy-url http://127.0.0.1:<proxy-port>
```

The command creates temporary certificate material under `/tmp`, starts a detached gateway, and serves `https://localhost.carvana.com/purchase/`. It does not proxy, rewrite, or otherwise change VerificationsUI. Never point the browser at `https://localhost.carvana.com:3002` or `https://localhost:3002`.

Log in directly on the secure origin so the auth cookies have the correct domain and security attributes:

```bash
purchase-ui.ts login \
  --customer-id <id> \
  --host local-https \
  --browser-port <port> \
  --proxy-url http://127.0.0.1:<proxy-port>
```

The self-signed certificate may show Chrome's privacy interstitial. Select **Advanced**, then **Proceed to localhost.carvana.com** once. Confirm the CheckoutUI app bundle returns `200`, then verify `window.isSecureContext` before continuing.

Check or stop the gateway with:

```bash
purchase-ui.ts https status
purchase-ui.ts https stop
```

The gateway state and logs are `/tmp/purchase-ui-https-443.json` and `/tmp/purchase-ui-https-443.log`.

`ApplePaySession` is unavailable in the Linux Chromium browser even when `window.isSecureContext` is true. Treat that as a platform limitation and report it immediately; do not mock the API or repeatedly rebuild the HTTPS gateway. Use Safari on macOS for the real Apple Pay sheet.

## Feature Overrides

Open `https://testazure.carvana.com/purchase` in the MCP browser. Preflight the published artifact before setting its cookies.

CheckoutUI:

```bash
purchase-ui.ts preflight-feature --component checkout --artifact-key <published-key>
```

Run with Chrome DevTools MCP `evaluate_script`:

```js
() => {
  document.cookie = "cvna-feature-enable=true; Path=/; SameSite=Lax";
  document.cookie = `cvna-feature-name=${encodeURIComponent("<published-key>")}; Path=/; SameSite=Lax`;
  return "configured";
};
```

VerificationsUI:

```bash
purchase-ui.ts preflight-feature --component verifx --branch '<branch>'
```

Run with Chrome DevTools MCP `evaluate_script`:

```js
() => {
  document.cookie = "cvna-local-verifx=; Path=/; Max-Age=0; SameSite=Lax";
  document.cookie = `cvna-verifx-feature-branch=${encodeURIComponent("<branch>")}; Path=/; SameSite=Lax`;
  return "configured";
};
```

Reload with cache disabled. Confirm the Checkout `index-<published-key>.html` or VerifX `assets-manifest-<branch-with-nonalphanumerics-replaced-by-hyphens>.json` request in Chrome DevTools MCP network traffic.

Clear overrides with `evaluate_script`:

```js
() => {
  const expire = "Path=/; Max-Age=0; SameSite=Lax";
  for (const name of [
    "cvna-feature-enable",
    "cvna-feature-name",
    "cvna-local-verifx",
    "cvna-verifx-feature-branch",
  ]) {
    document.cookie = `${name}=; ${expire}`;
  }
  return "cleared";
};
```
