import {Protocol, type MeasurementArtifactV1, type MeasurementV1, type ProblemV1} from "../protocol/index.js";

/** Parse one externally produced single-run measurement artifact. */
export function parseMeasurement(input: unknown): MeasurementV1 | ProblemV1 {
  const result = Protocol.measurement.safeParse(input);
  return result.success
    ? result.data
    : problem(
        "invalid-measurement",
        "The artifact is not a valid SmokingGun MeasurementV1.",
        "Import an immutable measurement artifact that satisfies the published schema.",
      );
}

/** Parse any supported externally produced measurement or scaling artifact. */
export function parseMeasurementArtifact(input: unknown): MeasurementArtifactV1 | ProblemV1 {
  const parsed = Protocol.measurementArtifact.safeParse(input);
  return parsed.success
    ? parsed.data
    : problem(
        "invalid-measurement-artifact",
        "The artifact is not a valid MeasurementV1, ScalingAnalysisV2, or ScalingAnalysisV3 document.",
        "Import an immutable artifact that satisfies one of the published measurement schemas.",
      );
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "smokinggun.problem.v1", code, message, recovery};
}
