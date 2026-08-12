import {Args} from "@oclif/core";
import {BaseCommand, globalFlags} from "../cli/base-command.js";
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
  "repeated-scan": {
    title: "Repeated collection scan",
    detail: "A collection transform appears inside iterative code and may repeat a full pass for each outer iteration.",
    next: "Confirm collection sizes and semantics before combining passes or precomputing an index.",
  },
};

export default class Explain extends BaseCommand {
  static override description = "Explain a built-in finding rule.";
  static override flags = globalFlags;
  static override args = {
    "finding-id": Args.string({description: "Built-in rule ID such as membership-in-loop.", required: true}),
  };

  public async run(): Promise<void> {
    const parsed = await this.parse(Explain);
    const context = await this.context(parsed.flags);
    const id = parsed.args["finding-id"];
    if (/^sg_[a-f0-9]{16}$/.test(id)) {
      this.emitProblem(
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "finding-report-required",
          message: "A stable finding ID can only be resolved from the scan report that contains it.",
          recovery: `Read its rule with jq --arg id '${id}' '.findings[] | select(.id == $id) | .ruleId' REPORT.json, then run smokinggun explain RULE_ID.`,
        },
        2,
        context,
      );
    }
    if (!Object.hasOwn(explanations, id)) {
      this.emitProblem(
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "invalid-finding-id",
          message: "The argument is not a known built-in rule ID.",
          recovery: "Copy ruleId from a `smokinggun scan --format json` finding.",
        },
        2,
        context,
      );
    }
    const ruleId = id;
    const explanation = explanations[ruleId];
    if (explanation === undefined) throw new Error(`Missing explanation for validated rule ${ruleId}.`);
    await printResult(
      {schemaVersion: "smokinggun.explanation.v1", id, ruleId, ...explanation},
      `${explanation.title}\n\n${explanation.detail}\n\nNext: ${explanation.next}`,
      context,
    );
  }
}
