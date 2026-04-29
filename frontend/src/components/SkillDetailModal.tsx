import { useState, useEffect } from 'react'
import { X, Loader2, Download, Check, Package, Clock, Calendar, User, ChevronDown } from 'lucide-react'
import { getSkillDetail } from '../lib/api'
import type { SkillDetail } from '../lib/api'
import MarkdownContent from './MarkdownContent'

interface SkillDetailModalProps {
  skillName: string
  category: string
  isInstalled: boolean
  isInstalling: boolean
  onInstall: () => void
  onClose: () => void
}

export default function SkillDetailModal({
  skillName,
  category,
  isInstalled,
  isInstalling,
  onInstall,
  onClose,
}: SkillDetailModalProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'versions'>('overview')
  const [expandedVersions, setExpandedVersions] = useState<Set<number>>(new Set())

  const toggleVersionExpand = (index: number) => {
    setExpandedVersions(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  useEffect(() => {
    setLoading(true)
    setError('')
    getSkillDetail(category, skillName)
      .then(setDetail)
      .catch((err) => setError(err?.message || '加载技能详情失败'))
      .finally(() => setLoading(false))
  }, [category, skillName])

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-dark-border bg-dark-card shadow-2xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-dark-border px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-blue/10">
              <Package size={20} className="text-accent-blue" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-dark-text truncate">{skillName}</h2>
              {detail?.description && (
                <p className="text-xs text-dark-text-secondary mt-0.5 leading-relaxed">{detail.description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={onInstall}
              disabled={isInstalled || isInstalling}
              className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                isInstalled
                  ? 'bg-accent-green/10 text-accent-green'
                  : 'bg-accent-blue text-white hover:bg-accent-blue/90 disabled:opacity-50'
              }`}
            >
              {isInstalling ? (
                <><Loader2 size={14} className="animate-spin" /> 安装中...</>
              ) : isInstalled ? (
                <><Check size={14} /> 已安装</>
              ) : (
                <><Download size={14} /> 安装</>
              )}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-dark-text-secondary hover:text-dark-text hover:bg-dark-bg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Meta info bar */}
        {detail?.meta && (
          <div className="flex items-center gap-6 border-b border-dark-border px-6 py-2.5 text-xs text-dark-text-secondary">
            {detail.meta.version && (
              <span className="flex items-center gap-1">
                <Package size={12} />
                v{detail.meta.version}
              </span>
            )}
            {detail.meta.publishedAt && (
              <span className="flex items-center gap-1">
                <Calendar size={12} />
                {formatDate(detail.meta.publishedAt)}
              </span>
            )}
            {detail.meta.ownerId && (
              <span className="flex items-center gap-1">
                <User size={12} />
                {detail.meta.ownerId.split('-')[0]}
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-dark-border px-6">
          <button
            onClick={() => setActiveTab('overview')}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'overview'
                ? 'text-accent-blue'
                : 'text-dark-text-secondary hover:text-dark-text'
            }`}
          >
            概述
            {activeTab === 'overview' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-blue rounded-t" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('versions')}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'versions'
                ? 'text-accent-blue'
                : 'text-dark-text-secondary hover:text-dark-text'
            }`}
          >
            版本历史
            {activeTab === 'versions' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-blue rounded-t" />
            )}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-accent-blue" />
              <span className="ml-3 text-sm text-dark-text-secondary">加载中...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg bg-accent-red/10 p-4 text-sm text-accent-red">{error}</div>
          ) : activeTab === 'overview' ? (
            <div className="skill-detail-markdown">
              <MarkdownContent content={detail?.markdown || ''} />
            </div>
          ) : (
            /* Versions tab — timeline style */
            <div>
              {detail?.meta?.changelog && detail.meta.changelog.length > 0 ? (
                <div className="relative">
                  {detail.meta.changelog.map((entry, i) => {
                    const isLatest = i === 0
                    const isExpanded = expandedVersions.has(i)
                    const isLast = i === detail.meta.changelog!.length - 1
                    return (
                      <div key={i} className="relative flex gap-4">
                        {/* Timeline line & dot */}
                        <div className="flex flex-col items-center">
                          <div className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${
                            isLatest
                              ? 'border-accent-blue bg-accent-blue'
                              : 'border-dark-border bg-dark-bg'
                          }`} />
                          {!isLast && (
                            <div className="w-px flex-1 bg-dark-border" />
                          )}
                        </div>

                        {/* Version content */}
                        <div className={`flex-1 pb-6 ${isLast ? 'pb-0' : ''}`}>
                          <button
                            onClick={() => toggleVersionExpand(i)}
                            className="flex w-full items-center justify-between group"
                          >
                            <div className="flex items-center gap-3">
                              <span className={`text-sm font-semibold ${isLatest ? 'text-dark-text' : 'text-dark-text-secondary'}`}>
                                v{entry.version}
                              </span>
                              {isLatest && (
                                <span className="rounded-full bg-accent-blue px-2 py-0.5 text-[10px] font-medium text-white">
                                  最新
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-dark-text-secondary">{entry.date}</span>
                              <ChevronDown
                                size={14}
                                className={`text-dark-text-secondary transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              />
                            </div>
                          </button>

                          {isExpanded && (
                            <ul className="mt-2 space-y-1.5 pl-1">
                              {entry.changes.map((change, j) => (
                                <li key={j} className="text-sm text-dark-text-secondary flex items-start gap-2">
                                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-dark-text-secondary/40" />
                                  {change}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : detail?.meta?.version ? (
                <div className="relative flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-accent-blue bg-accent-blue" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-dark-text">v{detail.meta.version}</span>
                      <span className="rounded-full bg-accent-blue px-2 py-0.5 text-[10px] font-medium text-white">最新</span>
                    </div>
                    {detail.meta.publishedAt && (
                      <span className="mt-1 text-xs text-dark-text-secondary">{formatDate(detail.meta.publishedAt)}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-dark-text-secondary">
                  <Clock size={32} className="mb-3 opacity-50" />
                  <p className="text-sm">暂无版本历史记录</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
