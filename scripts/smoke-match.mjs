import WebSocket from "ws";
import { createRandomFleet, WS_PROTOCOL } from "@pixelfleet/shared";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:5173";
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
const apiUrl = `${baseUrl}/api`;

function seededRandom(seedStart) {
  let seed = seedStart;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

async function createClient(username, seed) {
  const login = await fetch(`${apiUrl}/guest-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  if (!login.ok) {
    throw new Error(`Login failed for ${username}: ${await login.text()}`);
  }

  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    throw new Error(`Missing session cookie for ${username}`);
  }

  const { profile } = await login.json();
  const client = {
    username,
    profile,
    view: null,
    finished: null,
    errors: [],
    messages: [],
    initialized: false,
    targets: Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10) })),
    ws: new WebSocket(wsUrl, WS_PROTOCOL, { headers: { Cookie: cookie } })
  };

  client.ws.on("message", (payload) => {
    const message = JSON.parse(payload.toString());
    client.messages.push(message);
    if (message.type === "session_snapshot") {
      if (message.profile.userId !== profile.userId || message.state.kind !== "lobby") throw new Error("Unexpected initial smoke state");
      client.profile = message.profile;
      client.initialized = true;
    }
    if (message.type === "game_update" || message.type === "match_finished") {
      client.view = message.view;
    }
    if (message.type === "match_finished") {
      client.finished = message.view.result;
    }
    if (message.type === "error") {
      client.errors.push(message.message);
    }
  });

  await waitFor(() => client.ws.readyState === WebSocket.OPEN && client.initialized, `${username} initialized websocket`);
  client.placements = createRandomFleet(seededRandom(seed));
  return client;
}

function waitFor(predicate, label, timeoutMs = 15_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function send(client, message) {
  client.ws.send(JSON.stringify(message));
}

function nextUnknownTarget(client) {
  const known = new Set((client.view?.enemyBoard ?? []).filter((cell) => cell.state !== "unknown").map((cell) => `${cell.x}:${cell.y}`));
  return client.targets.find((target) => !known.has(`${target.x}:${target.y}`));
}

const clientA = await createClient(`Smoke A ${Date.now().toString(36)}`, 13);
const clientB = await createClient(`Smoke B ${Date.now().toString(36)}`, 29);

send(clientA, { type: "join_queue" });
send(clientB, { type: "join_queue" });

await waitFor(() => clientA.view?.phase === "placing" && clientB.view?.phase === "placing", "matchmaking");

send(clientA, { type: "place_ships", placements: clientA.placements });
send(clientB, { type: "place_ships", placements: clientB.placements });

await waitFor(() => clientA.view?.phase === "playing" && clientB.view?.phase === "playing", "playing phase");

for (let turn = 0; turn < 220; turn += 1) {
  if (clientA.finished && clientB.finished) {
    break;
  }

  const currentTurn = clientA.view?.currentTurnUserId;
  const shooter = currentTurn === clientA.profile.userId ? clientA : clientB;
  const target = nextUnknownTarget(shooter);
  if (!target) {
    throw new Error(`No target left for ${shooter.username}`);
  }

  send(shooter, { type: "fire", ...target });
  await waitFor(
    () => shooter.finished || shooter.view?.currentTurnUserId !== currentTurn,
    `turn resolution for ${shooter.username}`
  );

  if (clientA.errors.length || clientB.errors.length) {
    throw new Error(`Server rejected smoke action: ${[...clientA.errors, ...clientB.errors].join(", ")}`);
  }
}

await waitFor(() => clientA.finished && clientB.finished, "match finish");

clientA.ws.close();
clientB.ws.close();

console.log(
  JSON.stringify(
    {
      ok: true,
      winner: clientA.finished.won ? clientA.username : clientB.username,
      a: { won: clientA.finished.won, xp: clientA.finished.xpEarned },
      b: { won: clientB.finished.won, xp: clientB.finished.xpEarned }
    },
    null,
    2
  )
);
