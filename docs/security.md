# Security Notes

## AI lifecycle CLI (2026-10-16)

The lifecycle manager serializes its commands with a separate lease and uses the existing runtime/config leases. Read-only lease inspection never reclaims locks. A managed instance is identified by PID, process start time via its runtime lease, a lease nonce and an authenticated control response. Stop uses a dedicated loopback control listener, requires a separate random token, rejects Origin and unexpected Host, and never kills a PID. This listener is not exposed as an MCP tool. Its metadata file contains a control secret and must remain private to the current OS user; mode 0600 is requested, and Windows access control still depends on directory ACLs. Treat custom configuration directories as sensitive.

JSON CLI output excludes credentials and control tokens. `token create --out` and `client-config --out` create new local secret files without overwriting; do not commit, share or print them. Status/doctor do not return their contents. A Windows password dialog sends input only through an internal process pipe to the credential-store writer, never through CLI options or environment variables. A changed login identity requires fresh password entry. Client instructions alone cannot constrain a terminal-capable AI: that client still acts with the local user's OS permissions.

Background startup includes a TCP listener preflight and still handles actual bind failures; this is not an atomic port reservation. Shutdown waits for normal request/session cleanup. Timeout means uncertainty, not permission to force-kill or retry writes. Background mode does not install an OS service or guarantee crash/reboot recovery. Existing foreground service/UI instances remain outside managed stop/restart.

## Review and fixes (2026-10-15)

The local management API authentication guard now matches paths case-insensitively, consistent with Express routing. Previously uppercase paths such as `/API/state` bypassed the lowercase `/api/` middleware check; management mutations including token creation could also bypass that guard. Regression tests enforce authentication and same-origin checks across mixed-case paths. Restart all old processes to apply the fix; it is not a change to already running services.

The SELECT guard now rejects both `CLIENT` and `CLIENTS` outside quoted values, including `USING ALL CLIENTS`, `USING CLIENTS IN` and nested queries. Previously the plural form could bypass the configured-Client policy, subject to SAP backend support and authorization.

MCP initialization provides client instructions for data handling and safe write recovery. Parameter descriptions explain identifiers, filters and revision/request IDs. Tool arguments are limited to 2000 combined object members/array elements before schema validation. Client instructions are guidance, not an enforcement boundary; server validation and SAP authorizations remain required.

## Backend transport and access scope

Backend connections accept HTTP and HTTPS. Prefer HTTPS with a trusted server certificate; the bounded Axios client uses default TLS verification, forbids cross-origin requests and never follows redirects, including HTTPS-to-HTTP redirects. No insecure-certificate switch or automatic downgrade is provided. Existing HTTP connections remain compatible and still send authentication and data without transport encryption. HTTPS has not been validated against a live SAP system in this review.

All valid MCP tokens share configured connections and SAP-user privileges; there is no per-token system, table or row-level policy. Keep SAP users appropriately scoped. Query row limits do not bound database scan cost, and read operations may recreate a cached session and retry once. Enhancement version probes cannot establish BAdI/CMOD runtime enablement.

## Data Queries

`query_table` and `query_sql` use stateless SAP Data Preview requests and do not require `write_enabled`. The table tool validates identifiers and escapes string literals; the SQL tool conservatively accepts SELECT with FROM and rejects mutations, comments, statement terminators, INTO, client overrides, external connections and privileged access. SAP still controls syntax, entity visibility and authorizations. Queries use the configured Client and never acquire editor locks. Returned rows default to 100 and are capped at 500, with one extra row requested to detect truncation. This does not cap database scan cost. HTTP requests retain the 15-second timeout and 4 MiB response bound; timeout does not guarantee server-side cancellation. Query text, filter values and results are not added to application audit logs or the write-request cache. Raw string results preserve identifiers and numeric precision. Discovery advertisement is reported separately for DDIC and freestyle and does not establish authorization or confirmed availability.

## Local Lease Protection

Runtime and configuration lease operations use an exclusive `.guard` file to serialize stale-owner inspection, removal, creation and release. The guard is held only during these filesystem operations, not throughout the MCP service lifetime. Concurrent attempts fail closed and may be retried after the current command finishes.

The guard is deliberately never reclaimed automatically. If a process terminates while it holds a guard, stop all SAP MCP service and configuration processes, verify none is still running, then remove only the reported `runtime.lock.guard` or `config.lock.guard` from the configuration directory. Do not remove guards while another process may be modifying the configuration. Ordinary stale lease files still use process identity checks, under the guard.

All concurrent processes must run this guarded implementation. Stop older versions before upgrading; an older process does not honor the new guard. The protection assumes that other applications do not tamper with this user's configuration directory.

## Dependency Advisory

The current `abap-adt-api` dependency includes `sprintf-js@1.1.3`, affected by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). The advisory concerns attacker-controlled numeric precision in format strings. There is no published patched `sprintf-js` release at the time of review (2026-10-15).

In the reviewed ADT library, the format strings are static object-creation paths, containing at most one `%s`. Object names are encoded substitution arguments, not format strings. Regression tests verify these assumptions; this does not remove or fix the upstream dependency advisory. Production dependency audit remains nonzero and should be rechecked when updating the ADT library. Do not use `npm audit fix --force` to downgrade the ADT library to an incompatible historical version.
