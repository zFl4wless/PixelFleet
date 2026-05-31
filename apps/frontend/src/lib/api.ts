import type { PlayerProfile } from "@pixelfleet/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Request failed.");
  }

  return response.json() as Promise<T>;
}

export async function fetchMe(): Promise<PlayerProfile | null> {
  try {
    const body = await request<{ profile: PlayerProfile }>("/api/me");
    return body.profile;
  } catch {
    return null;
  }
}

export async function loginGuest(username: string): Promise<PlayerProfile> {
  const body = await request<{ profile: PlayerProfile }>("/api/guest-login", {
    method: "POST",
    body: JSON.stringify({ username })
  });
  return body.profile;
}

export async function logoutGuest(): Promise<void> {
  await request("/api/logout", { method: "POST" });
}
