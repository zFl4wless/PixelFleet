#!/usr/bin/env node

const baseUrl = process.env.PIXELFLEET_URL ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3001";
const token = process.env.ADMIN_TOKEN;
const [, , command, ...args] = process.argv;

function usage(exitCode = 0) {
  console.log(`Pixel Fleet admin

Usage:
  ADMIN_TOKEN=... PIXELFLEET_URL=https://your-domain.example npm run admin -- status
  ADMIN_TOKEN=... PIXELFLEET_URL=https://your-domain.example npm run admin -- metrics
  ADMIN_TOKEN=... PIXELFLEET_URL=https://your-domain.example npm run admin -- reset runtime --yes
  ADMIN_TOKEN=... PIXELFLEET_URL=https://your-domain.example npm run admin -- reset sessions --yes
  ADMIN_TOKEN=... PIXELFLEET_URL=https://your-domain.example npm run admin -- reset stats --yes
  ADMIN_TOKEN=... PIXELFLEET_URL=https://your-domain.example npm run admin -- reset accounts --yes

Scopes:
  runtime   Clear queue, active matches, sockets and in-memory rate-limit state.
  sessions  Clear session cookies server-side and runtime state.
  stats     Reset XP, levels, stats and runtime state while keeping accounts/sessions.
  accounts  Delete all guest accounts and sessions.

All scopes preserve durable match-completion receipts to prevent duplicate rewards.
`);
  process.exit(exitCode);
}

async function request(path, init = {}) {
  if (!token) {
    throw new Error("ADMIN_TOKEN is required.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(typeof body === "string" ? body : body.error ?? `Request failed with ${response.status}`);
  }

  return body;
}

try {
  if (!command || command === "help" || command === "--help") {
    usage();
  }

  if (command === "status") {
    console.log(JSON.stringify(await request("/api/admin/status"), null, 2));
  } else if (command === "metrics") {
    console.log(JSON.stringify(await request("/api/admin/metrics"), null, 2));
  } else if (command === "reset") {
    const [scope, yes] = args;
    if (!scope || yes !== "--yes") {
      usage(1);
    }
    console.log(JSON.stringify(await request("/api/admin/reset", { method: "POST", body: JSON.stringify({ scope }) }), null, 2));
  } else {
    usage(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
