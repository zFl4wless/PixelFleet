export const SESSION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
export const SESSION_LIFETIME_MS = SESSION_LIFETIME_SECONDS * 1000;

export function sessionExpiresAt(createdAt: string): number {
  return Date.parse(createdAt) + SESSION_LIFETIME_MS;
}
