---
name: smokinggun
description: Use SmokingGun to find complexity candidates and build evidence-backed optimization investigations.
---

# SmokingGun

Use SmokingGun as a local evidence boundary for complexity and performance work. It scans repository source and context, imports external findings, and compares explicitly authorized measurements. It does not edit source files.

## Start with a scan

Run the first action from the repository under review:

```bash
smokinggun scan .
```

If the `smokinggun` command is unavailable, do not treat that as a scan with no findings. Tell the user that SmokingGun could not be run and ask for authorization to use one of these recovery paths:

```bash
npx --yes --package=smokinggun -- smokinggun scan .
```

This is a one-command bootstrap: it may contact the npm registry, but it does not alter the repository or create a global installation. After the user authorizes it, run the exact command from the repository under review.

Or, for a reusable installation:

```bash
npm install --global smokinggun
smokinggun scan .
```

Do not install npm packages implicitly. If either recovery path fails, report the exact command and its diagnostic, keep SmokingGun coverage as unknown, and suggest checking Node 22.18+ and registry access. Do not substitute a failed or unavailable scan with an unsupported performance claim.

## Interpret evidence carefully

Keep these categories separate in every report:

- Static findings are observations from source, repository context, or imported artifacts.
- Estimates are theoretical consequences of stated assumptions, such as a likely repeated lookup inside a loop.
- Measurements are empirical results for a declared benchmark plan and runtime environment.
- Behavioral checks establish whether a proposed change preserves observed behavior; they do not prove all behavior is preserved.
- Unknowns include missing coverage, unresolved types, unavailable tools, unrun benchmarks, and unverified assumptions.

A finding is a candidate, not proof of a universal speedup or asymptotic bound. Missing or failed coverage must remain visible and must not be reported as clean coverage.

## Investigate and compare measurements

Create a durable investigation bundle when it will help organize evidence:

```bash
smokinggun investigate <path>
```

SmokingGun does not execute repository workloads. Produce benchmark and profile artifacts with the repository's existing tools, then import or compare those immutable artifacts through SmokingGun.

Keep baseline and candidate measurements tied to their benchmark plan, subject digest, shared input-set digest, executable, environment, artifacts, and behavior checks. Use `smokinggun compare <baseline> <candidate>` only after checking that both sides are comparable. Report what was not measured and which assumptions remain unresolved.

## Safety and recovery

Static scans are read-only, offline, and non-executing. SmokingGun does not apply automatic source edits. Do not modify source, configuration, dependencies, or generated artifacts unless the user explicitly asks for that change.

Use machine-readable output when handing results to another tool:

```bash
smokinggun scan . --format json
smokinggun scan . --format markdown
smokinggun scan . --format sarif --output smokinggun.sarif
```

Diagnostics belong on stderr, and a JSON or SARIF result on stdout is one document. Preserve nonzero exit codes and incomplete coverage when deciding whether a result is usable.
