import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  Brain,
  CheckCircle2,
  Database,
  FileSearch,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  TextCursorInput,
  ChevronDown,
} from 'lucide-react'
import ClearableInput from '../components/ui/ClearableInput.tsx'
import IconButton from '../components/ui/IconButton.tsx'
import { useToast } from '../components/ui/Toast.tsx'
import {
  commitOpenVikingSession,
  extractOpenVikingSession,
  getOpenVikingSessionContext,
  getOpenVikingSummary,
  listOpenVikingMemoryCards,
  listOpenVikingMemories,
  listOpenVikingSessions,
  searchOpenViking,
  waitOpenVikingProcessed,
  writeOpenVikingMemory,
} from '../lib/api.ts'
import type { OpenVikingEnvelope, OpenVikingMemoryCard, OpenVikingSession, OpenVikingSummary } from '../lib/api.ts'

type TabKey = 'memory' | 'recall' | 'sessions' | 'diagnostics'

const tabs: Array<{ key: TabKey; label: string; icon: typeof Brain }> = [
  { key: 'memory', label: '记忆', icon: Brain },
  { key: 'recall', label: '召回测试', icon: Search },
  { key: 'sessions', label: '会话提取', icon: GitBranch },
  { key: 'diagnostics', label: '诊断', icon: Activity },
]

const memoryCategoryLabels: Record<string, string> = {
  profile: '用户画像',
  preferences: '偏好',
  entities: '实体',
  events: '事件',
  cases: '案例',
  patterns: '模式',
  tools: '工具',
  skills: '技能',
}

function unwrap<T>(payload: OpenVikingEnvelope<T> | undefined): T | undefined {
  return payload?.result
}

function stringify(value: unknown): string {
  if (value == null || value === '') return '暂无数据'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function compactText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return (
      compactText(record.content) ||
      compactText(record.text) ||
      compactText(record.abstract) ||
      compactText(record.summary) ||
      compactText(record.uri) ||
      stringify(value)
    )
  }
  return String(value)
}

function resultItems(value: unknown): unknown[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['items', 'matches', 'results', 'memories', 'nodes']) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
  }
  return []
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium ${
        ok
          ? 'border-accent-green/25 bg-accent-green/10 text-emerald-700'
          : 'border-accent-red/25 bg-accent-red/10 text-accent-red'
      }`}
    >
      {ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
      {label}
    </span>
  )
}

function Panel({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string
  icon: typeof Brain
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-light-border bg-light-card shadow-sm shadow-slate-200/40">
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-light-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={17} className="shrink-0 text-accent-blue" />
          <h2 className="truncate text-sm font-semibold text-light-text">{title}</h2>
        </div>
        {action}
      </header>
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  )
}

function LoadingPanel() {
  return (
    <div className="grid gap-4 xl:grid-cols-3" aria-label="正在加载 OpenViking">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="rounded-lg border border-light-border bg-light-card p-4">
          <div className="skeleton-shimmer h-4 w-32 rounded-full" />
          <div className="skeleton-shimmer mt-4 h-8 w-20 rounded-full" />
          <div className="skeleton-shimmer mt-3 h-3 w-full rounded-full" />
        </div>
      ))}
    </div>
  )
}

function CodeBlock({ value, className = '' }: { value: unknown; className?: string }) {
  return (
    <pre className={`max-h-80 overflow-auto rounded-lg bg-light-card-hover p-3 text-xs leading-5 text-light-text ${className}`}>
      {stringify(value)}
    </pre>
  )
}

function formatMemoryDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function MemoryCard({ memory }: { memory: OpenVikingMemoryCard }) {
  const content = memory.content || memory.abstract || '暂无内容'
  const compactContent = content.length > 180 ? `${content.slice(0, 180).trim()}...` : content
  const tags = [
    memory.categoryLabel,
    memory.modified ? `更新 ${formatMemoryDate(memory.modified)}` : '',
  ].filter(Boolean)

  return (
    <details className="group rounded-lg border border-light-border bg-light-card transition-colors hover:bg-light-card-hover/55 open:bg-light-card-hover">
      <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-green/10 text-emerald-700">
          <Brain size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-light-text">{memory.title}</span>
            {memory.readError && (
              <span className="rounded-full bg-accent-yellow/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                读取异常
              </span>
            )}
          </span>
          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-light-text-secondary">
            {tags.map(tag => <span key={tag}>{tag}</span>)}
          </span>
          <span className="mt-3 block whitespace-pre-wrap text-sm leading-6 text-light-text">
            {compactContent}
          </span>
        </span>
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-light-text-secondary transition-colors group-hover:text-light-text"
          title="展开详情"
          aria-label="展开详情"
        >
          <ChevronDown size={16} className="transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="border-t border-light-border px-4 py-4">
        <div className="grid gap-3 text-sm">
          <div>
            <div className="mb-1 text-xs font-medium text-light-text-secondary">完整记忆</div>
            <p className="whitespace-pre-wrap leading-7 text-light-text">{content}</p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-light-text-secondary">存储位置</div>
            <div className="break-all rounded-lg bg-light-card px-3 py-2 text-xs leading-5 text-light-text-secondary">
              {memory.path || memory.uri}
              {memory.size ? <span className="ml-2">({memory.size} B)</span> : null}
            </div>
          </div>
        </div>
        {memory.readError && (
          <div className="mt-2 rounded-lg border border-accent-yellow/25 bg-accent-yellow/10 px-3 py-2 text-xs text-amber-700">
            {memory.readError}
          </div>
        )}
      </div>
    </details>
  )
}

export default function OpenViking() {
  const toast = useToast()
  const [summary, setSummary] = useState<OpenVikingSummary | null>(null)
  const [sessions, setSessions] = useState<OpenVikingSession[]>([])
  const [memories, setMemories] = useState<OpenVikingEnvelope<unknown> | null>(null)
  const [memoryCards, setMemoryCards] = useState<OpenVikingMemoryCard[]>([])
  const [memoryScope, setMemoryScope] = useState('all')
  const [activeTab, setActiveTab] = useState<TabKey>('memory')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [targetUri, setTargetUri] = useState('')
  const [searchResult, setSearchResult] = useState<OpenVikingEnvelope<unknown> | null>(null)
  const [searching, setSearching] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [sessionContext, setSessionContext] = useState<OpenVikingEnvelope<unknown> | null>(null)
  const [sessionActionLoading, setSessionActionLoading] = useState(false)
  const [memoryUri, setMemoryUri] = useState('viking://resources/manual-memory.md')
  const [memoryDraft, setMemoryDraft] = useState('')
  const [writingMemory, setWritingMemory] = useState(false)

  const memoryStats = unwrap(summary?.memoryStats)
  const queue = unwrap(summary?.queue)
  const models = unwrap(summary?.models)
  const vectorCount = unwrap(summary?.vectorCount)
  const ready = summary?.ready as { checks?: Record<string, string> } | undefined
  const memoryItems = resultItems(unwrap(memories || undefined))
  const searchItems = resultItems(unwrap(searchResult || undefined))
  const selectedSession = sessions.find(session => session.session_id === selectedSessionId)
  const memoryScopes = useMemo(() => {
    const categories = Array.from(new Set(memoryCards.map(memory => memory.category))).filter(Boolean)
    return [
      { key: 'all', label: '全局' },
      ...categories.map(key => ({ key, label: memoryCategoryLabels[key] || key })),
    ]
  }, [memoryCards])
  const visibleMemoryCards = useMemo(() => {
    if (memoryScope === 'all') return memoryCards
    return memoryCards.filter(memory => memory.category === memoryScope)
  }, [memoryCards, memoryScope])

  const loadAll = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    try {
      const [nextSummary, nextSessions, nextMemories, nextMemoryCards] = await Promise.all([
        getOpenVikingSummary(),
        listOpenVikingSessions(),
        listOpenVikingMemories(30),
        listOpenVikingMemoryCards(80),
      ])
      setSummary(nextSummary)
      setSessions(nextSessions.result || [])
      setMemories(nextMemories)
      setMemoryCards(nextMemoryCards.result?.memories || [])
      setSelectedSessionId(current => current || nextSessions.result?.[0]?.session_id || '')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 OpenViking 状态失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const hasEmbeddingRisk = useMemo(() => {
    const text = `${queue?.status || ''} ${models?.status || ''} ${JSON.stringify(summary?.errors || {})} ${(summary?.recentLogs || []).join('\n')}`
    return /insufficient balance|circuit breaker|failed to generate embedding|MiniMax API error|HTTP Error|OpenViking request failed/i.test(text)
  }, [models?.status, queue?.status, summary?.errors, summary?.recentLogs])

  async function handleSearch() {
    const nextQuery = query.trim()
    if (!nextQuery) {
      toast.info('先输入要测试召回的问题')
      return
    }
    setSearching(true)
    try {
      const result = await searchOpenViking({
        query: nextQuery,
        target_uri: targetUri.trim(),
        limit: 8,
        include_provenance: true,
      })
      setSearchResult(result)
      setActiveTab('recall')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '召回测试失败')
    } finally {
      setSearching(false)
    }
  }

  async function handleWriteMemory() {
    if (!memoryDraft.trim()) {
      toast.info('先写入一段要测试的记忆内容')
      return
    }
    setWritingMemory(true)
    try {
      await writeOpenVikingMemory({
        uri: memoryUri.trim() || 'viking://resources/manual-memory.md',
        content: `\n\n${new Date().toISOString()}\n${memoryDraft.trim()}\n`,
        mode: 'append',
        wait: true,
        timeout: 45,
      })
      await waitOpenVikingProcessed(30).catch(() => null)
      setMemoryDraft('')
      toast.success('已提交到 OpenViking，正在刷新面板')
      await loadAll(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '写入记忆失败')
    } finally {
      setWritingMemory(false)
    }
  }

  async function handleSessionContext(sessionId = selectedSessionId) {
    if (!sessionId) return
    setSessionActionLoading(true)
    try {
      setSessionContext(await getOpenVikingSessionContext(sessionId))
      setActiveTab('sessions')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取会话上下文失败')
    } finally {
      setSessionActionLoading(false)
    }
  }

  async function handleSessionCommit(kind: 'commit' | 'extract') {
    if (!selectedSessionId) return
    setSessionActionLoading(true)
    try {
      if (kind === 'commit') {
        await commitOpenVikingSession(selectedSessionId)
      } else {
        await extractOpenVikingSession(selectedSessionId)
      }
      await waitOpenVikingProcessed(30).catch(() => null)
      toast.success(kind === 'commit' ? '会话已提交' : '会话已触发提取')
      await loadAll(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '会话操作失败')
    } finally {
      setSessionActionLoading(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-light-bg">
      <header className="flex shrink-0 flex-col gap-4 border-b border-light-border px-5 py-5 sm:px-8 lg:px-10">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-normal text-light-text">OpenViking 记忆</h1>
            <p className="mt-1 text-sm leading-6 text-light-text-secondary">
              查看当前账号的记忆、召回、会话提取和 sidecar 诊断状态。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {summary?.sidecar && (
              <StatusPill
                ok={Boolean(summary.sidecar.healthy)}
                label={`${summary.sidecar.name || 'sidecar'} · ${summary.sidecar.health || summary.sidecar.status || 'unknown'}`}
              />
            )}
            <IconButton label="刷新 OpenViking" onClick={() => void loadAll(true)} disabled={refreshing}>
              {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            </IconButton>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-light-border bg-light-card p-3">
            <div className="flex items-center gap-2 text-xs text-light-text-secondary">
              <Brain size={15} className="text-accent-blue" />
              记忆总数
            </div>
            <div className="mt-2 text-2xl font-semibold text-light-text">{memoryStats?.total_memories ?? 0}</div>
          </div>
          <div className="rounded-lg border border-light-border bg-light-card p-3">
            <div className="flex items-center gap-2 text-xs text-light-text-secondary">
              <Database size={15} className="text-accent-blue" />
              向量数量
            </div>
            <div className="mt-2 text-2xl font-semibold text-light-text">{vectorCount?.count ?? 0}</div>
          </div>
          <div className="rounded-lg border border-light-border bg-light-card p-3">
            <div className="flex items-center gap-2 text-xs text-light-text-secondary">
              <Activity size={15} className="text-accent-blue" />
              队列
            </div>
            <div className={`mt-2 text-sm font-medium ${queue?.has_errors || hasEmbeddingRisk ? 'text-accent-red' : 'text-light-text'}`}>
              {queue?.is_healthy ? '运行中' : '需要关注'}
            </div>
          </div>
          <div className="rounded-lg border border-light-border bg-light-card p-3">
            <div className="flex items-center gap-2 text-xs text-light-text-secondary">
              <Server size={15} className="text-accent-blue" />
              模型
            </div>
            <div className={`mt-2 text-sm font-medium ${models?.has_errors || hasEmbeddingRisk ? 'text-accent-red' : 'text-light-text'}`}>
              {hasEmbeddingRisk ? 'Embedding 待修复' : models?.is_healthy ? '正常' : '暂无用量'}
            </div>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 lg:px-10">
        {loading ? (
          <LoadingPanel />
        ) : (
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
            {hasEmbeddingRisk && (
              <div className="rounded-lg border border-accent-yellow/30 bg-accent-yellow/10 px-4 py-3 text-sm leading-6 text-amber-800">
                检测到 embedding 队列或模型状态异常。MiniMax 充值后可点击刷新，再用“写入记忆”和“召回测试”验证是否恢复。
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {tabs.map(tab => {
                const Icon = tab.icon
                const active = activeTab === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'border-accent-blue/35 bg-accent-blue/10 text-accent-blue'
                        : 'border-light-border bg-light-card text-light-text-secondary hover:bg-light-card-hover hover:text-light-text'
                    }`}
                  >
                    <Icon size={16} />
                    {tab.label}
                  </button>
                )
              })}
            </div>

            {activeTab === 'memory' && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
                <Panel
                  title="已记住的内容"
                  icon={Brain}
                  action={
                    <span className="text-xs text-light-text-secondary">
                      {visibleMemoryCards.length} 条
                    </span>
                  }
                >
                  <div className="mb-4 flex flex-wrap gap-2 border-b border-light-border pb-3">
                    {memoryScopes.map(scope => {
                      const active = memoryScope === scope.key
                      return (
                        <button
                          key={scope.key}
                          type="button"
                          onClick={() => setMemoryScope(scope.key)}
                          className={`cursor-pointer border-b-2 px-2 py-1.5 text-sm transition-colors ${
                            active
                              ? 'border-accent-blue text-light-text'
                              : 'border-transparent text-light-text-secondary hover:text-light-text'
                          }`}
                        >
                          {scope.label}
                        </button>
                      )
                    })}
                  </div>

                  {visibleMemoryCards.length > 0 ? (
                    <div className="space-y-3">
                      {visibleMemoryCards.map(memory => (
                        <MemoryCard key={memory.uri} memory={memory} />
                      ))}
                    </div>
                  ) : (
                    <div className="flex min-h-60 items-center justify-center rounded-lg border border-dashed border-light-border text-sm text-light-text-secondary">
                      暂无具体记忆内容。可以先在右侧写入一条测试记忆。
                    </div>
                  )}
                </Panel>

                <Panel title="写入测试记忆" icon={TextCursorInput}>
                  <label className="mb-1.5 block text-xs font-medium text-light-text-secondary">写入位置</label>
                  <div className="mb-3 flex items-center rounded-lg border border-light-border bg-light-card-hover px-3">
                    <ClearableInput
                      value={memoryUri}
                      onValueChange={setMemoryUri}
                      className="h-10 text-sm text-light-text"
                      placeholder="viking://resources/manual-memory.md"
                    />
                  </div>
                  <label className="mb-1.5 block text-xs font-medium text-light-text-secondary">记忆内容</label>
                  <textarea
                    value={memoryDraft}
                    onChange={event => setMemoryDraft(event.target.value)}
                    placeholder="例如：我偏好简洁的中文回答，并希望测试 OpenViking 是否能记住这句话。"
                    className="min-h-36 w-full resize-none rounded-lg border border-light-border bg-light-card-hover px-3 py-2 text-sm leading-6 text-light-text outline-none transition-colors placeholder:text-light-text-secondary focus:border-accent-blue/50"
                  />
                  <button
                    type="button"
                    onClick={() => void handleWriteMemory()}
                    disabled={writingMemory}
                    className="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent-blue px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {writingMemory ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                    写入并等待处理
                  </button>
                </Panel>
              </div>
            )}

            {activeTab === 'recall' && (
              <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
                <Panel title="召回查询" icon={Search}>
                  <label className="mb-1.5 block text-xs font-medium text-light-text-secondary">查询内容</label>
                  <div className="flex items-center rounded-lg border border-light-border bg-light-card-hover px-3">
                    <ClearableInput
                      value={query}
                      onValueChange={setQuery}
                      className="h-10 text-sm text-light-text"
                      placeholder="输入一句要验证的记忆问题"
                    />
                  </div>
                  <label className="mb-1.5 mt-3 block text-xs font-medium text-light-text-secondary">目标 URI</label>
                  <div className="flex items-center rounded-lg border border-light-border bg-light-card-hover px-3">
                    <ClearableInput
                      value={targetUri}
                      onValueChange={setTargetUri}
                      className="h-10 text-sm text-light-text"
                      placeholder="留空搜索默认记忆，也可填 viking://resources"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSearch()}
                    disabled={searching}
                    className="mt-4 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent-blue px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {searching ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                    运行召回测试
                  </button>
                </Panel>

                <Panel title="召回结果" icon={FileSearch}>
                  {searchResult ? (
                    searchItems.length > 0 ? (
                      <div className="space-y-3">
                        {searchItems.map((item, index) => (
                          <div key={index} className="rounded-lg border border-light-border bg-light-card-hover p-3">
                            <div className="text-sm leading-6 text-light-text">{compactText(item)}</div>
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-light-text-secondary">原始数据</summary>
                              <CodeBlock value={item} className="mt-2" />
                            </details>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <CodeBlock value={searchResult} />
                    )
                  ) : (
                    <div className="flex min-h-52 items-center justify-center rounded-lg border border-dashed border-light-border text-sm text-light-text-secondary">
                      运行一次查询后，这里会展示召回内容、分数和来源
                    </div>
                  )}
                </Panel>
              </div>
            )}

            {activeTab === 'sessions' && (
              <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
                <Panel title="OpenViking 会话" icon={GitBranch}>
                  <div className="space-y-2">
                    {sessions.map(session => {
                      const active = selectedSessionId === session.session_id
                      return (
                        <button
                          key={session.session_id}
                          type="button"
                          onClick={() => setSelectedSessionId(session.session_id || '')}
                          className={`w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                            active
                              ? 'border-accent-blue/35 bg-accent-blue/10'
                              : 'border-light-border bg-light-card-hover hover:bg-light-card'
                          }`}
                        >
                          <span className="block truncate text-sm font-medium text-light-text">
                            {session.session_id || '未命名会话'}
                          </span>
                          <span className="mt-1 block truncate text-xs text-light-text-secondary">{session.uri}</span>
                        </button>
                      )
                    })}
                    {sessions.length === 0 && (
                      <div className="rounded-lg border border-dashed border-light-border px-3 py-8 text-center text-sm text-light-text-secondary">
                        暂无 OpenViking 会话
                      </div>
                    )}
                  </div>
                </Panel>

                <Panel
                  title="会话上下文"
                  icon={FileSearch}
                  action={sessionActionLoading ? <Loader2 size={16} className="animate-spin text-accent-blue" /> : null}
                >
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!selectedSessionId || sessionActionLoading}
                      onClick={() => void handleSessionContext()}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-light-border bg-light-card-hover px-3 py-2 text-sm text-light-text transition-colors hover:bg-light-card disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FileSearch size={15} />
                      查看上下文
                    </button>
                    <button
                      type="button"
                      disabled={!selectedSessionId || sessionActionLoading}
                      onClick={() => void handleSessionCommit('commit')}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-light-border bg-light-card-hover px-3 py-2 text-sm text-light-text transition-colors hover:bg-light-card disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Database size={15} />
                      Commit
                    </button>
                    <button
                      type="button"
                      disabled={!selectedSessionId || sessionActionLoading}
                      onClick={() => void handleSessionCommit('extract')}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-light-border bg-light-card-hover px-3 py-2 text-sm text-light-text transition-colors hover:bg-light-card disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Sparkles size={15} />
                      Extract
                    </button>
                  </div>
                  {selectedSession ? (
                    <CodeBlock value={sessionContext || selectedSession} />
                  ) : (
                    <div className="flex min-h-52 items-center justify-center rounded-lg border border-dashed border-light-border text-sm text-light-text-secondary">
                      选择一个会话查看上下文或手动触发提取
                    </div>
                  )}
                </Panel>
              </div>
            )}

            {activeTab === 'diagnostics' && (
              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="Ready 检查" icon={Server}>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(ready?.checks || {}).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-light-border bg-light-card-hover px-3 py-2 text-sm">
                        <span className="text-light-text-secondary">{key}</span>
                        <StatusPill ok={value === 'ok'} label={value} />
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel title="队列" icon={Activity}>
                  <CodeBlock value={queue?.status || summary?.queue} />
                </Panel>
                <Panel title="模型" icon={Database}>
                  <CodeBlock value={models?.status || summary?.models} />
                </Panel>
                <Panel title="最近异常日志" icon={AlertCircle}>
                  <CodeBlock value={summary?.recentLogs?.length ? summary.recentLogs.join('\n') : '暂无异常日志'} />
                </Panel>
                <Panel title="向量调试列表" icon={Brain}>
                  {memoryItems.length > 0 ? (
                    <div className="space-y-2">
                      {memoryItems.slice(0, 8).map((item, index) => (
                        <div key={index} className="rounded-lg border border-light-border bg-light-card-hover px-3 py-2 text-sm">
                          <div className="line-clamp-3 text-light-text">{compactText(item)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-light-border text-sm text-light-text-secondary">
                      暂无可展示的向量调试数据
                    </div>
                  )}
                </Panel>
                <Panel title="原始摘要" icon={FileSearch}>
                  <CodeBlock value={summary} />
                </Panel>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
