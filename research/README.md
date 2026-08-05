# Footgun research

This directory records the release audit, literature review, scanner evaluation,
hybrid architecture, roadmap, and validation design for the
`$complexity-optimizer` skill and the `footgun` CLI.

The conclusion is intentionally conservative: static analysis generates
candidates, but it is not evidence that a change improves a real workload.
Footgun therefore keeps scanning, context, measurement, behavior validation,
and reporting as separate evidence stages.

## Reproduction

Run the labeled scanner corpus and its precision/recall gate with:

```bash
pnpm test -- --run src/corpus.test.ts
```

The corpus is small by design. Its value is that every case is inspectable and
the output exposes both supported-pattern performance and known gaps. The
repository-wide first pass is:

```bash
footgun scan . --format json
```

The release check used for this audit is:

```bash
npm pack --dry-run --json
```

See the individual reports for the evidence and decisions:

- [Comprehensive research report](comprehensive-report.md)
- [Footgun / Complexity Optimizer long-term specification](long-term-spec.md)
- [Research log](research-log.md)
- [Release and package integrity](release-integrity.md)
- [Literature matrix](literature-matrix.md)
- [Technique and resource landscape](technique-landscape.md)
- [Toolchain and adapter landscape](toolchain-and-adapter-landscape.md)
- [Integration contracts: adapters, context, execution, corpus, and evidence](integration-contracts.md)
- [Benchmark and workload-corpus landscape](benchmark-landscape.md)
- [Hybrid scanner/report architecture](hybrid-architecture.md)
- [Prioritized roadmap](roadmap.md)
- [Validation design](validation-design.md)
