export type UserId = string;
export type MatchId = string;
export type ShipId =
  | "battleship"
  | "cruiser"
  | "destroyer-a"
  | "destroyer-b"
  | "submarine";

export type Orientation = "horizontal" | "vertical";

export interface Coordinate {
  x: number;
  y: number;
}

export interface ShipDefinition {
  id: ShipId;
  name: string;
  length: number;
}

export interface ShipPlacement {
  shipId: ShipId;
  x: number;
  y: number;
  orientation: Orientation;
}

export interface PlacedShip extends ShipDefinition {
  cells: Coordinate[];
  hits: Coordinate[];
}

export type KnownCellState =
  | "unknown"
  | "water"
  | "ship"
  | "hit"
  | "miss"
  | "sunk";

export interface PublicCell {
  x: number;
  y: number;
  state: KnownCellState;
  shipId?: ShipId;
}

export interface PlayerStats {
  wins: number;
  losses: number;
  gamesPlayed: number;
  shotsFired: number;
  hits: number;
  shipsSunk: number;
}

export interface PlayerProfile {
  userId: UserId;
  username: string;
  avatarSeed: string;
  xp: number;
  level: number;
  xpIntoLevel: number;
  xpForCurrentLevel: number;
  xpForNextLevel: number;
  stats: PlayerStats;
}

export interface MatchPlayerPublic {
  userId: UserId;
  username: string;
  avatarSeed: string;
  connected: boolean;
  ready: boolean;
}

export type MatchPhase = "placing" | "playing" | "finished";

export interface MatchResult {
  winnerId: UserId;
  reason: "ships_sunk" | "forfeit";
  xpEarned: number;
  won: boolean;
  profile: PlayerProfile;
}

export interface PublicMatchView {
  matchId: MatchId;
  phase: MatchPhase;
  you: MatchPlayerPublic;
  opponent: MatchPlayerPublic;
  currentTurnUserId: UserId | null;
  ownBoard: PublicCell[];
  enemyBoard: PublicCell[];
  message: string;
  result?: MatchResult;
  reconnectDeadline?: number;
}

export interface ShotOutcome {
  x: number;
  y: number;
  hit: boolean;
  sunkShipId?: ShipId;
  gameOver: boolean;
}

export interface MatchRewards {
  hits: number;
  shipsSunk: number;
  shotsFired: number;
  won: boolean;
}

export type ClientMessage =
  | { type: "join_queue" }
  | { type: "cancel_queue" }
  | { type: "place_ships"; placements: ShipPlacement[] }
  | { type: "fire"; x: number; y: number }
  | { type: "leave_match" };

export type ServerMessage =
  | { type: "profile"; profile: PlayerProfile }
  | { type: "queue_status"; queued: boolean; message: string }
  | { type: "match_found"; matchId: MatchId }
  | { type: "game_update"; view: PublicMatchView }
  | { type: "match_finished"; view: PublicMatchView }
  | { type: "toast"; tone: "info" | "success" | "warning" | "danger"; message: string }
  | { type: "error"; message: string };
