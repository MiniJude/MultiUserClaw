"""Platform gateway configuration."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Platform configuration loaded from environment variables."""

    # Database
    database_url: str = "postgresql+asyncpg://nanobot:nanobot@localhost:5432/nanobot_platform"

    # JWT
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 60 * 24  # 24 hours
    jwt_refresh_token_expire_days: int = 30

    # LLM Provider API Keys (platform-level, never exposed to containers)
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openai_api_base: str = ""  # Custom OpenAI-compatible base URL
    deepseek_api_key: str = ""
    openrouter_api_key: str = ""
    dashscope_api_key: str = ""
    minimax_api_key: str = ""
    minimax_api_base: str = "https://api.minimax.io/v1"
    aihubmix_api_key: str = ""
    moonshot_api_key: str = ""
    kimi_api_key: str = ""
    zhipu_api_key: str = ""
    doubao_api_key: str = ""

    # Self-hosted vLLM / OpenAI-compatible local model
    hosted_vllm_api_key: str = ""
    hosted_vllm_api_base: str = ""  # e.g. "http://117.133.60.219:8900/v1"

    # Default model for new users
    default_model: str = "claude-sonnet-4-5"

    # Docker
    openclaw_image: str = "openclaw:latest"
    deploy_version: str = ""
    container_network: str = "openclaw-internal"
    skills_repo_mirror_map: str = ""
    github_mirror_prefixes: str = ""

    # Shared OpenClaw runtime，共享openclaw容器时的参数
    shared_openclaw_enabled: bool = True
    shared_openclaw_url: str = "http://shared-openclaw:18080"
    shared_openclaw_timeout_seconds: int = 120
    shared_openclaw_system_token: str = ""
    user_container_publish_ports: bool = True
    user_container_api_via_host: bool = False
    user_container_bind_ip: str = "0.0.0.0"
    container_tz: str = "Asia/Shanghai"
    # 🟢 提升资源限制（适合浏览器/agent）
    container_memory_limit: str = "2g"  # 原来 512m
    container_cpu_limit: float = 4.0  # 原来 1.0
    container_pids_limit: int = 1024  # 原来 100

    # 建议增加 shm（非常重要，防止 Chromium 崩溃）
    container_shm_size: str = "1g"
    container_data_dir: str = "/data/openclaw-users"

    # Per-user OpenViking memory sidecar.
    # Disabled by default because OpenViking needs its own model/provider config.
    # When enabled, each dedicated user gets:
    #   openviking-user-<user-id-prefix> + openviking-data-<user-id-prefix>
    user_openviking_enabled: bool = False
    user_openviking_image: str = "ghcr.io/volcengine/openviking:latest"
    user_openviking_port: int = 1933
    user_openviking_bind_ip: str = "127.0.0.1"
    user_openviking_memory_limit: str = "1g"
    user_openviking_cpu_limit: float = 1.0
    user_openviking_api_key: str = ""
    user_openviking_conf_content: str = ""
    user_openviking_install_plugin: bool = True
    user_openviking_force_unsafe_plugin_install: bool = True
    user_openviking_embedding_provider: str = "minimax"
    user_openviking_embedding_model: str = "embo-01"
    user_openviking_embedding_api_base: str = "https://api.minimax.chat/v1/embeddings"
    user_openviking_embedding_dimension: int = 1536
    user_openviking_embedding_input: str = "text"
    user_openviking_embedding_max_concurrent: int = 2
    user_openviking_embedding_max_input_tokens: int = 2048
    user_openviking_vlm_provider: str = "openai"
    user_openviking_vlm_model: str = "deepseek-chat"
    user_openviking_vlm_api_base: str = "https://api.deepseek.com/v1"
    user_openviking_vlm_temperature: float = 0.0
    user_openviking_vlm_timeout: int = 90
    user_openviking_vlm_max_concurrent: int = 2
    user_openviking_plugin_timeout_ms: int = 2000
    user_openviking_plugin_auto_recall: bool = False
    user_openviking_plugin_recall_limit: int = 3
    user_openviking_plugin_recall_score_threshold: float = 0.18
    user_openviking_plugin_recall_max_injected_chars: int = 2500
    user_openviking_plugin_recall_resources: bool = False
    user_openviking_plugin_capture_max_length: int = 12000

    # Idle management
    container_idle_pause_minutes: int = 30
    container_idle_archive_days: int = 30

    # Quotas (tokens per day)
    quota_free: int = 20000000
    quota_basic: int = 1_000_000
    quota_pro: int = 10_000_000

    # Admin account (auto-created on first startup)
    admin_username: str = ""
    admin_password: str = ""

    # Platform gateway
    host: str = "0.0.0.0"
    port: int = 8080
    container_proxy_url: str = ""

    # Public-facing base URL (used to generate external access URLs in port mapping)
    public_base_url: str = "http://www.exmaple.com"

    # Local dev: set to e.g. "http://127.0.0.1:18080" to skip Docker containers
    dev_openclaw_url: str = ""

    # Local dev: OpenClaw Gateway WS URL for direct WS proxy (e.g. "ws://127.0.0.1:18789")
    dev_gateway_url: str = ""

    # User environment provisioning
    provisioning_timeout_seconds: int = 600
    provisioning_required_agents: str = "hr,doctor"
    provisioning_expose_debug_errors: bool = True
    provisioning_smoke_chat_enabled: bool = True
    provisioning_smoke_agent: str = "doctor"
    provisioning_smoke_message: str = "Provisioning readiness check. Reply exactly: READY"

    model_config = {"env_prefix": "PLATFORM_"}


settings = Settings()
