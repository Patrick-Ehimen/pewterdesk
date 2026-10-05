import { describe, expect, it } from "vitest";
import { hasBundledLogo, logoBase, pngAsSvg } from "../src/lib/bundledLogos";

describe("bundled logos", () => {
  it("reads the base coin off a file name", () => {
    expect(logoBase("../../../../assets/tokens/AAL.png")).toBe("AAL");
    expect(logoBase("/assets/tokens/ISRG.svg")).toBe("ISRG");
    // A generated badge is filed under its coin all the same.
    expect(logoBase("../assets/tokens/BYD.badge.svg")).toBe("BYD");
  });

  it("wraps a PNG as the SVG the icons are drawn from", () => {
    expect(pngAsSvg("iVBORw0KGgo=")).toContain('href="data:image/png;base64,iVBORw0KGgo="');
  });

  it("knows which coins have a logo in assets/tokens, whatever the case", () => {
    expect(hasBundledLogo("NOTACOINXYZQ")).toBe(false);
    expect(hasBundledLogo("aal")).toBe(hasBundledLogo("AAL"));
  });
});
