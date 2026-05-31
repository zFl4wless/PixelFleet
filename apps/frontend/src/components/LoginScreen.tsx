import { useState } from "react";
import type { PlayerProfile } from "@pixelfleet/shared";
import { loginGuest } from "../lib/api";
import { EightBitLoginForm } from "./8bit";

export function LoginScreen({ onLogin }: { onLogin: (profile: PlayerProfile) => void }) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function submit() {
    setError(undefined);
    setLoading(true);
    try {
      const profile = await loginGuest(username);
      onLogin(profile);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <EightBitLoginForm
        username={username}
        error={error}
        loading={loading}
        onUsernameChange={setUsername}
        onSubmit={submit}
      />
    </main>
  );
}
