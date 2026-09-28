#!/usr/bin/env node
// Removes every "— " (em dash followed by a space) from the repo's text files.
//
//   node scripts/remove-em-dash.mjs           dry run: list files and counts
//   node scripts/remove-em-dash.mjs --apply   rewrite the files in place
//
// Only files git knows about (tracked, or untracked but not ignored) are
// touched, so node_modules/, target/ and dist/ are skipped. Binary files and
// lockfiles are skipped too.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const NEEDLE = "— ";
const SKIP = [/(^|\/)pnpm-lock\.yaml$/, /(^|\/)Cargo\.lock$/, /(^|\/)LICENSE$/];

const apply = process.argv.includes("--apply");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((f) => f && !SKIP.some((re) => re.test(f)));

let total = 0;
let changed = 0;
for (const file of new Set(files)) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // deleted in the working tree
  }
  if (buf.includes(0)) continue; // binary
  const text = buf.toString("utf8");
  const count = text.split(NEEDLE).length - 1;
  if (count === 0) continue;
  total += count;
  changed += 1;
  console.log(`${String(count).padStart(5)}  ${file}`);
  if (apply) writeFileSync(file, text.replaceAll(NEEDLE, ""));
}

console.log(
  `\n${total} occurrence(s) in ${changed} file(s)${apply ? " removed." : ". Dry run; pass --apply to write."}`,
);
