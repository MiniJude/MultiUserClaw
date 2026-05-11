"""Authenticated OpenViking diagnostics and user-facing test APIs."""

from __future__ import annotations

import logging
import re
import time
import asyncio
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
    _ensure_openviking_sidecar,
    _openviking_api_key_for_user,
    _published_binding,
)
from app.db.engine import get_db
from app.db.models import User
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("platform.routes.openviking")
router = APIRouter(prefix="/api/openviking", tags=["openviking"])
_SIDECAR_BASE_CACHE: dict[str, tuple[str, float]] = {}
_SIDECAR_BASE_CACHE_TTL = 30.0


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


async def _wait_sidecar_ready(base_url: str, headers: dict[str, str], timeout: float = 12) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
                response = await client.get(f"{base_url}/health", headers=headers)
            if response.status_code < 500:
                return
        except httpx.HTTPError as exc:
            last_error = exc
        await asyncio.sleep(0.4)
    if last_error:
        logger.info("OpenViking sidecar did not become ready within %.1fs: %s", timeout, last_error)


async def _sidecar_base_url(user: User, db: AsyncSession) -> str:
    if not settings.user_openviking_enabled:
        raise HTTPException(status_code=404, detail="OpenViking is not enabled")
    if user.runtime_mode == "shared":
        raise HTTPException(status_code=409, detail="OpenViking panel only supports dedicated user runtime")

    cached = _SIDECAR_BASE_CACHE.get(user.id)
    now = time.monotonic()
    if cached and cached[1] > now:
        return cached[0]

    await asyncio.to_thread(_ensure_openviking_sidecar, user.id)
    sidecar_name = _expected_openviking_name(user.id)
    base_url = f"http://{sidecar_name}:{settings.user_openviking_port}"
    try:
        def _resolve_published_url() -> str | None:
            sidecar = docker.from_env().containers.get(sidecar_name)
            sidecar.reload()
            host_ip, host_port = _published_binding(sidecar, f"{settings.user_openviking_port}/tcp")
            if not host_port:
                return None
            host = host_ip if host_ip and host_ip not in {"0.0.0.0", "::"} else "127.0.0.1"
            return f"http://{host}:{host_port}"

        published_url = await asyncio.to_thread(_resolve_published_url)
        if published_url:
            base_url = published_url
    except Exception as exc:
        logger.debug("Failed to resolve published OpenViking port for %s: %s", sidecar_name, exc)
    await _wait_sidecar_ready(base_url, _tenant_headers(user.id))
    _SIDECAR_BASE_CACHE[user.id] = (base_url, now + _SIDECAR_BASE_CACHE_TTL)
    return base_url


async def _request_openviking_base(
    base_url: str,
    headers: dict[str, str],
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float = 30,
) -> Any:
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
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
    return await _request_openviking_base(
        await _sidecar_base_url(user, db),
        _tenant_headers(user.id),
        method,
        path,
        json=json,
        params=params,
        timeout=timeout,
    )


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
    results: dict[str, Any] = {}
    errors: dict[str, str] = {}
    base_url = await _sidecar_base_url(user, db)
    headers = _tenant_headers(user.id)
    results["sidecar"] = _docker_sidecar_status(user.id)

    async def _run_check(
        client: httpx.AsyncClient,
        key: str,
        method: str,
        path: str,
        params: Any,
    ) -> tuple[str, Any, str | None]:
        try:
            response = await client.request(
                method,
                f"{base_url}{path}",
                headers=headers,
                params=params,
            )
            try:
                value: Any = response.json()
            except ValueError:
                value = response.text
            if response.status_code >= 400:
                if isinstance(value, dict):
                    detail = value.get("detail") or value.get("error") or value.get("message")
                else:
                    detail = value
                return key, None, str(detail or "OpenViking request failed")
            return key, value, None
        except httpx.HTTPError as exc:
            return key, None, f"OpenViking request failed: {exc}"

    async with httpx.AsyncClient(timeout=4, trust_env=False) as client:
        checks = await asyncio.gather(
            *[_run_check(client, key, method, path, params) for key, (method, path, params) in calls.items()]
        )
    for key, value, error in checks:
        if error:
            errors[key] = error
        else:
            results[key] = value

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
    try:
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
            timeout=8,
        )
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        payload = {"result": []}
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
