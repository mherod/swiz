# Executing installed skill helpers

Keep the shell tool's `workdir` at the target repository and invoke the installed
helper directly. For example, substitute your configured skill root in:

```sh
bun <configured-skill-root>/commit/scripts/check-gpg-signing.mjs preflight
```

Swiz permits direct helper execution under the shared `.agents/skills` root and
provider skill roots, including `.claude/skills`, `.codex/skills` and
`.cursor/skills`. The script path must resolve inside a configured root. Eval
imports, environment wrappers and interpreter options that inject executable code
do not qualify for this exception. Reading a skill file does not authorize writing
to it.

Codex `exec_command` supplies the shell command as `cmd`; Swiz normalizes it to its
canonical `command` field. Explicit `workdir` (or another shell tool's `cwd`) controls
relative path resolution. Otherwise the session cwd applies. Denials show this
effective directory, its source and the session access boundary. Selecting a hidden
home directory as `workdir` does not grant arbitrary write access there.

Do not wrap the Bun helper in `pnpm exec` to satisfy a project's dependency-manager
preference: Bun file execution is a runtime operation. In the #909 reproduction,
direct Bun preserved the explicit skills workdir and imported the relative helper;
both `pnpm exec pwd` and `pnpm exec bun -e` started in the home directory instead.
That observed cwd change belongs to the pnpm execution step. Swiz does not launch
the user's shell command or control that runner's module resolution.

For manual verification using an existing isolated public-key keyring, substitute
the directory and commit SHA, then run:

```sh
export GNUPGHOME=/tmp/<isolated-public-keyring>
git verify-commit --raw <sha>
```

Required `-c gpg.format=openpgp` and `-c gpg.openpgp.program=<gpg-path>` options can
remain on the direct Git command. An inline `GNUPGHOME=... git ...` prefix is
rejected because command-profile checks require Git at the shell command boundary.
Exporting executable or Git configuration overrides does not make them permitted.
The same protections apply to inline and exported overrides.
