import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "../config.js";
import type { BridgeGatewayClient } from "../gateway-client.js";

export type SkillTargetScope = "global" | "builtin" | "agent";

export type SkillTarget = {
  scope: SkillTargetScope;
  agentId?: string;
};

export type SkillScopeInfo = {
  id: string;
  type: SkillTargetScope;
  label: string;
  path: string;
  agentId?: string;
  writable: boolean;
};

type AgentLike = {
  id?: string;
  name?: string | null;
  workspace?: string | null;
  identity?: {
    name?: string;
  } | null;
};

export function sanitizeSkillName(input: string): string | null {
  const name = input.trim();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || name === "." || name === "..") {
    return null;
  }
  return name;
}

export function sanitizeRelativeSkillPath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

function expandHome(value: string, cfg: BridgeConfig): string {
  if (value === "~") return cfg.openclawHome;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(cfg.openclawHome, value.slice(2));
  }
  return value;
}

function extractAgents(raw: unknown): AgentLike[] {
  if (Array.isArray(raw)) return raw as AgentLike[];
  if (raw && typeof raw === "object") {
    const record = raw as { agents?: unknown };
    if (Array.isArray(record.agents)) return record.agents as AgentLike[];
  }
  return [];
}

function getAgentLabel(agent: AgentLike): string {
  if (agent.id === "main") return "默认";
  return agent.identity?.name || agent.name || agent.id || "Agent";
}

function resolveAgentWorkspacePath(cfg: BridgeConfig, agent: AgentLike | undefined, agentId: string): string {
  const configured = typeof agent?.workspace === "string" ? agent.workspace.trim() : "";
  if (configured) return expandHome(configured, cfg);
  if (agentId === "main") return cfg.workspacePath;
  return path.join(cfg.openclawHome, `workspace-${agentId}`);
}

export async function listSkillScopes(
  cfg: BridgeConfig,
  client?: BridgeGatewayClient,
): Promise<SkillScopeInfo[]> {
  let agents: AgentLike[] = [];
  if (client) {
    try {
      agents = extractAgents(await client.request<unknown>("agents.list", {}));
    } catch {
      agents = [];
    }
  }
  if (!agents.some((agent) => agent.id === "main")) {
    agents.unshift({ id: "main", name: "默认", workspace: cfg.workspacePath });
  }

  const builtinSkillsDir = path.resolve(process.cwd(), "skills");
  const globalSkillsDir = path.join(cfg.openclawHome, "skills");
  const scopes: SkillScopeInfo[] = [
    {
      id: "global",
      type: "global",
      label: "全局技能",
      path: globalSkillsDir,
      writable: true,
    },
    {
      id: "builtin",
      type: "builtin",
      label: "内置技能",
      path: builtinSkillsDir,
      writable: false,
    },
  ];

  for (const agent of agents) {
    const agentId = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : "";
    if (!agentId) continue;
    scopes.push({
      id: `agent:${agentId}`,
      type: "agent",
      agentId,
      label: `${getAgentLabel(agent)} 的技能`,
      path: path.join(resolveAgentWorkspacePath(cfg, agent, agentId), "skills"),
      writable: true,
    });
  }

  return scopes;
}

export async function resolveSkillTargetDir(
  cfg: BridgeConfig,
  client: BridgeGatewayClient | undefined,
  target: SkillTarget,
): Promise<string> {
  if (target.scope === "agent" && !client) {
    const agentId = typeof target.agentId === "string" && target.agentId.trim() ? target.agentId.trim() : "";
    if (!agentId) throw new Error("agentId is required for agent skill target");
    const workspace = agentId === "main" ? cfg.workspacePath : path.join(cfg.openclawHome, `workspace-${agentId}`);
    const skillsDir = path.join(workspace, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    return skillsDir;
  }
  const scopes = await listSkillScopes(cfg, client);
  const found = scopes.find((scope) => {
    if (target.scope === "agent") {
      return scope.type === "agent" && scope.agentId === target.agentId;
    }
    return scope.type === target.scope;
  });
  if (!found) {
    throw new Error(target.scope === "agent" ? `Unknown agent: ${target.agentId || ""}` : `Unknown scope: ${target.scope}`);
  }
  if (!found.writable) {
    throw new Error("Target scope is read-only");
  }
  fs.mkdirSync(found.path, { recursive: true });
  return found.path;
}

export function parseSkillTarget(bodyOrQuery: Record<string, unknown>): SkillTarget {
  const rawScope = typeof bodyOrQuery.scope === "string"
    ? bodyOrQuery.scope
    : typeof bodyOrQuery.targetScope === "string"
      ? bodyOrQuery.targetScope
      : "";
  const scope = rawScope === "agent" || rawScope === "builtin" || rawScope === "global" ? rawScope : "global";
  const agentId = typeof bodyOrQuery.agentId === "string" ? bodyOrQuery.agentId.trim() : undefined;
  return { scope, agentId };
}

export function containedPath(root: string, relativePath: string): string | null {
  const resolved = path.resolve(root, relativePath);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    return null;
  }
  return resolved;
}
