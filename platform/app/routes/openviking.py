"""Authenticated OpenViking diagnostics and user-facing test APIs."""

from __future__ import annotations

import logging
import re
import time
from typing import Any
from urllib.parse import unquote

import docker
import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.dependencies import get_current_user
from app.config import settings
from app.container.manager import (
    _expected_openviking_name,
    _openviking_api_key_for_user,
    ensure_running,
)
from app.db.engine import get_db
from app.db.models import User
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("platform.routes.openviking")
router = APIRouter(prefix="/api/openviking", tags=["openviking"])


class OpenVikingSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    target_uri: str = ""
    limit: int = Field(default=8, ge=1, le=30)
    score_threshold: float | None = Field(default=None, ge=0, le=1)
    include_provenance: bool = True


class OpenVikingWriteMemoryRequest(BaseModel):
    uri: str = Field(default="viking://resources/manual-memory.md", min_length=1)
    content: str = Field(min_length=1)
    mode: str = "append"
    wait: bool = True
    timeout: float | None = 30


MEMORY_CATEGORY_LABELS = {
    "profile": "用户画像",
    "preferences": "偏好",
    "entities": "实体",
    "events": "事件",
    "cases": "案例",
    "patterns": "模式",
    "tools": "工具",
    "skills": "技能",
}


def _tenant_headers(user_id: str) -> dict[str, str]:
    short_id = user_id[:8]
    api_key = _openviking_api_key_for_user(user_id)
    return {
        "Authorization": f"Bearer {api_key}",
        "X-OpenViking-Account": f"user-{short_id}",
        "X-OpenViking-User": user_id,
        "X-OpenViking-Agent": "default",
    }


async def _sidecar_base_url(user: User, db: AsyncSession) -> str:
    if not settings.user_openviking_enabled:
        raise HTTPException(status_code=404, detail="OpenViking is not enabled")
    if user.runtime_mode == "shared":
        raise HTTPException(status_code=409, detail="OpenViking panel only supports dedicated user runtime")

    await ensure_running(db, user.id)
    sidecar_name = _expected_openviking_name(user.id)
    return f"http://{sidecar_name}:{settings.user_openviking_port}"


async def _openviking_request(
    user: User,
    db: AsyncSession,
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float = 30,
) -> Any:
    base_url = await _sidecar_base_url(user, db)
    headers = _tenant_headers(user.id)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                f"{base_url}{path}",
                headers=headers,
                json=json,
                params=params,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OpenViking request failed: {exc}",
        ) from exc

    try:
        payload: Any = response.json()
    except ValueError:
        payload = response.text

    if response.status_code >= 400:
        if isinstance(payload, dict):
            detail = payload.get("detail") or payload.get("error") or payload.get("message")
        else:
            detail = payload
        raise HTTPException(status_code=response.status_code, detail=detail or "OpenViking request failed")
    return payload


def _docker_sidecar_status(user_id: str) -> dict[str, Any]:
    name = _expected_openviking_name(user_id)
    try:
        container = docker.from_env().containers.get(name)
    except Exception as exc:
        return {
            "name": name,
            "status": "missing",
            "healthy": False,
            "error": str(exc),
        }

    health = (
        container.attrs.get("State", {})
        .get("Health", {})
        .get("Status")
    )
    return {
        "name": name,
        "status": container.status,
        "healthy": container.status == "running" and health in {None, "healthy"},
        "health": health,
        "image": container.image.tags[0] if container.image.tags else container.image.short_id,
    }


def _recent_sidecar_logs(user_id: str) -> list[str]:
    name = _expected_openviking_name(user_id)
    try:
        container = docker.from_env().containers.get(name)
        raw = container.logs(tail=160).decode("utf-8", errors="replace")
    except Exception:
        return []

    lines: list[str] = []
    for line in raw.splitlines():
        if not re.search(r"\b(error|warning|failed|insufficient|circuit breaker)\b", line, re.I):
            continue
        redacted = re.sub(r"\b(sk|ov)_[A-Za-z0-9._-]{8,}\b", r"\1_***", line)
        lines.append(redacted[-600:])
    return lines[-30:]


def _memory_title(uri: str) -> str:
    name = unquote(uri.rstrip("/").split("/")[-1])
    return re.sub(r"\.md$", "", name, flags=re.I) or uri


def _memory_category(uri: str) -> str:
    marker = "/memories/"
    if marker not in uri:
        return "memory"
    rest = uri.split(marker, 1)[1]
    return rest.split("/", 1)[0] or "memory"


def _clean_memory_content(value: Any, fallback: str = "") -> str:
    text = value if isinstance(value, str) else fallback
    text = re.sub(r"^time:\s*[^\n]+\n", "", text).strip()
    text = re.sub(r"^\[[^\]]+\]:\s*", "", text).strip()
    return text


@router.get("/summary")
async def openviking_summary(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sidecar = _docker_sidecar_status(user.id)
    calls = {
        "health": ("GET", "/health", None),
        "ready": ("GET", "/ready", None),
        "system": ("GET", "/api/v1/system/status", None),
        "memoryStats": ("GET", "/api/v1/stats/memories", None),
        "queue": ("GET", "/api/v1/observer/queue", None),
        "models": ("GET", "/api/v1/observer/models", None),
        "retrieval": ("GET", "/api/v1/observer/retrieval", None),
        "vectorCount": ("GET", "/api/v1/debug/vector/count", None),
    }
    results: dict[str, Any] = {"sidecar": sidecar}
    errors: dict[str, str] = {}

    for key, (method, path, params) in calls.items():
        try:
            results[key] = await _openviking_request(user, db, method, path, params=params, timeout=12)
        except HTTPException as exc:
            errors[key] = str(exc.detail)

    results["errors"] = errors
    results["recentLogs"] = _recent_sidecar_logs(user.id)
    return results


@router.get("/sessions")
async def openviking_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _openviking_request(user, db, "GET", "/api/v1/sessions")


@router.get("/sessions/{session_id}/context")
async def openviking_session_context(
    session_id: str,
    token_budget: int = 2000,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _openviking_request(
        user,
        db,
        "GET",
        f"/api/v1/sessions/{session_id}/context",
        params={"token_budget": token_budget},
        timeout=20,
    )


@router.post("/sessions/{session_id}/commit")
async def openviking_session_commit(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _openviking_request(user, db, "POST", f"/api/v1/sessions/{session_id}/commit", timeout=60)


@router.post("/sessions/{session_id}/extract")
async def openviking_session_extract(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _openviking_request(user, db, "POST", f"/api/v1/sessions/{session_id}/extract", timeout=60)


@router.post("/search")
async def openviking_search(
    req: OpenVikingSearchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    body = req.model_dump(exclude_none=True)
    return await _openviking_request(user, db, "POST", "/api/v1/search/find", json=body, timeout=45)


@router.get("/memories")
async def openviking_memory_scroll(
    limit: int = 20,
    cursor: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    params: dict[str, Any] = {"limit": max(1, min(limit, 100))}
    if cursor:
        params["cursor"] = cursor
    return await _openviking_request(user, db, "GET", "/api/v1/debug/vector/scroll", params=params, timeout=20)


@router.get("/memories/list")
async def openviking_memory_list(
    limit: int = 60,
    category: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    root = f"viking://user/{user.id}/memories"
    payload = await _openviking_request(
        user,
        db,
        "GET",
        "/api/v1/fs/tree",
        params={
            "uri": root if not category else f"{root}/{category}",
            "level_limit": 8,
            "limit": max(20, min(limit * 4, 240)),
        },
        timeout=25,
    )
    entries = payload.get("result") if isinstance(payload, dict) else []
    if not isinstance(entries, list):
        entries = []

    memories: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("isDir"):
            continue
        uri = str(entry.get("uri") or "")
        if not uri.endswith(".md") or uri.endswith("/.abstract.md") or uri.endswith("/.overview.md"):
            continue

        item_category = _memory_category(uri)
        content = ""
        read_error = None
        try:
            content_payload = await _openviking_request(
                user,
                db,
                "GET",
                "/api/v1/content/read",
                params={"uri": uri},
                timeout=15,
            )
            content_value = content_payload.get("result") if isinstance(content_payload, dict) else content_payload
            content = _clean_memory_content(content_value, str(entry.get("abstract") or ""))
        except HTTPException as exc:
            read_error = str(exc.detail)
            content = _clean_memory_content(str(entry.get("abstract") or ""))

        memories.append(
            {
                "uri": uri,
                "title": _memory_title(uri),
                "category": item_category,
                "categoryLabel": MEMORY_CATEGORY_LABELS.get(item_category, item_category),
                "content": content,
                "abstract": entry.get("abstract") or "",
                "size": entry.get("size"),
                "modified": entry.get("modTime"),
                "path": entry.get("rel_path") or uri.replace(f"{root}/", ""),
                "readError": read_error,
            }
        )
        if len(memories) >= limit:
            break

    return {
        "status": "ok",
        "result": {
            "root": root,
            "memories": memories,
            "categories": MEMORY_CATEGORY_LABELS,
        },
        "error": None,
        "telemetry": None,
    }


@router.post("/memory/write")
async def openviking_write_memory(
    req: OpenVikingWriteMemoryRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await _openviking_request(
            user,
            db,
            "POST",
            "/api/v1/content/write",
            json=req.model_dump(exclude_none=True),
            timeout=60,
        )
    except HTTPException as exc:
        if exc.status_code != 404:
            raise

    session_id = f"manual-memory-{int(time.time())}"
    await _openviking_request(
        user,
        db,
        "POST",
        "/api/v1/sessions",
        json={"session_id": session_id},
        timeout=20,
    )
    await _openviking_request(
        user,
        db,
        "POST",
        f"/api/v1/sessions/{session_id}/messages",
        json={
            "role": "user",
            "content": (
                "请把下面内容作为可长期召回的用户记忆进行提取。"
                f"\n\n{req.content}"
            ),
        },
        timeout=20,
    )
    return await _openviking_request(
        user,
        db,
        "POST",
        f"/api/v1/sessions/{session_id}/commit",
        timeout=60,
    )


@router.post("/system/wait")
async def openviking_wait_processed(
    timeout: float = 30,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _openviking_request(
        user,
        db,
        "POST",
        "/api/v1/system/wait",
        json={"timeout": timeout},
        timeout=max(timeout + 5, 10),
    )
