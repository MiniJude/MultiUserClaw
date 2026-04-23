  先纠正一下实际链路：当前聊天前端不是 WebSocket，而是 POST /messages 发消息 + SSE /events/stream 收流。frontend/src/pages/Chat.tsx:561
  platform/app/routes/proxy.py:328

  最主要的慢点

  1. 前端自己做了打字机限速，硬性限制到大约 150 chars/sec。代码里每 20ms 只放 3 个字符，1500 字回答光前端动画就要 10 秒左右。frontend/src/pages/
     Chat.tsx:101
  2. 前端在收到 final 后又故意多等 3s，收到 lifecycle end 后又等 1s，然后才拉最终消息，所以“回答已经结束了但 UI 还在转”。frontend/src/pages/
     Chat.tsx:476 frontend/src/pages/Chat.tsx:536
  3. 网关发给前端的 delta 不是增量，而是“截至当前的整段全文”；同时还做了 150ms 节流。openclaw/src/gateway/server-chat.ts:724 这会带来两个问题：
      - 长回复时 payload 越来越大
      - 前端每次都在重设整段文本，再配合打字机，体感更慢
  4. 前端每个 SSE chunk 都 console.log，流式回复时日志很多，浏览器 DevTools 打开时会明显拖慢。frontend/src/pages/Chat.tsx:450 frontend/src/
     pages/Chat.tsx:579

  后端/模型侧还能再抠的延迟

  1. platform 的 LLM proxy 每次请求前都要做鉴权、查用户/容器、再跑一次“今天已用 token 求和”。这是真实首包延迟来源之一，尤其并发高时更明显。
     platform/app/llm_proxy/service.py:265 platform/app/llm_proxy/service.py:194
  2. usage_records 目前只有 user_id 单列索引，没有 (user_id, created_at) 这种适合 quota 查询的组合索引；数据多了以后 _check_quota() 会越来越贵。
     platform/app/db/models.py:90
  3. 聊天默认可能会自动带上 thinking/reasoning，这会真实增加模型首 token 延迟。这个要看你当前会话和默认模型配置。openclaw/src/gateway/server-
     methods/chat.ts:1297 openclaw/src/agents/model-selection.ts:778
  4. SSE 双代理本身看起来只是透明转发，不像主要瓶颈。openclaw/bridge/routes/events.ts:12 platform/app/routes/proxy.py:350

  建议按这个顺序改

  1. 去掉前端打字机，直接显示流式文本。
  2. 去掉 final 的 3 秒和 lifecycle end 的 1 秒 debounce，收到终态立即收尾。
  3. 删掉 SSE per-chunk console.log。
  4. gateway 改成发送真正的 delta，前端本地 append；同时把 150ms 节流降到 30-50ms，或者按字符数自适应。
  5. platform 给 quota 查询加组合索引 (user_id, created_at)，并把“今日用量”改成缓存/聚合计数，而不是每次 sum()。
  6. 如果当前默认 thinking 不是 off/low，聊天场景降一级。

  如果只改前 3 项，体感通常会立刻快很多；如果再加第 4 项，长回答会明显顺滑；第 5、6 项主要改善首包时间和高并发下稳定性。
