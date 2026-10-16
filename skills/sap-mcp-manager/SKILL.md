---
name: sap-mcp-manager
description: "Install, configure, diagnose, start, stop, restart, and upgrade a local SAP MCP server through its terminal CLI. Use for managing the tool itself from Codex or another terminal-capable AI client; use SAP MCP tools for ABAP development and business queries."
---

# SAP MCP Manager

Work in the user's SAP MCP checkout (`package.json` name `sap-mcp`). Use the project directory already available in context; ask for the location only if unknown. This workflow needs a local terminal and Windows for credential entry. It does not depend on an already-running MCP connection.

## Inspect and install

Use `node dist/cli.js status --json` and `node dist/cli.js doctor --json`. Invoke Node directly so npm banners do not break JSON parsing. Every operational JSON result has `schema_version`, `status`, and `data` or `error`; also inspect the process exit code. A completed doctor command can have `status=success` but exit 1 and `data.healthy=false` because checks failed. By default doctor makes no SAP request; `--connection <name>` explicitly tests that login and ADT discovery.

If Node or the compiled CLI is missing, inspect the environment first. The project requires Node.js 22+. Install the checkout's pinned dependencies with `npm ci --ignore-scripts` and build with `npm run build`. Do not run a broad dependency upgrade or `npm audit fix --force` as setup. Respect user-selected installation paths and versions.

Report the diagnosed cause and perform the authorized fix. Do not keep retrying an unchanged failure. `unknown`, `unresponsive`, or `lease.guard_present=true` requires inspection; never delete a lock or kill a process just to make startup succeed.

## Configure connections and credentials

Use `node dist/cli.js connection list --json` to find the exact name and Client. Names allow English letters, digits, `_` and `-`; Client is exactly three digits. Keep writes off unless the user requests enabling them. Treat the user's request for a named operation as authorization; do not ask for duplicate confirmation.

For a new connection, collect only non-secret fields and run:

```powershell
node dist/cli.js connection add dev --url https://sap-host:443 --client 001 --username SAPUSER --language EN --password-prompt --json
```

Explain that a local password window will appear, then let the human enter the password there. Never ask for a password in chat, pass it on the command line or through an environment variable, or print credential-store content. `--json` never prompts in the terminal; without `--password-prompt`, a required password produces `INTERACTION_REQUIRED`. Cancelled input must not be retried automatically. Passwords are stored under the connection UUID in the current Windows user's credential store.

Edit with `connection edit <name>` and the desired flags (`--url`, `--client`, `--username`, `--language`, `--enable-writes`, `--disable-writes`). A changed login identity requires a fresh password and cannot reuse the old host's credential. Connection mutations require the runtime to be stopped. If it was a managed running instance, save its port, stop it, make the requested change, then restore it on that port. If the change fails without saving, restore the prior managed service when possible. Test the selected SAP connection with `connection test <name> --json`; login success does not establish all SAP permissions.

Remove a connection with `connection remove <name> --yes --json` only when removal of that specific connection and credential is intended. The flag avoids a terminal question; it does not expand user authorization.

## Tokens and client setup

List token IDs with `token list --json`. To create a token, choose a new file in the user's local private configuration area and use `token create --out <absolute-file> --json`. The result returns the token ID and path, never the secret. Existing files are not overwritten. Do not create a new token merely to check an existing installation.

Use `client-config --token-file <file> --out <new-file> --json` to export connection parameters. This artifact contains a bearer token: do not print, attach, commit or paste it into chat. It is a product-independent transport/URL/header bundle, not a guaranteed Codex or WorkBuddy settings schema. Inspect the chosen client's existing configuration and supported format before installing these values; preserve unrelated entries and keep a local backup. Read/write secret values inside a local script without sending them to tool output. Never invent a client settings path or claim that creating this file verifies client connectivity.

Revoke only the intended token ID with `token revoke <id> --json`. Revoking a token does not erase copies in client files; remove those only when that cleanup is in scope.

## Start, stop, restart and recover

```powershell
node dist/cli.js service start --port 8765 --json
node dist/cli.js service status --json
node dist/cli.js service restart --json
node dist/cli.js service stop --json
```

Startup needs at least one token. A managed service runs hidden in the background; restart preserves its port unless explicitly changed. Stop waits for graceful shutdown and does not force-kill SAP work. Control is authenticated separately from MCP tokens, and process identity is checked against the runtime lease. The JSON status omits control secrets.

`external` means a foreground UI/service or another owner holds the runtime. Do not stop it with PID termination; explain which owner needs normal shutdown. The legacy `ui` and `serve` commands remain foreground interactive commands and are unsuitable as long-running calls inside an AI turn. An occupied port is not permission to terminate its owner. On `SERVICE_START_UNKNOWN` or `SERVICE_STOP_UNKNOWN`, inspect status before deciding another action.

Managed background mode is not an installed Windows Service or boot-time supervisor. Do not promise unattended crash recovery or reboot persistence. Fixes take effect after restarting the appropriate process; changing files does not patch an already running server.

## Upgrade and uninstall requests

For a requested upgrade, record the current revision, inspect local changes and identify whether a managed service is running. Preserve configuration and credentials. Update only the intended checkout/version, rebuild and test before restoring service. Do not discard user changes, force-reset branches, or automatically downgrade dependencies. On build failure report the current revision and actual service state; use an isolated known-good release directory when available rather than overwriting user work for rollback.

For an uninstall request, stop only a verified managed instance and distinguish deleting the checkout from deleting configuration, token files and credentials. Remove only the data the user intends to remove; do not scan or delete unrelated client installations.
