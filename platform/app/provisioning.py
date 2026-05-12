"""User environment provisioning state and background runner."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import traceback
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

import docker
import httpx
from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.container.manager import ensure_running
from app.db.engine import async_session
from app.db.models import Container, ProvisioningStatus, User
from app.shared_runtime import ensure_shared_agent_binding

logger = logging.getLogger("platform.provisioning")

STAGE_MESSAGES: dict[str, str] = {
    "registered": "账号已创建，正在等待准备工作区",
    "queued": "准备任务已进入队列",
    "creating_container": "正在创建或启动专属 OpenClaw 容器",
    "starting_runtime": "OpenClaw 运行时正在启动",
    "syncing_agents": "正在同步内置 Agent 配置",
    "checking_agents": "正在检查 HR、Doctor 等内置 Agent",
    "warming_chat": "正在预热 Agent 对话能力",
    "ready": "工作区已准备完成",
    "failed": "工作区准备失败",
    "skipped": "当前账号不需要独立准备流程",
}

STAGE_LABELS: dict[str, str] = {
    "registered": "账号已创建",
    "queued": "进入准备队列",
    "creating_container": "创建专属容器",
    "starting_runtime": "启动 OpenClaw",
    "syncing_agents": "同步内置 Agent",
    "checking_agents": "检查 Agent 可用性",
    "warming_chat": "预热对话能力",
    "ready": "准备完成",
}

STAGE_PROGRESS: dict[str, int] = {
    "registered": 5,
    "queued": 10,
    "creating_container": 28,
    "starting_runtime": 58,
    "syncing_agents": 74,
    "checking_agents": 86,
    "warming_chat": 94,
    "ready": 100,
    "failed": 100,
    "skipped": 100,
}

SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization:\s*bearer\s+)[^\s,;]+"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;'\"]+"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|password)\"?\s*:\s*\")[^\"]+"),
]


def _utcnow() -> datetime:
    return datetime.utcnow()


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _json_loads(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _sanitize_debug_text(text: str | None) -> str | None:
    if not text:
        return text
    sanitized = text
    for pattern in SECRET_PATTERNS:
        sanitized = pattern.sub(r"\1[REDACTED]", sanitized)
    return sanitized


def _required_agent_ids() -> set[str]:
    configured = {
        item.strip().lower()
        for item in settings.provisioning_required_agents.split(",")
        if item.strip()
    }
    return configured or {"hr", "doctor"}


def _base_url_from_container(record: Container) -> str:
    return f"http://{record.internal_host}:{record.internal_port}".rstrip("/")


def _agent_ids_from_catalog(payload: dict[str, Any]) -> list[str]:
    agents = payload.get("agents")
    if not isinstance(agents, list):
        raise RuntimeError("OpenClaw /api/agents response is missing agents[]")
    return sorted(
        str(item.get("id", "")).lower()
        for item in agents
        if isinstance(item, dict) and item.get("id")
    )


def _row_to_dict(row: ProvisioningStatus, *, include_debug: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": row.status,
        "stage": row.stage,
        "progress": row.progress,
        "message": row.message or STAGE_MESSAGES.get(row.stage, ""),
        "public_error": row.public_error,
        "attempts": row.attempts,
        "details": _json_loads(row.details),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
        "stages": [
            {"key": key, "label": label, "progress": STAGE_PROGRESS[key]}
            for key, label in STAGE_LABELS.items()
        ],
    }
    if include_debug:
        payload["debug"] = {
            "error": row.debug_error,
            "traceback": row.debug_traceback,
        }
    return payload


async def get_or_create_provisioning_status(
    db: AsyncSession,
    user: User,
) -> ProvisioningStatus:
    row = await db.get(ProvisioningStatus, user.id)
    if row is not None:
        return row

    if user.runtime_mode == "shared":
        row = ProvisioningStatus(
            user_id=user.id,
            status="ready",
            stage="ready",
            progress=100,
            message="共享 OpenClaw 运行时将在首次访问时绑定",
            completed_at=_utcnow(),
        )
    else:
        row = ProvisioningStatus(
            user_id=user.id,
            status="pending",
            stage="registered",
            progress=STAGE_PROGRESS["registered"],
            message=STAGE_MESSAGES["registered"],
        )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _set_stage(
    db: AsyncSession,
    user_id: str,
    *,
    status: str = "running",
    stage: str,
    progress: int | None = None,
    message: str | None = None,
    details: dict[str, Any] | None = None,
) -> ProvisioningStatus:
    row = await db.get(ProvisioningStatus, user_id)
    if row is None:
        row = ProvisioningStatus(user_id=user_id)
        db.add(row)
        await db.flush()

    row.status = status
    row.stage = stage
    row.progress = progress if progress is not None else STAGE_PROGRESS.get(stage, row.progress)
    row.message = message or STAGE_MESSAGES.get(stage, row.message)
    if status in {"running", "ready", "skipped"}:
        row.public_error = None
        row.debug_error = None
        row.debug_traceback = None
    if details is not None:
        row.details = _json_dumps(details)
    if status in {"ready", "failed", "skipped"}:
        row.completed_at = _utcnow()
    await db.commit()
    await db.refresh(row)
    return row


async def _claim_provisioning_run(
    db: AsyncSession,
    user: User,
    *,
    force: bool = False,
) -> bool:
    row = await get_or_create_provisioning_status(db, user)

    if user.runtime_mode == "shared":
        row.status = "ready"
        row.stage = "ready"
        row.progress = 100
        row.message = "共享 OpenClaw 运行时将在首次访问时绑定"
        row.completed_at = _utcnow()
        await db.commit()
        await db.refresh(row)
        return False

    if row.status == "ready" and not force:
        return False

    if row.status == "running" and not force:
        updated_at = row.updated_at or row.started_at or _utcnow()
        if updated_at > _utcnow() - timedelta(minutes=10):
            return False

    if row.status == "failed" and not force:
        return False

    row.status = "running"
    row.stage = "queued"
    row.progress = STAGE_PROGRESS["queued"]
    row.message = STAGE_MESSAGES["queued"]
    row.public_error = None
    row.debug_error = None
    row.debug_traceback = None
    row.attempts = (row.attempts or 0) + 1
    row.started_at = _utcnow()
    row.completed_at = None
    row.details = _json_dumps({"requiredAgents": sorted(_required_agent_ids())})
    await db.commit()
    await db.refresh(row)
    return True


async def request_user_provisioning(
    db: AsyncSession,
    user: User,
    background_tasks: BackgroundTasks,
    *,
    force: bool = False,
) -> ProvisioningStatus:
    should_start = await _claim_provisioning_run(db, user, force=force)
    row = await db.get(ProvisioningStatus, user.id)
    if should_start:
        background_tasks.add_task(run_user_provisioning, user.id)
    if row is None:
        row = await get_or_create_provisioning_status(db, user)
    elif not should_start and row.status == "failed":
        row = await recover_failed_provisioning_if_ready(db, user, row)
    return row


async def _request_agents(base_url: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
        response = await client.get(f"{base_url.rstrip('/')}/api/agents")
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("OpenClaw /api/agents returned a non-object response")
    return payload


async def _request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    json_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = await client.request(method, url, json=json_payload)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"{method} {url} returned a non-object response")
    return payload


async def _warm_agent_chat(
    db: AsyncSession,
    user_id: str,
    base_url: str,
    agent_ids: list[str],
) -> dict[str, Any]:
    if not settings.provisioning_smoke_chat_enabled:
        return {"enabled": False}

    smoke_agent = settings.provisioning_smoke_agent.strip().lower() or "doctor"
    if smoke_agent not in {agent_id.lower() for agent_id in agent_ids}:
        smoke_agent = sorted(_required_agent_ids())[0]

    session_key = f"agent:{smoke_agent}:provisioning-readiness"
    encoded_session_key = quote(session_key, safe="")
    timeout_seconds = max(30, settings.provisioning_timeout_seconds)
    deadline = time.monotonic() + timeout_seconds
    wait_attempt = 0
    last_result: dict[str, Any] = {}

    await _set_stage(
        db,
        user_id,
        stage="warming_chat",
        progress=STAGE_PROGRESS["warming_chat"],
        message=f"正在预热 {smoke_agent} Agent 的首次对话",
        details={"baseUrl": base_url, "agent": smoke_agent, "sessionKey": session_key},
    )

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=5.0),
        trust_env=False,
    ) as client:
        send_payload = await _request_json(
            client,
            "POST",
            f"{base_url.rstrip('/')}/api/sessions/{encoded_session_key}/messages",
            json_payload={"message": settings.provisioning_smoke_message},
        )
        run_id = send_payload.get("runId")
        if not run_id:
            raise RuntimeError(f"Smoke chat did not return runId: {send_payload}")

        while time.monotonic() < deadline:
            wait_attempt += 1
            wait_payload = await _request_json(
                client,
                "GET",
                f"{base_url.rstrip('/')}/api/runs/{quote(str(run_id), safe='')}/wait?timeoutMs=25000",
            )
            last_result = wait_payload
            status = str(wait_payload.get("status") or "").lower()
            if status in {"completed", "ok", "done", "success"}:
                session_payload = await _request_json(
                    client,
                    "GET",
                    f"{base_url.rstrip('/')}/api/sessions/{encoded_session_key}",
                )
                messages = session_payload.get("messages")
                if isinstance(messages, list) and any(
                    isinstance(item, dict) and item.get("role") == "assistant"
                    for item in messages
                ):
                    await client.delete(
                        f"{base_url.rstrip('/')}/api/sessions/{encoded_session_key}",
                    )
                    return {
                        "enabled": True,
                        "agent": smoke_agent,
                        "runId": str(run_id),
                        "status": status,
                    }
                raise RuntimeError(
                    "Smoke chat completed but no assistant message was persisted"
                )
            if status in {"failed", "error", "aborted", "cancelled", "canceled"}:
                raise RuntimeError(f"Smoke chat failed: {wait_payload}")

            await _set_stage(
                db,
                user_id,
                stage="warming_chat",
                progress=min(99, STAGE_PROGRESS["warming_chat"] + wait_attempt),
                message=f"正在等待 {smoke_agent} Agent 首次回复（第 {wait_attempt} 次）",
                details={
                    "baseUrl": base_url,
                    "agent": smoke_agent,
                    "sessionKey": session_key,
                    "runId": str(run_id),
                    "lastResult": wait_payload,
                },
            )

        raise RuntimeError(
            "Smoke chat did not complete in time; "
            f"last_result={_sanitize_debug_text(_json_dumps(last_result))}"
        )


async def _wait_for_agent_catalog(
    db: AsyncSession,
    user_id: str,
    base_url: str,
) -> dict[str, Any]:
    required_ids = _required_agent_ids()
    timeout_seconds = max(20, settings.provisioning_timeout_seconds)
    deadline = time.monotonic() + timeout_seconds
    attempt = 0
    last_error = ""
    last_agent_ids: list[str] = []

    while time.monotonic() < deadline:
        attempt += 1
        try:
            payload = await _request_agents(base_url)
            agent_ids = _agent_ids_from_catalog(payload)
            last_agent_ids = agent_ids
            missing = sorted(required_ids - set(agent_ids))
            if not missing:
                return payload
            last_error = f"missing required agents: {', '.join(missing)}"
        except Exception as exc:  # noqa: BLE001 - stored for UI diagnostics
            last_error = str(exc)

        if attempt == 1 or attempt % 5 == 0:
            await _set_stage(
                db,
                user_id,
                stage="checking_agents",
                progress=min(96, STAGE_PROGRESS["checking_agents"] + attempt),
                message=f"正在检查内置 Agent（第 {attempt} 次）",
                details={
                    "baseUrl": base_url,
                    "lastAgentIds": last_agent_ids,
                    "lastError": _sanitize_debug_text(last_error),
                    "requiredAgents": sorted(required_ids),
                },
            )
        await asyncio.sleep(2)

    raise RuntimeError(
        "Agent catalog did not become ready in time; "
        f"last_error={last_error}; last_agent_ids={last_agent_ids}"
    )


async def recover_failed_provisioning_if_ready(
    db: AsyncSession,
    user: User,
    row: ProvisioningStatus,
) -> ProvisioningStatus:
    """Mark a previously failed run ready if the runtime is now reachable."""
    if row.status != "failed" or user.runtime_mode == "shared":
        return row

    try:
        if settings.dev_openclaw_url:
            base_url = settings.dev_openclaw_url.rstrip("/")
            container_details: dict[str, Any] = {"mode": "dev", "baseUrl": base_url}
        else:
            record = await ensure_running(db, user.id)
            base_url = _base_url_from_container(record)
            container_details = {
                "mode": "dedicated",
                "containerId": record.docker_id,
                "containerHost": record.internal_host,
                "containerPort": record.internal_port,
                "baseUrl": base_url,
                "recoveredFromFailed": True,
            }

        payload = await _request_agents(base_url)
        agent_ids = _agent_ids_from_catalog(payload)
        missing = sorted(_required_agent_ids() - set(agent_ids))
        if missing:
            return row

        await _set_stage(
            db,
            user.id,
            status="ready",
            stage="ready",
            progress=100,
            message=STAGE_MESSAGES["ready"],
            details={
                **container_details,
                "agentIds": agent_ids,
                "smokeChat": await _warm_agent_chat(db, user.id, base_url, agent_ids),
            },
        )
        refreshed = await db.get(ProvisioningStatus, user.id)
        return refreshed or row
    except Exception as exc:  # noqa: BLE001 - best-effort recovery path
        logger.info("Provisioning recovery check did not mark user %s ready: %s", user.id, exc)
        return row


async def _collect_container_logs(db: AsyncSession, user_id: str) -> str:
    result = await db.execute(select(Container).where(Container.user_id == user_id))
    record = result.scalar_one_or_none()
    if record is None or not record.docker_id:
        return ""
    try:
        client = docker.from_env()
        container = client.containers.get(record.docker_id)
        logs = container.logs(tail=120, stdout=True, stderr=True)
        return logs.decode("utf-8", errors="replace") if isinstance(logs, bytes) else str(logs)
    except Exception as exc:  # noqa: BLE001 - best effort debug context
        return f"Unable to read container logs: {exc}"


def _public_error_from_exception(exc: Exception) -> str:
    text = str(exc).strip()
    if not text:
        return "工作区准备失败，请稍后重试或联系管理员。"
    if "missing required agents" in text:
        return "OpenClaw 已启动，但内置 Agent 尚未全部加载。"
    if isinstance(exc, httpx.HTTPError):
        return "OpenClaw 运行时暂时无法访问。"
    return "工作区准备失败，请稍后重试或联系管理员。"


async def _mark_failed(db: AsyncSession, user_id: str, exc: Exception) -> None:
    debug_trace = _sanitize_debug_text(traceback.format_exc())
    logs = _sanitize_debug_text(await _collect_container_logs(db, user_id))
    row = await db.get(ProvisioningStatus, user_id)
    if row is None:
        row = ProvisioningStatus(user_id=user_id)
        db.add(row)
        await db.flush()
    failed_stage = row.stage if row.stage and row.stage not in {"ready", "failed"} else "failed"
    row.status = "failed"
    row.stage = failed_stage
    row.progress = 100
    row.message = STAGE_MESSAGES["failed"]
    row.public_error = _public_error_from_exception(exc)
    row.debug_error = _sanitize_debug_text(str(exc))
    row.debug_traceback = "\n\n".join(part for part in [debug_trace, logs] if part)
    row.completed_at = _utcnow()
    await db.commit()


async def run_user_provisioning(user_id: str) -> None:
    """Prepare a dedicated user's OpenClaw runtime and built-in agent catalog."""
    async with async_session() as db:
        user = await db.get(User, user_id)
        if user is None:
            logger.warning("Provisioning skipped because user %s no longer exists", user_id)
            return

        try:
            if user.runtime_mode == "shared":
                await ensure_shared_agent_binding(db, user)
                await _set_stage(
                    db,
                    user_id,
                    status="ready",
                    stage="ready",
                    progress=100,
                    message="共享 OpenClaw Agent 已绑定",
                )
                return

            await _set_stage(db, user_id, stage="creating_container")

            if settings.dev_openclaw_url:
                base_url = settings.dev_openclaw_url.rstrip("/")
                container_details: dict[str, Any] = {"mode": "dev", "baseUrl": base_url}
            else:
                record = await ensure_running(db, user_id)
                base_url = _base_url_from_container(record)
                container_details = {
                    "mode": "dedicated",
                    "containerId": record.docker_id,
                    "containerHost": record.internal_host,
                    "containerPort": record.internal_port,
                    "baseUrl": base_url,
                }

            await _set_stage(
                db,
                user_id,
                stage="starting_runtime",
                details=container_details,
            )

            await asyncio.sleep(1)
            await _set_stage(
                db,
                user_id,
                stage="syncing_agents",
                message=STAGE_MESSAGES["syncing_agents"],
                details=container_details,
            )

            payload = await _wait_for_agent_catalog(db, user_id, base_url)
            agent_ids = sorted(
                str(item.get("id", ""))
                for item in payload.get("agents", [])
                if isinstance(item, dict) and item.get("id")
            )
            smoke_details = await _warm_agent_chat(db, user_id, base_url, agent_ids)

            await _set_stage(
                db,
                user_id,
                status="ready",
                stage="ready",
                progress=100,
                message=STAGE_MESSAGES["ready"],
                details={**container_details, "agentIds": agent_ids, "smokeChat": smoke_details},
            )
        except Exception as exc:  # noqa: BLE001 - returned to provisioning UI
            logger.error("Provisioning failed for user %s: %s", user_id, exc, exc_info=True)
            await _mark_failed(db, user_id, exc)


def provisioning_payload_for_user(
    row: ProvisioningStatus,
    user: User,
) -> dict[str, Any]:
    include_debug = user.role == "admin" or settings.provisioning_expose_debug_errors
    return _row_to_dict(row, include_debug=include_debug)
