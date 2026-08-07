# smokinggun

## 2.1.0

### Minor Changes

- 0da8cf0: Add bounded two-parameter scaling grids with deterministic coordinates and exact-grid comparison.

### Patch Changes

- 29970ce: Make the packaged agent skill provide an exact, authorization-gated recovery path when the SmokingGun CLI is unavailable.
- 9689633: Bind investigation scan evidence digests to the exact stored scan-report artifact bytes.
- 9729dcf: Reject gzip-compressed pprof profiles whose decompressed output exceeds the 64 MiB import limit.
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
