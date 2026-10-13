import type { PlayerProfile, ServerMessage, SessionState } from "@pixelfleet/shared";

export interface ClientState {
  profile: PlayerProfile | null;
  state: SessionState;
}

export const emptySessionState: ClientState = { profile: null, state: { kind: "lobby" } };

// One update replaces the entire authoritative state, including explicit emptiness.
export function applySessionMessage(current: ClientState, message: ServerMessage): ClientState {
  switch (message.type) {
    case "session_snapshot": return { profile: message.profile, state: message.state };
    case "profile": return { ...current, profile: message.profile };
    case "queue_status":
      // A cancellation sent just before matchmaking can arrive after match_found.
      // Queue status cannot revoke an active match; only a snapshot can do that.
      if (current.state.kind === "match" && current.state.view.phase !== "finished") return current;
      return { ...current, state: { kind: message.queued ? "queue" : "lobby" } };
    case "game_update":
    case "match_finished": return { ...current, state: { kind: "match", view: message.view } };
    default: return current;
  }
}
