import { describe, expect, it } from "vitest";
import { frontendPageFromPath } from "@pixelfleet/shared";

describe("frontend route selection", () => {
  it("recognizes the game and legal pages, including slash and HTML aliases", () => {
    expect(frontendPageFromPath("/")).toBe("game");
    expect(frontendPageFromPath("/index.html")).toBe("game");
    for (const page of ["legal-notice", "privacy-policy"] as const) {
      for (const suffix of ["", "/", "/index.html"]) {
        expect(frontendPageFromPath(`/${page}${suffix}`)).toBe(page);
      }
    }
    expect(frontendPageFromPath("/%6Cegal-notice/")).toBe("legal-notice");
  });

  it("selects the error page for unknown or malformed paths", () => {
    for (const path of ["/xxx", "/xxx/", "/legal-notice/xxx", "/privacy-policy-old", "/404.html", "/%ZZ"]) {
      expect(frontendPageFromPath(path)).toBe("not-found");
    }
  });
});
