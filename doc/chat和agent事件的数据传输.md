# Chat 事件和 Agent 事件的数据传输

## 概述

OpenClaw 内部有两类事件最终流向前端：

1. **Chat 事件** — 助理消息的流式增量/最终结果/错误，前端用来渲染聊天气泡
2. **Agent 事件** — Agent 运行的生命周期和工具执行事件，前端用来维护"正在运行"状态

它们的传输路径是：

```
openclaw gateway (进程内事件总线)
    │  onAgentEvent → createAgentEventHandler
    │  broadcast("chat"/"agent", payload) → 所有已连接的 WS 客户端
    ▼
bridge (WS 客户端 + HTTP SSE 端点)
    │  gateway-client 收到 WS 帧 → SSE 端点逐连接转发
    ▼
platform (FastAPI 反向代理)
    │  /api/openclaw/events/stream → 透传或过滤转发
    ▼
frontend (EventSource 消费)
    │  sse.onmessage → handleChatEvent / handleAgentEvent
```

---

## 1. 事件定义

### 1.1 内部 Agent 事件（进程内总线）

定义在 `src/infra/agent-events.ts`，是整个事件系统的源头。

```typescript
// AgentEventStream 是事件流类型
type AgentEventStream =
  | "lifecycle" | "tool" | "assistant" | "error"
  | "item" | "plan" | "approval" | "command_output"
  | "patch" | "thinking" | "compaction" | (string & {});

// AgentEventPayload 是事件负载
type AgentEventPayload = {
  runId: string;          // 某次 Agent run 的唯一 ID
  seq: number;            // 单调递增序列号（从 1 开始）
  stream: AgentEventStream;
  ts: number;             // 时间戳
  data: Record<string, unknown>;
  sessionKey?: string;
};
```

核心函数：`emitAgentEvent(payload)` → 通知所有 `onAgentEvent` 注册的监听器。

### 1.2 聊天事件（WS 线缆格式）

Chat 事件**不是直接发射的**，而是由 `createAgentEventHandler` 从 Agent 事件派生出来的。

定义在 `src/gateway/protocol/schema/logs-chat.ts`：

```typescript
type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: { role: "assistant"; content: [{ type: "text"; text: string }]; timestamp: number };
  errorMessage?: string;
  errorKind?: string;
  stopReason?: string;
};
```

| state | 含义 | 触发时机 |
|-------|------|---------|
| `started` | 运行开始 | lifecycle phase: "start" |
| `delta` | 流式中间结果 | assistant 事件的 text_delta（150ms 节流） |
| `final` | 运行正常结束 | lifecycle phase: "end" |
| `error` | 运行出错 | lifecycle phase: "error" |
| `aborted` | 运行被取消 | 用户主动 abort |

### 1.3 Agent 事件（WS 线缆格式）

定义在 `src/gateway/protocol/schema/agent.ts`：

```typescript
type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;       // lifecycle / tool / item / assistant / plan / approval / ...
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};
```

Agent 事件是内部 AgentEventPayload 的**直接转发**（几乎不做变换）。

---

## 2. 事件如何产生：openclaw gateway 内部

### 2.1 Agent 事件发射源

Agent 运行时在以下位置发射事件：

| 事件流 | 发射位置 | 触发时机 |
|--------|---------|---------|
| `lifecycle` | `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts:24` | Agent 启动/结束/出错 |
| `assistant` | `src/agents/pi-embedded-subscribe.handlers.messages.ts:197` | LLM 输出流式 text_delta |
| `tool` / `item` | `src/agents/pi-embedded-subscribe.handlers.tools.ts` | 工具开始/调用/结束 |
| `plan` / `approval` | `src/agents/pi-embedded-subscribe.handlers.tools.ts` | 计划更新/审批请求 |
| `command_output` | `src/agents/pi-embedded-subscribe.handlers.tools.ts` | 命令执行输出 |
| `error` | 各处 | 运行时异常 |

所有发射都调用 `emitAgentEvent()`，它是一个进程内的基于 Set 的发布/订阅模式（`src/infra/agent-events.ts:200`）。

### 2.2 桥接：onAgentEvent → createAgentEventHandler

在 `src/gateway/server-runtime-subscriptions.ts:36`，gateway 启动时注册监听器：

```typescript
const agentUnsub = onAgentEvent(
  createAgentEventHandler({
    broadcast,              // → 广播给所有 WS 客户端
    broadcastToConnIds,    // → 广播给指定 connId 的 WS 客户端
    nodeSendToSession,     // → 发送给节点（移动端）会话
    agentRunSeq,           // 跟踪序列保证顺序
    chatRunState,          // 管理聊天缓冲区状态
    ...
  }),
);
```

### 2.3 事件路由逻辑（server-chat.ts:879-1021）

`createAgentEventHandler` 返回的处理函数对每种 Agent 事件做不同处理：

```
收到 AgentEventPayload
│
├─ stream === "assistant" && text
│   └─ emitChatDelta() → broadcast("chat", { state: "delta", ... })
│      （150ms 节流，buffer 累积文本）
│
├─ stream === "lifecycle" && phase === "start"
│   └─ broadcast("sessions.changed", ...) 给 session 订阅者
│
├─ stream === "lifecycle" && phase === "end"
│   └─ emitChatFinal() → broadcast("chat", { state: "final", ... })
│
├─ stream === "lifecycle" && phase === "error"
│   └─ finalizeLifecycleEvent → broadcast("chat", { state: "error", ... })
│
├─ stream === "tool"
│   └─ broadcastToConnIds("agent", toolPayload, toolRecipients)
│   └─ broadcastToConnIds("session.tool", ..., sessionEventSubscribers)
│
├─ stream === "item" (phase: "start")
│   └─ flush 缓存的 delta → broadcast("chat", delta) 确保工具前文本完整
│
└─ 其他 (非 tool)
    └─ broadcast("agent", agentPayload)  → 广播给所有 WS 客户端
```

关键点：**Chat 事件是 Agent 事件的派生品**。"assistant" 事件产 "chat:delta"，lifecycle end/error 产 "chat:final/error"。而 "agent" 事件是**原样转发**的 Agent 事件。

---

## 3. 事件如何通过 bridge 传输

### 3.1 bridge 的 gateway-client 连接

`openclaw/bridge/start.ts` 中启动 gateway 子进程后，`GatewayManager.start()` 创建 `BridgeGatewayClient` 并连接到 gateway 的 WS 端口（默认 18789）。

`openclaw/bridge/gateway-client.ts:170` 的 WS 消息处理：

```
收到 WS message
│
├─ frame.type === "event"
│   ├─ event === "connect.challenge" → 执行 Ed25519 签名认证
│   ├─ event === "connect.ok" / "hello" → 标记 connected
│   └─ 其他事件 → 通知所有 eventListeners（gateway-client.ts:246-248）
│
└─ frame.type === "res"
    └─ 调度到 pending request 的 resolve/reject
```

BridgeGatewayClient 的 `onEvent(listener)` 允许注册任意多个监听器（gateway-client.ts:121）。

### 3.2 SSE 端点转发

`openclaw/bridge/routes/events.ts:46` — 核心 SSE 端点：

```
GET /api/events/stream

为每个连接创建：
1. 每个连接独立的:
   - connTextState: Map<sessionKey, lastFullText> → 用于计算增量
   - connLastSendTime / connThrottledBuffer / connThrottleTimer: 50ms 节流

2. 收到 "chat" 事件:
   │
   ├─ state === "started" | "final" | "error" | "aborted"
   │   → 立即发送（先 flush 缓存中的 delta）
   │
   └─ state === "delta"
       → connTransformDeltaEvent() 将全量文本转为增量:
         从 connTextState 拿到上一次已发送的完整文本
         用 slice(prev.length) 截取新增部分
         设置 is_delta: true 标记
         → 50ms 节流发送

3. 收到 "agent" 事件:
   → 原样发送，无节流、无变换

4. 每 25s 发送 ": keepalive\n\n" 防止代理超时

5. 连接关闭时: 清理 timer、取消监听
```

`connTransformDeltaEvent()`（events.ts:63-80）将 gateway 发出的全量文本转成增量增量，避免前端重复渲染：

```typescript
function connTransformDeltaEvent(evt): GatewayEvent {
  const prev = connTextState.get(sessionKey) || "";
  const delta = textPart.text.slice(prev.length);   // 计算新增部分
  connTextState.set(sessionKey, textPart.text);
  return { ...evt, payload: { ..., content: [{ text: delta, is_delta: true }] } };
}
```

### 3.3 WebSocket 中继

`openclaw/bridge/server.ts:72-120` 中还维护了一个 `/ws` 的透明 WebSocket 中继，双向透传所有 WS 帧给 gateway。供需要直接 WS 连接的客户端（如 Control UI）使用。

---

## 4. 事件如何通过 platform 转发到前端

### 4.1 独立容器模式

`platform/app/routes/proxy.py` 的 `router = APIRouter(prefix="/api/openclaw")`，挂载在 FastAPI 主应用上（main.py:169 `app.include_router(proxy.router)`）。

`proxy_events_stream`（proxy.py:328-363）：

```
GET /api/openclaw/events/stream?token=xxx

1. 从 query param token 解码出 user
2. 查询用户的容器 URL（base_url = user's bridge container）
3. target_url = f"{base_url}/api/events/stream"
4. 用 httpx.AsyncClient.stream() GET target_url
5. 逐 chunk yield 回前端（纯透传，不做任何检视/过滤）
```

即：platform 在此模式下只是一个**透明 SSE 代理**，auth 后把浏览器和用户容器 bridge 之间的 SSE 流接起来。

### 4.2 共享容器模式（shared_openclaw）

`platform/app/routes/shared_openclaw.py:78-116`：

```
GET /api/shared-openclaw/events/stream?token=xxx

1. 解码 token → 查询 user → 获取 session_prefix
2. 连接到共享 bridge: {shared_openclaw_url}/api/events/stream
3. 逐行解析 SSE 块，用 _filter_shared_sse_block 过滤:
   - 只放行 sessionKey 以用户 session_prefix 开头的事件
   - 非 data: 行（如 keepalive）直接放行
4. 过滤后的块 yield 给前端
```

### 4.3 前端路由（Vite dev proxy）

`frontend/vite.config.ts` 中配置了开发代理：

```
/api/openclaw/events/stream → http://localhost:8080 （禁用缓存/缓冲）
/api/* → http://localhost:8080
```

生产环境（Docker nginx）中，`/api/openclaw/*` 被反向代理到 platform（port 8080）。

---

## 5. 前端如何处理事件

### 5.1 Chat 页面

`frontend/src/pages/Chat.tsx:531-572`：

```typescript
const sse = new EventSource(`/api/openclaw/events/stream?token=${token}`)

sse.onmessage = (evt) => {
  const msg = JSON.parse(evt.data)
  if (msg.event === 'chat' && msg.payload) {
    handleChatEvent(msg.payload)
  } else if (msg.event === 'agent' && msg.payload) {
    handleAgentEvent(msg.payload)
  }
}
```

**handleChatEvent**（Chat.tsx:408-479）：

| payload.state | 前端行为 |
|---------------|---------|
| `started` | 清空 streamingText，设置 agentRunning=true |
| `delta` + `is_delta` | append 到 displayedText（textPart.text） |
| `delta` + 无 is_delta | replace displayedText（向后兼容） |
| `final` | 调 getSession() 加载完整消息列表，清空 streamingText |
| `error` | 显示错误信息，调 getSession() 加载已有消息 |
| `aborted` | 同 final |

**handleAgentEvent**（Chat.tsx:482-528）：

| stream | data.phase | 前端行为 |
|--------|-----------|---------|
| `tool` | `start` / `call` | 取消 complettion timer，保持 agentRunning=true |
| `lifecycle` | `end` | 立即加载消息列表，停止 agent 运行状态。注意：如果先收到 lifecycle end 再收到 chat final，前端的 agentRunning 会在 lifecycle end 时先清除 |

### 5.2 Dashboard

`frontend/src/pages/Dashboard.tsx:98-131`：

只关心 chat 事件的 state：
- `started` / `delta` → 标记该 agent 为 running
- `final` / `error` / `aborted` → 标记 running=false，添加到 recentlyActive

### 5.3 NotificationProvider

`frontend/src/components/NotificationProvider.tsx:138-213`：

只关心 chat 事件的 state：
- `started` → 取消该 session 的 complettion timer
- `final` → 启动 3s 延时 timer，到期后加载会话摘要并创建通知（仅当不在当前聊天页面时）

---

## 6. 完整数据流总结

```
LLM 输出流
    │
    ▼
pi-embedded-subscribe.handlers.messages.ts
    │ emitAgentEvent({ runId, stream: "assistant", data: { text, delta } })
    ▼
Agent 事件总线 (src/infra/agent-events.ts)
    │ onAgentEvent 通知所有监听器
    ▼
createAgentEventHandler (src/gateway/server-chat.ts:879)
    │ emitChatDelta() → broadcast("chat", { state:"delta", message: { content: [{ text }] } })
    │ ← 150ms 节流 + buffer 累积
    ▼
gateway WebSocket broadcaster (src/gateway/server-broadcast.ts)
    │ 序列化为 { type:"event", event:"chat", payload: {...} }
    │ 发送给所有已连接的 WS 客户端
    ▼
bridge gateway-client (gateway-client.ts)
    │ ws.onmessage → eventListeners 通知
    ▼
bridge SSE 端点 (routes/events.ts:46)
    │ connTransformDeltaEvent() 全量→增量变换
    │ 50ms 节流 + 去重
    │ 写入 SSE response
    ▼
platform 反向代理 (proxy.py:328)
    │ httpx 透传 SSE 流
    ▼
前端 EventSource (Chat.tsx:531)
    │ sse.onmessage → handleChatEvent / handleAgentEvent
    ▼
React state 更新 → UI 渲染
```

Chat 事件和 Agent 事件是**两条平行的流**，来自同一个 AgentEventPayload 源头：
- Chat 事件：承载**用户可见**的聊天文本（delta/final/error）
- Agent 事件：承载**运行状态**信息（tool lifecycle / lifecycle），前端用来控制 loading 状态

两者通过 `createAgentEventHandler` 从统一的 `emitAgentEvent` 总线分叉而来，经 gateway → bridge SSE → platform proxy → frontend 三条中继层到达浏览器。
