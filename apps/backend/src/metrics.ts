import type { ServerResponse } from "node:http";

type CounterName =
  | "admin_actions_total"
  | "guest_accounts_created_total"
  | "http_errors_total"
  | "http_requests_total"
  | "matches_created_total"
  | "matches_finished_total"
  | "rate_limited_total"
  | "ws_connections_accepted_total"
  | "ws_connections_rejected_total"
  | "ws_messages_rejected_total"
  | "ws_messages_total";

interface TimedEvent {
  at: number;
  message: string;
  type: "error" | "security" | "admin";
}

const counterNames: CounterName[] = [
  "admin_actions_total",
  "guest_accounts_created_total",
  "http_errors_total",
  "http_requests_total",
  "matches_created_total",
  "matches_finished_total",
  "rate_limited_total",
  "ws_connections_accepted_total",
  "ws_connections_rejected_total",
  "ws_messages_rejected_total",
  "ws_messages_total"
];

class MetricsRegistry {
  private readonly startedAt = Date.now();
  private readonly counters = new Map<CounterName, number>(counterNames.map((name) => [name, 0]));
  private readonly recentEvents: TimedEvent[] = [];

  inc(name: CounterName, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  trackResponse(res: ServerResponse): void {
    res.on("finish", () => {
      this.inc("http_requests_total");
      if (res.statusCode >= 400) {
        this.inc("http_errors_total");
      }
    });
  }

  event(type: TimedEvent["type"], message: string): void {
    this.recentEvents.push({ at: Date.now(), message, type });
    if (this.recentEvents.length > 50) {
      this.recentEvents.shift();
    }
  }

  snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      startedAt: new Date(this.startedAt).toISOString(),
      counters: Object.fromEntries(this.counters),
      recentEvents: this.recentEvents.map((event) => ({
        ...event,
        at: new Date(event.at).toISOString()
      })),
      ...extra
    };
  }

  prometheus(extra: Record<string, number> = {}): string {
    const lines = [
      "# HELP pixelfleet_uptime_seconds Process uptime in seconds.",
      "# TYPE pixelfleet_uptime_seconds gauge",
      `pixelfleet_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`
    ];

    for (const [name, value] of this.counters) {
      lines.push(`# TYPE pixelfleet_${name} counter`);
      lines.push(`pixelfleet_${name} ${value}`);
    }

    for (const [name, value] of Object.entries(extra)) {
      lines.push(`# TYPE pixelfleet_${name} gauge`);
      lines.push(`pixelfleet_${name} ${value}`);
    }

    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new MetricsRegistry();
