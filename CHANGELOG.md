# smokinggun

## 5.0.0

### Major Changes

- c7b4a97: Remove the unused executable-adapter protocol, configuration, CLI flags, and sandbox runtime. Static scanners and passive SARIF, SCIP, benchmark, pprof, and Perfetto imports remain available.

### Minor Changes

- cbbbb1c: Default repository scans to runtime source while preserving auxiliary files in inventory, with `--source-profile all` and explicit `--only` paths available to scan tests, documentation, examples, and fixtures.

### Patch Changes

- 67ffe66: Mark completed scan reports as successful SARIF invocations even when they contain warning diagnostics.
- 7eb9677: Reject measurement imports that name an investigation which does not exist instead of silently discarding the requested attachment.
- cd2b1e8: Reject malformed pyperf and JMH raw observations instead of silently importing a partial sample set.
- c2706b3: Report each incomplete Tree-sitter parse once instead of emitting duplicate diagnostics for the same file.
- 19f5d7b: Accept cancelled points in single-parameter scaling artifacts, matching multi-parameter scaling and the public execution-state model.
- 1bc6b6a: Reject measurement comparisons whose baseline and candidate declare different statistical policies.
- ebd824f: Reject scan reports whose repository inventory digest does not match the inventory's canonical content.
- d0ba2f9: Align C and C++ discovery, inventory, coverage, and explicit scope filtering across supported source extensions.
- ac40338: Probe the complete declared adapter command by default so missing entrypoints are not reported as available.
- c1e67ea: Reject context imports that name a missing investigation instead of reporting an unattached import as successful.
- 1cb7340: Ignore directories and other non-file entries whose names resemble package manifests when building repository inventory.
- 5de964f: Bound configuration and adapter-manifest reads before parsing repository-controlled JSON.
- cbc9106: Reject malformed UTF-8 in textual configuration, adapter manifests, evidence imports, and investigation data instead of silently replacing input bytes.
- 0673a1f: Block measurement promotion when baseline and candidate artifacts identify different benchmark subjects.
- 2495e4f: Read comparison inputs through the bounded regular-file artifact boundary instead of loading arbitrary paths without a size limit.
- f03713f: Validate complete adapter results and all inline artifacts before retaining any artifact bytes.
- 1c00fbb: Allow auto-discovered user configuration to reference paths outside the XDG configuration directory.
- 8bf9a50: Reject pprof sample values and identifiers outside JavaScript's exact integer range instead of silently normalizing them to zero.
- bc9634a: Keep malformed and non-file SARIF artifact URIs from aborting an import or being mistaken for repository-relative paths.
- 80f1464: Run Perfetto trace processing against the captured content-addressed artifact instead of the mutable input path.
- 5b7a9f9: Reject non-canonical SCIP document paths instead of silently rewriting producer input.

## 4.0.0

### Major Changes

- a9c3c02: Reset scanning, imported evidence, content storage, and investigation updates around immutable inputs and host-enforced authority boundaries. Reports use exact content-addressed bytes; semantic scanners consume captured text; authorized adapters receive a private read-only snapshot; and measurement execution is removed in favor of strict imports from existing benchmark tools. Bounded findings now represent repository areas, stable finding IDs require their source report, SARIF imports report unknown external coverage, Google Benchmark repetitions retain raw distributions, and investigations advance through parent-linked compare-and-swap commits.

### Patch Changes

- 8755bef: Remove obsolete design documents that described retired workload execution and align the public README, architecture guide, contributor instructions, and packaged agent skill with the import-only measurement boundary.

## 3.0.0

### Major Changes

- 9301a2e: Reject internally inconsistent workload, scaling, comparison, provenance, and adapter result documents at their protocol boundary. Existing documents that encode contradictory states are no longer accepted.

### Minor Changes

- 0da8cf0: Add bounded two-parameter scaling grids with deterministic coordinates and exact-grid comparison.

### Patch Changes

- 29970ce: Make the packaged agent skill provide an exact, authorization-gated recovery path when the SmokingGun CLI is unavailable.
- 9689633: Bind investigation scan evidence digests to the exact stored scan-report artifact bytes.
- 9729dcf: Reject gzip-compressed pprof profiles whose decompressed output exceeds the 64 MiB import limit.
- 5a25d51: Bound TypeScript semantic worker memory and report resource exhaustion as incomplete coverage.
- c464cb3: Classify unvalidated nested iteration candidates as medium severity.
- ce7be67: Block timing promotion when compared measurements record different Node runtimes.
- fe9bc43: Include immutable baseline and candidate artifact digests in comparison identities.
- 81eed92: Disclose bounded scan findings and evaluate fail policies before the limit.
- 35cafec: Require explicit command-line authorization before SmokingGun probes or executes configured external adapters.
- 8bbcf37: Validate the target investigation before an explicitly authorized measurement workload can execute or write an artifact.
- 4e1dfa3: Normalize supported JMH throughput scores as milliseconds per operation.
- d76ac6d: Preserve isolation provenance for scaling points and block downgraded comparisons.
- 39a6e3c: Refresh the bundled Rust grammar to parse raw identifiers correctly.
- b499ad7: Reject measurements that request host resource limits the available runner cannot enforce.
- b4540bb: Report the installed SmokingGun version in scan and SARIF tool metadata.
- 4a1db1a: Validate report investigation references before processing or emitting the requested artifact.
- fc7b0f3: Report skipped source symlinks as partial scan coverage instead of silently omitting them.
- 041b708: Return an existing matching plan-only investigation instead of replaying an invalid lifecycle transition.
- 7f41676: Report SARIF analyzed-file coverage from unique result-location paths instead of finding count.
- e42960d: Keep TypeScript semantic findings within explicit scan selection boundaries.
- fdc3ec1: Mark scans dirty when their analyzed source includes untracked Git files.
- d2343d9: Reject focused investigation IDs that are absent from the current scan report.
- 0519469: Verify declared adapter artifact digests and preserve verified bindings in scan reports.
- 9e25f28: Verify existing content-addressed artifact bytes before reusing their digest path.

## 2.0.0

### Major Changes

- b3143ac: Adopt the npm CLI and the host-neutral `$smokinggun` skill distributed through the shared Skills CLI. Remove the SmokingGun-owned skill installer and host-specific skill metadata.
