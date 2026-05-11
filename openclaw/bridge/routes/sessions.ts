import { Router } from "express";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asyncHandler, toOpenclawSessionKey, toNanobotSessionId, extractTextContent, stripInboundMetadata, cleanSessionTitle } from "../utils.js";
import { loadConfig } from "../config.js";

interface OpenclawSessionRow {
  key: string;
  updatedAt: number | null;
  [key: string]: unknown;
}

interface OpenclawSessionsListResult {
  sessions: OpenclawSessionRow[];
  [key: string]: unknown;
}

interface OpenclawChatHistoryResult {
  messages: Array<{
    role: string;
    content: unknown;
    timestamp?: number | string | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface LocalSessionStoreEntry {
  sessionId?: string;
  updatedAt?: number;
  sessionStartedAt?: number;
  sessionFile?: string;
  label?: string | null;
  displayName?: string;
  subject?: string;
  origin?: {
    label?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface LocalSessionRecord {
  key: string;
  storePath: string;
  agentId?: string;
  entry: LocalSessionStoreEntry;
}

function normalizeGeneratedTitle(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  const cleaned = firstLine
    .replace(/^["'“”‘’「」《》]+|["'“”‘’「」《》。.!！?？]+$/g, "")
    .replace(/^标题[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return Array.from(cleaned).slice(0, 24).join("");
}

const sessionsWithTitleGenerationStarted = new Set<string>();
const HIDDEN_ASSISTANT_TEXTS = new Set([
  "HEARTBEAT_OK",
  "[assistant turn failed before producing content]",
]);

function isDefaultMainSessionKey(key: string): boolean {
  return key === "agent:main:main" || key === "main";
}

function isHiddenAssistantText(text: string): boolean {
  return HIDDEN_ASSISTANT_TEXTS.has(text.trim());
}

function isHiddenSessionTitle(title: string): boolean {
  const normalized = title.trim();
  return (
    isHiddenAssistantText(normalized) ||
    /heartbeat|心跳/i.test(normalized) ||
    normalized === "main 会话"
  );
}

async function generateSessionTitle(message: string): Promise<string> {
  const fallback = "新对话";
  const config = loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${config.proxyUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.proxyToken}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 32,
        messages: [
          {
            role: "system",
            content: [
              "你是对话标题生成器。",
              "请只根据用户第一条消息概括其真实意图和要求。",
              "输出一个中文短标题，8到16个汉字为宜，最多24个汉字。",
              "不要使用引号、句号、编号、解释、Markdown。",
              "不要照抄用户原文，要提炼问题主题。",
              "不要根据助手回答内容生成标题。",
              "如果用户只是在询问某个助手能做什么，也要说明具体对象，例如“询问演示文稿助手能力”。",
            ].join("\n"),
          },
          {
            role: "user",
            content: message,
          },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return normalizeGeneratedTitle(data.choices?.[0]?.message?.content || "") || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function hasStoredSessionTitle(row: OpenclawSessionRow | undefined): boolean {
  if (!row) return false;
  const displayName = typeof row.displayName === "string" && row.displayName !== "OpenClaw Bridge"
    ? cleanSessionTitle(row.displayName)
    : "";
  const label = typeof row.label === "string" ? cleanSessionTitle(row.label) : "";
  const derivedTitle = typeof row.derivedTitle === "string" ? cleanSessionTitle(row.derivedTitle) : "";
  return Boolean(displayName || label || derivedTitle);
}

async function shouldCreateFirstQuestionTitle(params: {
  client: BridgeGatewayClient;
  key: string;
}): Promise<boolean> {
  if (sessionsWithTitleGenerationStarted.has(params.key)) return false;

  const sessionRow = await params.client.request<OpenclawSessionsListResult>("sessions.list", {
    includeDerivedTitles: true,
  })
    .then((result) => (result.sessions || []).find((s) => toOpenclawSessionKey(String(s.key)) === params.key))
    .catch(() => undefined);

  return !hasStoredSessionTitle(sessionRow);
}

/** Convert "agent:programmer:session-1773503840989" → "programmer 会话" */
function friendlySessionKey(key: string): string {
  const parts = key.split(":");
  // agent:<name>:session-<ts> or agent:<name>:<channel>:<id>
  if (parts.length >= 2 && parts[0] === "agent") {
    const agentName = parts[1]!;
    return `${agentName} 会话`;
  }
  return key;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function toIsoTimestamp(value: unknown): string | null {
  const numeric = toFiniteNumber(value);
  if (numeric !== null) return new Date(numeric).toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function stripMessageTimestamp(text: string): string {
  return text.replace(/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/, "");
}

function readJsonObject(filePath: string): Record<string, LocalSessionStoreEntry> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, LocalSessionStoreEntry>;
  } catch {
    return null;
  }
}

function inferAgentIdFromStorePath(storePath: string, openclawHome: string): string | undefined {
  const relative = path.relative(openclawHome, storePath).split(path.sep);
  if (relative.length >= 4 && relative[0] === "agents" && relative[2] === "sessions") {
    return relative[1];
  }
  return undefined;
}

function listLocalSessionStorePaths(openclawHome: string): string[] {
  const paths: string[] = [];
  const rootStore = path.join(openclawHome, "sessions", "sessions.json");
  if (fs.existsSync(rootStore)) paths.push(rootStore);

  const agentsDir = path.join(openclawHome, "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const storePath = path.join(agentsDir, entry.name, "sessions", "sessions.json");
      if (fs.existsSync(storePath)) paths.push(storePath);
    }
  } catch {
    // No agent session stores yet.
  }
  return paths;
}

function loadLocalSessionRecords(): LocalSessionRecord[] {
  const cfg = loadConfig();
  const byKey = new Map<string, LocalSessionRecord>();

  for (const storePath of listLocalSessionStorePaths(cfg.openclawHome)) {
    const store = readJsonObject(storePath);
    if (!store) continue;
    const agentId = inferAgentIdFromStorePath(storePath, cfg.openclawHome);
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const existing = byKey.get(key);
      const updatedAt = toFiniteNumber(entry.updatedAt) ?? 0;
      const existingUpdatedAt = existing ? (toFiniteNumber(existing.entry.updatedAt) ?? 0) : -1;
      if (!existing || updatedAt >= existingUpdatedAt) {
        byKey.set(key, { key, storePath, agentId, entry });
      }
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    return (toFiniteNumber(b.entry.updatedAt) ?? 0) - (toFiniteNumber(a.entry.updatedAt) ?? 0);
  });
}

function resolveLocalTranscriptPath(record: LocalSessionRecord): string | null {
  const sessionFile = typeof record.entry.sessionFile === "string" ? record.entry.sessionFile.trim() : "";
  if (sessionFile) {
    return path.isAbsolute(sessionFile)
      ? sessionFile
      : path.resolve(path.dirname(record.storePath), sessionFile);
  }

  const sessionId = typeof record.entry.sessionId === "string" ? record.entry.sessionId.trim() : "";
  if (!sessionId) return null;
  return path.join(path.dirname(record.storePath), `${sessionId}.jsonl`);
}

function readTranscriptHead(filePath: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = Math.min(maxBytes, stat.size);
    if (size <= 0) return "";
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function normalizeVisibleMessageText(role: string, content: unknown): string {
  const text = stripMessageTimestamp(extractTextContent(content)).trim();
  return role === "user" ? stripInboundMetadata(text).trim() : text;
}

function parseLocalTranscriptMessage(line: string): {
  role: string;
  content: string;
  timestamp: string | null;
} | null {
  if (!line.trim()) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawMessage = parsed.message;
  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) return null;
  const message = rawMessage as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") return null;
  if (role === "assistant" && message.tool_calls) return null;

  const text = normalizeVisibleMessageText(role, message.content);
  if (!text) return null;
  if (role === "assistant" && isHiddenAssistantText(text)) return null;

  return {
    role,
    content: text,
    timestamp: toIsoTimestamp(message.timestamp) || toIsoTimestamp(parsed.timestamp),
  };
}

function readFirstUserMessageFromTranscript(filePath: string): string {
  const head = readTranscriptHead(filePath);
  if (!head) return "";
  for (const line of head.split(/\r?\n/)) {
    const message = parseLocalTranscriptMessage(line);
    if (message?.role === "user") return message.content;
  }
  return "";
}

function readLocalTranscriptMessages(filePath: string, limit = 200): OpenclawChatHistoryResult["messages"] {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: OpenclawChatHistoryResult["messages"] = [];
  for (const line of content.split(/\r?\n/)) {
    const message = parseLocalTranscriptMessage(line);
    if (!message) continue;
    messages.push(message);
  }

  return messages.length > limit ? messages.slice(-limit) : messages;
}

function buildLocalSessionTitle(record: LocalSessionRecord): { title: string; hasTitle: boolean } {
  const displayName = typeof record.entry.displayName === "string" && record.entry.displayName !== "OpenClaw Bridge"
    ? cleanSessionTitle(record.entry.displayName)
    : "";
  const label = typeof record.entry.label === "string" ? cleanSessionTitle(record.entry.label) : "";
  const subject = typeof record.entry.subject === "string" ? cleanSessionTitle(record.entry.subject) : "";
  const originLabel = typeof record.entry.origin?.label === "string" && record.entry.origin.label !== "OpenClaw Bridge"
    ? cleanSessionTitle(record.entry.origin.label)
    : "";
  let title = displayName || label || subject || originLabel;

  if (!title) {
    const transcriptPath = resolveLocalTranscriptPath(record);
    if (transcriptPath) {
      title = cleanSessionTitle(readFirstUserMessageFromTranscript(transcriptPath));
    }
  }

  const cleaned = cleanSessionTitle(stripMessageTimestamp(title)).trim();
  return {
    title: cleaned || friendlySessionKey(record.key),
    hasTitle: Boolean(cleaned),
  };
}

function listLocalSessions(limit?: number): Array<{
  key: string;
  created_at: string | null;
  updated_at: string | null;
  title: string;
}> {
  const records = loadLocalSessionRecords();
  const sliced = typeof limit === "number" && Number.isFinite(limit)
    ? records.slice(0, Math.max(1, Math.floor(limit)))
    : records;

  return sliced
    .map((record) => {
      const { title, hasTitle } = buildLocalSessionTitle(record);
      return {
        key: toNanobotSessionId(record.key),
        created_at: toIsoTimestamp(record.entry.sessionStartedAt) || toIsoTimestamp(record.entry.updatedAt),
        updated_at: toIsoTimestamp(record.entry.updatedAt),
        title,
        hasTitle,
      };
    })
    .filter((session) => {
      if (isHiddenSessionTitle(session.title)) return false;
      if (isDefaultMainSessionKey(session.key) && !session.hasTitle) return false;
      return true;
    })
    .map(({ hasTitle, ...session }) => session);
}

function findLocalSessionRecord(key: string): LocalSessionRecord | null {
  const normalizedKey = toOpenclawSessionKey(key);
  return loadLocalSessionRecords().find((record) => record.key === normalizedKey) || null;
}

function loadLocalSessionDetail(key: string): {
  key: string;
  messages: OpenclawChatHistoryResult["messages"];
  created_at: string | null;
  updated_at: string | null;
} | null {
  const record = findLocalSessionRecord(key);
  if (!record) return null;
  const transcriptPath = resolveLocalTranscriptPath(record);
  const messages = transcriptPath ? readLocalTranscriptMessages(transcriptPath) : [];
  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];

  return {
    key: toNanobotSessionId(record.key),
    messages,
    created_at: toIsoTimestamp(firstMsg?.timestamp) || toIsoTimestamp(record.entry.sessionStartedAt) || null,
    updated_at: toIsoTimestamp(lastMsg?.timestamp) || toIsoTimestamp(record.entry.updatedAt) || null,
  };
}

export function sessionsRoutes(client: BridgeGatewayClient): Router {
  const router = Router();

  // GET /api/sessions — list sessions
  router.get("/sessions", asyncHandler(async (req, res) => {
    try {
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(50, Math.floor(rawLimit as number)))
        : undefined;
      const localSessions = listLocalSessions(limit);
      res.setHeader("X-OpenClaw-Session-Source", "local-store");
      res.json(localSessions);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // GET /api/sessions/:key — get session detail with messages
  router.get("/sessions/:key(*)", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);

    try {
      const localDetail = loadLocalSessionDetail(key);
      if (localDetail) {
        res.setHeader("X-OpenClaw-Session-Source", "local-store");
        res.json(localDetail);
        return;
      }

      const history = await client.request<OpenclawChatHistoryResult>("chat.history", {
        sessionKey: key,
        limit: 200,
      });

      // Filter: only user and assistant messages (skip tool, system)
      // Also filter intermediate assistant messages that have tool_calls or empty content
      const messages = (history.messages || [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => {
          if (m.role !== "assistant") return true;
          // Skip assistant messages that are just tool calls
          if (m.tool_calls) return false;
          // Skip assistant messages with empty content (intermediate agent loop artifacts)
          const text = extractTextContent(m.content);
          if (!text.trim()) return false;
          if (isHiddenAssistantText(text)) return false;
          return true;
        })
        .map((m) => ({
          role: m.role,
          content: m.role === "user"
            ? stripInboundMetadata(extractTextContent(m.content))
            : extractTextContent(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        }));

      // Determine timestamps from messages
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      res.json({
        key: toNanobotSessionId(key),
        messages,
        created_at: firstMsg?.timestamp || null,
        updated_at: lastMsg?.timestamp || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/sessions/:key/messages — send a chat message
  router.post("/sessions/:key(*)/messages", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ detail: "message is required" });
      return;
    }

    try {
      const params: Record<string, unknown> = {
        sessionKey: key,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      };

      const result = await client.request<Record<string, unknown>>("chat.send", params);

      res.json({ ok: true, runId: result.runId || null, title: null });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/sessions/:key/title-summary — summarize the first user question into a fixed title
  router.post("/sessions/:key(*)/title-summary", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

    if (!message) {
      res.status(400).json({ detail: "message is required" });
      return;
    }

    try {
      const shouldGenerateTitle = await shouldCreateFirstQuestionTitle({ client, key });
      if (!shouldGenerateTitle) {
        res.json({ ok: true, key: toNanobotSessionId(key), title: null });
        return;
      }

      sessionsWithTitleGenerationStarted.add(key);
      const title = await generateSessionTitle(message);
      await client.request("sessions.patch", {
        key,
        label: title,
      }).catch(() => {});

      res.json({ ok: true, key: toNanobotSessionId(key), title });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // PUT /api/sessions/:key/title — set or clear a custom session title
  router.put("/sessions/:key(*)/title", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);
    const rawTitle = req.body?.title;
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";

    try {
      const result = await client.request<Record<string, unknown>>("sessions.patch", {
        key,
        label: title || null,
      });
      res.json({
        ok: true,
        key: toNanobotSessionId(String(result.key || key)),
        title: title || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // GET /api/runs/:runId/wait — wait for a specific agent/chat run to finish
  router.get("/runs/:runId/wait", asyncHandler(async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    const rawTimeout = Number(req.query.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout)
      ? Math.max(0, Math.min(30_000, Math.floor(rawTimeout)))
      : 25_000;

    if (!runId) {
      res.status(400).json({ detail: "runId is required" });
      return;
    }

    try {
      const result = await client.request<Record<string, unknown>>("agent.wait", {
        runId,
        timeoutMs,
      });
      res.json({
        runId,
        status: result.status || "timeout",
        startedAt: result.startedAt || null,
        endedAt: result.endedAt || null,
        error: result.error || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/runs/:runId/abort — 终止某个特定对话的逻辑
  router.post("/sessions/:key(*)/abort-active", asyncHandler(async (req, res) => {
    const sessionKey = toOpenclawSessionKey(req.params.key);
    if (!sessionKey) {
      res.status(400).json({ detail: "sessionKey is required" });
      return;
    }

    try {
      const result = await client.request<Record<string, unknown>>("chat.abort", {
        sessionKey,
      });
      const runIds = Array.isArray(result.runIds) ? result.runIds.map(item => String(item)) : [];
      res.json({
        ok: true,
        aborted: Boolean(result.aborted),
        runIds,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  router.post("/runs/:runId/abort", asyncHandler(async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    const rawSessionKey = String(req.body?.sessionKey || "").trim();
    const sessionKey = rawSessionKey ? toOpenclawSessionKey(rawSessionKey) : "";

    if (!runId) {
      res.status(400).json({ detail: "runId is required" });
      return;
    }
    if (!sessionKey) {
      res.status(400).json({ detail: "sessionKey is required" });
      return;
    }

    try {
      const result = await client.request<Record<string, unknown>>("chat.abort", {
        sessionKey,
        runId,
      });
      const runIds = Array.isArray(result.runIds) ? result.runIds.map(item => String(item)) : [];
      res.json({
        ok: true,
        aborted: Boolean(result.aborted),
        runIds,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // DELETE /api/sessions/:key — delete session
  router.delete("/sessions/:key(*)", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);

    try {
      await client.request("sessions.delete", { key });
      res.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("INVALID_REQUEST")) {
        res.status(404).json({ detail: "Session not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  return router;
}
