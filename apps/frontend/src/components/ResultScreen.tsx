import type { PublicMatchView } from "@pixelfleet/shared";
import { EightBitAlert, EightBitBadge, EightBitButton, EightBitTable } from "./8bit";

export function ResultScreen({ view, onBack }: { view: PublicMatchView; onBack: () => void }) {
  const result = view.result;

  return (
    <main className="app-screen center-screen">
      <section className="pixel-panel result-panel">
        <EightBitBadge tone={result?.won ? "success" : "danger"}>{result?.won ? "Victory" : "Defeat"}</EightBitBadge>
        <h1>{result?.won ? "Fleet Victorious" : "Fleet Lost"}</h1>
        <EightBitAlert tone={result?.reason === "forfeit" ? "warning" : "info"}>
          {result?.reason === "forfeit" ? "Match decided by disconnect." : "All enemy ships were sunk."}
        </EightBitAlert>
        <EightBitTable
          rows={[
            { label: "XP Earned", value: result?.xpEarned ?? 0 },
            { label: "New Level", value: result?.profile.level ?? "-" },
            { label: "Wins", value: result?.profile.stats.wins ?? "-" },
            { label: "Losses", value: result?.profile.stats.losses ?? "-" },
            { label: "Games Played", value: result?.profile.stats.gamesPlayed ?? "-" }
          ]}
        />
        <EightBitButton size="lg" onClick={onBack}>
          Back to Lobby
        </EightBitButton>
      </section>
    </main>
  );
}
