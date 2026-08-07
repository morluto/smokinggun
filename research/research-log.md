# Footgun implementation log

This log records current implementation decisions and reproducible local
evidence and current operating instructions.

## Package foundation

The root package is TypeScript ESM, targets Node 22.18 or newer, uses pnpm
11.20.0, and exposes only the footgun executable. oclif owns command parsing
and help; domain modules remain independent of command handlers. Configuration
is strict JSON with CLI, environment, explicit-file, nearest-file, user-file,
and built-in precedence.

## Scanner and context

The repository scanner reads source without executing it, normalizes portable
paths, reports repository revision and dirty state, and separates structural,
Tree-sitter, and semantic coverage. Tree-sitter grammars are pinned and
verified by digest. TypeScript context uses the compiler API; SCIP import uses
the maintained generated protobuf bindings. Findings carry deterministic IDs,
assumptions, evidence, status, and relations.

## Execution and evidence

Workloads are parsed at the command boundary. Local execution uses Execa
without a shell, caller cancellation, timeout and output bounds, a safe
environment allowlist, and explicit behavior checks. Unsupported isolation and
resource limits return typed recovery results; parameterized input series are
measured point-by-point and retain their candidate fits. Measures retain raw
samples, warmups, repetitions, workload digest, environment identity, applied
isolation controls, and behavior outcomes. Explicit bwrap and nsjail runners
record namespace controls; Docker and Podman require pinned images. Standard
benchmark JSON importers normalize Hyperfine, pyperf, Google Benchmark,
Criterion, and JMH records, including source digests.

Investigation transitions are immutable content-addressed snapshots. A real
CLI probe advances a plan-only investigation through measurement and
comparison to behavior-validated while retaining the original bundle.

## Verification commands

    npx --yes pnpm@11.20.0 typecheck
    npx --yes pnpm@11.20.0 test
    npx --yes pnpm@11.20.0 test:vp
    npx --yes pnpm@11.20.0 test:cli
    npx --yes pnpm@11.20.0 test:package
    npx --yes pnpm@11.20.0 verify:release

The current local run passes 17 test files and 36 tests under Vitest and Vite+,
the CLI smoke contract, the content-digested multi-language corpus evaluation,
release verification, and the packed-consumer
Verdaccio test. The packed test covers repeated install, npm exec, offline npm
exec, global installation, scanner listing, doctor, and packed skill discovery
from outside the checkout.
