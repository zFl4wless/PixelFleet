import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, PlayerProfile, PublicCell, PublicMatchView, ServerMessage, ShipPlacement } from "@pixelfleet/shared";
import { fetchMe, logoutGuest } from "./lib/api";
import { GameScreen } from "./components/GameScreen";
import { Lobby } from "./components/Lobby";
import { LoginScreen } from "./components/LoginScreen";
import { Matchmaking } from "./components/Matchmaking";
import { ResultScreen } from "./components/ResultScreen";
import { EightBitSkeleton, EightBitToastViewport } from "./components/8bit";

type Toast = { id: string; tone: "default" | "success" | "warning" | "danger" | "info"; message: string };

export default function App() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);
  const [queued, setQueued] = useState(false);
  const [matchView, setMatchView] = useState<PublicMatchView | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, ...toast }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((candidate) => candidate.id !== id));
    }, 4200);
  }, []);

  useEffect(() => {
    fetchMe()
      .then(setProfile)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!profile) {
      socketRef.current?.close();
      socketRef.current = null;
      setSocketConnected(false);
      return;
    }

    let disposed = false;

    function connect() {
      if (disposed) {
        return;
      }

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => setSocketConnected(true);
      ws.onclose = () => {
        setSocketConnected(false);
        if (!disposed) {
          reconnectRef.current = window.setTimeout(connect, 1200);
        }
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        handleServerMessage(message);
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectRef.current) {
        window.clearTimeout(reconnectRef.current);
      }
      socketRef.current?.close();
    };
  }, [profile?.userId]);

  function handleServerMessage(message: ServerMessage) {
    switch (message.type) {
      case "profile":
        setProfile(message.profile);
        break;
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
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      pushToast({ tone: "warning", message: "Server connection is reconnecting." });
      return;
    }
    socketRef.current.send(JSON.stringify(message));
  }

  async function logout() {
    await logoutGuest();
    setProfile(null);
    setMatchView(null);
    setQueued(false);
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
        <LoginScreen onLogin={setProfile} />
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
        <Lobby profile={profile} connected={socketConnected} onStart={() => send({ type: "join_queue" })} onLogout={logout} />
      )}
      <EightBitToastViewport
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </>
  );
}
