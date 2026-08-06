# Changesets

This repository releases with [changesets](https://github.com/changesets/changesets).

Record a change intent whenever your work should produce a version bump:

```bash
pnpm changeset
```

`pnpm changeset version` applies pending changesets (run by the release workflow via
`pnpm version:packages`), and `pnpm changeset publish` publishes to npm with provenance
(`pnpm publish:packages`).
