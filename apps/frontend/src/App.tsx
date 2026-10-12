import { useCallback, useEffect, useState } from "react";
import { frontendPageFromPath } from "@pixelfleet/shared";
import type { ClientMessage, PlayerProfile, PublicCell, PublicMatchView, ServerMessage, ShipPlacement } from "@pixelfleet/shared";
import { SessionConnection } from "./lib/sessionConnection";
import { GameScreen } from "./components/GameScreen";
import { Lobby } from "./components/Lobby";
import { LoginScreen } from "./components/LoginScreen";
import { Matchmaking } from "./components/Matchmaking";
import { ResultScreen } from "./components/ResultScreen";
import { EightBitSkeleton, EightBitToastViewport } from "./components/8bit";
import { LegalFooter, LegalPage } from "./components/legal/LegalPages";
import { NotFoundPage } from "./components/NotFoundPage";

type Toast = { id: string; tone: "default" | "success" | "warning" | "danger" | "info"; message: string };

export default function App() {
  const page = frontendPageFromPath(window.location.pathname);
  if (page === "not-found") {
    return <NotFoundPage />;
  }
  if (page !== "game") {
    return <LegalPage page={page} />;
  }
  return <GameApp />;
}

function GameApp() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);
  const [queued, setQueued] = useState(false);
  const [matchView, setMatchView] = useState<PublicMatchView | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, ...toast }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((candidate) => candidate.id !== id));
    }, 4200);
  }, []);

  const [session] = useState(() => new SessionConnection({
    profile: setProfile,
    loading: setLoading,
    connected: setSocketConnected,
    reset: () => {
      setMatchView(null);
      setQueued(false);
      setToasts([]);
    },
    message: handleServerMessage,
    error: (message) => pushToast({ tone: "danger", message })
  }));

  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  function handleServerMessage(message: ServerMessage) {
    switch (message.type) {
      case "queue_status":
        setQueued(message.queued);
        if (message.message.includes("found")) {
          pushToast({ tone: "success", message: message.message });
        }
        break;
      case "match_found":
        setQueued(false);
        pushToast({ tone: "success", message: "Match found!" });
        break;
      case "game_update":
        setMatchView(message.view);
        if (message.view.phase === "playing" && /hits|sunk|misses/i.test(message.view.message)) {
          pushToast({ tone: message.view.message.includes("misses") ? "info" : "warning", message: message.view.message });
        }
        break;
      case "match_finished":
        setMatchView(message.view);
        setQueued(false);
        pushToast({ tone: message.view.result?.won ? "success" : "danger", message: message.view.result?.won ? "Victory!" : "Defeat." });
        break;
      case "toast":
        pushToast({ tone: message.tone, message: message.message });
        break;
      case "error":
        pushToast({ tone: "danger", message: message.message });
        break;
    }
  }

  function send(message: ClientMessage) {
    if (!session.send(message)) {
      pushToast({ tone: "warning", message: "Server connection is reconnecting." });
    }
  }

  if (loading) {
    return (
      <main className="app-screen center-screen">
        <section className="pixel-panel loading-panel">
          <EightBitSkeleton lines={4} />
        </section>
      </main>
    );
  }

  return (
    <>
      {!profile ? (
        <LoginScreen onLogin={session.loginHandler()} />
      ) : matchView?.phase === "finished" ? (
        <ResultScreen
          view={matchView}
          onBack={() => {
            send({ type: "leave_match" });
            setMatchView(null);
          }}
        />
      ) : matchView ? (
        <GameScreen
          view={matchView}
          onPlaceFleet={(placements: ShipPlacement[]) => send({ type: "place_ships", placements })}
          onFire={(cell: PublicCell) => send({ type: "fire", x: cell.x, y: cell.y })}
        />
      ) : queued ? (
        <Matchmaking onCancel={() => send({ type: "cancel_queue" })} />
      ) : (
        <Lobby profile={profile} connected={socketConnected} onStart={() => send({ type: "join_queue" })} onLogout={() => void session.logout()} />
      )}
      <LegalFooter />
      <EightBitToastViewport
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </>
  );
}
