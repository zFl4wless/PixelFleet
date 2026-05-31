import type {
  Coordinate,
  MatchRewards,
  Orientation,
  PlacedShip,
  PlayerStats,
  ShipDefinition,
  ShipId,
  ShipPlacement,
  ShotOutcome
} from "./types.js";

export const BOARD_SIZE = 10;

export const SHIP_DEFINITIONS: ShipDefinition[] = [
  { id: "battleship", name: "Battleship", length: 5 },
  { id: "cruiser", name: "Cruiser", length: 4 },
  { id: "destroyer-a", name: "Destroyer A", length: 3 },
  { id: "destroyer-b", name: "Destroyer B", length: 3 },
  { id: "submarine", name: "Submarine", length: 2 }
];

export const TOTAL_SHIP_CELLS = SHIP_DEFINITIONS.reduce((sum, ship) => sum + ship.length, 0);

export function coordinateKey({ x, y }: Coordinate): string {
  return `${x}:${y}`;
}

export function isInsideBoard({ x, y }: Coordinate): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

export function cellsForPlacement(placement: ShipPlacement): Coordinate[] {
  const definition = getShipDefinition(placement.shipId);
  return Array.from({ length: definition.length }, (_, index) => ({
    x: placement.x + (placement.orientation === "horizontal" ? index : 0),
    y: placement.y + (placement.orientation === "vertical" ? index : 0)
  }));
}

export function getShipDefinition(shipId: ShipId): ShipDefinition {
  const definition = SHIP_DEFINITIONS.find((ship) => ship.id === shipId);
  if (!definition) {
    throw new Error(`Unknown ship id: ${shipId}`);
  }
  return definition;
}

export function validateFleet(placements: ShipPlacement[]): { valid: true; ships: PlacedShip[] } | { valid: false; error: string } {
  if (placements.length !== SHIP_DEFINITIONS.length) {
    return { valid: false, error: "Place every ship before confirming." };
  }

  const expectedIds = new Set(SHIP_DEFINITIONS.map((ship) => ship.id));
  const seenIds = new Set<ShipId>();
  const occupied = new Set<string>();
  const ships: PlacedShip[] = [];

  for (const placement of placements) {
    if (!expectedIds.has(placement.shipId)) {
      return { valid: false, error: "Unknown ship." };
    }
    if (seenIds.has(placement.shipId)) {
      return { valid: false, error: "Each ship can only be placed once." };
    }
    if (placement.orientation !== "horizontal" && placement.orientation !== "vertical") {
      return { valid: false, error: "Invalid orientation." };
    }

    const cells = cellsForPlacement(placement);
    if (cells.some((cell) => !isInsideBoard(cell))) {
      return { valid: false, error: "Ships must stay fully inside the board." };
    }

    for (const cell of cells) {
      const key = coordinateKey(cell);
      if (occupied.has(key)) {
        return { valid: false, error: "Ships cannot overlap." };
      }
      occupied.add(key);
    }

    seenIds.add(placement.shipId);
    ships.push({ ...getShipDefinition(placement.shipId), cells, hits: [] });
  }

  return { valid: true, ships };
}

export function canPlaceShip(placements: ShipPlacement[], candidate: ShipPlacement): boolean {
  const withoutCandidate = placements.filter((placement) => placement.shipId !== candidate.shipId);
  const occupied = new Set<string>();

  for (const placement of withoutCandidate) {
    for (const cell of cellsForPlacement(placement)) {
      occupied.add(coordinateKey(cell));
    }
  }

  return cellsForPlacement(candidate).every((cell) => isInsideBoard(cell) && !occupied.has(coordinateKey(cell)));
}

export function createRandomFleet(random: () => number = Math.random): ShipPlacement[] {
  const placements: ShipPlacement[] = [];

  for (const ship of SHIP_DEFINITIONS) {
    let placed = false;
    let guard = 0;

    while (!placed && guard < 500) {
      guard += 1;
      const orientation: Orientation = random() > 0.5 ? "horizontal" : "vertical";
      const maxX = orientation === "horizontal" ? BOARD_SIZE - ship.length : BOARD_SIZE - 1;
      const maxY = orientation === "vertical" ? BOARD_SIZE - ship.length : BOARD_SIZE - 1;
      const candidate: ShipPlacement = {
        shipId: ship.id,
        x: Math.floor(random() * (maxX + 1)),
        y: Math.floor(random() * (maxY + 1)),
        orientation
      };

      if (canPlaceShip(placements, candidate)) {
        placements.push(candidate);
        placed = true;
      }
    }

    if (!placed) {
      throw new Error("Could not create random fleet.");
    }
  }

  return placements;
}

export function applyShot(ships: PlacedShip[], target: Coordinate, previousShots: Set<string>): ShotOutcome {
  if (!isInsideBoard(target)) {
    throw new Error("Shot is outside the board.");
  }

  const key = coordinateKey(target);
  if (previousShots.has(key)) {
    throw new Error("This tile has already been targeted.");
  }

  previousShots.add(key);

  const ship = ships.find((candidate) => candidate.cells.some((cell) => coordinateKey(cell) === key));
  if (!ship) {
    return { ...target, hit: false, gameOver: false };
  }

  ship.hits.push(target);
  const sunk = isShipSunk(ship);

  return {
    ...target,
    hit: true,
    sunkShipId: sunk ? ship.id : undefined,
    gameOver: ships.every(isShipSunk)
  };
}

export function isShipSunk(ship: PlacedShip): boolean {
  const hitKeys = new Set(ship.hits.map(coordinateKey));
  return ship.cells.every((cell) => hitKeys.has(coordinateKey(cell)));
}

export function xpForLevel(level: number): number {
  if (level <= 1) {
    return 0;
  }
  return Math.round(120 * (level - 1) ** 1.55);
}

export function levelFromXp(xp: number): number {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) {
    level += 1;
  }
  return level;
}

export function xpProgress(xp: number): {
  level: number;
  xpIntoLevel: number;
  xpForCurrentLevel: number;
  xpForNextLevel: number;
} {
  const level = levelFromXp(xp);
  const current = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    xpIntoLevel: xp - current,
    xpForCurrentLevel: current,
    xpForNextLevel: next
  };
}

export function hitRate(stats: PlayerStats): number {
  if (stats.shotsFired === 0) {
    return 0;
  }
  return Math.round((stats.hits / stats.shotsFired) * 100);
}

export function calculateMatchXp(rewards: MatchRewards): number {
  const base = rewards.won ? 150 : 70;
  return base + rewards.hits * 10 + rewards.shipsSunk * 25 + 20;
}
