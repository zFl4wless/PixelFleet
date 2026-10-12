import { access } from "node:fs/promises";
import { chromium } from "@playwright/test";

export default async function setup() {
  try {
    await Promise.all([
      access("apps/backend/dist/server.js"),
      access("apps/frontend/dist/index.html")
    ]);
  } catch {
    throw new Error("Browser tests require the production build. Run npm run build first.");
  }
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch (error) {
    throw new Error("Chromium is unavailable. Run npm run browser:install during preparation (not during tests).", { cause: error });
  }
}
