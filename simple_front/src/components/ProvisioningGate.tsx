import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clipboard,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import {
  getProvisioningStatus,
  invalidateAgentsCache,
  invalidateSessionsCache,
  retryProvisioning,
} from '../lib/api.ts'
import type { ProvisioningStatus, ProvisioningStageMeta } from '../lib/api.ts'
import { useToast } from './ui/Toast.tsx'

const fallbackStages: ProvisioningStageMeta[] = [
  { key: 'registered', label: '账号已创建', progress: 5 },
  { key: 'queued', label: '进入准备队列', progress: 10 },
  { key: 'creating_container', label: '创建专属容器', progress: 28 },
  { key: 'starting_runtime', label: '启动 OpenClaw', progress: 58 },
  { key: 'syncing_agents', label: '同步内置 Agent', progress: 74 },
  { key: 'checking_agents', label: '检查 Agent 可用性', progress: 86 },
  { key: 'ready', label: '准备完成', progress: 100 },
]

function clampProgress(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value || 0)))
}

function formatTime(value?: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function getDebugText(status: ProvisioningStatus): string {
  const parts = [
    status.debug?.error ? `Error:\n${status.debug.error}` : '',
    status.debug?.traceback ? `Traceback and logs:\n${status.debug.traceback}` : '',
    status.details ? `Details:\n${JSON.stringify(status.details, null, 2)}` : '',
  ].filter(Boolean)
  return parts.join('\n\n')
}

function ProvisioningSkeleton() {
  return (
    <div className="min-h-screen bg-light-bg px-5 py-6 text-light-text">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-5xl items-center">
        <div className="w-full rounded-3xl border border-light-border bg-light-card p-6 shadow-sm">
          <div className="skeleton-shimmer h-6 w-48 rounded-full" />
          <div className="skeleton-shimmer mt-5 h-3 w-full rounded-full" />
          <div className="mt-8 grid gap-3 md:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-light-border p-4">
                <div className="skeleton-shimmer h-4 w-36 rounded-full" />
                <div className="skeleton-shimmer mt-3 h-3 w-24 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProvisioningPage({
  status,
  loading,
  onRefresh,
  onRetry,
}: {
  status: ProvisioningStatus
  loading: boolean
  onRefresh: () => void
  onRetry: () => void
}) {
  const toast = useToast()
  const progress = clampProgress(status.progress)
  const stages = status.stages?.length ? status.stages : fallbackStages
  const activeIndex = Math.max(0, stages.findIndex(stage => stage.key === status.stage))
  const failed = status.status === 'failed'
  const debugText = getDebugText(status)

  const copyDebug = async () => {
    const payload = debugText || JSON.stringify(status, null, 2)
    try {
      await navigator.clipboard.writeText(payload)
      toast.success('调试信息已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="min-h-screen bg-light-bg px-4 py-5 text-light-text sm:px-6 lg:px-8">
      <main className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-6xl items-center">
        <section className="grid w-full gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-3xl border border-light-border bg-light-card p-5 shadow-sm sm:p-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-accent-blue">
                  {failed ? <ShieldAlert size={17} /> : <Loader2 size={17} className="animate-spin" />}
                  <span>{failed ? '工作区准备失败' : '正在准备你的 Agent 工作区'}</span>
                </div>
                <h1 className="mt-3 text-2xl font-semibold tracking-normal text-light-text sm:text-3xl">
                  {failed ? '准备流程停在了这里' : '登录后即可使用完整 OpenClaw'}
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-light-text-secondary">
                  {failed
                    ? status.public_error || '准备任务执行失败，请查看错误信息或重试。'
                    : status.message || '系统正在创建专属运行环境，并确认内置 Agent 已加载。'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-light-border bg-white px-3 text-sm font-medium text-light-text transition-colors hover:bg-light-card-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                  刷新
                </button>
                {failed && (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={loading}
                    className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    <RefreshCw size={16} />
                    重试
                  </button>
                )}
              </div>
            </div>

            <div className="mt-8">
              <div className="mb-2 flex items-center justify-between text-xs text-light-text-secondary">
                <span>{status.message || '准备中'}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    failed ? 'bg-accent-red' : 'bg-accent-blue'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <div className="mt-7 grid gap-3 md:grid-cols-2">
              {stages.map((stage, index) => {
                const isCurrent = index === activeIndex && !failed
                const isDone = !failed && (status.status === 'ready' || index < activeIndex)
                const isFailedStage = failed && index === Math.max(0, activeIndex)
                return (
                  <div
                    key={stage.key}
                    className={`flex items-start gap-3 rounded-2xl border p-4 transition-colors ${
                      isCurrent
                        ? 'border-accent-blue/40 bg-cyan-50/60'
                        : isFailedStage
                          ? 'border-accent-red/30 bg-red-50/60'
                          : 'border-light-border bg-white'
                    }`}
                  >
                    <div className="mt-0.5 shrink-0">
                      {isDone ? (
                        <CheckCircle2 size={18} className="text-accent-green" />
                      ) : isCurrent ? (
                        <Loader2 size={18} className="animate-spin text-accent-blue" />
                      ) : isFailedStage ? (
                        <AlertTriangle size={18} className="text-accent-red" />
                      ) : (
                        <Circle size={18} className="text-slate-300" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-light-text">{stage.label}</div>
                      <div className="mt-1 text-xs text-light-text-secondary">
                        {isDone ? '已完成' : isCurrent ? '进行中' : isFailedStage ? '失败' : '等待中'}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {failed && (
              <div className="mt-6 rounded-2xl border border-accent-red/25 bg-red-50/70 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0 text-accent-red" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-light-text">错误反馈</div>
                    <p className="mt-1 text-sm leading-6 text-light-text-secondary">
                      {status.public_error || '准备任务失败。你可以重试，或复制调试信息交给管理员排查。'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {debugText && (
              <div className="mt-5 rounded-2xl border border-light-border bg-slate-950 p-4 text-slate-100">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">调试详情</div>
                  <button
                    type="button"
                    onClick={copyDebug}
                    className="inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-lg border border-white/15 px-2.5 text-xs text-slate-100 transition-colors hover:bg-white/10"
                  >
                    <Clipboard size={14} />
                    复制
                  </button>
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-200">
                  {debugText}
                </pre>
              </div>
            )}
          </div>

          <aside className="rounded-3xl border border-light-border bg-light-sidebar p-5 shadow-sm">
            <div className="text-sm font-semibold text-light-text">准备状态</div>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-light-text-secondary">状态</dt>
                <dd className="font-medium text-light-text">{status.status}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-light-text-secondary">阶段</dt>
                <dd className="font-medium text-light-text">{status.stage}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-light-text-secondary">尝试次数</dt>
                <dd className="font-medium text-light-text">{status.attempts || 0}</dd>
              </div>
              <div className="border-t border-light-border pt-3">
                <dt className="text-light-text-secondary">开始时间</dt>
                <dd className="mt-1 font-medium text-light-text">{formatTime(status.started_at)}</dd>
              </div>
              <div>
                <dt className="text-light-text-secondary">更新时间</dt>
                <dd className="mt-1 font-medium text-light-text">{formatTime(status.updated_at)}</dd>
              </div>
            </dl>
            {!debugText && failed && (
              <p className="mt-5 rounded-2xl bg-white/70 p-3 text-xs leading-5 text-light-text-secondary">
                源码级 traceback 默认只在管理员账号或调试开关开启时返回，避免泄露密钥和内部配置。
              </p>
            )}
          </aside>
        </section>
      </main>
    </div>
  )
}

export default function ProvisioningGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ProvisioningStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const toast = useToast()

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const next = await getProvisioningStatus()
      setStatus(next)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载准备状态失败')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  const handleRetry = useCallback(async () => {
    setLoading(true)
    try {
      const next = await retryProvisioning()
      setStatus(next)
      setLoadError(null)
      toast.success('已重新开始准备工作区')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试失败')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (!status || status.status === 'ready' || status.status === 'failed' || status.status === 'skipped') return
    const timer = window.setInterval(() => {
      void loadStatus(true)
    }, 2200)
    return () => window.clearInterval(timer)
  }, [loadStatus, status])

  useEffect(() => {
    if (status?.status === 'ready' || status?.status === 'skipped') {
      invalidateAgentsCache()
      invalidateSessionsCache()
    }
  }, [status?.status])

  const fallbackStatus = useMemo<ProvisioningStatus>(() => ({
    status: 'failed',
    stage: 'failed',
    progress: 100,
    message: '准备状态读取失败',
    public_error: loadError || '无法读取准备状态，请稍后重试。',
    stages: fallbackStages,
  }), [loadError])

  if (status?.status === 'ready' || status?.status === 'skipped') {
    return <>{children}</>
  }

  if (loading && !status && !loadError) {
    return <ProvisioningSkeleton />
  }

  return (
    <ProvisioningPage
      status={status || fallbackStatus}
      loading={loading}
      onRefresh={() => void loadStatus()}
      onRetry={handleRetry}
    />
  )
}
