import {Args} from "@oclif/core";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {printResult} from "../cli/command-output.js";

const explanations: Record<string, {readonly title: string; readonly detail: string; readonly next: string}> = {
  "nested-or-callback-loop": {
    title: "Nested iteration",
    detail:
      "An iterative operation appears inside another iterative region. The observed syntax does not prove input sizes or runtime behavior.",
    next: "Inspect collection bounds and preserve ordering before considering an index, grouping, or batch.",
  },
  "membership-in-loop": {
    title: "Membership search in a loop",
    detail: "A membership or search operation appears inside iterative code and may rescan a collection.",
    next: "Confirm the right-hand collection and equality semantics before replacing it with Set or Map.",
  },
  "sort-in-loop": {
    title: "Sort in a loop",
    detail: "Sorting appears inside iterative code and may repeat O(n log n) work.",
    next: "Measure representative input sizes and consider one sort, a heap, or an ordered lookup.",
  },
  "io-or-query-in-loop": {
    title: "I/O or query in a loop",
    detail: "A likely request, query, or execution call appears inside iterative code.",
    next: "Check authorization, filters, pagination, ordering, and error behavior before batching.",
  },
  "render-derived-work": {
    title: "Render-derived collection work",
    detail: "A collection transform appears in a likely UI component.",
    next: "Confirm render frequency and collection size; use profiling before memoizing or moving work.",
  },
  "recursive-call": {
    title: "Recursive call",
    detail:
      "A function appears to call itself. The recurrence, decreasing measure, and memoization behavior are unknown.",
    next: "Inspect base cases and repeated subproblems, then test depth and representative workloads.",
  },
};

export default class Explain extends BaseCommand {
  static override description = "Explain a finding rule or stable finding identifier.";
  static override flags = globalFlags;
  static override args = {
    "finding-id": Args.string({description: "Finding ID such as fg_0123456789abcdef.", required: true}),
  };

  public async run(): Promise<void> {
    const parsed = await this.parse(Explain);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    const id = parsed.args["finding-id"];
    if (!/^fg_[a-f0-9]{16}$/.test(id) && !Object.hasOwn(explanations, id)) {
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "invalid-finding-id",
          message: "Finding IDs must use fg_ followed by 16 lowercase hexadecimal characters, or be a known rule ID.",
          recovery: "Copy the ID from `footgun scan --format json`.",
        },
        2,
        context,
      );
    }
    const ruleId = Object.hasOwn(explanations, id) ? id : "unknown";
    const explanation = explanations[ruleId] ?? {
      title: "Unknown finding",
      detail: "This stable ID is not a built-in rule explanation. Its scan artifact is the source of truth.",
      next: "Open the report containing this ID and inspect its assumptions and evidence.",
    };
    await printResult(
      {schemaVersion: "footgun.explanation.v1", id, ruleId, ...explanation},
      `${explanation.title}\n\n${explanation.detail}\n\nNext: ${explanation.next}`,
      context,
    );
  }
}
