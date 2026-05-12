"""Provisioning progress API for user workspaces."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.engine import get_db
from app.db.models import User
from app.provisioning import (
    get_or_create_provisioning_status,
    provisioning_payload_for_user,
    recover_failed_provisioning_if_ready,
    request_user_provisioning,
)

router = APIRouter(prefix="/api/provisioning", tags=["provisioning"])


@router.get("/me")
async def get_my_provisioning_status(
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await request_user_provisioning(db, user, background_tasks)
    return provisioning_payload_for_user(row, user)


@router.post("/me/retry")
async def retry_my_provisioning(
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await request_user_provisioning(db, user, background_tasks, force=True)
    return provisioning_payload_for_user(row, user)


@router.get("/me/current")
async def get_my_current_provisioning_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await get_or_create_provisioning_status(db, user)
    row = await recover_failed_provisioning_if_ready(db, user, row)
    return provisioning_payload_for_user(row, user)
