import {expect, it} from "vitest";
import {parseMeasurement, parseMeasurementArtifact} from "./artifacts.js";

it("keeps immutable measurement parsing without owning workload execution", () => {
  expect(parseMeasurement({schemaVersion: "unknown"})).toMatchObject({code: "invalid-measurement"});
  expect(parseMeasurementArtifact({schemaVersion: "unknown"})).toMatchObject({
    code: "invalid-measurement-artifact",
  });
});
