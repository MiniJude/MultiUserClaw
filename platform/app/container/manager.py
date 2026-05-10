"""Docker container lifecycle management for per-user openclaw instances."""

from __future__ import annotations

import io
import hashlib
import hmac
import json
import logging
import secrets
import tarfile
import time
from pathlib import Path

import docker
from docker.errors import APIError as DockerAPIError, NotFound as DockerNotFound
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Container, User, UserPortBinding

_client: docker.DockerClient | None = None
logger = logging.getLogger(__name__)


def _docker() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def _ensure_network() -> None:
    """Create the internal Docker network if it doesn't exist."""
    client = _docker()
    try:
        client.networks.get(settings.container_network)
    except DockerNotFound:
        client.networks.create(
            settings.container_network,
            driver="bridge",
            internal=False,  # allow internet access for tool downloads
        )


def _published_binding(container: docker.models.containers.Container, container_port: str) -> tuple[str, str]:
    """Return (host_ip, host_port) for a published container port."""
    ports = container.attrs.get("NetworkSettings", {}).get("Ports", {}) or {}
    bindings = ports.get(container_port) or []
    if not bindings:
        return "", ""
    host_ip = bindings[0].get("HostIp", "") or ""
    host_port = bindings[0].get("HostPort", "") or ""
    return host_ip, host_port


def _is_host_port_in_use(client: docker.DockerClient, host_port: int) -> bool:
    """Return True if any container currently publishes the given host port."""
    port_str = str(host_port)
    for c in client.containers.list(all=True):
        ports = c.attrs.get("NetworkSettings", {}).get("Ports", {}) or {}
        for bindings in ports.values():
            for binding in (bindings or []):
                if (binding.get("HostPort") or "") == port_str:
                    return True
    return False


def _expected_container_name(user_id: str) -> str:
    return f"openclaw-user-{user_id[:8]}"


def _expected_openviking_name(user_id: str) -> str:
    return f"openviking-user-{user_id[:8]}"


def _expected_openviking_volume(user_id: str) -> str:
    return f"openviking-data-{user_id[:8]}"


def _openviking_api_key_for_user(user_id: str) -> str:
    if settings.user_openviking_api_key:
        return settings.user_openviking_api_key
    secret = settings.jwt_secret or "openclaw-openviking-dev-secret"
    digest = hmac.new(secret.encode("utf-8"), user_id.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"ov_{digest}"


def _build_openviking_plugin_config(user_id: str) -> dict:
    short_id = user_id[:8]
    sidecar_name = _expected_openviking_name(user_id)
    config: dict[str, object] = {
        "baseUrl": f"http://{sidecar_name}:{settings.user_openviking_port}",
        "agent_prefix": f"user-{short_id}",
        "accountId": f"user-{short_id}",
        "userId": user_id,
        "timeoutMs": settings.user_openviking_plugin_timeout_ms,
        "autoRecall": settings.user_openviking_plugin_auto_recall,
        "recallLimit": settings.user_openviking_plugin_recall_limit,
        "recallScoreThreshold": settings.user_openviking_plugin_recall_score_threshold,
        "recallMaxInjectedChars": settings.user_openviking_plugin_recall_max_injected_chars,
        "recallPreferAbstract": True,
        "recallResources": settings.user_openviking_plugin_recall_resources,
        "autoCapture": True,
        "captureMaxLength": settings.user_openviking_plugin_capture_max_length,
    }
    config["apiKey"] = _openviking_api_key_for_user(user_id)
    return {
        "plugins": {
            "enabled": True,
            "allow": ["openviking"],
            "slots": {
                "contextEngine": "openviking",
            },
            "entries": {
                "openviking": {
                    "enabled": True,
                    "hooks": {
                        "allowConversationAccess": True,
                    },
                    "config": config,
                },
            },
        },
    }


def _build_default_openviking_conf(user_id: str) -> str:
    """Return the explicit platform-managed OpenViking server config."""
    config = {
        "storage": {
            "workspace": "/app/.openviking/data",
            "agfs": {
                "backend": "local",
                "timeout": 10,
            },
            "vectordb": {
                "backend": "local",
            },
        },
        "server": {
            "host": "0.0.0.0",
            "port": settings.user_openviking_port,
            "auth_mode": "trusted",
            "root_api_key": _openviking_api_key_for_user(user_id),
            "cors_origins": ["*"],
        },
        "retrieval": {
            "hotness_alpha": 0.0,
            "score_propagation_alpha": 0.5,
        },
    }
    embedding_api_key = _openviking_embedding_api_key()
    if embedding_api_key:
        config["embedding"] = {
            "dense": {
                "provider": settings.user_openviking_embedding_provider,
                "model": settings.user_openviking_embedding_model,
                "api_key": embedding_api_key,
                "api_base": settings.user_openviking_embedding_api_base,
                "dimension": settings.user_openviking_embedding_dimension,
                "input": settings.user_openviking_embedding_input,
            },
            "max_concurrent": settings.user_openviking_embedding_max_concurrent,
            "max_retries": 2,
            "max_input_tokens": settings.user_openviking_embedding_max_input_tokens,
        }
    vlm_api_key = _openviking_vlm_api_key()
    if vlm_api_key:
        config["vlm"] = {
            "model": settings.user_openviking_vlm_model,
            "provider": settings.user_openviking_vlm_provider,
            "api_key": vlm_api_key,
            "api_base": settings.user_openviking_vlm_api_base,
            "temperature": settings.user_openviking_vlm_temperature,
            "timeout": settings.user_openviking_vlm_timeout,
            "max_concurrent": settings.user_openviking_vlm_max_concurrent,
        }
    return json.dumps(config, ensure_ascii=False, separators=(",", ":"))


def _openviking_embedding_api_key() -> str:
    provider = settings.user_openviking_embedding_provider.lower()
    if provider == "minimax":
        return settings.minimax_api_key
    if provider == "dashscope":
        return settings.dashscope_api_key
    if provider in {"openai", "azure"}:
        return settings.openai_api_key
    if provider == "jina":
        return settings.aihubmix_api_key
    if provider == "volcengine":
        return settings.doubao_api_key
    return ""


def _openviking_vlm_api_key() -> str:
    provider = settings.user_openviking_vlm_provider.lower()
    model = settings.user_openviking_vlm_model.lower()
    if "deepseek" in model:
        return settings.deepseek_api_key
    if provider == "openai":
        return settings.openai_api_key
    if provider == "kimi":
        return settings.kimi_api_key or settings.moonshot_api_key
    if provider == "glm":
        return settings.zhipu_api_key
    if provider == "volcengine":
        return settings.doubao_api_key
    if "minimax" in model:
        return settings.minimax_api_key
    return ""


def _merge_openclaw_config_patch(data_volume: str, patch: dict) -> None:
    """Merge a patch into /root/.openclaw/openclaw.json stored in a Docker volume."""
    client = _docker()
    patch_json = json.dumps(patch, ensure_ascii=False)
    script = r"""
import json
import os
from pathlib import Path

path = Path("/data/openclaw.json")
patch = json.loads(os.environ["OPENCLAW_CONFIG_PATCH"])

def merge(dst, src):
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            merge(dst[key], value)
        elif isinstance(value, list) and isinstance(dst.get(key), list):
            for item in value:
                if item not in dst[key]:
                    dst[key].append(item)
        else:
            dst[key] = value
    return dst

if path.exists():
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        config = {}
else:
    config = {}

merge(config, patch)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
"""
    client.containers.run(
        image="python:3.13-alpine",
        command=["python", "-c", script],
        environment={"OPENCLAW_CONFIG_PATCH": patch_json},
        volumes={data_volume: {"bind": "/data", "mode": "rw"}},
        remove=True,
        detach=False,
    )


def _ensure_openviking_sidecar(user_id: str) -> docker.models.containers.Container | None:
    """Ensure a per-user OpenViking sidecar exists and is running."""
    if not settings.user_openviking_enabled:
        return None

    _ensure_network()
    client = _docker()
    sidecar_name = _expected_openviking_name(user_id)
    data_volume = _expected_openviking_volume(user_id)

    try:
        sidecar = client.containers.get(sidecar_name)
        if sidecar.status == "paused":
            sidecar.unpause()
            sidecar.reload()
        elif sidecar.status != "running":
            sidecar.start()
            sidecar.reload()
        return sidecar
    except DockerNotFound:
        pass

    environment = {
        "TZ": settings.container_tz,
    }
    environment["OPENVIKING_CONF_CONTENT"] = (
        settings.user_openviking_conf_content or _build_default_openviking_conf(user_id)
    )
    environment["OPENVIKING_API_KEY"] = _openviking_api_key_for_user(user_id)

    return client.containers.run(
        image=settings.user_openviking_image,
        name=sidecar_name,
        detach=True,
        environment=environment,
        mounts=[
            docker.types.Mount("/app/.openviking", data_volume, type="volume"),
        ],
        network=settings.container_network,
        mem_limit=settings.user_openviking_memory_limit,
        nano_cpus=int(settings.user_openviking_cpu_limit * 1e9),
        restart_policy={"Name": "unless-stopped"},
        labels={
            "openclaw.user_id": user_id,
            "openclaw.sidecar": "openviking",
        },
    )


def _openviking_sidecar_exists(user_id: str) -> bool:
    if not settings.user_openviking_enabled:
        return False
    try:
        _docker().containers.get(_expected_openviking_name(user_id))
        return True
    except DockerNotFound:
        return False


def _patch_openviking_plugin_config(user_id: str, data_volume: str) -> None:
    if not settings.user_openviking_enabled:
        return
    _merge_openclaw_config_patch(data_volume, _build_openviking_plugin_config(user_id))


def _install_openviking_plugin(container: docker.models.containers.Container) -> bool:
    """Best-effort install of the OpenViking OpenClaw plugin inside a user container."""
    if not settings.user_openviking_enabled or not settings.user_openviking_install_plugin:
        return False

    force_flag = (
        " --dangerously-force-unsafe-install"
        if settings.user_openviking_force_unsafe_plugin_install
        else ""
    )
    command = (
        "test -d /root/.openclaw/extensions/openviking "
        f"|| node /app/openclaw.mjs plugins install{force_flag} clawhub:@openclaw/openviking"
    )
    exit_code, output = container.exec_run(
        cmd=["sh", "-lc", command],
        user="root",
        demux=True,
    )
    if exit_code != 0:
        stdout = (output[0] or b"").decode("utf-8", errors="replace") if output else ""
        stderr = (output[1] or b"").decode("utf-8", errors="replace") if output else ""
        logger.warning(
            "OpenViking plugin install failed for %s: exit=%s stdout=%s stderr=%s",
            container.name,
            exit_code,
            stdout[-1000:],
            stderr[-1000:],
        )
        return False
    return True


def _stop_or_pause_openviking_sidecar(user_id: str, pause: bool) -> None:
    if not settings.user_openviking_enabled:
        return
    client = _docker()
    try:
        sidecar = client.containers.get(_expected_openviking_name(user_id))
        if pause and sidecar.status == "running":
            sidecar.pause()
        elif not pause and sidecar.status in {"running", "paused"}:
            if sidecar.status == "paused":
                sidecar.unpause()
            sidecar.stop(timeout=10)
    except DockerNotFound:
        pass


def _container_uses_current_image(container: docker.models.containers.Container) -> bool:
    """Return whether a user container was created from the configured image id."""
    try:
        current_image = _docker().images.get(settings.openclaw_image)
        container.reload()
        return container.attrs.get("Image") == current_image.id
    except Exception:
        # If Docker cannot resolve the image, avoid forcing a recreate loop.
        return True


async def _recreate_container_record(db: AsyncSession, record: Container, existing_container=None) -> Container:
    """Drop a stale DB binding and recreate the user's OpenClaw container."""
    if existing_container is not None:
        try:
            existing_container.remove(force=True)
        except DockerNotFound:
            pass

    user_id = record.user_id
    await db.delete(record)
    await db.commit()
    created = await create_container(db, user_id)
    if created is not None:
        return created
    record = await get_container(db, user_id)
    if record is not None:
        return record
    raise RuntimeError("Failed to recreate container")


def _build_expose_port_skill_markdown(
    user_id: str,
    container_name: str,
    browser_binding: tuple[str, str],
    service_binding: tuple[str, str],
    public_base_url: str = "",
) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime())
    lines = [
        "---",
        "name: container-expose-info",
        "description: Current container info and host-exposed ports (5900/30000).",
        "---",
        "",
        "# Container Expose Info",
        "",
        f"- User ID: `{user_id}`",
        f"- Container: `{container_name}`",
        f"- Generated At: `{now}`",
        "",
        "## Mapped Ports",
        "",
    ]

    browser_ip, browser_port = browser_binding
    service_ip, service_port = service_binding

    if browser_port:
        lines.append(f"- `5900/tcp` (browser) -> `{browser_ip}:{browser_port}`")
    else:
        lines.append("- `5900/tcp` (browser) -> `not published`")

    if service_port:
        lines.append(f"- `30000/tcp` (service) -> `{service_ip}:{service_port}`")
    else:
        lines.append("- `30000/tcp` (service) -> `not published`")

    # External access URLs (for users accessing from outside the server)
    if public_base_url:
        base = public_base_url.rstrip("/")
        # Extract domain from URL (e.g. "https://openclaw.infox-med.com" -> "openclaw.infox-med.com")
        from urllib.parse import urlparse
        parsed = urlparse(base)
        domain = parsed.hostname or ""
        scheme = parsed.scheme or "https"

        lines.extend(["", "## External Access URLs", ""])
        if service_port:
            lines.append(f"- Service URL: `{scheme}://{domain}:{service_port}`")
        if browser_port:
            lines.append(f"- Browser URL: `{scheme}://{domain}:{browser_port}`")
        lines.extend([
            "",
            "**Important**: When the user creates a web service on port 30000 inside the container,",
            f"tell them to access it via the Service URL above (`{scheme}://{domain}:{service_port}`).",
            "Do NOT use `0.0.0.0` or `localhost` — those are internal addresses not reachable from outside.",
        ])

    lines.extend([
        "",
        "## Notes",
        "",
        "- This file is auto-generated during user container creation.",
        "- Recreate the user container to refresh mapped host ports.",
        "",
    ])
    return "\n".join(lines)


def _write_expose_port_skill(container: docker.models.containers.Container, markdown: str) -> None:
    """Write /root/.openclaw/workspace/skills/container-expose-info/SKILL.md via put_archive."""
    content = markdown.encode("utf-8")
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
        workspace_dir = tarfile.TarInfo(name="workspace")
        workspace_dir.type = tarfile.DIRTYPE
        workspace_dir.mode = 0o755
        workspace_dir.mtime = int(time.time())
        tar.addfile(workspace_dir)

        skills_dir = tarfile.TarInfo(name="workspace/skills")
        skills_dir.type = tarfile.DIRTYPE
        skills_dir.mode = 0o755
        skills_dir.mtime = int(time.time())
        tar.addfile(skills_dir)

        skill_subdir = tarfile.TarInfo(name="workspace/skills/container-expose-info")
        skill_subdir.type = tarfile.DIRTYPE
        skill_subdir.mode = 0o755
        skill_subdir.mtime = int(time.time())
        tar.addfile(skill_subdir)

        skill_file = tarfile.TarInfo(name="workspace/skills/container-expose-info/SKILL.md")
        skill_file.size = len(content)
        skill_file.mode = 0o644
        skill_file.mtime = int(time.time())
        tar.addfile(skill_file, io.BytesIO(content))

    tar_buffer.seek(0)
    ok = container.put_archive("/root/.openclaw", tar_buffer.read())
    if not ok:
        raise RuntimeError("failed to write container-expose-info SKILL.md into container")


async def get_container(db: AsyncSession, user_id: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.user_id == user_id))
    return result.scalar_one_or_none()


async def get_container_by_token(db: AsyncSession, token: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.container_token == token))
    return result.scalar_one_or_none()


async def get_user_port_binding(db: AsyncSession, user_id: str) -> UserPortBinding | None:
    result = await db.execute(select(UserPortBinding).where(UserPortBinding.user_id == user_id))
    return result.scalar_one_or_none()


async def upsert_user_port_binding(
    db: AsyncSession,
    user_id: str,
    host_bind_ip: str,
    host_port_browser: int | None,
    host_port_service: int | None,
) -> None:
    stmt = (
        pg_insert(UserPortBinding)
        .values(
            user_id=user_id,
            host_bind_ip=host_bind_ip,
            host_port_browser=host_port_browser,
            host_port_service=host_port_service,
        )
        .on_conflict_do_update(
            index_elements=[UserPortBinding.__table__.c.user_id],
            set_={
                "host_bind_ip": host_bind_ip,
                "host_port_browser": host_port_browser,
                "host_port_service": host_port_service,
            },
        )
    )
    await db.execute(stmt)


async def create_container(db: AsyncSession, user_id: str) -> Container | None:
    """Create a Docker container for a user and record metadata in DB.

    Inserts a DB record first to claim the user_id slot (preventing races),
    then creates the Docker container and updates the record.
    Returns None if another request already claimed the slot.
    """
    container_token = secrets.token_urlsafe(32)
    short_id = user_id[:8]

    # Insert DB record to claim the unique user_id slot.
    # ON CONFLICT DO NOTHING avoids PostgreSQL ERROR logs on races.
    stmt = (
        pg_insert(Container)
        .values(
            user_id=user_id,
            docker_id="",
            container_token=container_token,
            status="creating",
            internal_host="",
            internal_port=18080,
        )
        .on_conflict_do_nothing(index_elements=["user_id"])
        .returning(Container.__table__.c.id)
    )
    result = await db.execute(stmt)
    row = result.first()
    if row is None:
        # Another request already claimed this user_id — not an error
        return None

    await db.flush()
    record = await get_container(db, user_id)

    # Now safe to create Docker resources — we hold the DB slot.
    _ensure_network()
    client = _docker()

    data_vol = f"openclaw-data-{short_id}"
    container_name = f"openclaw-user-{short_id}"

    # Remove any stale container with the same name
    try:
        stale = client.containers.get(container_name)
        stale.remove(force=True)
    except DockerNotFound:
        pass

    if settings.user_openviking_enabled:
        # The sidecar and plugin config are user-scoped. Patch the OpenClaw
        # volume before first boot so the bridge startup merge preserves it.
        try:
            _ensure_openviking_sidecar(user_id)
            _patch_openviking_plugin_config(user_id, data_vol)
        except Exception:
            await db.rollback()
            raise

    # Fetch user's SSO token if available (e.g. InfoX-Med)
    # user_result = await db.execute(select(User).where(User.id == user_id))
    # user_row = user_result.scalar_one_or_none()
    # sso_token = user_row.sso_token if user_row else None

    container_env = {
        "NANOBOT_PROXY__URL": f"http://gateway:8080/llm/v1",
        "NANOBOT_PROXY__TOKEN": container_token,
        "NANOBOT_AGENTS__DEFAULTS__MODEL": settings.default_model,
        "DEPLOY_VERSION": settings.deploy_version,
        "TZ": settings.container_tz,
        "BRIDGE_ENABLE_CHANNELS": "1",
        "NANOBOT_SKILLS_REPO_MIRROR_MAP": settings.skills_repo_mirror_map,
        "NANOBOT_GITHUB_MIRROR_PREFIXES": settings.github_mirror_prefixes,
    }
    # if sso_token:
    #     container_env["SSO_TOKEN"] = sso_token

    run_kwargs = {
        "image": settings.openclaw_image,
        "command": ["node", "bridge/dist/bridge/start.js"],
        "name": container_name,
        "detach": True,
        "environment": container_env,
        "mounts": [
            docker.types.Mount("/root/.openclaw", data_vol, type="volume"),
        ],
        "network": settings.container_network,
        "mem_limit": settings.container_memory_limit,
        "shm_size": settings.container_shm_size,
        "nano_cpus": int(settings.container_cpu_limit * 1e9),
        "pids_limit": settings.container_pids_limit,
        "restart_policy": {"Name": "unless-stopped"},
    }

    if settings.user_container_publish_ports:
        binding = await get_user_port_binding(db, user_id)
        preferred_browser_port = binding.host_port_browser if binding is not None else None
        preferred_service_port = binding.host_port_service if binding is not None else None

        preferred_usable = (
            preferred_browser_port is not None
            and preferred_service_port is not None
            and preferred_browser_port != preferred_service_port
            and not _is_host_port_in_use(client, preferred_browser_port)
            and not _is_host_port_in_use(client, preferred_service_port)
        )

        if preferred_usable:
            run_kwargs["ports"] = {
                "5900/tcp": (settings.user_container_bind_ip, preferred_browser_port),
                "30000/tcp": (settings.user_container_bind_ip, preferred_service_port),
            }
        else:
            run_kwargs["ports"] = {
                "5900/tcp": (settings.user_container_bind_ip, None),
                "30000/tcp": (settings.user_container_bind_ip, None),
            }

    try:
        docker_container = client.containers.run(**run_kwargs)
    except DockerAPIError as exc:
        # Preferred ports can race with other creators; fallback to random publish.
        if settings.user_container_publish_ports and "port is already allocated" in str(exc).lower():
            run_kwargs["ports"] = {
                "5900/tcp": (settings.user_container_bind_ip, None),
                "30000/tcp": (settings.user_container_bind_ip, None),
            }
            docker_container = client.containers.run(**run_kwargs)
        else:
            await db.rollback()
            raise
    except Exception:
        # Docker creation failed — remove the placeholder DB record
        await db.rollback()
        raise

    # Read container IP on the internal network
    docker_container.reload()
    browser_binding = _published_binding(docker_container, "5900/tcp")
    service_binding = _published_binding(docker_container, "30000/tcp")
    expose_markdown = _build_expose_port_skill_markdown(
        user_id=user_id,
        container_name=container_name,
        browser_binding=browser_binding,
        service_binding=service_binding,
        public_base_url=settings.public_base_url,
    )
    _write_expose_port_skill(docker_container, expose_markdown)
    plugin_ready = _install_openviking_plugin(docker_container)
    if plugin_ready:
        docker_container.restart(timeout=10)
        docker_container.reload()

    network_settings = docker_container.attrs["NetworkSettings"]["Networks"]
    internal_ip = network_settings.get(settings.container_network, {}).get("IPAddress", "")

    record.docker_id = docker_container.id
    record.status = "running"
    record.internal_host = internal_ip
    await upsert_user_port_binding(
        db=db,
        user_id=user_id,
        host_bind_ip=browser_binding[0] or service_binding[0] or settings.user_container_bind_ip,
        host_port_browser=int(browser_binding[1]) if browser_binding[1] else None,
        host_port_service=int(service_binding[1]) if service_binding[1] else None,
    )
    await db.commit()
    await db.refresh(record)
    return record


async def ensure_running(db: AsyncSession, user_id: str) -> Container:
    """Return a running container for the user, creating or unpausing as needed."""
    import asyncio

    record = await get_container(db, user_id)

    if record is None:
        created = await create_container(db, user_id)
        if created is not None:
            return created
        # Race condition: another request created the container first
        record = await get_container(db, user_id)
        if record is None:
            raise RuntimeError("Failed to create or find container")

    # Another request is still creating the container — wait for it
    if record.status == "creating":
        for _ in range(30):  # wait up to 60s
            await asyncio.sleep(2)
            await db.expire(record)
            record = await get_container(db, user_id)
            if record is None or record.status != "creating":
                break
        if record is None:
            return await create_container(db, user_id)
        if record.status == "creating":
            raise RuntimeError("Container creation timed out")

    client = _docker()
    sidecar_missing = settings.user_openviking_enabled and not _openviking_sidecar_exists(user_id)
    if settings.user_openviking_enabled:
        _ensure_openviking_sidecar(user_id)

    if record.docker_id:
        try:
            c = client.containers.get(record.docker_id)
            if c.name != _expected_container_name(user_id):
                return await _recreate_container_record(db, record, c)
            if not _container_uses_current_image(c):
                return await _recreate_container_record(db, record, c)
        except DockerNotFound:
            await db.delete(record)
            await db.commit()
            created = await create_container(db, user_id)
            if created is not None:
                return created
            record = await get_container(db, user_id)
            if record is not None:
                return record
            raise RuntimeError("Failed to recreate container")

    if record.status == "paused":
        try:
            c = client.containers.get(record.docker_id)
            c.unpause()
            await db.execute(
                update(Container)
                .where(Container.id == record.id)
                .values(status="running")
            )
            await db.commit()
            record.status = "running"
        except DockerNotFound:
            # Container was removed externally — recreate
            return await _recreate_container_record(db, record)

    elif record.status == "archived":
        # Recreate from persisted data volumes
        return await _recreate_container_record(db, record)

    elif record.status == "running":
        # Verify it's actually running
        try:
            c = client.containers.get(record.docker_id)
            if c.status != "running":
                c.start()
                c.reload()
            if settings.user_openviking_enabled:
                data_vol = f"openclaw-data-{user_id[:8]}"
                _patch_openviking_plugin_config(user_id, data_vol)
                if sidecar_missing:
                    plugin_ready = _install_openviking_plugin(c)
                    if plugin_ready:
                        c.restart(timeout=10)
                        c.reload()
            # Sync internal IP — it may change after container restart
            nets = c.attrs.get("NetworkSettings", {}).get("Networks", {})
            for net_info in nets.values():
                current_ip = net_info.get("IPAddress", "")
                if current_ip and current_ip != record.internal_host:
                    record.internal_host = current_ip
                    await db.execute(
                        update(Container)
                        .where(Container.id == record.id)
                        .values(internal_host=current_ip)
                    )
                    await db.commit()
                break
        except DockerNotFound:
            return await _recreate_container_record(db, record)

    return record


async def pause_container(db: AsyncSession, user_id: str) -> bool:
    """Pause a user's container to save resources."""
    record = await get_container(db, user_id)
    if record is None or record.status != "running":
        return False

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)
        c.pause()
        _stop_or_pause_openviking_sidecar(user_id, pause=True)
        await db.execute(
            update(Container).where(Container.id == record.id).values(status="paused")
        )
        await db.commit()
        return True
    except DockerNotFound:
        return False


async def resume_container(db: AsyncSession, user_id: str) -> bool:
    """Resume a paused or stopped container to running state."""
    record = await get_container(db, user_id)
    if record is None:
        return False

    if record.status == "running":
        return True  # Already running

    client = _docker()
    try:
        if settings.user_openviking_enabled:
            _ensure_openviking_sidecar(user_id)
        c = client.containers.get(record.docker_id)
        
        if record.status == "paused":
            c.unpause()
        elif record.status == "stopped":
            c.start()
        
        # Reload to get latest status
        c.reload()
        await db.execute(
            update(Container).where(Container.id == record.id).values(status="running")
        )
        await db.commit()
        return True
    except DockerNotFound:
        return False


async def destroy_container(db: AsyncSession, user_id: str) -> bool:
    """Stop and remove a user's container (data volumes are preserved)."""
    record = await get_container(db, user_id)
    if record is None:
        return False

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)
        c.stop(timeout=10)
        c.remove()
    except DockerNotFound:
        pass
    _stop_or_pause_openviking_sidecar(user_id, pause=False)

    await db.delete(record)
    await db.commit()
    return True
