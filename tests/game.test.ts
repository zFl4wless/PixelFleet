import { describe, expect, it } from "vitest";
import {
  applyShot,
  canPlaceShip,
  createRandomFleet,
  levelFromXp,
  SHIP_DEFINITIONS,
  validateFleet
} from "@pixelfleet/shared";

describe("fleet placement", () => {
  it("accepts a complete non-overlapping fleet", () => {
    const placements = [
      { shipId: "battleship" as const, x: 0, y: 0, orientation: "horizontal" as const },
      { shipId: "cruiser" as const, x: 0, y: 2, orientation: "horizontal" as const },
      { shipId: "destroyer-a" as const, x: 0, y: 4, orientation: "horizontal" as const },
      { shipId: "destroyer-b" as const, x: 0, y: 6, orientation: "horizontal" as const },
      { shipId: "submarine" as const, x: 0, y: 8, orientation: "horizontal" as const }
    ];

    expect(validateFleet(placements).valid).toBe(true);
  });

  it("rejects overlap and out-of-board ships", () => {
    expect(
      canPlaceShip([{ shipId: "cruiser", x: 0, y: 0, orientation: "horizontal" }], {
        shipId: "submarine",
        x: 1,
        y: 0,
        orientation: "horizontal"
      })
    ).toBe(false);

    expect(
      canPlaceShip([], {
        shipId: "battleship",
        x: 8,
        y: 1,
        orientation: "horizontal"
      })
    ).toBe(false);
  });

  it("creates a valid random fleet", () => {
    let seed = 7;
    const fleet = createRandomFleet(() => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    });
    const result = validateFleet(fleet);

    expect(fleet).toHaveLength(SHIP_DEFINITIONS.length);
    expect(result.valid).toBe(true);
  });
});

describe("shots and levels", () => {
  it("marks hits and prevents duplicate shots", () => {
    const result = validateFleet([
      { shipId: "battleship", x: 0, y: 0, orientation: "horizontal" },
      { shipId: "cruiser", x: 0, y: 2, orientation: "horizontal" },
      { shipId: "destroyer-a", x: 0, y: 4, orientation: "horizontal" },
      { shipId: "destroyer-b", x: 0, y: 6, orientation: "horizontal" },
      { shipId: "submarine", x: 0, y: 8, orientation: "horizontal" }
    ]);

    if (!result.valid) {
      throw new Error(result.error);
    }

    const shots = new Set<string>();
    expect(applyShot(result.ships, { x: 0, y: 0 }, shots).hit).toBe(true);
    expect(() => applyShot(result.ships, { x: 0, y: 0 }, shots)).toThrow(/already/);
  });

  it("calculates level thresholds from xp", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(120)).toBe(2);
    expect(levelFromXp(1000)).toBeGreaterThan(2);
  });
});
