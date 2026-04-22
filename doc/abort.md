# openclaw的停止输出功能
涉及的前端代码
./ui/src/ui/controllers/chat.ts
./ui/src/ui/views/chat.ts

chat.ts 里有 stop 按钮，后端则有 sessions.abort 和 chat.abort, 按钮并不直接断 WebSocket，而是发 RPC chat.abort

OpenClaw 的“终止”不是前端单纯停渲染，而是走了一条真正的取消链路：

  1. 前端点击 Stop，发 RPC chat.abort
  2. Gateway 根据 runId/sessionKey 找到该次运行对应的 AbortController
  3. 调 abortController.abort()
  4. 这个 AbortSignal 之前已经传进 reply pipeline 和 agent/model 执行层，所以模型流会被真正中断
  5. Gateway 同时广播一个 state: "aborted" 的 chat 事件，前端把已生成的 partial 文本收口进聊天记录

  前端入口

  Stop 按钮在 openclaw/ui/src/ui/views/chat.ts:1422 渲染，点击调用 props.onAbort。
  这个回调从 openclaw/ui/src/ui/app-render.ts:1822 传入，最终落到 openclaw/ui/src/ui/app-chat.ts:92 的 handleAbortChat()。
  handleAbortChat() 继续调用 openclaw/ui/src/ui/controllers/chat.ts:324 的 abortChatRun()，实际发送：

  client.request("chat.abort", { sessionKey, runId })

  前端收到后端回来的 payload.state === "aborted" 时，会把当前 chatStream 里的 partial 内容落成一条 assistant message，然后清掉 chatRunId/
  chatStream，见 openclaw/ui/src/ui/controllers/chat.ts:381。

  后端取消链路

  chat.abort 在 openclaw/src/gateway/server-methods/chat.ts:1322。
  它会从 context.chatAbortControllers 里取当前 run，对应逻辑在 openclaw/src/gateway/chat-abort.ts:76。

  真正的取消动作就在这里：

  - openclaw/src/gateway/chat-abort.ts:95 标记 aborted
  - openclaw/src/gateway/chat-abort.ts:96 调 active.controller.abort()
  - openclaw/src/gateway/chat-abort.ts:102 广播 state: "aborted"，并带上 partialText

  也就是说，后端在 abort 时做了两件事：

  1. 真取消执行
  2. 真通知 UI 这是一次 aborted run，而不是普通结束

  AbortController 是怎么接进模型调用的

  在 chat.send 开始时，Gateway 为每个 chat run 新建一个 AbortController，并登记到 context.chatAbortControllers，见 openclaw/src/gateway/server-
  methods/chat.ts:1596。

  随后它把 abortController.signal 传进 reply pipeline：

  - openclaw/src/gateway/server-methods/chat.ts:1775

  reply pipeline 再把上游 signal 接到 reply operation 上：

  - openclaw/src/auto-reply/reply/reply-run-registry.ts:226
  - openclaw/src/auto-reply/reply/reply-run-registry.ts:245

  再往下，真正跑 agent/model 的地方会不断检查 abortSignal，例如 embedded runner：

  - openclaw/src/agents/pi-embedded-runner/run.ts:191

  一旦 signal 已 abort，就直接抛 AbortError。
  另外 ACP/agent command 路径也是同样把 signal 透传下去的，例如 openclaw/src/agents/agent-command.ts:427。

  所以它不是“断前端显示”，而是“前端发 abort RPC，后端用 AbortSignal 终止底层执行”。

  流式输出为什么能保留一段 partial 文本

  流式 assistant 文本先在 Gateway 侧缓冲，并按节流广播 delta：

  - openclaw/src/gateway/server-chat.ts:724
  - openclaw/src/gateway/server-chat.ts:731

  abort 时会从 buffer 里取最后的 partial text，作为 aborted message 一起广播：

  - openclaw/src/gateway/server-methods/chat.ts:1377
  - openclaw/src/gateway/chat-abort.ts:64

  如果最后一小段因为 150ms 节流还没发出去，正常 final 时还会先 flush 一次 delta，见 openclaw/src/gateway/server-chat.ts:782。abort 场景则直接拿
  buffer 做 aborted payload，所以用户通常能看到“已生成到一半”的内容。

  你提到的 API 代码补充

  sessions.abort 不是 chat 页按钮直接走的入口，但它本质上只是包了一层再转发到 chat.abort：

  - openclaw/src/gateway/server-methods/sessions.ts:1198

  一句话概括

  OpenClaw 的终止机制是：

  UI Stop 按钮 -> WebSocket RPC chat.abort -> Gateway 查 runId -> AbortController.abort() -> abortSignal 传导到 agent/model -> 广播 aborted 事件
  -> 前端把 partial 文本收尾显示。


# 改造

## Bridge层
openclaw/bridge 这层已经是真调用了 OpenClaw 的终止 RPC，不是模拟。

  具体看这里：

  - POST /sessions/:key/abort-active 在 openclaw/bridge/routes/sessions.ts:196 里直接调用：
      - client.request("chat.abort", { sessionKey })
  - POST /runs/:runId/abort 在 openclaw/bridge/routes/sessions.ts:218 里直接调用：
      - client.request("chat.abort", { sessionKey, runId })

  这个 client.request(...) 不是本地 stub，而是 bridge 自己的 Gateway WebSocket RPC client。
  实现见 openclaw/bridge/gateway-client.ts:298：

  - 它会组一个 { type: "req", id, method, params }
  - 然后 this.ws.send(JSON.stringify(frame))

  也就是说，bridge 发出的就是 OpenClaw Gateway 的真实 RPC 帧。

  要点是：

  - bridge 调的是真 RPC
  - 但它调的是 chat.abort
  - 不是 sessions.abort

  这其实没问题，因为你前面追到的真正中止链路本来就是 chat.abort -> AbortController.abort() -> 底层模型/agent 停止。
  sessions.abort 只是 OpenClaw Gateway 里更高一层的包装接口，内部最后也会转到 chat.abort。

  所以结论是：

  - openclaw/bridge 的取消已经是真取消
  - 只是它直接走底层的 chat.abort
  - 不是走 sessions.abort

## Platform层
Dedicate模式，普通每个用户1个容器的模式
platform/app/routes/proxy.py
abort_run和abort-active函数

share模式
app/routes/shared_openclaw.py
abort_shared_run和abort_active_shared_session_run函数

## 前端
调用这2个端口进行停止输出
http://localhost:3086/api/openclaw/runs/38503bdd-9468-4265-b038-2e4178bb5b1c/abort
http://localhost:3086/api/openclaw/sessions/agent%3Ainnovation%3Asession-1776860861664/abort-active
