---
name: footgun
description: Use Footgun to find complexity candidates and build evidence-backed optimization investigations.
---

# Footgun

Use Footgun as a local evidence boundary for complexity and performance work. It scans repository source and context, imports external findings, and compares explicitly authorized measurements. It does not edit source files.

## Start with a scan

Run the first action from the repository under review:

```bash
footgun scan .
```

If the `footgun` command is unavailable, show the user one of these explicit installation choices and wait for them to run it:

```bash
npm install -g footgun
```

Or run one command without a global install:

```bash
npx footgun scan .
```

Do not install npm packages implicitly. `npx` is an explicit, user-visible bootstrap path and may contact the npm registry when the user runs it.

## Interpret evidence carefully

Keep these categories separate in every report:

- Static findings are observations from source, repository context, or imported artifacts.
- Estimates are theoretical consequences of stated assumptions, such as a likely repeated lookup inside a loop.
- Measurements are empirical results for a declared workload and runtime environment.
- Behavioral checks establish whether a proposed change preserves observed behavior; they do not prove all behavior is preserved.
- Unknowns include missing coverage, unresolved types, unavailable tools, unrun workloads, and unverified assumptions.

A finding is a candidate, not proof of a universal speedup or asymptotic bound. Missing or failed coverage must remain visible and must not be reported as clean coverage.

## Investigate and measure

Create a durable investigation bundle when it will help organize evidence:

```bash
footgun investigate <path>
```

Before executing any repository workload, obtain explicit user authorization. A measurement must include a declared `WorkloadV1` descriptor and the `--execute` flag. `--yes` confirms an ordinary command choice; it never authorizes workload execution.

Keep baseline and candidate measurements tied to their workload, environment, artifacts, and behavior checks. Use `footgun compare <baseline> <candidate>` only after checking that both sides are comparable. Report what was not measured and which assumptions remain unresolved.

## Safety and recovery

Static scans are read-only, offline, and non-executing. Footgun does not apply automatic source edits. Do not modify source, configuration, dependencies, or generated artifacts unless the user explicitly asks for that change.

Use machine-readable output when handing results to another tool:

```bash
footgun scan . --format json
footgun scan . --format markdown
footgun scan . --format sarif --output footgun.sarif
```

Diagnostics belong on stderr, and a JSON or SARIF result on stdout is one document. Preserve nonzero exit codes and incomplete coverage when deciding whether a result is usable.
