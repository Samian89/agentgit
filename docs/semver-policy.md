# Semver Policy

AgentGit's TypeScript packages (`@agentgit/core`, `@agentgit/sdk`,
`@agentgit/cli`) follow [Semantic Versioning](https://semver.org).

This page documents which symbols are covered by that contract, how
deprecations work, and how surface changes are policed in CI.

## Release tags

Every exported symbol is implicitly or explicitly classified with a
[TSDoc release tag](https://api-extractor.com/pages/tsdoc/tag_public/):

| Tag         | Covered by semver?    | Meaning |
| ----------- | --------------------- | --- |
| `@public`   | Yes                   | Stable; breaking change requires a major version bump. |
| `@beta`     | No (pre-stable)       | API is available but may change without a major bump. Pin a minor version if you depend on it. |
| `@internal` | No                    | Implementation detail. May be removed or renamed at any time. Do not import these. |

If a symbol carries no tag, treat it as `@public` for the package's
documented entry point and `@internal` for any subpath import.

## Surface lock

The `.api.md` baseline files under `packages/<name>/etc/` are the
authoritative record of the public surface. API Extractor compares the
working set against this baseline on every PR; CI fails if the diff is
non-empty.

To intentionally update the surface:

```bash
# Build only the packages that produce dist/ for API Extractor (avoids
# @agentgit/ui whose "build:tauri" requires Rust + platform deps; "build" is now safe Vite-only).
pnpm --filter @agentgit/core --filter @agentgit/sdk build
pnpm api:update      # rewrites etc/*.api.md
git add packages/*/etc
git commit -m "api: <reason>"
```

PR reviewers should treat any change under `etc/*.api.md` as a
deliberate API change, classify it (additive vs. breaking), and bump
the version accordingly per the rules below.

## Deprecation flow

Symbols leaving the public surface follow a two-minor-version grace
window so users have a clear runway to migrate:

1. **Minor N**: mark the symbol `@deprecated <reason and replacement>`.
   Keep the implementation working. The deprecation note appears in
   the generated `.api.md`.
2. **Minor N+1**: emit a runtime warning (if reasonably cheap) the
   first time the symbol is used per process. Deprecation note
   strengthened to include the planned removal version.
3. **Minor N+2**: the symbol may be removed in this release. Removal
   constitutes a public-surface change and triggers a `major` bump,
   per semver.

`@beta` symbols may be removed in any minor release without a
deprecation cycle. `@internal` symbols may be removed in any patch
release.

## What counts as breaking?

A breaking change to a `@public` symbol means any of:

- Renaming or removing an exported function/class/type/constant.
- Changing a function's signature in a way that rejects previously
  valid calls (adding required parameters, narrowing a parameter type,
  widening a return type, removing an overload, etc.).
- Changing a class's instance shape in a way that rejects previously
  valid subclasses or usages.
- Changing a documented runtime guarantee (e.g., "throws when X" →
  "returns null when X").

Additive changes — new exports, new optional parameters, new optional
fields on returned objects — are minor.

Bug fixes that preserve documented behavior are patches.

## Telemetry, config, and on-disk formats

The telemetry config keys, the schema of `.agentgit/config.json`, and
the on-disk object format are also part of the public surface. Changes
that read or write old data must remain backward-compatible across a
full deprecation cycle. The SQLite schema is versioned independently
via the migration table; see `packages/core/src/migrations/`.
