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

openclaw/bridge是我的bridge的代码，openclaw下的其它代码都是官方的，不建议进行改动，改动后不方便和官方保持一致

# OpenClaw 前端性能优化设计

**日期:** 2026-04-25
**状态:** 设计已批准
**范围:** 针对前端响应速度、Bridge SSE 效率和平台配额检查的三阶段优化

---

## 执行摘要

当前聊天体验缓慢并非由于网络延迟或模型推理，而是因为：
1. **前端打字机动画**人为地将显示速度限制在约 150 字符/秒（增加了 8-10 秒的虚假延迟）
2. **防抖延迟**（3 秒 + 1 秒）即使在响应到达后也使 UI 持续加载
3. **Bridge 为每个增量发送完整文本**而不是增量部分（有效载荷增大，前端重新渲染整个消息）
4. **平台在每个请求上通过累加 `usage_records` 检查配额**（没有索引时为 O(n)）
5. **流式传输路径中过多的 `console.log`** 减慢了 DevTools

本设计将通过三个阶段消除这些瓶颈：前端（即时显示 + 移除防抖）、Bridge（增量格式 + 降低节流）和平台（配额缓存）。

---

## 架构与组件

### 当前消息流

```
前端 (Chat.tsx)
  → POST /api/messages  (发送用户消息)
  → SSE /api/openclaw/events/stream  (接收更新)
    ├─ state='started'  (清除流式传输)
    ├─ state='delta'  (流式更新 — 当前为完整文本)
    ├─ state='final'  (3 秒防抖，然后获取消息)
    └─ state='agent' (生命周期事件)
    └─ state='lifecycle' ('end' 后 1 秒防抖)
  → getSession()  (加载最终消息批次)
  → 打字机动画 (20ms 节拍，3 字符/节拍)
  → 显示文本 (实际约 150 字符/秒)
```

### 优化后的消息流

```
前端 (Chat.tsx)
  → POST /api/messages  (发送用户消息)
  → SSE /api/openclaw/events/stream  (接收更新)
    ├─ state='started'  (清除流式传输)
    ├─ state='delta'  (立即追加增量文本)
    │   └─ payload: {message: {content: [{type: 'text', text: '...', is_delta: true}]}}
    ├─ state='final'  (立即 getSession，无防抖)
    └─ state='agent' (生命周期事件，'end' 时无防抖)
  → 显示文本 (即时，收到即显示)
```

---

## 阶段 1：前端即时显示与移除防抖

**文件:** `frontend/src/pages/Chat.tsx`

### 变更

#### 1.1 移除打字机动画

**之前:**
```typescript
const setStreamingText = useCallback((text: string) => {
  targetTextRef.current = text
  // 如果打字机未运行，则启动
  if (!typewriterTimerRef.current) {
    typewriterTimerRef.current = setInterval(() => {
      setDisplayedText(prev => {
        // 每个节拍显示 2-4 个字符
        const charsToAdd = Math.min(3, target.length - prev.length)
        return target.substring(0, prev.length + charsToAdd)
      })
    }, 20) // ~50fps, 3 chars per tick ≈ 150 chars/sec
  }
}, [])
```

**之后:**
```typescript
const setStreamingText = useCallback((text: string) => {
  setDisplayedText(text)
}, [])
```

这是最大的改进：消除了典型 1500 字符响应中 8 秒以上的人为延迟。

#### 1.2 移除最终防抖 (3 秒)

**之前 (约 476-506 行):**
```typescript
if (state === 'final' || state === 'error' || state === 'aborted') {
  // ... 错误处理 ...

  // 防抖：在每个“final”事件上重置完成计时器
  if (sseFinalTimerRef.current) clearTimeout(sseFinalTimerRef.current)
  sseFinalTimerRef.current = setTimeout(() => {
    // 3 秒内没有新的“final”事件 — agent 真正完成
    getSession(currentKey).then(detail => {
      setMessages(detail.messages || [])
      setStreamingText('')
      // ...
    })
  }, 3000)  // 3 秒延迟！
}
```

**之后:**
```typescript
if (state === 'final' || state === 'error' || state === 'aborted') {
  // ... 错误处理 ...

  // 立即加载消息，无防抖
  getSession(currentKey).then(detail => {
    setMessages(detail.messages || [])
    setStreamingText('')
    // ...
  }).catch(() => {
    setStreamingText('')
    // ...
  })
}
```

#### 1.3 移除生命周期防抖 (1 秒)

**之前 (约 532-556 行):**
```typescript
if (phase === 'end') {
  if (sseFinalTimerRef.current) clearTimeout(sseFinalTimerRef.current)
  sseFinalTimerRef.current = setTimeout(() => {
    // 1 秒延迟后才最终完成
    const key = activeSessionKeyRef.current
    if (key) {
      getSession(key).then(...)
    }
  }, 1000)  // 1 秒延迟！
}
```

**之后:**
```typescript
if (phase === 'end') {
  // 立即加载
  const key = activeSessionKeyRef.current
  if (key) {
    getSession(key).then(...)
  }
}
```

#### 1.4 移除 `console.log` 垃圾输出

**之前:** 第 442、444、451、457、523、534、563、566、571、576、580 行在每个 SSE 事件上都有 `console.log`。

**之后:** 只保留错误级别日志或受功能标志保护的调试级别日志。在流式传输路径中，移除所有按块的日志记录。

### 预期影响

- **打字动画:** 移除约 8-10 秒
- **3 秒最终防抖:** 移除 3 秒
- **1 秒生命周期防抖:** 移除 1 秒
- **Console.log:** 解除浏览器 DevTools 的阻塞（打开时可能增加 2-3 秒的延迟）
- **总感知改进:** 典型响应中提升 12 秒以上

---

## 阶段 2：Bridge SSE 增量格式与降低节流

**文件:** `openclaw/bridge/routes/events.ts` (你的代码，可安全修改)

### 2.1 SSE 消息格式变更

**当前增量消息 (约 724 行):**
```typescript
// 每次更新发送完整的 message.content
{
  state: 'delta',
  message: {
    content: [
      {
        type: 'text',
        text: '这是到目前为止累积的完整文本... (每次都会变长)'
      }
    ]
  }
}
```

**新增量消息:**
```typescript
{
  state: 'delta',
  message: {
    content: [
      {
        type: 'text',
        text: '这是自上次增量以来的增量添加',
        is_delta: true,  // 新增：标志此为增量
        index: 123       // 可选：用于验证的字节偏移或序列号
      }
    ]
  }
}
```

### 2.2 前端增量消费

**文件:** `frontend/src/pages/Chat.tsx` (适应新格式)

**之前:**
```typescript
if (state === 'delta' && payload.message) {
  const content = payload.message.content
  if (Array.isArray(content)) {
    const textPart = content.find((c: any) => c.type === 'text')
    if (textPart?.text) {
      setStreamingText(textPart.text)  // 完整文本，替换之前的内容
    }
  }
}
```

**之后:**
```typescript
if (state === 'delta' && payload.message) {
  const content = payload.message.content
  if (Array.isArray(content)) {
    const textPart = content.find((c: any) => c.type === 'text')
    if (textPart?.text) {
      setDisplayedText(prev => {
        if (textPart.is_delta) {
          return prev + textPart.text  // 追加增量
        } else {
          return textPart.text  // 完整文本（用于兼容性）
        }
      })
    }
  }
}
```

### 2.3 降低 Bridge 中的节流

**之前 (约 724 行):**
```typescript
// 150ms 节流
const throttledSend = throttle(() => { ... }, 150)
```

**之后:**
```typescript
// 50ms 节流
const throttledSend = throttle(() => { ... }, 50)
```

### 预期影响

- **有效载荷大小:** 长响应时不再持续增长（之前为 1KB → 5KB → 20KB，现在每个增量保持约 200 字节）
- **前端渲染:** 不再在每次增量时重新渲染整个消息
- **节流:** 150ms → 50ms = 响应速度提升 3 倍

---

## 阶段 3：平台配额缓存

**文件:** `platform/app/llm_proxy/service.py`

### 3.1 添加 QuotaCache 类

**位置:** 添加到 `platform/app/llm_proxy/service.py` 顶部附近

```python
from datetime import datetime, timedelta
import time

class QuotaCache:
    """带有 TTL 的每日配额求和的内存缓存。"""

    def __init__(self, ttl_seconds: int = 60):
        self.ttl_seconds = ttl_seconds
        self._cache: dict[str, tuple[int, float]] = {}  # {user_id: (tokens, timestamp)}

    def get(self, user_id: str) -> int | None:
        """获取缓存的配额，如果过期则返回 None。"""
        if user_id not in self._cache:
            return None
        tokens, cached_at = self._cache[user_id]
        if time.time() - cached_at > self.ttl_seconds:
            del self._cache[user_id]
            return None
        return tokens

    def set(self, user_id: str, tokens: int):
        """用当前时间戳缓存配额。"""
        self._cache[user_id] = (tokens, time.time())

    def invalidate(self, user_id: str):
        """强制缓存失效。"""
        self._cache.pop(user_id, None)

_quota_cache = QuotaCache(ttl_seconds=60)
```

### 3.2 修改 `_check_quota()`

**之前 (约 194-265 行):**
```python
async def _check_quota(self, session: AsyncSession, user_id: str, tokens: int) -> bool:
    # 每个请求：累加今天使用的所有 token
    today = datetime.utcnow().date()
    result = await session.execute(
        select(func.sum(UsageRecord.tokens)).where(
            and_(
                UsageRecord.user_id == user_id,
                func.date(UsageRecord.created_at) == today
            )
        )
    )
    total_used = result.scalar() or 0

    daily_limit = self.user_quota.get(user_id, 1_000_000)
    if total_used + tokens > daily_limit:
        raise HTTPException(status_code=429, detail="配额超出")
    return True
```

**之后:**
```python
async def _check_quota(self, session: AsyncSession, user_id: str, tokens: int) -> bool:
    # 1. 首先检查缓存
    cached_used = _quota_cache.get(user_id)
    if cached_used is not None:
        total_used = cached_used
    else:
        # 2. 缓存未命中：查询数据库
        today = datetime.utcnow().date()
        result = await session.execute(
            select(func.sum(UsageRecord.tokens)).where(
                and_(
                    UsageRecord.user_id == user_id,
                    func.date(UsageRecord.created_at) == today
                )
            )
        )
        total_used = result.scalar() or 0
        _quota_cache.set(user_id, total_used)

    # 3. 检查限制
    daily_limit = self.user_quota.get(user_id, 1_000_000)
    if total_used + tokens > daily_limit:
        raise HTTPException(status_code=429, detail="配额超出")
    return True
```

### 3.3 可选：添加数据库索引

**文件:** `platform/app/db/models.py` (约 90 行)

**当前:**
```python
class UsageRecord(Base):
    __tablename__ = "usage_records"

    id = Column(Integer, primary_key=True)
    user_id = Column(String, index=True)  # 单列索引
    tokens = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow)
```

**带索引:**
```python
class UsageRecord(Base):
    __tablename__ = "usage_records"

    id = Column(Integer, primary_key=True)
    user_id = Column(String, index=True)
    tokens = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_usage_user_date', 'user_id', 'created_at'),
    )
```

此索引更好地支持配额查询中的 WHERE 子句。

### 预期影响

- **首次请求延迟:** 快 200-500ms（缓存命中路径为 O(1) 而非 O(n) 求和）
- **高并发:** 减少 `usage_records` 表的数据库争用
- **缓存失效:** TTL = 60s 意味着配额可能滞后 1 分钟（对于每日限制是可接受的）

---

## 数据流契约

### SSE 增量消息契约

```typescript
// 向后兼容：完整文本消息（始终支持）
{
  state: 'delta',
  message: {
    content: [
      {
        type: 'text',
        text: '到目前为止累积的完整文本',
        is_delta?: false  // 省略或明确的 false
      }
    ]
  }
}

// 新增：增量消息
{
  state: 'delta',
  message: {
    content: [
      {
        type: 'text',
        text: '只有新增部分',
        is_delta: true
      }
    ]
  }
}
```

**前端行为:**
- 如果 `is_delta === true`: 追加文本
- 否则（默认）：替换文本

---

## 测试与验证

### 单元测试

1. **前端增量逻辑:**
   - 测试 `setDisplayedText` 在 `is_delta: true` 时追加
   - 测试 `setDisplayedText` 在 `is_delta: false` 时替换

2. **后端配额缓存:**
   - 测试缓存命中/未命中
   - 测试 TTL 过期
   - 测试失效

### 集成测试

1. **端到端消息流:**
   - 发送消息
   - 验证第一个增量在 2 秒内到达
   - 验证完整响应在 5 秒内显示（无防抖等待）

2. **高并发配额:**
   - 同一用户发送 10 个并发请求
   - 验证配额检查在 <100ms 内完成

### 性能测量脚本

创建 `scripts/perf-measure.js` 来测试：
- 到第一个增量字符的时间
- 到完整消息显示的时间
- SSE p99 延迟
- 配额检查延迟（带/不带缓存）

---

## 发布计划

### 阶段 1 (第 1-2 天): 前端
- 部署 Chat.tsx 变更
- 监控日志中的 SSE 延迟
- 用户测试：感觉响应迅速吗？

### 阶段 2 (第 3-4 天): Bridge
- 部署增量格式变更
- 验证向后兼容性（旧前端 + 新 Bridge）
- 监控有效载荷大小

### 阶段 3 (第 5-7 天): 平台
- 部署配额缓存（非破坏性，优雅回退到数据库）
- 添加数据库索引（独立部署，可异步运行）
- 监控配额检查延迟

---

## 回滚计划

每个阶段都是独立的：
- **阶段 1 回滚:** 恢复 Chat.tsx，重新构建前端
- **阶段 2 回滚:** 恢复 bridge events.ts，重新构建 Bridge
- **阶段 3 回滚:** 移除配额缓存，保留数据库查询（向后兼容）

无需数据迁移。

---

## 成功标准

| 指标 | 之前 | 之后 | 目标 |
|--------|--------|-------|--------|
| 感知响应时间 | 12+ 秒 | <2 秒 | ✓ |
| 打字动画延迟 | 8 秒 | 0 秒 | ✓ |
| 防抖开销 | 4 秒 | 0 秒 | ✓ |
| SSE 有效载荷大小（1KB+ 响应） | 20+ KB | <1 KB | ✓ |
| 配额检查延迟（缓存命中） | ~50ms | <5ms | ✓ |
| 第一个增量延迟 p99 | 200ms+ | <100ms | ✓ |

---

## 风险与缓解

| 风险 | 严重性 | 缓解措施 |
|------|----------|-----------|
| 增量格式不匹配（旧前端 + 新 Bridge） | 中 | 逐步推出；Bridge 在过渡期间发送两种格式 |
| 配额缓存假阴性（用户配额超限） | 低 | 60 秒 TTL 对于每日限制是可接受的；用户可以等待/重试 |
| 移除防抖导致快速 `getSession` 调用 | 低 | `getSession` 由浏览器缓存；多次调用开销小 |
| 移除 `console.log` 导致调试困难 | 低 | 保留错误/警告日志；如果需要，添加查询参数以实现详细日志记录 |

---

## 参考资料

- 优化分析: `doc/speed.md`
- 前端聊天组件: `frontend/src/pages/Chat.tsx`
- Bridge 事件: `openclaw/bridge/routes/events.ts`
- 平台 LLM 代理: `platform/app/llm_proxy/service.py`
- 平台模型: `platform/app/db/models.py`
