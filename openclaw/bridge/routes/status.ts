import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Router } from "express";
import type { BridgeGatewayClient } from "../gateway-client.js";
import type { BridgeConfig } from "../config.js";
import { asyncHandler } from "../utils.js";

export function statusRoutes(client: BridgeGatewayClient, config: BridgeConfig): Router {
  const router = Router();

  // GET /api/ping
  router.get("/ping", (_req, res) => {
    res.json({ message: "pong" });
  });

  // GET /api/status
  router.get("/status", asyncHandler(async (_req, res) => {
    const status: Record<string, unknown> = {
      config_path: `${config.openclawHome}/openclaw.json`,
      config_exists: true,
      workspace: config.workspacePath,
      workspace_exists: true,
      model: (() => {
        try {
          const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
          const cfg = JSON.parse(fs.readFileSync(path.join(openclawHome, "openclaw.json"), "utf-8"));
          return cfg?.agents?.defaults?.model || config.model;
        } catch { return config.model; }
      })(),
      max_tokens: 8192,
      temperature: 0.7,
      max_tool_iterations: 10,
      providers: [
        {
          name: "platform-proxy",
          has_key: true,
          detail: config.proxyUrl,
        },
      ],
      channels: [
        { name: "web", enabled: true },
      ],
      gateway_connected: client.isConnected(),
    };

    // Try to get cron info from gateway
    try {
      const cronJobs = await client.request<unknown[]>("cron.list", {});
      status.cron = {
        enabled: true,
        jobs: Array.isArray(cronJobs) ? cronJobs.length : 0,
        next_wake_at_ms: null,
      };
    } catch {
      status.cron = { enabled: false, jobs: 0, next_wake_at_ms: null };
    }

    res.json(status);
  }));

  return router;
}
