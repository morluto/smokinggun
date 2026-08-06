---
name: complexity-optimizer
description: Use Footgun to find complexity candidates and build evidence-backed optimization investigations.
---

# Complexity Optimizer

Use the local `footgun` executable as the scanner and evidence boundary.

Start with `footgun scan .` and inspect the reported source locations, repository context, assumptions, and coverage. A finding is a candidate, not proof: separate static facts, theoretical estimates, measurements, behavior checks, and unknowns.

Use `footgun investigate <path>` when a durable bundle is useful. Ask for explicit authorization before executing any workload. Measurement requires a declared `WorkloadV1` descriptor and `--execute`; `--yes` never authorizes workload execution. Verify behavior before treating a comparison as validated.

Do not modify source files unless the user explicitly asks. Keep optimization recommendations small, preserve ordering/errors/mutation/permissions/pagination/cache behavior, and report what was not observed. Footgun does not apply automatic rewrites.
