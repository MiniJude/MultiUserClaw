"""Low-latency platform-native chat sessions.

This route intentionally bypasses the full OpenClaw embedded agent runtime for
ordinary conversational turns. It keeps session persistence in the platform DB
and calls the same LLM proxy directly, so first token latency is provider-bound
instead of tool/prompt bootstrap-bound.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.engine import get_db
from app.db.models import FastChatMessage, FastChatSession, User
from app.config import settings

logger = logging.getLogger("platform.routes.fast_chat")
router = APIRouter(prefix="/api/fast-chat", tags=["fast-chat"])


class FastChatMessageRequest(BaseModel):
    message: str
    agentName: str | None = None


class FastChatTitleRequest(BaseModel):
    title: str


def _agent_id_from_key(key: str) -> str:
    parts = key.split(":")
    if len(parts) >= 3 and parts[0] == "agent":
        return parts[1] or "main"
    return "main"


def _fallback_title(text: str) -> str:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return "新对话"
    return normalized[:28] + ("..." if len(normalized) > 28 else "")


def _message_row(row: FastChatMessage) -> dict:
    return {
        "role": row.role,
        "content": row.content,
        "timestamp": row.created_at.isoformat() if row.created_at else None,
    }


async def _ensure_session(
    db: AsyncSession,
    user: User,
    key: str,
    first_message: str = "",
) -> FastChatSession:
    existing = await db.get(FastChatSession, key)
    if existing:
        if existing.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
        return existing

    session = FastChatSession(
        key=key,
        user_id=user.id,
        agent_id=_agent_id_from_key(key),
        title=_fallback_title(first_message),
    )
    db.add(session)
    await db.flush()
    return session


async def _load_messages(db: AsyncSession, user: User, key: str) -> list[FastChatMessage]:
    result = await db.execute(
        select(FastChatMessage)
        .where(FastChatMessage.user_id == user.id, FastChatMessage.session_key == key)
        .order_by(FastChatMessage.created_at.asc(), FastChatMessage.id.asc())
    )
    return list(result.scalars().all())


def _system_prompt(agent_id: str, agent_name: str | None) -> str:
    name = (agent_name or "").strip() or ("默认助手" if agent_id == "main" else agent_id)
    return (
        f"你是 OpenClaw 平台里的{name}。"
        "默认用中文回答，简洁、直接、可执行。"
        "如果用户需要操作文件、运行命令、使用浏览器、长期任务、深度记忆召回或 OpenViking 工具，"
        "请明确说明需要切换到增强 Agent 模式。"
    )


@router.get("/sessions")
async def list_fast_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FastChatSession)
        .where(FastChatSession.user_id == user.id)
        .order_by(FastChatSession.updated_at.desc())
    )
    return [
        {
            "key": row.key,
            "title": row.title,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
        for row in result.scalars().all()
    ]


@router.get("/sessions/{session_key:path}")
async def get_fast_session(
    session_key: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(FastChatSession, session_key)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    messages = await _load_messages(db, user, session_key)
    return {
        "key": session.key,
        "messages": [_message_row(row) for row in messages],
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "updated_at": session.updated_at.isoformat() if session.updated_at else None,
    }


@router.put("/sessions/{session_key:path}/title")
async def update_fast_session_title(
    session_key: str,
    req: FastChatTitleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(FastChatSession, session_key)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    session.title = req.title.strip() or session.title
    session.updated_at = datetime.utcnow()
    await db.commit()
    return {"ok": True, "key": session.key, "title": session.title}


@router.delete("/sessions/{session_key:path}")
async def delete_fast_session(
    session_key: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(FastChatSession, session_key)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    await db.execute(delete(FastChatMessage).where(FastChatMessage.session_key == session_key))
    await db.delete(session)
    await db.commit()
    return {"ok": True}


@router.post("/sessions/{session_key:path}/messages/stream")
async def stream_fast_message(
    session_key: str,
    req: FastChatMessageRequest,
    authorization: str = Header(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    text = req.message.strip()
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message is empty")

    session = await _ensure_session(db, user, session_key, text)
    user_msg = FastChatMessage(session_key=session_key, user_id=user.id, role="user", content=text)
    db.add(user_msg)
    session.updated_at = datetime.utcnow()
    await db.commit()

    history_rows = await _load_messages(db, user, session_key)
    history = [{"role": row.role, "content": row.content} for row in history_rows[-16:]]
    messages = [{"role": "system", "content": _system_prompt(session.agent_id, req.agentName)}, *history]
    model = settings.default_model

    async def _events():
        assistant_text = ""
        in_thinking = False

        def visible_delta(text: str) -> str:
            nonlocal in_thinking
            output = ""
            rest = text
            while rest:
                if in_thinking:
                    end = rest.find("</think>")
                    if end < 0:
                        return output
                    rest = rest[end + len("</think>"):]
                    in_thinking = False
                    continue
                start = rest.find("<think>")
                if start < 0:
                    output += rest
                    return output
                output += rest[:start]
                rest = rest[start + len("<think>"):]
                in_thinking = True
            return output

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"http://127.0.0.1:{settings.port}/llm/v1/chat/completions",
                    headers={
                        "Authorization": authorization,
                        "Content-Type": "application/json",
                    },
                    json={
                    "model": model,
                    "stream": True,
                    "temperature": 0.7,
                    "messages": messages,
                    },
                ) as resp:
                    resp.raise_for_status()
                    buffer = ""
                    async for chunk_text in resp.aiter_text():
                        buffer += chunk_text
                        parts = buffer.split("\n\n")
                        buffer = parts.pop() or ""
                        for event in parts:
                            line = next((item for item in event.splitlines() if item.startswith("data:")), "")
                            if not line:
                                continue
                            payload = line[5:].strip()
                            if payload == "[DONE]":
                                continue
                            try:
                                chunk = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            delta = ""
                            choices = chunk.get("choices") if isinstance(chunk, dict) else None
                            if choices:
                                delta_obj = choices[0].get("delta") or {}
                                delta = delta_obj.get("content") or ""
                            if delta:
                                visible = visible_delta(delta)
                                if visible:
                                    assistant_text += visible
                                    yield f"data: {json.dumps({'type': 'delta', 'text': visible}, ensure_ascii=False)}\n\n"
            if assistant_text.strip():
                db.add(FastChatMessage(
                    session_key=session_key,
                    user_id=user.id,
                    role="assistant",
                    content=assistant_text,
                ))
                session.updated_at = datetime.utcnow()
                await db.commit()
            yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            logger.error("Fast chat stream failed: %s", exc, exc_info=True)
            await db.rollback()
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
