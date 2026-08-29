<!--
PR title: type(optional-scope): imperative outcome
Use a Conventional Commit title; add a changeset for user-visible package behavior.
-->

## Summary

<!-- What user, agent, or maintainer problem does this solve? Link the issue
with "Fixes #123" when applicable. Keep prior behavior, expected contract,
and new behavior understandable without private context. -->

## Problem and expected behavior

<!-- For fixes, state the smallest trigger and violated invariant. For features,
state the use case and observable outcome. -->

## Change and scope

<!-- Explain the approach, why it fits SmokingGun's evidence architecture, and
what is intentionally not included. -->

## Evidence and correctness

<!--
Separate static candidate findings, imported observations, executed measurements,
and verified conclusions. For optimization changes, include a baseline/candidate
comparison with workload, metric, units, methodology, and correctness gate.
-->

- Tests or fixtures added/updated:
- Scanner coverage and assumptions:
- Baseline/candidate evidence (if applicable):
- User-visible CLI/MCP/SARIF/SCIP output (if applicable):
- Remaining proof gaps:

## Contract and boundary impact

<!-- Complete the applicable lines; use "none" or "not applicable" explicitly. -->

- Semantic owner and earliest changed stage:
- CLI, MCP, SARIF, SCIP, schema, or grammar contract:
- Source snapshot, artifact identity, coverage, or evidence semantics:
- Read-only, no-execution, sandbox, network, or process side effects:
- Resource budget or performance impact:

## Testing

<!-- List only commands that actually ran, with observed results. -->

- `command` — result

## Compatibility and release

<!-- Call out breaking changes, migration steps, format/schema compatibility,
and package or changeset impact. -->

- Breaking changes or migration steps:
- Package/release impact:
- Documentation or generated schema impact:

## Review checklist

- [ ] The PR has one focused outcome and the title follows `type(scope): outcome`.
- [ ] Related issue is linked, or the reason for not linking one is stated above.
- [ ] Tests cover changed observable behavior and meaningful failure paths.
- [ ] Static findings are not described as performance or correctness proof.
- [ ] Scanner behavior remains local, read-only, and non-executing unless an explicit reviewed boundary says otherwise.
- [ ] A changeset is included when package behavior is user-visible, or the reason is stated above.
- [ ] I checked the final diff for secrets, unrelated cleanup, and unsupported claims.
