import { Router } from "express";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "../config.js";
import type { GatewayRestartable } from "../server.js";
import { asyncHandler } from "../utils.js";

export function settingsRoutes(config: BridgeConfig, manager?: GatewayRestartable): Router {
  const router = Router();
  const configPath = path.join(config.openclawHome, "openclaw.json");

  function readConfig(): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.mkdirSync(config.openclawHome, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  }

  // GET /api/settings/config — read openclaw.json
  router.get("/settings/config", asyncHandler(async (_req, res) => {
    const cfg = readConfig();
    res.json({ config: cfg });
  }));

  // PUT /api/settings/config — merge-update openclaw.json
  router.put("/settings/config", asyncHandler(async (req, res) => {
    const updates = req.body as Record<string, unknown>;
    const existing = readConfig();

    // Shallow merge top-level keys, deep merge for gateway
    for (const [key, value] of Object.entries(updates)) {
      if (key === "gateway" && typeof value === "object" && value !== null &&
          typeof existing.gateway === "object" && existing.gateway !== null) {
        existing.gateway = { ...(existing.gateway as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        existing[key] = value;
      }
    }

    writeConfig(existing);
    res.json({ success: true, config: existing });
  }));

  // POST /api/settings/gateway/restart — validate config then restart the gateway process
  router.post("/settings/gateway/restart", asyncHandler(async (_req, res) => {
    if (!manager) {
      res.status(501).json({ detail: "Gateway restart not supported in this mode" });
      return;
    }

    // Validate config with `openclaw doctor --non-interactive` before restarting
    const openclawDir = process.env.OPENCLAW_DIR || path.resolve(process.cwd());
    const openclawMjs = path.join(openclawDir, "openclaw.mjs");
    const doctorEnv = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: config.openclawHome,
    };

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          [openclawMjs, "doctor", "--non-interactive"],
          { cwd: openclawDir, env: doctorEnv, timeout: 30_000 },
          (err, stdout, stderr) => {
            const output = (stdout || "") + (stderr || "");
            // Check for "Invalid config" in output — doctor exits 0 even with config warnings
            if (output.includes("Invalid config")) {
              // Extract the error lines after "Invalid config"
              const lines = output.split("\n");
              const errorLines: string[] = [];
              let capturing = false;
              for (const line of lines) {
                if (line.includes("Invalid config")) {
                  capturing = true;
                  errorLines.push(line);
                } else if (capturing && line.trimStart().startsWith("-")) {
                  errorLines.push(line);
                } else if (capturing) {
                  break;
                }
              }
              reject(new Error(errorLines.join("\n") || output));
              return;
            }
            if (err && err.code !== 0) {
              reject(new Error(`Config validation failed: ${output || err.message}`));
              return;
            }
            resolve();
          },
        );
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: "配置检查未通过，请修正后再重启网关",
        detail: (err as Error).message,
      });
      return;
    }

    try {
      await manager.restart();
      res.json({ success: true, message: "Gateway restarted" });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  return router;
}
