import type { PlayerProfile } from "@pixelfleet/shared";

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

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
    throw new RequestError(body.error ?? "Request failed.", response.status);
  }

  return response.json() as Promise<T>;
}

export async function fetchMe(signal?: AbortSignal): Promise<PlayerProfile | null> {
  try {
    const body = await request<{ profile: PlayerProfile }>("/api/me", { signal });
    return body.profile;
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) return null;
    throw error;
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
