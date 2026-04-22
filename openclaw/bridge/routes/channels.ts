import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeGatewayClient } from "../gateway-client.js";
import type { BridgeConfig } from "../config.js";
import { asyncHandler } from "../utils.js";

interface ChannelAccountSnapshot {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  mode?: string;
  webhookUrl?: string;
  [key: string]: unknown;
}

interface ChannelsStatusResult {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: Array<{ id: string; label: string; detailLabel: string; systemImage?: string }>;
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
}

export function channelsRoutes(client: BridgeGatewayClient, config: BridgeConfig): Router {
  const router = Router();

  // GET /api/channels/status — get full channels status from gateway
  router.get("/channels/status", asyncHandler(async (_req, res) => {
    try {
      const probe = _req.query.probe === "true";
      const result = await client.request<ChannelsStatusResult>("channels.status", { probe });
      res.json(result || {});
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // GET /api/channels/configured — list channel types that have config in openclaw.json
  router.get("/channels/configured", asyncHandler(async (_req, res) => {
    try {
      const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const configPath = path.join(openclawHome, "openclaw.json");
      const configured: string[] = [];

      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const channelsCfg = cfg?.channels || {};
          // Collect channel keys that have actual config (not just defaults)
          for (const [key, value] of Object.entries(channelsCfg)) {
            if (key === "defaults" || key === "modelByChannel") continue;
            if (value && typeof value === "object") {
              configured.push(key);
            }
          }
        } catch { /* ignore parse errors */ }
      }

      res.json({ success: true, channels: configured });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // PUT /api/channels/:channelType/config — save channel config to openclaw.json
  router.put("/channels/:channelType/config", asyncHandler(async (req, res) => {
    const { channelType } = req.params;
    const channelConfig = req.body;

    const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const configPath = path.join(openclawHome, "openclaw.json");

    let cfg: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* start fresh */ }
    }

    if (!cfg.channels || typeof cfg.channels !== "object") {
      cfg.channels = {};
    }
    (cfg.channels as Record<string, unknown>)[channelType] = channelConfig;

    fs.mkdirSync(openclawHome, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    res.json({ ok: true });
  }));

  // GET /api/channels/:channelType/config — get channel config from openclaw.json
  router.get("/channels/:channelType/config", asyncHandler(async (req, res) => {
    const { channelType } = req.params;

    const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const configPath = path.join(openclawHome, "openclaw.json");

    if (!fs.existsSync(configPath)) {
      res.json({ config: null });
      return;
    }

    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const channelCfg = cfg?.channels?.[channelType] || null;
      res.json({ config: channelCfg });
    } catch {
      res.json({ config: null });
    }
  }));

  // DELETE /api/channels/:channelType/config — remove channel config from openclaw.json
  router.delete("/channels/:channelType/config", asyncHandler(async (req, res) => {
    const { channelType } = req.params;

    const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const configPath = path.join(openclawHome, "openclaw.json");

    if (!fs.existsSync(configPath)) {
      res.json({ ok: true });
      return;
    }

    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (cfg?.channels?.[channelType]) {
        delete cfg.channels[channelType];
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/channels/:channelType/logout — logout a channel account
  router.post("/channels/:channelType/logout", asyncHandler(async (req, res) => {
    const { channelType } = req.params;
    const { accountId } = req.body;

    try {
      const result = await client.request("channels.logout", {
        channel: channelType,
        accountId,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  return router;
}
