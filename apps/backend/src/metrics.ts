import type { ServerResponse } from "node:http";

type CounterName =
  | "admin_actions_total"
  | "guest_accounts_created_total"
  | "http_errors_total"
  | "http_client_errors_total"
  | "http_server_errors_total"
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
  requestId?: string;
  method?: string;
  route?: string;
  stage?: "preparation" | "handler" | "static";
  responseState?: "unstarted" | "started" | "closed";
  diagnostic?: HttpDiagnostic;
}

interface HttpDiagnostic {
  kind: "database" | "type" | "syntax" | "range" | "uri" | "error" | "unknown";
  code?: string;
  sqliteCode?: number;
  location?: { component: string; line: number; column: number };
}

export interface HttpErrorContext {
  requestId: string;
  method: string | undefined;
  route: "unknown" | "health" | "me" | "guest-login" | "logout" | "admin-status" | "admin-metrics" | "admin-reset" | "admin-other" | "metrics" | "api-other" | "static";
  stage: "preparation" | "handler" | "static";
  responseState: "unstarted" | "started" | "closed";
}

function httpDiagnostic(error: unknown): HttpDiagnostic {
  try {
    if (!(error instanceof Error)) return { kind: "unknown" };
    const detail = error as Error & { code?: unknown; errcode?: unknown };
    const allowedCodes = new Set(["ERR_SQLITE_ERROR", "ENOENT", "ENOTDIR", "EACCES", "EIO", "EBUSY", "EMFILE", "ENFILE", "ENOSPC", "ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]);
    const code = typeof detail.code === "string" && allowedCodes.has(detail.code) ? detail.code : undefined;
    const kind = code === "ERR_SQLITE_ERROR" ? "database" : error instanceof TypeError ? "type"
      : error instanceof SyntaxError ? "syntax" : error instanceof RangeError ? "range"
      : error instanceof URIError ? "uri" : "error";
    // Keep only a known application component and numeric position, never raw
    // messages, stack frames, absolute paths, headers, URLs or body contents.
    const frame = typeof error.stack === "string"
      ? error.stack.match(/\n\s+at [^\n]*[/\\](db|http|server|migrations|input-errors)\.(?:ts|js):(\d{1,7}):(\d{1,7})\)?(?:\n|$)/) : null;
    return {
      kind, ...(code ? { code } : {}),
      ...(code === "ERR_SQLITE_ERROR" && typeof detail.errcode === "number" && Number.isInteger(detail.errcode) && detail.errcode >= 0 && detail.errcode <= 65535
        ? { sqliteCode: detail.errcode } : {}),
      ...(frame ? { location: { component: frame[1], line: Number(frame[2]), column: Number(frame[3]) } } : {})
    };
  } catch {
    return { kind: "unknown" }; // Even a hostile thrown object's getters cannot break the handler.
  }
}

const counterNames: CounterName[] = [
  "admin_actions_total",
  "guest_accounts_created_total",
  "http_errors_total",
  "http_client_errors_total",
  "http_server_errors_total",
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
  private readonly trackedResponses = new WeakSet<ServerResponse>();

  inc(name: CounterName, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  trackResponse(res: ServerResponse): void {
    if (this.trackedResponses.has(res)) return;
    this.trackedResponses.add(res);
    res.once("finish", () => {
      this.inc("http_requests_total");
      if (res.statusCode >= 400) {
        this.inc("http_errors_total");
      }
      if (res.statusCode >= 400 && res.statusCode < 500) this.inc("http_client_errors_total");
      if (res.statusCode >= 500 && res.statusCode < 600) this.inc("http_server_errors_total");
    });
  }

  event(type: TimedEvent["type"], message: string): void {
    this.recentEvents.push({ at: Date.now(), message, type });
    if (this.recentEvents.length > 50) {
      this.recentEvents.shift();
    }
  }

  httpError(context: HttpErrorContext, error: unknown): void {
    const method = ["GET", "HEAD", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"].includes(context.method ?? "") ? context.method : "OTHER";
    this.recentEvents.push({ at: Date.now(), type: "error", message: "Unexpected HTTP request failure.",
      ...context, method, diagnostic: httpDiagnostic(error) });
    if (this.recentEvents.length > 50) this.recentEvents.shift();
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
