#!/usr/bin/env node
import {execute} from "@oclif/core";

const handleBrokenPipe = (cause: NodeJS.ErrnoException): void => {
  if (cause.code === "EPIPE") process.exit(0);
  throw cause;
};

process.stdout.once("error", handleBrokenPipe);
process.stderr.once("error", handleBrokenPipe);
await execute({dir: import.meta.url});
