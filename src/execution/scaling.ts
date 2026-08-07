import {createHash} from "node:crypto";
import {relative, resolve} from "node:path";
import {
  Protocol,
  type ProblemV1,
  type ScalingAnalysisV1,
  type ScalingAnalysisV2,
  type ScalingModelV1,
  type ScalingPointV1,
} from "../protocol/index.js";
import {stableJson} from "../serialization.js";
import {measureWorkload, type MeasurementOptions} from "./measure.js";
import {executionEnvironment, redactCommand} from "./environment.js";
import {portablePath} from "../paths.js";

/** Measure every declared input point and fit only the supported candidate models. */
export async function measureScaling(
  input: unknown,
  options: MeasurementOptions,
): Promise<ScalingAnalysisV1 | ProblemV1> {
  const parsed = Protocol.workload.safeParse(input);
  if (!parsed.success)
    return problem(
      "invalid-workload",
      "The workload is not a valid WorkloadV1 descriptor.",
      "Provide a strict workload with an input-size parameterization.",
    );
  const workload = parsed.data;
  const parameter = workload.inputSizeParameterization;
  if (parameter === undefined)
    return problem(
      "scaling-parameter-missing",
      "The workload does not declare an input-size parameterization.",
      "Add name, values, and an explicit commandIndex to WorkloadV1.",
    );
  if (parameter.commandIndex >= workload.command.length)
    return problem(
      "scaling-command-index-invalid",
      "The input-size command index is outside the declared command.",
      "Point commandIndex at an existing argument; command substitution never uses a shell.",
    );
  const points: ScalingPointV1[] = [];
  const {inputSizeParameterization: _parameter, ...baseWorkload} = workload;
  for (const value of parameter.values) {
    options.signal?.throwIfAborted();
    const command = [...workload.command];
    command[parameter.commandIndex] = String(value);
    const pointWorkload: unknown = {...baseWorkload, command};
    const measurement = await measureWorkload(pointWorkload, options);
    if ("code" in measurement) {
      points.push({
        value,
        status: measurement.code === "measurement-timeout" ? "timed-out" : "failed",
        samplesMs: [],
        medianMs: 0,
        meanMs: 0,
        quartiles: {q1Ms: 0, q3Ms: 0},
        statisticalPolicy: workload.statisticalPolicy,
        timedOut: measurement.code === "measurement-timeout",
        behaviorValidated: false,
        diagnostic: measurement.code,
      });
      if (measurement.code === "measurement-cancelled") return measurement;
      continue;
    }
    points.push({
      value,
      status: "complete",
      samplesMs: measurement.samplesMs,
      medianMs: measurement.medianMs,
      meanMs: measurement.meanMs,
      quartiles: measurement.quartiles,
      statisticalPolicy: measurement.statisticalPolicy,
      timedOut: false,
      behaviorValidated: measurement.behaviorValidated,
      ...(measurement.behaviorValidated ? {} : {diagnostic: "behavior-check-failed"}),
    });
  }
  const models = fitModels(points);
  const workloadDigest = createHash("sha256").update(stableJson(workload)).digest("hex");
  const id = `scale_${createHash("sha256").update(`${workloadDigest}\0${parameter.name}\0${Date.now()}`).digest("hex").slice(0, 16)}`;
  const selectedModel = models[0]?.name;
  const root = resolve(options.root);
  const cwd = resolve(root, workload.cwd);
  const limitations = [
    "Fits describe this finite input range and do not prove an asymptotic bound.",
    "Warmup, cache, scheduler, setup, and constant-factor effects remain part of the measured environment.",
    ...(points.some((point) => point.status !== "complete") ? ["One or more input points did not complete."] : []),
    ...(points.length < 3 ? ["Fewer than three complete input points limit model discrimination."] : []),
    ...(parameter.values.some((value) => value <= 0)
      ? ["Non-positive input values are excluded from logarithmic model fitting."]
      : []),
  ];
  return {
    schemaVersion: "footgun.scaling.v1",
    id,
    workloadDigest,
    parameter: parameter.name,
    points,
    models,
    ...(selectedModel === undefined ? {} : {selectedModel}),
    reproduction: {
      command: redactCommand(workload.command, root),
      cwd: portablePath(relative(root, cwd) || "."),
      environmentKeys: Object.keys(executionEnvironment(workload.environment, workload.inheritEnvironment)).sort(),
      timeoutMs: workload.timeoutMs,
      warmups: workload.warmups,
      repetitions: workload.repetitions,
      expectedArtifacts: workload.expectedArtifacts.map((artifact) => portablePath(artifact)).sort(),
      datasetDigests: workload.datasetDigests,
    },
    environment: {node: process.versions.node, platform: process.platform, arch: process.arch},
    limitations,
  };
}

/** Measure a bounded two-parameter coordinate plan without fitting a multivariate model. */
export async function measureMultiScaling(
  input: unknown,
  options: MeasurementOptions,
): Promise<ScalingAnalysisV2 | ProblemV1> {
  const parsed = Protocol.workload.safeParse(input);
  if (!parsed.success)
    return problem(
      "invalid-workload",
      "The workload is not a valid WorkloadV1 descriptor.",
      "Provide a strict workload.",
    );
  const workload = parsed.data;
  const design = workload.multiParameterization;
  if (design === undefined)
    return problem(
      "scaling-parameters-missing",
      "The workload does not declare a multi-parameter scaling plan.",
      "Add multiParameterization.",
    );
  const names = design.parameters.map((parameter) => parameter.name);
  if (
    new Set(names).size !== names.length ||
    new Set(design.parameters.map((parameter) => parameter.commandIndex)).size !== names.length
  )
    return problem(
      "scaling-parameters-invalid",
      "Scaling parameter names and command indexes must be distinct.",
      "Declare distinct names and commandIndex values.",
    );
  if (design.parameters.some((parameter) => parameter.commandIndex >= workload.command.length))
    return problem(
      "scaling-command-index-invalid",
      "A scaling command index is outside the declared command.",
      "Point every commandIndex at an existing argument.",
    );
  const coordinates = design.coordinates ?? cartesianCoordinates(design.parameters);
  if (coordinates.length > design.maxPoints)
    return problem(
      "scaling-points-limit-exceeded",
      "The scaling coordinate plan exceeds maxPoints.",
      "Reduce parameter values, provide explicit coordinates, or raise maxPoints up to 64.",
    );
  if (
    coordinates.some(
      (coordinate) =>
        !names.every((name) => Number.isFinite(coordinate[name])) ||
        Object.keys(coordinate).some((name) => !names.includes(name)),
    )
  )
    return problem(
      "scaling-coordinates-invalid",
      "Every coordinate must contain exactly the declared numeric parameter names.",
      "Provide complete named coordinates.",
    );
  const {inputSizeParameterization: _single, multiParameterization: _multi, ...baseWorkload} = workload;
  const points: ScalingAnalysisV2["points"] = [];
  for (const [index, coordinate] of coordinates.entries()) {
    if (options.signal?.aborted) {
      appendCancelledPoints(points, coordinates.slice(index), workload.statisticalPolicy);
      break;
    }
    const command = [...workload.command];
    for (const parameter of design.parameters) command[parameter.commandIndex] = String(coordinate[parameter.name]);
    const measurement = await measureWorkload({...baseWorkload, command}, options);
    if ("code" in measurement) {
      points.push({
        value: points.length,
        coordinates: coordinate,
        status: measurement.code === "measurement-timeout" ? "timed-out" : "failed",
        samplesMs: [],
        medianMs: 0,
        meanMs: 0,
        quartiles: {q1Ms: 0, q3Ms: 0},
        statisticalPolicy: workload.statisticalPolicy,
        timedOut: measurement.code === "measurement-timeout",
        behaviorValidated: false,
        diagnostic: measurement.code,
      });
      if (measurement.code === "measurement-cancelled") {
        points[points.length - 1] = {...points[points.length - 1]!, status: "cancelled", diagnostic: measurement.code};
        appendCancelledPoints(points, coordinates.slice(index + 1), workload.statisticalPolicy);
        break;
      }
    } else {
      points.push({
        value: points.length,
        coordinates: coordinate,
        status: "complete",
        samplesMs: measurement.samplesMs,
        medianMs: measurement.medianMs,
        meanMs: measurement.meanMs,
        quartiles: measurement.quartiles,
        statisticalPolicy: measurement.statisticalPolicy,
        timedOut: false,
        behaviorValidated: measurement.behaviorValidated,
        ...(measurement.behaviorValidated ? {} : {diagnostic: "behavior-check-failed"}),
      });
    }
  }
  const workloadDigest = createHash("sha256").update(stableJson(workload)).digest("hex");
  const coordinatesDigest = createHash("sha256").update(stableJson(coordinates)).digest("hex");
  const id = `scale_${createHash("sha256").update(`${workloadDigest}\0${coordinatesDigest}\0${Date.now()}`).digest("hex").slice(0, 16)}`;
  const root = resolve(options.root);
  const cwd = resolve(root, workload.cwd);
  return {
    schemaVersion: "footgun.scaling.v2",
    id,
    workloadDigest,
    parameters: names,
    coordinatesDigest,
    points,
    reproduction: {
      command: redactCommand(workload.command, root),
      cwd: portablePath(relative(root, cwd) || "."),
      environmentKeys: Object.keys(executionEnvironment(workload.environment, workload.inheritEnvironment)).sort(),
      timeoutMs: workload.timeoutMs,
      warmups: workload.warmups,
      repetitions: workload.repetitions,
      expectedArtifacts: workload.expectedArtifacts.map((artifact) => portablePath(artifact)).sort(),
      datasetDigests: workload.datasetDigests,
    },
    environment: {node: process.versions.node, platform: process.platform, arch: process.arch},
    limitations: [
      "This bounded coordinate grid does not claim a multivariate asymptotic law.",
      ...(points.some((point) => point.status !== "complete") ? ["One or more coordinates did not complete."] : []),
    ],
  };
}

function cartesianCoordinates(
  parameters: ReadonlyArray<{readonly name: string; readonly values: ReadonlyArray<number>}>,
): Array<Record<string, number>> {
  return parameters.reduce<Array<Record<string, number>>>(
    (coordinates, parameter) =>
      coordinates.flatMap((coordinate) => parameter.values.map((value) => ({...coordinate, [parameter.name]: value}))),
    [{}],
  );
}

function appendCancelledPoints(
  points: ScalingAnalysisV2["points"],
  coordinates: ReadonlyArray<Record<string, number>>,
  statisticalPolicy: ScalingAnalysisV2["points"][number]["statisticalPolicy"],
): void {
  for (const coordinate of coordinates)
    points.push({
      value: points.length,
      coordinates: coordinate,
      status: "cancelled",
      samplesMs: [],
      medianMs: 0,
      meanMs: 0,
      quartiles: {q1Ms: 0, q3Ms: 0},
      statisticalPolicy,
      timedOut: false,
      behaviorValidated: false,
      diagnostic: "measurement-cancelled",
    });
}

function fitModels(points: ReadonlyArray<ScalingPointV1>): ScalingModelV1[] {
  const complete = points.filter((point) => point.status === "complete");
  const definitions: ReadonlyArray<{
    readonly name: ScalingModelV1["name"];
    readonly feature: (value: number) => number | undefined;
  }> = [
    {name: "constant", feature: () => 1},
    {name: "logarithmic", feature: (value) => (value > 0 ? Math.log(value) : undefined)},
    {name: "linear", feature: (value) => value},
    {name: "linearithmic", feature: (value) => (value > 0 ? value * Math.log(value) : undefined)},
    {name: "quadratic", feature: (value) => value * value},
  ];
  const models = definitions.flatMap((definition) => {
    const observations = complete.flatMap((point) => {
      const feature = definition.feature(point.value);
      return feature === undefined ? [] : [{x: feature, y: point.medianMs}];
    });
    const fit = linearFit(observations);
    return fit === undefined ? [] : [{name: definition.name, ...fit}];
  });
  return models.sort((left, right) => left.residual - right.residual || modelOrder(left.name) - modelOrder(right.name));
}

function linearFit(
  observations: ReadonlyArray<{readonly x: number; readonly y: number}>,
): Omit<ScalingModelV1, "name"> | undefined {
  if (observations.length < 2) return undefined;
  const n = observations.length;
  const sumX = observations.reduce((sum, observation) => sum + observation.x, 0);
  const sumY = observations.reduce((sum, observation) => sum + observation.y, 0);
  const sumXX = observations.reduce((sum, observation) => sum + observation.x * observation.x, 0);
  const sumXY = observations.reduce((sum, observation) => sum + observation.x * observation.y, 0);
  const determinant = n * sumXX - sumX * sumX;
  if (determinant === 0) return undefined;
  const slope = (n * sumXY - sumX * sumY) / determinant;
  const intercept = (sumY - slope * sumX) / n;
  const mean = sumY / n;
  const residual = observations.reduce(
    (sum, observation) => sum + (observation.y - (intercept + slope * observation.x)) ** 2,
    0,
  );
  const total = observations.reduce((sum, observation) => sum + (observation.y - mean) ** 2, 0);
  if (![slope, intercept, residual].every(Number.isFinite)) return undefined;
  const rSquared = total === 0 ? (residual === 0 ? 1 : 0) : 1 - residual / total;
  if (!Number.isFinite(rSquared)) return undefined;
  return {coefficients: [intercept, slope], residual, rSquared};
}

function modelOrder(name: ScalingModelV1["name"]): number {
  return ["constant", "logarithmic", "linear", "linearithmic", "quadratic"].indexOf(name);
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}
