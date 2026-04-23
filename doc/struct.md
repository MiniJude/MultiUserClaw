[Frontend] Vite+React (端口 3080)
    | WebSocket 连接
    v
[Platform Gateway] FastAPI (端口 8080) --对应platform目录和项目
    | 1. JWT 认证
    | 2. 查找/启动用户容器
    | 3. WebSocket 代理
    v
[用户容器] — 每个用户一个独立 Docker 容器
    |
    |  容器内部结构:
    |  ┌─────────────────────────────────────────┐
    |  │  Bridge (Node.js, 端口 18080)            │
    |  │    - HTTP API 服务器                      │
    |  │    - WebSocket 中继                       │
    |  │              |                            │
    |  │              v                            │
    |  │  OpenClaw Gateway (端口 18789, loopback)  │
    |  │    - Agent 处理引擎                       │
    |  │    - 工具调用 (bash/文件/搜索等)           │
    |  │    - Skills 系统                          │
    |  │    - Session 管理                         │
    |  └─────────────────────────────────────────┘
    |
    | Agent 需要调用 LLM 时:
[Platform Gateway] /llm/v1/chat/completions
    | 1. 验证容器 Token
    | 2. 检查用户配额
    | 3. 根据模型名匹配 Provider
    | 4. 注入真实 API Key
    v
[LLM 提供商] (Anthropic / OpenAI / DashScope / DeepSeek / ...)
    |
    | 响应沿原路返回
    v


目录：
openclaw/Dockerfile.bridge打包成openclaw:latest
platform打包成openclaw-gateway 
frontend打包成openclaw-frontend

b0c73766924d   openclaw:latest              "/entrypoint.sh node…"   11 hours ago   Up 11 hours               18080/tcp, 18789/tcp, 0.0.0.0:50583->5900/tcp, 0.0.0.0:50584->30000/tcp   openclaw-user-f0536784

4dc176c124c0   openclaw-gateway             "uvicorn app.main:ap…"   11 hours ago   Up 11 hours               0.0.0.0:8080->8080/tcp                                                    openclaw-gateway

a687842353f2   openclaw-frontend            "/docker-entrypoint.…"   36 hours ago   Up 36 hours               80/tcp, 0.0.0.0:3080->3000/tcp                                            openclaw-frontend
