import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import archiver from "archiver";
import unzipper from "unzipper";
import type { BridgeConfig } from "../config.js";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { asyncHandler } from "../utils.js";
import {
  containedPath,
  listSkillScopes,
  parseSkillTarget,
  resolveSkillTargetDir,
  sanitizeRelativeSkillPath,
  sanitizeSkillName,
  type SkillScopeInfo,
} from "./skill-targets.js";

interface SkillInfo {
  name: string;
  description: string;
  source: string;
  scope: string;
  scopeType: string;
  scopeLabel: string;
  agentId?: string;
  available: boolean;
  disabled: boolean;
  writable: boolean;
  path: string;
  dirPath: string;
}

function fixOriginalName(raw: string): string {
  try {
    return Buffer.from(raw, "latin1").toString("utf8");
  } catch {
    return raw;
  }
}

function copyDirectoryRobust(sourceDir: string, destDir: string): void {
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.copyFileSync(sourceDir, destDir);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRobust(sourcePath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(sourcePath);
      try {
        fs.symlinkSync(target, destPath);
      } catch {
        const resolved = fs.realpathSync(sourcePath);
        copyDirectoryRobust(resolved, destPath);
      }
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

function parseSkillMd(content: string): { description: string } {
  const lines = content.split("\n");
  let inFrontmatter = false;
  let description = "";

  for (const line of lines) {
    if (line.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) {
      const match = line.match(/^description:\s*(.+)/);
      if (match) {
        description = match[1].trim();
      }
    }
  }

  if (!description && lines.length > 0) {
    description = lines.find((l) => l.trim() && l.trim() !== "---") || "";
  }

  return { description };
}

function scanSkillsDir(scope: SkillScopeInfo): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!fs.existsSync(scope.path)) return skills;

  for (const entry of fs.readdirSync(scope.path, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(scope.path, entry.name);
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch { continue; }
    const skillMdPath = path.join(entryPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, "utf-8");
    const { description } = parseSkillMd(content);

    skills.push({
      name: entry.name,
      description,
      source: scope.type,
      scope: scope.id,
      scopeType: scope.type,
      scopeLabel: scope.label,
      agentId: scope.agentId,
      available: true,
      disabled: false,
      writable: scope.writable,
      path: skillMdPath,
      dirPath: entryPath,
    });
  }

  return skills;
}

function pickSkillDir(scopes: SkillScopeInfo[], name: string, query: Record<string, unknown>): SkillInfo | null {
  const target = parseSkillTarget(query);
  const explicitScope = typeof query.scope === "string" || typeof query.targetScope === "string" || typeof query.agentId === "string";
  const orderedScopes = explicitScope
    ? scopes.filter((scope) => {
        if (target.scope === "agent") return scope.type === "agent" && scope.agentId === target.agentId;
        return scope.type === target.scope;
      })
    : [
        ...scopes.filter((scope) => scope.type === "global"),
        ...scopes.filter((scope) => scope.type === "agent" && scope.agentId === "main"),
        ...scopes.filter((scope) => scope.type === "builtin"),
      ];

  for (const scope of orderedScopes) {
    const dir = path.join(scope.path, name);
    const skillMdPath = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    return {
      name,
      description: parseSkillMd(content).description,
      source: scope.type,
      scope: scope.id,
      scopeType: scope.type,
      scopeLabel: scope.label,
      agentId: scope.agentId,
      available: true,
      disabled: false,
      writable: scope.writable,
      path: skillMdPath,
      dirPath: dir,
    };
  }
  return null;
}

function streamSkillZip(res: { setHeader: (key: string, value: string) => void }, skillDir: string, name: string) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}.zip"`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.directory(skillDir, name);
  return archive;
}

export function skillsRoutes(config: BridgeConfig, client: BridgeGatewayClient): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

  // GET /api/skills/scopes
  router.get("/skills/scopes", asyncHandler(async (_req, res) => {
    res.json(await listSkillScopes(config, client));
  }));

  // GET /api/skills
  router.get("/skills", asyncHandler(async (req, res) => {
    const scopes = await listSkillScopes(config, client);
    const requestedScope = typeof req.query.scope === "string" ? req.query.scope : "";
    const requestedAgentId = typeof req.query.agentId === "string" ? req.query.agentId : "";
    const includeAll = req.query.all === "1" || req.query.all === "true" || requestedScope === "all";

    const scoped = includeAll
      ? scopes
      : requestedScope || requestedAgentId
        ? scopes.filter((scope) => {
            if (requestedScope === "agent") return scope.type === "agent" && scope.agentId === requestedAgentId;
            return scope.type === requestedScope;
          })
        : scopes;

    const scanned = scoped.flatMap(scanSkillsDir);

    if (includeAll || requestedScope || requestedAgentId) {
      res.json(scanned);
      return;
    }

    const priority = new Map<string, number>([["builtin", 0], ["global", 1], ["agent", 2]]);
    const skillMap = new Map<string, SkillInfo>();
    for (const skill of scanned) {
      const current = skillMap.get(skill.name);
      if (!current || (priority.get(skill.scopeType) || 0) >= (priority.get(current.scopeType) || 0)) {
        skillMap.set(skill.name, skill);
      }
    }

    try {
      const statusReport = await client.request<{ skills?: Array<{ name?: string; skillKey?: string; disabled?: boolean }> }>("skills.status", {});
      const statusSkills = statusReport?.skills || [];
      for (const ss of statusSkills) {
        const key = ss.name || ss.skillKey || "";
        const existing = skillMap.get(key);
        if (existing && ss.disabled) {
          existing.disabled = true;
        }
      }
    } catch {
      // Gateway may not support skills.status; keep filesystem result.
    }

    res.json(Array.from(skillMap.values()));
  }));

  // GET /api/skills/:name/files
  router.get("/skills/:name/files", asyncHandler(async (req, res) => {
    const name = sanitizeSkillName(req.params.name);
    if (!name) {
      res.status(400).json({ detail: "Invalid skill name" });
      return;
    }
    const scopes = await listSkillScopes(config, client);
    const skill = pickSkillDir(scopes, name, req.query as Record<string, unknown>);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }

    const files: Array<{ name: string; path: string; size: number; modified: string; editable: boolean }> = [];
    const walk = (dir: string, prefix = "") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const stat = fs.statSync(abs);
        if (entry.isDirectory()) {
          walk(abs, rel);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        files.push({
          name: entry.name,
          path: rel,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          editable: [".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".js", ".ts", ".py", ".sh", ".css"].includes(ext) && stat.size <= 512 * 1024,
        });
      }
    };
    walk(skill.dirPath);
    res.json({ skill, files });
  }));

  // GET /api/skills/:name/files/content?path=...
  router.get("/skills/:name/files/content", asyncHandler(async (req, res) => {
    const name = sanitizeSkillName(req.params.name);
    const rel = typeof req.query.path === "string" ? sanitizeRelativeSkillPath(req.query.path) : null;
    if (!name || !rel) {
      res.status(400).json({ detail: "Invalid skill name or path" });
      return;
    }
    const scopes = await listSkillScopes(config, client);
    const skill = pickSkillDir(scopes, name, req.query as Record<string, unknown>);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }
    const abs = containedPath(skill.dirPath, rel);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ detail: "File not found" });
      return;
    }
    const stat = fs.statSync(abs);
    if (stat.size > 512 * 1024) {
      res.status(400).json({ detail: "File is too large to edit" });
      return;
    }
    res.json({
      path: rel,
      name: path.basename(abs),
      content: fs.readFileSync(abs, "utf-8"),
      modified: stat.mtime.toISOString(),
      size: stat.size,
    });
  }));

  // PUT /api/skills/:name/files/content
  router.put("/skills/:name/files/content", asyncHandler(async (req, res) => {
    const name = sanitizeSkillName(req.params.name);
    const rel = typeof req.body?.path === "string" ? sanitizeRelativeSkillPath(req.body.path) : null;
    const content = typeof req.body?.content === "string" ? req.body.content : null;
    if (!name || !rel || content === null) {
      res.status(400).json({ detail: "Invalid skill name, path, or content" });
      return;
    }
    const scopes = await listSkillScopes(config, client);
    const skill = pickSkillDir(scopes, name, req.body as Record<string, unknown>);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }
    if (!skill.writable) {
      res.status(400).json({ detail: "This skill scope is read-only" });
      return;
    }
    const abs = containedPath(skill.dirPath, rel);
    if (!abs) {
      res.status(400).json({ detail: "Invalid file path" });
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
    const stat = fs.statSync(abs);
    res.json({ ok: true, path: rel, modified: stat.mtime.toISOString(), size: stat.size });
  }));

  // PUT /api/skills/:name/toggle
  router.put("/skills/:name/toggle", asyncHandler(async (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    try {
      await client.request("skills.update", {
        skillKey: req.params.name,
        enabled,
      });
      res.json({ ok: true, name: req.params.name, enabled });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // DELETE /api/skills/:name
  router.delete("/skills/:name", asyncHandler(async (req, res) => {
    const name = sanitizeSkillName(req.params.name);
    if (!name) {
      res.status(400).json({ detail: "Invalid skill name" });
      return;
    }
    const scopes = await listSkillScopes(config, client);
    const skill = pickSkillDir(scopes, name, req.query as Record<string, unknown>);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }
    if (!skill.writable) {
      res.status(400).json({ detail: "Cannot delete builtin skills" });
      return;
    }
    fs.rmSync(skill.dirPath, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  // GET /api/skills/:name/download
  router.get("/skills/:name/download", asyncHandler(async (req, res) => {
    const name = sanitizeSkillName(req.params.name);
    if (!name) {
      res.status(400).json({ detail: "Invalid skill name" });
      return;
    }
    const scopes = await listSkillScopes(config, client);
    const skill = pickSkillDir(scopes, name, req.query as Record<string, unknown>);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }
    const archive = streamSkillZip(res, skill.dirPath, name);
    archive.pipe(res);
    await archive.finalize();
  }));

  // POST /api/skills/upload
  router.post("/skills/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ detail: "No file provided" });
      return;
    }

    const originalName = fixOriginalName(file.originalname || "");
    if (!originalName.toLowerCase().endsWith(".zip")) {
      res.status(400).json({ detail: "File must be a .zip archive" });
      return;
    }

    const targetDir = await resolveSkillTargetDir(config, client, parseSkillTarget(req.body as Record<string, unknown>));
    const tmpDir = path.join(config.openclawHome, "tmp", `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const directory = await unzipper.Open.buffer(file.buffer);
      await directory.extract({ path: tmpDir });

      let skillMdPath: string | null = null;
      let skillName: string | null = null;

      if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
        skillMdPath = path.join(tmpDir, "SKILL.md");
        skillName = sanitizeSkillName(path.basename(originalName, ".zip"));
      } else {
        for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const mdPath = path.join(tmpDir, entry.name, "SKILL.md");
          if (fs.existsSync(mdPath)) {
            skillMdPath = mdPath;
            skillName = sanitizeSkillName(entry.name);
            break;
          }
        }
      }

      if (!skillMdPath || !skillName) {
        res.status(400).json({ detail: "Zip must contain a SKILL.md file" });
        return;
      }

      const destDir = path.join(targetDir, skillName);
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      const sourceDir = path.dirname(skillMdPath) === tmpDir ? tmpDir : path.dirname(skillMdPath);
      copyDirectoryRobust(sourceDir, destDir);

      const content = fs.readFileSync(path.join(destDir, "SKILL.md"), "utf-8");
      const { description } = parseSkillMd(content);

      res.json({
        name: skillName,
        description,
        available: true,
        path: path.join(destDir, "SKILL.md"),
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }));

  return router;
}
