"use strict";
const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["bootstrap.js", ...readdirSync(path.join(root, "modules")).filter(n => n.endsWith(".js")).map(n => "modules/" + n)];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const file of readdirSync(path.join(root, "tests")).filter(n => n.endsWith(".test.cjs")).sort()) {
  const result = spawnSync(process.execPath, [path.join(root, "tests", file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
