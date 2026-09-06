# Dependency security

Swiz runs and installs with Bun. `package.json#packageManager` and `bun.lock`
define the installed dependency graph. The obsolete root `pnpm-lock.yaml` has
been removed: it described a different graph, was unused by installation and CI,
and caused GitHub to report alerts and attempt npm security updates against
dependencies outside the installed graph. Changes in those GitHub alert counts
must be distinguished from fixes to the Bun graph tracked in
[#874](https://github.com/mherod/swiz/issues/874).

## Update automation

`.github/dependabot.yml` configures weekly Bun version updates. As of 2026-09-06,
[GitHub supports Bun version updates but not Bun security updates](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).
A successful version-update job is therefore not evidence of a successful
security-update job. Check the installed graph with `bun audit --json`.

[Bun version-update run 34057863241](https://github.com/mherod/swiz/actions/runs/34057863241)
completed successfully at `431bff20` and opened five dependency update PRs.
The separate [qs security-update run 34057873043](https://github.com/mherod/swiz/actions/runs/34057873043)
still failed with `security_update_dependency_not_found` against the old graph.

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

## Transitive refresh

A fresh Bun resolution within the published parent dependency ranges preserves
all direct runtime SDK versions and patches the remaining compatible transitive
paths. Both installed brace-expansion lines are fixed (2.1.4 and 5.0.9), both
picomatch lines are fixed (2.3.2 and 4.0.7), and Vitest shares the root Vite 7.3.6
installation instead of retaining a vulnerable Vite 8.0.10 copy.

The Bun executable and its types are pinned to the declared 1.3.14 runtime.
Vitest UI and coverage packages match the installed runner at 4.1.8; update these
companions together with the runner to retain their exact peer contract.

| 2026-09-06 Bun audit | Original | Security overrides | Transitive refresh |
|---|---:|---:|---:|
| Advisory entries | 121 | 22 | 7 |
| Affected packages | 34 | 10 | 7 |
| Critical | 2 | 0 | 0 |
| High | 48 | 13 | 4 |
| Moderate | 64 | 8 | 2 |
| Low | 7 | 1 | 1 |

These are Bun audit counts, not GitHub alert counts, and they do not establish
that every vulnerable path was exploitable. A lower GitHub count after removing
the unused pnpm graph does not mean the seven remaining Bun advisories are fixed.

## Remaining work

| Package | Audited installed line | Required floor or constraint | Owning dependency path |
|---|---|---|---|
| @opentelemetry/core | 2.0.1 | 2.8.0 | Gemini telemetry and Google resource detector |
| @opentelemetry/propagator-jaeger | 2.0.1 | 2.9.0 | Gemini → sdk-node |
| @opentelemetry/sdk-node, exporter-prometheus | 0.203.0 | 0.217.0 | Gemini telemetry family |
| diff | 7.0.0 | 8.0.3 | Gemini core |
| uuid | 9.0.1 | 11.1.1 | Google auth dependency tree |
| extract-zip | 2.0.1 | No published fixed version | Gemini → get-ripgrep |

- OpenTelemetry: migrate the Gemini provider's experimental 0.203.x telemetry
  family coherently; do not force only one experimental package to 0.217.x.
- `diff` and `uuid`: assess the required major upgrades in the pinned Gemini
  provider tree.
- `extract-zip`: the audited 2.0.1 line has no published fix; migrate the owning
  ripgrep downloader/provider path.

Keep #874 open until the remaining graph, validation failures and unsupported
security-update acceptance criterion have an explicit resolution.
