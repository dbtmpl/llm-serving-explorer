import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

const SCENARIOS_SOURCE_DIR = path.resolve(__dirname, "../scenarios");
const ALLOWED_SCENARIO_EXTENSIONS = [".json", ".md", ".yaml", ".yml", ".ndjson.gz"];

function isAllowedScenarioFile(fileName: string): boolean {
  if (fileName.endsWith(".ts") || fileName.endsWith(".tsx")) {
    return false;
  }
  return ALLOWED_SCENARIO_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

function contentTypeForFile(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "text/yaml; charset=utf-8";
  // Serve .ndjson.gz as raw compressed bytes (never Content-Encoding: gzip)
  // so browser fetch() + DecompressionStream("gzip") works identically in dev, preview, and static hosting.
  if (filePath.endsWith(".ndjson.gz")) return "application/octet-stream";
  return "application/octet-stream";
}

function copyScenariosDir(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyScenariosDir(srcPath, destPath);
    } else if (entry.isFile() && isAllowedScenarioFile(entry.name)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function scenariosStaticPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig;

  const createMiddleware = () => {
    const normalizedBase = resolvedConfig.base.endsWith("/")
      ? resolvedConfig.base
      : `${resolvedConfig.base}/`;
    const scenariosPrefix = `${normalizedBase}scenarios/`;

    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const rawUrl = req.url ?? "";
      const pathname = rawUrl.split("?")[0] ?? "";
      if (!pathname.startsWith(scenariosPrefix)) {
        next();
        return;
      }

      const relPath = decodeURIComponent(pathname.slice(scenariosPrefix.length));
      if (!relPath || relPath.includes("..")) {
        res.statusCode = 400;
        res.end("Invalid scenario path");
        return;
      }

      const fullPath = path.resolve(SCENARIOS_SOURCE_DIR, relPath);
      if (!fullPath.startsWith(SCENARIOS_SOURCE_DIR + path.sep)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile() || !isAllowedScenarioFile(fullPath)) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeForFile(fullPath));
      res.setHeader("Cache-Control", "no-cache");
      fs.createReadStream(fullPath).pipe(res);
    };
  };

  return {
    name: "llm-viz-scenarios-static",
    configResolved(config) {
      resolvedConfig = config;
    },
    configureServer(server) {
      server.middlewares.use(createMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createMiddleware());
    },
    closeBundle() {
      if (!resolvedConfig || resolvedConfig.command !== "build") {
        return;
      }
      const outScenariosDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir, "scenarios");
      if (fs.existsSync(SCENARIOS_SOURCE_DIR)) {
        copyScenariosDir(SCENARIOS_SOURCE_DIR, outScenariosDir);
      }
    }
  };
}

const base = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [react(), scenariosStaticPlugin()],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        classic: path.resolve(__dirname, "classic.html")
      }
    }
  }
});
