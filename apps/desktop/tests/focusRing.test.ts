import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The focus ring is the global `:focus-visible` box-shadow, so a borderless
// field in a box of its own must take it off, or it draws a second outline
// inside the box. `outline: none` doesn't: there's no outline to remove.
const folders = [
  new URL("../src/styles/", import.meta.url),
  new URL("../../../packages/ui/src/styles/", import.meta.url),
];
const sheets = folders.flatMap((folder) =>
  readdirSync(folder)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(new URL(file, folder), "utf8")),
);

interface Rule {
  selector: string;
  body: string;
}

const rules: Rule[] = sheets.flatMap((css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) =>
    (m[1] ?? "").split(",").map((s) => ({ selector: s.trim(), body: m[2] ?? "" })),
  ),
);

describe("focus rings", () => {
  it("every borderless text field in a box leaves the outline to the box", () => {
    const fields = rules
      .filter(
        (r) =>
          /(^|\s)(input|textarea)$/.test(r.selector) &&
          /border:\s*(0|none)\b/.test(r.body) &&
          r.selector !== "input",
      )
      .map((r) => r.selector);
    expect(fields.length).toBeGreaterThan(5);
    const doubled = fields.filter(
      (field) =>
        !rules.some(
          (r) => r.selector.startsWith(`${field}:focus`) && /box-shadow:\s*none/.test(r.body),
        ),
    );
    expect(doubled).toEqual([]);
  });
});
