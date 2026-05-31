import { useMemo, useState } from "react";
import {
  canPlaceShip,
  cellsForPlacement,
  createRandomFleet,
  SHIP_DEFINITIONS,
  validateFleet,
  type Coordinate,
  type Orientation,
  type PublicCell,
  type PublicMatchView,
  type ShipId,
  type ShipPlacement
} from "@pixelfleet/shared";
import { OceanBoard, PlacementBoard } from "./Board";
import type { CoordinateWithShip } from "./Board";
import {
  EightBitAlert,
  EightBitAvatar,
  EightBitBadge,
  EightBitButton,
  EightBitSeparator,
  EightBitTooltip
} from "./8bit";

export function GameScreen({
  view,
  onPlaceFleet,
  onFire
}: {
  view: PublicMatchView;
  onPlaceFleet: (placements: ShipPlacement[]) => void;
  onFire: (cell: PublicCell) => void;
}) {
  return (
    <main className="app-screen game-screen">
      <MatchHeader view={view} />
      {view.phase === "placing" ? (
        <PlacementPhase view={view} onPlaceFleet={onPlaceFleet} />
      ) : (
        <BattlePhase view={view} onFire={onFire} />
      )}
    </main>
  );
}

function MatchHeader({ view }: { view: PublicMatchView }) {
  const turnTone = view.currentTurnUserId === view.you.userId ? "success" : "warning";

  return (
    <section className="pixel-panel match-header">
      <div className="match-player">
        <EightBitAvatar seed={view.you.avatarSeed} label={view.you.username} size="sm" />
        <span>{view.you.username}</span>
        <EightBitBadge tone={view.you.ready ? "success" : "warning"}>{view.you.ready ? "Ready" : "Shipyard"}</EightBitBadge>
      </div>
      <div className="match-status">
        <EightBitBadge tone={view.phase === "playing" ? turnTone : "info"}>
          {view.phase === "playing" ? (view.currentTurnUserId === view.you.userId ? "Your Turn" : "Opponent Turn") : "Placement"}
        </EightBitBadge>
        <p>{view.message}</p>
      </div>
      <div className="match-player opponent">
        <EightBitAvatar seed={view.opponent.avatarSeed} label={view.opponent.username} size="sm" />
        <span>{view.opponent.username}</span>
        <EightBitBadge tone={view.opponent.connected ? "info" : "danger"}>
          {view.opponent.connected ? "Online" : "Offline"}
        </EightBitBadge>
      </div>
    </section>
  );
}

function PlacementPhase({
  view,
  onPlaceFleet
}: {
  view: PublicMatchView;
  onPlaceFleet: (placements: ShipPlacement[]) => void;
}) {
  const [placements, setPlacements] = useState<ShipPlacement[]>([]);
  const [selectedShipId, setSelectedShipId] = useState<ShipId>("battleship");
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [hover, setHover] = useState<Coordinate | null>(null);
  const [localError, setLocalError] = useState<string>();

  const placedCells: CoordinateWithShip[] = useMemo(
    () =>
      placements.flatMap((placement) =>
        cellsForPlacement(placement).map((cell) => ({
          ...cell,
          shipId: placement.shipId
        }))
      ),
    [placements]
  );

  const candidate = hover
    ? {
        shipId: selectedShipId,
        x: hover.x,
        y: hover.y,
        orientation
      }
    : null;
  const preview = candidate ? cellsForPlacement(candidate) : null;
  const previewValid = candidate ? canPlaceShip(placements, candidate) : false;
  const allPlaced = validateFleet(placements).valid;

  function place(coordinate: Coordinate) {
    const nextPlacement: ShipPlacement = { shipId: selectedShipId, x: coordinate.x, y: coordinate.y, orientation };
    if (!canPlaceShip(placements, nextPlacement)) {
      setLocalError("Invalid placement.");
      return;
    }

    setLocalError(undefined);
    const next = [...placements.filter((placement) => placement.shipId !== selectedShipId), nextPlacement];
    setPlacements(next);
    const unplaced = SHIP_DEFINITIONS.find((ship) => !next.some((placement) => placement.shipId === ship.id));
    if (unplaced) {
      setSelectedShipId(unplaced.id);
    }
  }

  function confirm() {
    const validation = validateFleet(placements);
    if (!validation.valid) {
      setLocalError(validation.error);
      return;
    }
    setLocalError(undefined);
    onPlaceFleet(placements);
  }

  if (view.you.ready) {
    return (
      <section className="phase-layout">
        <OceanBoard title="Your Fleet" cells={view.ownBoard} />
        <aside className="pixel-panel side-panel">
          <EightBitAlert tone="success">Fleet confirmed. Waiting for the opponent to be ready.</EightBitAlert>
        </aside>
      </section>
    );
  }

  return (
    <section className="phase-layout">
      <PlacementBoard
        placements={placedCells}
        preview={preview}
        previewValid={previewValid}
        onHover={setHover}
        onLeave={() => setHover(null)}
        onPlace={place}
      />

      <aside className="pixel-panel side-panel">
        <div className="side-panel-header">
          <h2>Ships</h2>
          <EightBitBadge tone={allPlaced ? "success" : "warning"}>{placements.length}/5</EightBitBadge>
        </div>
        <div className="ship-list">
          {SHIP_DEFINITIONS.map((ship) => {
            const placed = placements.some((placement) => placement.shipId === ship.id);
            return (
              <button
                className={selectedShipId === ship.id ? "ship-choice active" : "ship-choice"}
                key={ship.id}
                onClick={() => setSelectedShipId(ship.id)}
              >
                <span>{ship.name}</span>
                <small>{ship.length} Tiles</small>
                <EightBitBadge tone={placed ? "success" : "default"}>{placed ? "OK" : "New"}</EightBitBadge>
              </button>
            );
          })}
        </div>

        <EightBitSeparator />

        <div className="button-row">
          <EightBitTooltip label="Switches between horizontal and vertical placement.">
            <EightBitButton
              variant="secondary"
              onClick={() => setOrientation((current) => (current === "horizontal" ? "vertical" : "horizontal"))}
            >
              {orientation === "horizontal" ? "Horizontal" : "Vertical"}
            </EightBitButton>
          </EightBitTooltip>
          <EightBitButton
            variant="secondary"
            onClick={() => {
              setPlacements(createRandomFleet());
              setLocalError(undefined);
            }}
          >
            Random
          </EightBitButton>
        </div>
        <div className="button-row">
          <EightBitButton
            variant="ghost"
            onClick={() => {
              setPlacements([]);
              setLocalError(undefined);
            }}
          >
            Reset
          </EightBitButton>
          <EightBitButton disabled={!allPlaced} onClick={confirm}>
            Confirm
          </EightBitButton>
        </div>

        {localError ? <EightBitAlert tone="danger">{localError}</EightBitAlert> : null}
      </aside>
    </section>
  );
}

function BattlePhase({ view, onFire }: { view: PublicMatchView; onFire: (cell: PublicCell) => void }) {
  const isYourTurn = view.currentTurnUserId === view.you.userId;
  const disabled = !isYourTurn || !view.opponent.connected;

  return (
    <section className="battle-layout">
      {!view.opponent.connected ? (
        <EightBitAlert tone="warning">
          Opponent offline. If they do not reconnect, you win automatically.
        </EightBitAlert>
      ) : null}
      <div className="boards-grid">
        <OceanBoard title="Your Fleet" cells={view.ownBoard} />
        <OceanBoard title="Target Grid" cells={view.enemyBoard} interactive disabled={disabled} onCellClick={onFire} />
      </div>
    </section>
  );
}
