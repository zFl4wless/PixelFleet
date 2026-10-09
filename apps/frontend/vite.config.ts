import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

const appDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(appDir, "dist");
const legalRoutes = ["legal-notice", "privacy-policy"];
const noIndexTags = [
  '<meta name="robots" content="noindex, nofollow, noarchive" />',
  '<meta name="googlebot" content="noindex, nofollow, noarchive" />'
];

function routeHtmlPlugin(): Plugin {
  return {
    name: "pixelfleet-route-html",
    apply: "build",
    async closeBundle() {
      const indexPath = join(distDir, "index.html");
      const indexHtml = await readFile(indexPath, "utf8");
      const legalHtml = indexHtml.replace("</head>", `${noIndexTags.map((tag) => `    ${tag}`).join("\n")}\n  </head>`);

      await Promise.all(
        legalRoutes.map(async (route) => {
          const routeDir = join(distDir, route);
          await mkdir(routeDir, { recursive: true });
          await writeFile(join(routeDir, "index.html"), legalHtml);
        })
      );
      const notFoundHtml = legalHtml.replace(/<title>.*?<\/title>/, "<title>404 - Page not found | Pixel Fleet</title>");
      await writeFile(join(distDir, "404.html"), notFoundHtml);
    }
  };
}

export default defineConfig({
  plugins: [react(), routeHtmlPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true
      }
    }
  }
});
