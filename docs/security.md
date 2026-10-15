# Security Notes

## Data Queries

`query_table` and `query_sql` use stateless SAP Data Preview requests and do not require `write_enabled`. The table tool validates identifiers and escapes string literals; the SQL tool conservatively accepts SELECT with FROM and rejects mutations, comments, statement terminators, INTO, client overrides, external connections and privileged access. SAP still controls syntax, entity visibility and authorizations. Queries use the configured Client and never acquire editor locks. Returned rows default to 100 and are capped at 500, with one extra row requested to detect truncation. This does not cap database scan cost. HTTP requests retain the 15-second timeout and 4 MiB response bound; timeout does not guarantee server-side cancellation. Query text, filter values and results are not added to application audit logs or the write-request cache. Raw string results preserve identifiers and numeric precision. Discovery advertisement is reported separately for DDIC and freestyle and does not establish authorization or confirmed availability.

## Local Lease Protection

Runtime and configuration lease operations use an exclusive `.guard` file to serialize stale-owner inspection, removal, creation and release. The guard is held only during these filesystem operations, not throughout the MCP service lifetime. Concurrent attempts fail closed and may be retried after the current command finishes.

The guard is deliberately never reclaimed automatically. If a process terminates while it holds a guard, stop all SAP MCP service and configuration processes, verify none is still running, then remove only the reported `runtime.lock.guard` or `config.lock.guard` from the configuration directory. Do not remove guards while another process may be modifying the configuration. Ordinary stale lease files still use process identity checks, under the guard.

All concurrent processes must run this guarded implementation. Stop older versions before upgrading; an older process does not honor the new guard. The protection assumes that other applications do not tamper with this user's configuration directory.

## Dependency Advisory

The current `abap-adt-api` dependency includes `sprintf-js@1.1.3`, affected by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). The advisory concerns attacker-controlled numeric precision in format strings. There is no published patched `sprintf-js` release at the time of review (2026-10-15).

In the reviewed ADT library, the format strings are static object-creation paths, containing at most one `%s`. Object names are encoded substitution arguments, not format strings. Regression tests verify these assumptions; this does not remove or fix the upstream dependency advisory. Production dependency audit remains nonzero and should be rechecked when updating the ADT library. Do not use `npm audit fix --force` to downgrade the ADT library to an incompatible historical version.
