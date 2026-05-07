import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, exec, execFileSync } from "node:child_process";
import type { BridgeConfig } from "../config.js";
import { asyncHandler } from "../utils.js";
import { parseSkillTarget, resolveSkillTargetDir } from "./skill-targets.js";

// Strip ANSI escape codes
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

interface SkillSearchResult {
  slug: string;
  url: string;
  installs: string;
}

function parseSkillsFindOutput(raw: string): SkillSearchResult[] {
  const clean = stripAnsi(raw);
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    // Match lines like: owner/repo@skill-name  123 installs
    const match = line.match(/^(\S+\/\S+@\S+)\s+(.+?\s+installs?)$/);
    if (match) {
      const slug = match[1]!;
      const installs = match[2]!.trim();
      // Next line is the URL
      const urlLine = lines[i + 1]?.trim();
      const url = urlLine?.startsWith("└") ? urlLine.replace(/^└\s*/, "") : `https://skills.sh/${slug.replace("@", "/")}`;
      results.push({ slug, url, installs });
    }
  }
  return results;
}

interface GitSkillInfo {
  name: string;
  description: string;
  sourcePath: string;
  relativePath: string;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(36);
}

function parseSkillMdDescription(content: string): string {
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
  return description;
}

function listSkillDirNames(dir: string): Set<string> {
  try {
    return new Set(
      fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function inferSkillNameFromSlug(slug: string): string {
  const atIndex = slug.lastIndexOf("@");
  if (atIndex >= 0) return slug.slice(atIndex + 1);
  return slug.split("/").pop() || slug;
}

function containsSkillsCliFailure(output: string): boolean {
  return /(?:installation failed|failed to clone repository|canceled|cancelled|error\s*:)/i.test(stripAnsi(output));
}

function summarizeSkillsCliError(stdout: string, stderr: string, fallback: string): string {
  const lines = stripAnsi(`${stderr}\n${stdout}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[█╚═╗╔║ ]+$/.test(line))
    .filter((line) => !line.includes("Tip: use the --yes"))
    .filter((line) => !line.startsWith("T   skills"));
  const important = lines.filter((line) => /failed|fatal|authentication|unable to access|error|canceled|cancelled|installation failed/i.test(line));
  return (important.length > 0 ? important : lines).slice(0, 5).join("\n") || fallback;
}

function findInstalledSkillDir(skillName: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, skillName);
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
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

function parseSkillsSlug(slug: string): { owner: string; repo: string; skillName: string; repoKey: string; repoUrl: string } | null {
  const match = slug.match(/^([\w\-.]+)\/([\w\-.]+)(?:@([\w\-.]+))?$/);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  const skillName = match[3] || repo;
  const repoKey = `${owner}/${repo}`;
  return {
    owner,
    repo,
    skillName,
    repoKey,
    repoUrl: `https://github.com/${repoKey}.git`,
  };
}

function parseMirrorMap(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string | string[]>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value : [value]]),
    );
  } catch {
    const entries: Record<string, string[]> = {};
    for (const item of raw.split(/[;\n]/)) {
      const [key, value] = item.split("=");
      const repoKey = key?.trim().toLowerCase();
      const url = value?.trim();
      if (repoKey && url) entries[repoKey] = [...(entries[repoKey] || []), url];
    }
    return entries;
  }
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function githubMirrorUrls(repoKey: string, repoUrl: string): string[] {
  const builtInMirrors: Record<string, string[]> = {
    "sickn33/antigravity-awesome-skills": ["https://gitee.com/github-29244000/antigravity-awesome-skills.git"],
  };
  const configuredMirrors = parseMirrorMap(process.env.NANOBOT_SKILLS_REPO_MIRROR_MAP);
  const mirrorPrefixes = (process.env.NANOBOT_GITHUB_MIRROR_PREFIXES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((prefix) => {
      if (prefix.includes("{url}")) return prefix.replace("{url}", repoUrl);
      if (prefix.includes("{repo}")) return prefix.replace("{repo}", repoKey);
      return `${prefix.replace(/\/+$/, "")}/${repoUrl}`;
    });

  return uniqueStrings([
    ...(configuredMirrors[repoKey.toLowerCase()] || []),
    ...(builtInMirrors[repoKey.toLowerCase()] || []),
    ...mirrorPrefixes,
    repoUrl,
  ]);
}

function cloneRepoFromAnyUrl(urls: string[], repoDir: string): { url: string; error?: string } {
  let lastError = "";
  for (const url of urls) {
    try {
      if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
      execFileSync("git", ["clone", "--depth", "1", url, repoDir], { stdio: "pipe", timeout: 90000 });
      return { url };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { url: "", error: lastError || "all clone attempts failed" };
}

function pickFallbackSkill(skills: GitSkillInfo[], requestedName: string): GitSkillInfo | null {
  const exact = skills.find((skill) => skill.name === requestedName);
  if (exact) return exact;

  const loose = skills.filter((skill) => skill.name.toLowerCase().includes("superpower"));
  if (requestedName.toLowerCase().includes("superpower") && loose.length === 1) {
    return loose[0]!;
  }

  return null;
}

function installSkillFromGitFallback(slug: string, targetSkillsDir: string): { ok: boolean; output: string; name: string } {
  const parsed = parseSkillsSlug(slug);
  if (!parsed) throw new Error("invalid slug format");

  const cacheDir = path.join(getMarketplacesDir(), "skills-cli-fallback-cache");
  const repoDir = path.join(cacheDir, `${parsed.repo}-${hashString(slug)}`);
  fs.mkdirSync(cacheDir, { recursive: true });

  const urls = githubMirrorUrls(parsed.repoKey, parsed.repoUrl);
  const cloned = cloneRepoFromAnyUrl(urls, repoDir);
  if (!cloned.url) {
    throw new Error(`skills.sh 安装失败，且镜像兜底也无法 clone ${parsed.repoKey}。可以设置 NANOBOT_SKILLS_REPO_MIRROR_MAP 指向可访问的 Gitee/私有镜像。${cloned.error ? `\n${cloned.error}` : ""}`);
  }

  const skills = scanForSkills(repoDir);
  const selected = pickFallbackSkill(skills, parsed.skillName);
  if (!selected) {
    const names = skills.map((skill) => skill.name).slice(0, 20).join(", ");
    throw new Error(`已从 ${cloned.url} clone 仓库，但没有找到技能 "${parsed.skillName}"。可用技能：${names || "无"}`);
  }

  const destDir = path.join(targetSkillsDir, selected.name);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  copyDirectoryRobust(selected.sourcePath, destDir);
  if (!fs.existsSync(path.join(destDir, "SKILL.md"))) {
    throw new Error(`镜像安装后缺少 SKILL.md: ${selected.name}`);
  }

  return {
    ok: true,
    output: `skills.sh clone 失败，已改用镜像仓库安装：${cloned.url}${selected.name !== parsed.skillName ? `\n请求技能 ${parsed.skillName} 未找到，已安装同仓库可用替代技能 ${selected.name}。` : ""}`,
    name: selected.name,
  };
}

/** Recursively scan a directory for skills (dirs with SKILL.md), searching up to 3 levels deep */
function scanForSkills(rootDir: string, maxDepth = 3): GitSkillInfo[] {
  const skills: GitSkillInfo[] = [];

  function walk(dir: string, depth: number, relPrefix: string) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(dir, entry.name);
      const skillMd = path.join(fullPath, "SKILL.md");
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (fs.existsSync(skillMd)) {
        const content = fs.readFileSync(skillMd, "utf-8");
        const description = parseSkillMdDescription(content);
        skills.push({
          name: entry.name,
          description,
          sourcePath: fullPath,
          relativePath: relPath,
        });
      } else {
        // Go deeper
        walk(fullPath, depth + 1, relPath);
      }
    }
  }

  walk(rootDir, 0, "");
  return skills;
}

interface MarketplaceEntry {
  name: string;
  source: string;
  type: "git" | "local";
}

interface MarketplacePluginInfo {
  name: string;
  description: string;
  marketplace_name: string;
  installed: boolean;
}

function getMarketplacesDir(): string {
  return path.join(os.homedir(), ".nanobot", "marketplaces");
}

function getMarketplacesRegistry(): string {
  return path.join(getMarketplacesDir(), "registry.json");
}

function loadRegistry(): MarketplaceEntry[] {
  const registryPath = getMarketplacesRegistry();
  if (!fs.existsSync(registryPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveRegistry(entries: MarketplaceEntry[]): void {
  const dir = getMarketplacesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getMarketplacesRegistry(), JSON.stringify(entries, null, 2));
}

function isGitUrl(source: string): boolean {
  return (
    source.startsWith("https://") ||
    source.startsWith("ssh://") ||
    source.startsWith("git://") ||
    source.startsWith("git@") ||
    source.endsWith(".git")
  );
}

function nameFromSource(source: string): string {
  const base = path.basename(source, ".git");
  return base || "marketplace";
}

function getCachePath(name: string): string {
  return path.join(getMarketplacesDir(), "cache", name);
}

// -----------------------------------------------------------------------
// Recommended skills marketplace (Gitee repo with categories)
// -----------------------------------------------------------------------

interface CategoryMeta {
  id: string;
  name: string;
  name_en: string;
  icon: string;
  description: string;
  order: number;
  path?: string;
}

interface RecommendedSkill {
  name: string;
  description: string;
  category: string;
}

interface RecommendedCategory extends CategoryMeta {
  skills: RecommendedSkill[];
}

function getRecommendedCacheDir(): string {
  return path.join(getMarketplacesDir(), "recommended-cache");
}

function cloneOrPullRecommended(repoUrl: string): string {
  const cacheDir = getRecommendedCacheDir();
  const repoDir = path.join(cacheDir, "infoxmed_skills_marketplace");
  fs.mkdirSync(cacheDir, { recursive: true });

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    try {
      execSync("git pull --rebase", { cwd: repoDir, stdio: "pipe", timeout: 30000 });
    } catch {
      // Re-clone on failure
      fs.rmSync(repoDir, { recursive: true, force: true });
      execSync(`git clone --depth 1 -b aph_skills "${repoUrl}" "${repoDir}"`, { stdio: "pipe", timeout: 60000 });
    }
  } else {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    execSync(`git clone --depth 1 -b aph_skills "${repoUrl}" "${repoDir}"`, { stdio: "pipe", timeout: 60000 });
  }
  return repoDir;
}

function loadRecommendedSkills(repoDir: string): RecommendedCategory[] {
  const skillsDir = path.join(repoDir, "skills");
  const catFile = path.join(skillsDir, "categories.json");
  if (!fs.existsSync(catFile)) return [];

  let catData: { categories: CategoryMeta[] };
  try {
    catData = JSON.parse(fs.readFileSync(catFile, "utf-8"));
  } catch {
    return [];
  }

  const results: RecommendedCategory[] = [];

  for (const cat of catData.categories) {
    // "exclusive" category uses path: "claude-plugins" under skills/

    const catDir = path.join(skillsDir, cat.path || cat.id);
    if (!fs.existsSync(catDir)) continue;

    const skills: RecommendedSkill[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(catDir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMd = path.join(catDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, "utf-8");
      const desc = parseSkillMdDescription(content);
      skills.push({ name: entry.name, description: desc, category: cat.id });
    }

    if (skills.length > 0) {
      results.push({ ...cat, skills });
    }
  }

  results.sort((a, b) => a.order - b.order);
  return results;
}

export function marketplacesRoutes(_config: BridgeConfig): Router {
  const router = Router();

  // GET /api/marketplaces
  router.get("/marketplaces", asyncHandler(async (_req, res) => {
    res.json(loadRegistry());
  }));

  // POST /api/marketplaces
  router.post("/marketplaces", asyncHandler(async (req, res) => {
    const { source } = req.body;
    if (!source) {
      res.status(400).json({ detail: "Source is required" });
      return;
    }

    const type = isGitUrl(source) ? "git" : "local";
    const name = nameFromSource(source);

    const registry = loadRegistry();
    if (registry.some((m) => m.name === name)) {
      res.status(400).json({ detail: `Marketplace '${name}' already exists` });
      return;
    }

    const entry: MarketplaceEntry = { name, source, type };

    // Clone if git
    if (type === "git") {
      const cachePath = getCachePath(name);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      try {
        execSync(`git clone --depth 1 "${source}" "${cachePath}"`, { stdio: "pipe" });
      } catch (err) {
        res.status(400).json({ detail: `Failed to clone: ${(err as Error).message}` });
        return;
      }
    } else {
      // Validate local path exists
      if (!fs.existsSync(source)) {
        res.status(400).json({ detail: `Local path does not exist: ${source}` });
        return;
      }
    }

    registry.push(entry);
    saveRegistry(registry);
    res.json(entry);
  }));

  // DELETE /api/marketplaces/:name
  router.delete("/marketplaces/:name", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const registry = loadRegistry();
    const idx = registry.findIndex((m) => m.name === name);

    if (idx === -1) {
      res.status(404).json({ detail: "Marketplace not found" });
      return;
    }

    registry.splice(idx, 1);
    saveRegistry(registry);

    // Clean up cache
    const cachePath = getCachePath(name);
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true });
    }

    res.json({ ok: true });
  }));

  // POST /api/marketplaces/:name/update
  router.post("/marketplaces/:name/update", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const registry = loadRegistry();
    const entry = registry.find((m) => m.name === name);

    if (!entry) {
      res.status(404).json({ detail: "Marketplace not found" });
      return;
    }

    if (entry.type === "git") {
      const cachePath = getCachePath(name);
      if (fs.existsSync(cachePath)) {
        try {
          execSync("git pull --rebase", { cwd: cachePath, stdio: "pipe" });
        } catch {
          // Re-clone on pull failure
          fs.rmSync(cachePath, { recursive: true });
          execSync(`git clone --depth 1 "${entry.source}" "${cachePath}"`, { stdio: "pipe" });
        }
      } else {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        execSync(`git clone --depth 1 "${entry.source}" "${cachePath}"`, { stdio: "pipe" });
      }
    } else {
      if (!fs.existsSync(entry.source)) {
        res.status(400).json({ detail: "Local path no longer exists" });
        return;
      }
    }

    res.json(entry);
  }));

  // GET /api/marketplaces/:name/plugins
  router.get("/marketplaces/:name/plugins", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const registry = loadRegistry();
    const entry = registry.find((m) => m.name === name);

    if (!entry) {
      res.status(404).json({ detail: "Marketplace not found" });
      return;
    }

    const sourcePath = entry.type === "git" ? getCachePath(name) : entry.source;
    if (!fs.existsSync(sourcePath)) {
      res.status(400).json({ detail: "Marketplace source not available" });
      return;
    }

    const plugins: MarketplacePluginInfo[] = [];
    const installedPluginsDir = path.join(os.homedir(), ".nanobot", "plugins");

    for (const dirEntry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      if (!dirEntry.isDirectory() || dirEntry.name.startsWith(".")) continue;

      const pluginDir = path.join(sourcePath, dirEntry.name);
      // Check if it looks like a plugin (has plugin.json or agents/ or skills/)
      const hasPluginJson = fs.existsSync(path.join(pluginDir, "plugin.json"));
      const hasAgents = fs.existsSync(path.join(pluginDir, "agents"));
      const hasSkills = fs.existsSync(path.join(pluginDir, "skills"));

      if (!hasPluginJson && !hasAgents && !hasSkills) continue;

      let description = "";
      if (hasPluginJson) {
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf-8"));
          description = pj.description || "";
        } catch { /* ignore */ }
      }

      const installed = fs.existsSync(path.join(installedPluginsDir, dirEntry.name));

      plugins.push({
        name: dirEntry.name,
        description,
        marketplace_name: name,
        installed,
      });
    }

    res.json(plugins);
  }));

  // POST /api/marketplaces/:name/plugins/:plugin_name/install
  router.post("/marketplaces/:name/plugins/:plugin_name/install", asyncHandler(async (req, res) => {
    const { name, plugin_name } = req.params;
    const registry = loadRegistry();
    const entry = registry.find((m) => m.name === name);

    if (!entry) {
      res.status(400).json({ detail: "Marketplace not found" });
      return;
    }

    const sourcePath = entry.type === "git" ? getCachePath(name) : entry.source;
    const pluginSourceDir = path.join(sourcePath, plugin_name);

    if (!fs.existsSync(pluginSourceDir)) {
      res.status(400).json({ detail: "Plugin not found in marketplace" });
      return;
    }

    const installedPluginsDir = path.join(os.homedir(), ".nanobot", "plugins");
    const destDir = path.join(installedPluginsDir, plugin_name);

    fs.mkdirSync(installedPluginsDir, { recursive: true });
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }
    copyDirectoryRobust(pluginSourceDir, destDir);

    res.json({ ok: true, path: destDir });
  }));

  // -----------------------------------------------------------------------
  // Git repo skill scanning & installation
  // -----------------------------------------------------------------------

  // POST /api/marketplaces/git/scan-skills — clone a git repo and list skills
  router.post("/marketplaces/git/scan-skills", asyncHandler(async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      res.status(400).json({ detail: "url is required" });
      return;
    }

    // Validate git URL format
    if (!isGitUrl(url)) {
      res.status(400).json({ detail: "Invalid git URL. Supports https://, git@, ssh://, git:// URLs" });
      return;
    }

    const repoName = nameFromSource(url);
    const cacheDir = path.join(getMarketplacesDir(), "git-skills-cache");
    const repoDir = path.join(cacheDir, repoName + "-" + hashString(url));

    fs.mkdirSync(cacheDir, { recursive: true });

    // Clone or update
    try {
      if (fs.existsSync(repoDir)) {
        // Pull latest
        try {
          execSync("git pull --rebase", { cwd: repoDir, stdio: "pipe", timeout: 30000 });
        } catch {
          // Re-clone on failure
          fs.rmSync(repoDir, { recursive: true });
          execSync(`git clone --depth 1 "${url}" "${repoDir}"`, { stdio: "pipe", timeout: 60000 });
        }
      } else {
        execSync(`git clone --depth 1 "${url}" "${repoDir}"`, { stdio: "pipe", timeout: 60000 });
      }
    } catch (err) {
      res.status(400).json({ detail: `Failed to clone repo: ${(err as Error).message}` });
      return;
    }

    // Scan for skills (directories containing SKILL.md)
    const skills = scanForSkills(repoDir);

    res.json({ repo: url, repoName, skills, cacheKey: repoName + "-" + hashString(url) });
  }));

  // POST /api/marketplaces/git/install-skills — install selected skills from a cloned git repo
  router.post("/marketplaces/git/install-skills", asyncHandler(async (req, res) => {
    const { cacheKey, skillNames } = req.body;
    if (!cacheKey || typeof cacheKey !== "string") {
      res.status(400).json({ detail: "cacheKey is required" });
      return;
    }
    if (!Array.isArray(skillNames) || skillNames.length === 0) {
      res.status(400).json({ detail: "skillNames array is required" });
      return;
    }

    const repoDir = path.join(getMarketplacesDir(), "git-skills-cache", cacheKey);
    if (!fs.existsSync(repoDir)) {
      res.status(400).json({ detail: "Repo not found in cache. Please scan first." });
      return;
    }

    const targetSkillsDir = await resolveSkillTargetDir(_config, undefined, parseSkillTarget(req.body as Record<string, unknown>));

    const installedSkills: string[] = [];
    const errors: string[] = [];

    // Build a map of all skills found in the repo
    const allSkills = scanForSkills(repoDir);
    const skillPathMap = new Map<string, string>();
    for (const s of allSkills) {
      skillPathMap.set(s.name, s.sourcePath);
    }

    for (const name of skillNames) {
      const safeName = String(name).replace(/[^a-zA-Z0-9_\-]/g, "");
      if (!safeName) {
        errors.push(`Invalid skill name: ${name}`);
        continue;
      }

      const sourcePath = skillPathMap.get(safeName);
      if (!sourcePath) {
        errors.push(`Skill not found in repo: ${safeName}`);
        continue;
      }

      const destDir = path.join(targetSkillsDir, safeName);
      try {
        if (fs.existsSync(destDir)) {
          fs.rmSync(destDir, { recursive: true });
        }
        copyDirectoryRobust(sourcePath, destDir);
        installedSkills.push(safeName);
      } catch (err) {
        errors.push(`Failed to install ${safeName}: ${(err as Error).message}`);
      }
    }

    res.json({ ok: true, installed: installedSkills, errors });
  }));

  // -----------------------------------------------------------------------
  // Recommended skills (from Gitee marketplace repo)
  // -----------------------------------------------------------------------

  // GET /api/marketplaces/recommended — list categorized recommended skills
  router.get("/marketplaces/recommended", asyncHandler(async (_req, res) => {
    try {
      const repoDir = cloneOrPullRecommended(_config.skillsMarketplaceRepo);
      const categories = loadRecommendedSkills(repoDir);
      res.json({ categories });
    } catch (err) {
      res.status(500).json({ detail: `Failed to load recommended skills: ${(err as Error).message}` });
    }
  }));

  // POST /api/marketplaces/recommended/install — install a recommended skill by category and name
  router.post("/marketplaces/recommended/install", asyncHandler(async (req, res) => {
    const { category, skillName } = req.body;
    if (!category || !skillName) {
      res.status(400).json({ detail: "category and skillName are required" });
      return;
    }

    const safeCat = String(category).replace(/[^a-zA-Z0-9_\-]/g, "");
    const safeName = String(skillName).replace(/[^a-zA-Z0-9_\-]/g, "");

    const repoDir = cloneOrPullRecommended(_config.skillsMarketplaceRepo);

    // Resolve category directory: use "path" field from categories.json if defined
    let catDir = safeCat;
    const catFile = path.join(repoDir, "skills", "categories.json");
    try {
      const catData = JSON.parse(fs.readFileSync(catFile, "utf-8"));
      const catMeta = catData.categories?.find((c: CategoryMeta) => c.id === safeCat);
      if (catMeta?.path) catDir = catMeta.path;
    } catch { /* use safeCat as fallback */ }

    const sourcePath = path.join(repoDir, "skills", catDir, safeName);

    if (!fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourcePath, "SKILL.md"))) {
      res.status(404).json({ detail: `Skill "${safeName}" not found in category "${safeCat}"` });
      return;
    }

    const targetSkillsDir = await resolveSkillTargetDir(_config, undefined, parseSkillTarget(req.body as Record<string, unknown>));
    const destDir = path.join(targetSkillsDir, safeName);

    try {
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true });
      }
      copyDirectoryRobust(sourcePath, destDir);
      res.json({ ok: true, name: safeName, path: destDir });
    } catch (err) {
      res.status(500).json({ detail: `Failed to install: ${(err as Error).message}` });
    }
  }));

  // GET /api/marketplaces/recommended/:category/:skillName/detail — get skill detail (SKILL.md + _meta.json)
  router.get("/marketplaces/recommended/:category/:skillName/detail", asyncHandler(async (req, res) => {
    const { category, skillName } = req.params;
    const safeCat = String(category).replace(/[^a-zA-Z0-9_\-]/g, "");
    const safeName = String(skillName).replace(/[^a-zA-Z0-9_\-]/g, "");

    const repoDir = cloneOrPullRecommended(_config.skillsMarketplaceRepo);

    // Resolve category directory
    let catDir = safeCat;
    const catFile = path.join(repoDir, "skills", "categories.json");
    try {
      const catData = JSON.parse(fs.readFileSync(catFile, "utf-8"));
      const catMeta = catData.categories?.find((c: CategoryMeta) => c.id === safeCat);
      if (catMeta?.path) catDir = catMeta.path;
    } catch { /* use safeCat as fallback */ }

    const skillDir = path.join(repoDir, "skills", catDir, safeName);
    const skillMdPath = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillMdPath)) {
      res.status(404).json({ detail: `Skill "${safeName}" not found in category "${safeCat}"` });
      return;
    }

    const skillMdContent = fs.readFileSync(skillMdPath, "utf-8");
    const description = parseSkillMdDescription(skillMdContent);

    // Strip frontmatter from markdown body for display
    let markdownBody = skillMdContent;
    const fmMatch = skillMdContent.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
    if (fmMatch) {
      markdownBody = skillMdContent.slice(fmMatch[0].length);
    }

    // Read _meta.json if exists
    let meta: Record<string, unknown> = {};
    const metaPath = path.join(skillDir, "_meta.json");
    try {
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      }
    } catch { /* ignore */ }

    res.json({
      name: safeName,
      description,
      category: safeCat,
      markdown: markdownBody,
      meta,
    });
  }));

  // -----------------------------------------------------------------------
  // Skills CLI integration (skills.sh)
  // -----------------------------------------------------------------------

  // POST /api/marketplaces/skills/search — search skills via `npx skills find`
  router.post("/marketplaces/skills/search", asyncHandler(async (req, res) => {
    const { query, limit } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ detail: "query is required" });
      return;
    }
    const safeQuery = query.replace(/[^\w\s\-]/g, "").slice(0, 100);
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 30);

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        exec(
          `npx --yes skills find ${JSON.stringify(safeQuery)} --limit ${safeLimit}`,
          { timeout: 30000, env: { ...process.env, NO_COLOR: "1" } },
          (err, stdout, stderr) => {
            // skills find exits 0 on success; parse stdout regardless
            if (stdout) resolve(stdout);
            else reject(new Error(stderr || (err?.message ?? "skills find failed")));
          },
        );
      });
      const results = parseSkillsFindOutput(stdout);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/marketplaces/skills/install — install a skill via `npx skills add`
  router.post("/marketplaces/skills/install", asyncHandler(async (req, res) => {
    const { slug } = req.body;
    if (!slug || typeof slug !== "string") {
      res.status(400).json({ detail: "slug is required" });
      return;
    }
    // Validate slug format: owner/repo@skill or owner/repo
    if (!/^[\w\-.]+\/[\w\-.]+(@[\w\-.]+)?$/.test(slug)) {
      res.status(400).json({ detail: "invalid slug format" });
      return;
    }

    try {
      const target = parseSkillTarget(req.body as Record<string, unknown>);
      const targetSkillsDir = await resolveSkillTargetDir(_config, undefined, target);
      const globalSkillsDir = path.join(_config.openclawHome, "skills");
      const sourceSkillDirs = [
        globalSkillsDir,
        path.join(os.homedir(), ".claude", "skills"),
        path.join(os.homedir(), ".codex", "skills"),
      ];
      const beforeByDir = new Map(sourceSkillDirs.map((dir) => [dir, listSkillDirNames(dir)]));
      const stdout = await new Promise<string>((resolve, reject) => {
        exec(
          `npx --yes skills add ${slug} -g -y`,
          { timeout: 60000, env: { ...process.env, NO_COLOR: "1" } },
          (err, stdout, stderr) => {
            // npm warnings go to stderr but are not real errors
            const cleanStderr = stripAnsi(stderr || "")
              .split("\n")
              .filter((l) => !l.startsWith("npm warn") && l.trim())
              .join("\n")
              .trim();
            const cleanStdout = stripAnsi(stdout || "");
            if (err || cleanStderr || containsSkillsCliFailure(cleanStdout)) {
              reject(new Error(summarizeSkillsCliError(cleanStdout, cleanStderr, err?.message || "skills add failed")));
            } else {
              resolve(cleanStdout);
            }
          },
        );
      }).catch((cliErr) => {
        try {
          const fallback = installSkillFromGitFallback(slug, targetSkillsDir);
          res.json(fallback);
          return null;
        } catch (fallbackErr) {
          const cliMessage = cliErr instanceof Error ? cliErr.message : String(cliErr);
          const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          throw new Error(`${cliMessage}\n\n镜像兜底失败：${fallbackMessage}`);
        }
      });
      if (stdout === null) return;
      const inferredName = inferSkillNameFromSlug(slug);
      const added = sourceSkillDirs.flatMap((dir) => {
        const before = beforeByDir.get(dir) || new Set<string>();
        const after = listSkillDirNames(dir);
        return [...after].filter((name) => !before.has(name));
      });
      const installedName = added[0] || inferredName;
      const sourceDir = findInstalledSkillDir(installedName, sourceSkillDirs);
      if (!sourceDir) {
        throw new Error(`Installed skill directory not found: ${installedName}`);
      }
      const destDir = path.join(targetSkillsDir, installedName);
      if (path.resolve(sourceDir) !== path.resolve(destDir)) {
        if (fs.existsSync(destDir)) {
          fs.rmSync(destDir, { recursive: true, force: true });
        }
        copyDirectoryRobust(sourceDir, destDir);
      }
      if (!fs.existsSync(path.join(destDir, "SKILL.md"))) {
        throw new Error(`Installed skill is missing SKILL.md: ${installedName}`);
      }
      res.json({ ok: true, output: stdout.trim(), name: installedName });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  return router;
}
