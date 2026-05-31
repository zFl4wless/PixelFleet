import { rm } from "node:fs/promises";

const paths = [
  "apps/backend/dist",
  "apps/frontend/dist",
  "packages/shared/dist",
  "apps/backend/tsconfig.tsbuildinfo",
  "apps/frontend/tsconfig.tsbuildinfo",
  "packages/shared/tsconfig.tsbuildinfo"
];

await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
console.log("Cleaned build artifacts.");
