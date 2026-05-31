import { EightBitAlert, EightBitButton, EightBitSpinner } from "./8bit";

export function Matchmaking({ onCancel }: { onCancel: () => void }) {
  return (
    <main className="app-screen center-screen">
      <section className="pixel-panel matchmaking-panel">
        <EightBitSpinner label="Searching for an opponent..." />
        <EightBitAlert tone="info">You are in the queue. The match starts as soon as another captain is online.</EightBitAlert>
        <EightBitButton variant="secondary" onClick={onCancel}>
          Cancel Search
        </EightBitButton>
      </section>
    </main>
  );
}
