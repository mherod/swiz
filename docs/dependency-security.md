# Dependency security

Swiz runs and installs with Bun. `package.json#packageManager` and `bun.lock`
define the installed dependency graph. The retained `pnpm-lock.yaml` is an older,
different graph; its GitHub alerts do not measure the current Bun installation.
Reconciliation of that obsolete file remains tracked in [#874](https://github.com/mherod/swiz/issues/874).

## Update automation

`.github/dependabot.yml` configures weekly Bun version updates. As of 2026-09-06,
[GitHub supports Bun version updates but not Bun security updates](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).
A successful version-update job is therefore not evidence of a successful
security-update job. Check the installed graph with `bun audit --json`.

The two failed jobs cited in #874 selected npm and reported
`security_update_dependency_not_found` in **Run Dependabot**:

- [fast-uri, run 34008977949](https://github.com/mherod/swiz/actions/runs/34008977949)
- [qs, run 34008978333](https://github.com/mherod/swiz/actions/runs/34008978333)

Both runs used commit `8af12361fe7a7ce56a7fb6b99d2787fed34596fd`.
The observed failure is dependency discovery; the logs do not prove a Bun
lockfile conflict.

## Security overrides

The overrides in `package.json` retain patched versions of transitive packages
without changing the direct SDK versions. Each target stays in the installed
package's release line. Review the floors when upgrading the owning SDK or
toolchain; remove an override only after the generated lockfile retains a fixed
version on every dependency path and a fresh audit confirms the result.

| Dependency group | Fixed versions |
|---|---|
| HTTP and URI handling | fast-uri 3.1.6; qs 6.16.0; hono 4.12.34; undici 7.29.0; @hono/node-server 1.19.15; body-parser 2.3.0; ip-address 10.3.1; path-to-regexp 8.4.0; ws 8.21.3 |
| Serialization and command handling | protobufjs 7.6.5; @grpc/grpc-js 1.14.4; shell-quote 1.9.0; simple-git 3.36.0; js-yaml 4.3.1; fast-xml-parser 5.7.0; fast-xml-builder 1.1.7 |
| Supporting libraries and build tools | @humanfs/node 0.16.8; @tootallnate/once 2.0.1; fflate 0.8.3; flatted 3.4.2; form-data 2.5.6; postcss 8.5.23 |

The 2026-09-06 local audit changed from 121 advisory entries across 34 packages
to 22 entries across 10 packages. Critical entries fell from two to zero and
high-severity entries from 48 to 13. These are Bun audit counts, not GitHub alert
counts, and they do not establish that every vulnerable path was exploitable.

## Remaining work

| Package | Audited installed line | Required floor or constraint | Owning dependency path |
|---|---|---|---|
| @opentelemetry/core | 2.0.1 and 2.6.0 | 2.8.0 | Gemini telemetry and Google resource detector |
| @opentelemetry/propagator-jaeger | 2.0.1 | 2.9.0 | Gemini → sdk-node |
| @opentelemetry/sdk-node, exporter-prometheus | 0.203.0 | 0.217.0 | Gemini telemetry family |
| brace-expansion | 2.0.2 and 5.0.4 | 2.1.4 and 5.0.9 respectively | rimraf → glob → minimatch; minimatch 10 |
| picomatch | 2.3.1 and 4.0.3 | 2.3.2 and 4.0.4 respectively | micromatch; Gemini/tinyglobby |
| diff | 7.0.0 | 8.0.3 | Gemini core |
| uuid | 8.3.2 and 9.0.1 | 11.1.1 | Google logging/auth dependency tree |
| extract-zip | 2.0.1 | No published fixed version | Gemini → get-ripgrep |
| vite | Nested 8.0.10 | Above 8.0.15 | Vitest; root Vite remains 7.3.6 |

- OpenTelemetry: migrate the Gemini provider's experimental 0.203.x telemetry
  family coherently; do not force only one experimental package to 0.217.x.
- `brace-expansion` and `picomatch`: update each installed major through its
  owning parent. A single global override must not replace both major lines.
- `diff` and `uuid`: assess the required major upgrades in the pinned Gemini
  provider tree.
- `extract-zip`: the audited 2.0.1 line has no published fix; migrate the owning
  ripgrep downloader/provider path.
- Vite: update Vitest's nested vulnerable 8.x installation while preserving the
  root 7.x contract, or migrate the toolchain together.

Keep #874 open until the remaining graph, obsolete-lockfile reconciliation,
validation failures and unsupported security-update acceptance criterion have
an explicit resolution. Do not interpret a lower alert count from removing an
obsolete lockfile as proof that the Bun graph is vulnerability-free.
