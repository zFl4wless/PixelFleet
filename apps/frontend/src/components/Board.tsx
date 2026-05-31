import { BOARD_SIZE, coordinateKey, type Coordinate, type PublicCell } from "@pixelfleet/shared";
import { cn } from "../lib/classNames";

const letters = "ABCDEFGHIJ".split("");

export function OceanBoard({
  title,
  cells,
  interactive = false,
  disabled = false,
  onCellClick
}: {
  title: string;
  cells: PublicCell[];
  interactive?: boolean;
  disabled?: boolean;
  onCellClick?: (cell: PublicCell) => void;
}) {
  return (
    <section className="board-shell" aria-label={title}>
      <div className="board-title">
        <span>{title}</span>
      </div>
      <div className="board-axis board-axis-top" aria-hidden="true">
        <span />
        {letters.map((letter) => (
          <span key={letter}>{letter}</span>
        ))}
      </div>
      <div className="board-row-wrap">
        <div className="board-axis board-axis-left" aria-hidden="true">
          {Array.from({ length: BOARD_SIZE }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <div className="ocean-board">
          {cells.map((cell) => (
            <button
              aria-label={`${title} ${letters[cell.x]}${cell.y + 1} ${cell.state}`}
              className={cn("board-cell", `cell-${cell.state}`, interactive && "cell-interactive")}
              disabled={disabled || !interactive || cell.state !== "unknown"}
              key={coordinateKey(cell)}
              onClick={() => onCellClick?.(cell)}
            >
              <CellMark state={cell.state} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function PlacementBoard({
  placements,
  preview,
  previewValid,
  onHover,
  onLeave,
  onPlace
}: {
  placements: CoordinateWithShip[];
  preview: Coordinate[] | null;
  previewValid: boolean;
  onHover: (coordinate: Coordinate) => void;
  onLeave: () => void;
  onPlace: (coordinate: Coordinate) => void;
}) {
  const placedByKey = new Map(placements.map((cell) => [coordinateKey(cell), cell.shipId]));
  const previewKeys = new Set((preview ?? []).map(coordinateKey));

  return (
    <section className="board-shell" aria-label="Your placement">
      <div className="board-title">
        <span>Your Shipyard</span>
      </div>
      <div className="board-axis board-axis-top" aria-hidden="true">
        <span />
        {letters.map((letter) => (
          <span key={letter}>{letter}</span>
        ))}
      </div>
      <div className="board-row-wrap">
        <div className="board-axis board-axis-left" aria-hidden="true">
          {Array.from({ length: BOARD_SIZE }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <div className="ocean-board">
          {Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => {
            const cell = { x: index % BOARD_SIZE, y: Math.floor(index / BOARD_SIZE) };
            const key = coordinateKey(cell);
            const hasShip = placedByKey.has(key);
            const isPreview = previewKeys.has(key);

            return (
              <button
                aria-label={`Tile ${letters[cell.x]}${cell.y + 1}`}
                className={cn(
                  "board-cell",
                  hasShip ? "cell-ship" : "cell-water",
                  isPreview && (previewValid ? "cell-preview-valid" : "cell-preview-invalid")
                )}
                key={key}
                onBlur={onLeave}
                onClick={() => onPlace(cell)}
                onFocus={() => onHover(cell)}
                onMouseEnter={() => onHover(cell)}
                onMouseLeave={onLeave}
              >
                <CellMark state={hasShip ? "ship" : "water"} />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function CellMark({ state }: { state: PublicCell["state"] }) {
  if (state === "hit") {
    return <span className="mark-hit" />;
  }
  if (state === "miss") {
    return <span className="mark-miss" />;
  }
  if (state === "sunk") {
    return <span className="mark-sunk" />;
  }
  if (state === "ship") {
    return <span className="mark-ship" />;
  }
  return null;
}

export interface CoordinateWithShip extends Coordinate {
  shipId: string;
}
