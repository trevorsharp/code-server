---
name: test-purchase-ui
description: Stage TEST purchases from PB Redux blueprints, log test users into local CheckoutUI or testazure through Chrome DevTools MCP, and configure CheckoutUI or VerificationsUI testazure feature overrides.
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
2. Use the session ID shown in the Chrome DevTools tool description as `--browser-instance`.
3. Run one of:

```bash
purchase-ui.ts login --customer-id <id> --host local --browser-instance <session-id>
purchase-ui.ts login --customer-id <id> --host testazure --browser-instance <session-id>
```

`local` navigates to `http://localhost:3001/purchase/`. `testazure` navigates to `https://testazure.carvana.com/purchase`. Continue browser work through Chrome DevTools MCP after login.

## Feature Overrides

Open `https://testazure.carvana.com/purchase` in the MCP browser. Preflight the published artifact before setting its cookies.

CheckoutUI:

```bash
purchase-ui.ts preflight-feature --component checkout --artifact-key <published-key>
```

Run with Chrome DevTools MCP `evaluate_script`:

```js
() => {
  document.cookie = 'cvna-feature-enable=true; Path=/; SameSite=Lax';
  document.cookie = `cvna-feature-name=${encodeURIComponent('<published-key>')}; Path=/; SameSite=Lax`;
  return 'configured';
}
```

VerificationsUI:

```bash
purchase-ui.ts preflight-feature --component verifx --branch '<branch>'
```

Run with Chrome DevTools MCP `evaluate_script`:

```js
() => {
  document.cookie = 'cvna-local-verifx=; Path=/; Max-Age=0; SameSite=Lax';
  document.cookie = `cvna-verifx-feature-branch=${encodeURIComponent('<branch>')}; Path=/; SameSite=Lax`;
  return 'configured';
}
```

Reload with cache disabled. Confirm the Checkout `index-<published-key>.html` or VerifX `assets-manifest-<branch-with-nonalphanumerics-replaced-by-hyphens>.json` request in Chrome DevTools MCP network traffic.

Clear overrides with `evaluate_script`:

```js
() => {
  const expire = 'Path=/; Max-Age=0; SameSite=Lax';
  for (const name of ['cvna-feature-enable', 'cvna-feature-name', 'cvna-local-verifx', 'cvna-verifx-feature-branch']) {
    document.cookie = `${name}=; ${expire}`;
  }
  return 'cleared';
}
```
