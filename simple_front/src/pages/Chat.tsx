import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import {
  Plus,
  Send,
  Loader2,
  MessageSquare,
  Bot,
  Search,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  X,
  FileText,
  Menu,
} from 'lucide-react'
import MarkdownContent from '../components/MarkdownContent.tsx'
import UserAvatar from '../components/UserAvatar.tsx'
import AgentCreatePanel from '../components/AgentCreatePanel.tsx'
import ClearableInput from '../components/ui/ClearableInput.tsx'
import ClearableTextarea from '../components/ui/ClearableTextarea.tsx'
import IconButton from '../components/ui/IconButton.tsx'
import Tooltip from '../components/ui/Tooltip.tsx'
import type { LayoutOutletContext } from '../components/Layout.tsx'
import {
  getSession,
  sendChatMessage,
  waitForAgentRun,
  listAgents,
  getAccessToken,
  uploadFileToWorkspace,
} from '../lib/api.ts'
import type { SessionDetail, AgentInfo } from '../lib/api.ts'

/**
 * Extract agentId from session key.
 * Format: agent:<agentId>:session-<timestamp>
 */
function getAgentIdFromKey(key: string): string {
  const parts = key.split(':')
  if (parts.length >= 2 && parts[0] === 'agent') return parts[1]
  return 'main'
}

/**
 * Get the workspace upload dir for an agent.
 * main agent → workspace/uploads
 * other agents → workspace-<agentId>/uploads
 */
function getUploadDir(agentId: string): string {
  if (agentId === 'main') return 'workspace/uploads'
  return `workspace-${agentId}/uploads`
}

interface PendingFile {
  id: string
  file: File
  name: string
  isImage: boolean
  previewUrl?: string
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeSessionKey(key: string): string {
  return key.replace(/:/g, '')
}

const retiredBuiltInAgentIds = new Set(['manager', 'programmer', 'researcher', 'hr', 'doctor'])
const agentDescriptions: Record<string, string> = {
  'daily-assistant': '整理待办、规划下一步、跟进日常事项',
  'web-operator': '处理网页访问、表单、截图和在线流程',
  'slide-maker': '制作、改造和检查汇报演示材料',
  'research-scout': '调研公开信息，筛选来源并整理结论',
  'writing-desk': '撰写邮件、方案、纪要、文案和润色稿',
}

export default function Chat() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user, refreshSessions, openMobileSidebar } = useOutletContext<LayoutOutletContext>()

  // Sessions
  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(null)

  // Chat
  const [messages, setMessages] = useState<SessionDetail['messages']>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sendingBySession, setSendingBySession] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [displayedTextBySession, setDisplayedTextBySession] = useState<Record<string, string>>({})
  const targetTextBySessionRef = useRef<Record<string, string>>({})
  const typewriterTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({})
  const sendingBySessionRef = useRef<Record<string, boolean>>({})
  const sseCompletedRef = useRef<Record<string, boolean>>({})
  const sseFinalTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const setSendingForSession = useCallback((key: string, value: boolean) => {
    setSendingBySession(prev => {
      const next = { ...prev }
      if (value) {
        next[key] = true
      } else {
        delete next[key]
      }
      sendingBySessionRef.current = next
      return next
    })
  }, [])

  const clearStreamingText = useCallback((key: string) => {
    targetTextBySessionRef.current[key] = ''
    setDisplayedTextBySession(prev => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    if (typewriterTimersRef.current[key]) {
      clearInterval(typewriterTimersRef.current[key])
      delete typewriterTimersRef.current[key]
    }
  }, [])

  const setStreamingText = useCallback((key: string, text: string) => {
    if (!text) {
      clearStreamingText(key)
      return
    }

    targetTextBySessionRef.current[key] = text
    if (!typewriterTimersRef.current[key]) {
      typewriterTimersRef.current[key] = setInterval(() => {
        setDisplayedTextBySession(prev => {
          const target = targetTextBySessionRef.current[key] || ''
          const current = prev[key] || ''
          if (current.length >= target.length) {
            if (typewriterTimersRef.current[key]) {
              clearInterval(typewriterTimersRef.current[key])
              delete typewriterTimersRef.current[key]
            }
            return { ...prev, [key]: target }
          }
          const charsToAdd = Math.min(3, target.length - current.length)
          return { ...prev, [key]: target.substring(0, current.length + charsToAdd) }
        })
      }, 20)
    }
  }, [clearStreamingText])

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [draftAgentId, setDraftAgentId] = useState('')
  const [isDraftSession, setIsDraftSession] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [agentCreateOpen, setAgentCreateOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [agentSearch, setAgentSearch] = useState('')
  const [agentPickerStyle, setAgentPickerStyle] = useState<CSSProperties>({})
  const [agentPickerListMaxHeight, setAgentPickerListMaxHeight] = useState(288)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeSessionKeyRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const agentPickerButtonRef = useRef<HTMLButtonElement>(null)
  const sessionLoadSeqRef = useRef(0)

  const resolveKnownSessionKey = useCallback((rawKey: string): string => {
    const normalized = normalizeSessionKey(rawKey)
    const candidates = [
      activeSessionKeyRef.current,
      ...Object.keys(sendingBySessionRef.current),
      ...Object.keys(targetTextBySessionRef.current),
    ].filter(Boolean) as string[]
    return candidates.find(key => normalizeSessionKey(key) === normalized) || rawKey
  }, [])

  // Files
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const loadAgentsCatalog = useCallback(async () => {
    try {
      const result = await listAgents()
      setAgents(result.agents || [])
    } catch {
      setAgents([])
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, activeSessionKey, displayedTextBySession, scrollToBottom])

  useEffect(() => {
    loadAgentsCatalog()
  }, [loadAgentsCatalog])

  useEffect(() => {
    const createdAgent = searchParams.get('createdAgent')
    if (!createdAgent) return
    setNotice(`已创建“${createdAgent}”，可以开始对话了`)
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [searchParams])

  const updateAgentPickerPosition = useCallback(() => {
    const button = agentPickerButtonRef.current
    if (!button) return

    const rect = button.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const margin = 12
    const gap = 8
    const panelWidth = Math.min(320, viewportWidth - margin * 2)
    const left = Math.min(
      Math.max(rect.left, margin),
      viewportWidth - panelWidth - margin,
    )

    const spaceAbove = rect.top - margin
    const spaceBelow = viewportHeight - rect.bottom - margin
    const openBelow = spaceBelow >= 280 || spaceBelow > spaceAbove
    const availableSpace = Math.max(
      180,
      (openBelow ? spaceBelow : spaceAbove) - gap,
    )
    const panelMaxHeight = Math.min(420, availableSpace)
    const top = openBelow
      ? Math.min(rect.bottom + gap, viewportHeight - panelMaxHeight - margin)
      : Math.max(margin, rect.top - panelMaxHeight - gap)
    const reservedHeight = draftAgentId && !agentSearch.trim() ? 126 : 72

    setAgentPickerStyle({
      position: 'fixed',
      top,
      left,
      width: panelWidth,
      maxHeight: panelMaxHeight,
    })
    setAgentPickerListMaxHeight(Math.max(108, panelMaxHeight - reservedHeight))
  }, [agentSearch, draftAgentId])

  useEffect(() => {
    if (!agentPickerOpen) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && agentPickerRef.current?.contains(target)) return
      setAgentPickerOpen(false)
    }
    const updatePosition = () => updateAgentPickerPosition()
    requestAnimationFrame(updatePosition)
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [agentPickerOpen, updateAgentPickerPosition])

  // Restore session from URL param
  useEffect(() => {
    const sessionKey = searchParams.get('session')
    if (sessionKey && sessionKey !== activeSessionKey) {
      loadSession(sessionKey)
      return
    }
    if (!sessionKey && searchParams.get('new') !== '1') {
      sessionLoadSeqRef.current += 1
      setActiveSessionKey(null)
      activeSessionKeyRef.current = null
      setMessages([])
      setPendingFiles([])
      setChatLoading(false)
      setIsDraftSession(false)
    }
  }, [searchParams])

  useEffect(() => {
    if (searchParams.get('new') !== '1') return
    const agentId = searchParams.get('agent') || ''
    sessionLoadSeqRef.current += 1
    setActiveSessionKey(null)
    activeSessionKeyRef.current = null
    setMessages([])
    setPendingFiles([])
    setError('')
    setChatLoading(false)
    setIsDraftSession(true)
    setDraftAgentId(agentId)
    setAgentPickerOpen(false)
    setTimeout(() => inputRef.current?.focus(), 100)
  }, [searchParams])

  const loadSession = async (key: string) => {
    const loadSeq = sessionLoadSeqRef.current + 1
    sessionLoadSeqRef.current = loadSeq
    setActiveSessionKey(key)
    activeSessionKeyRef.current = key
    setIsDraftSession(false)
    setDraftAgentId(getAgentIdFromKey(key))
    setAgentPickerOpen(false)
    setChatLoading(true)
    setError('')
    setSearchParams({ session: key })
    try {
      const detail = await getSession(key)
      if (sessionLoadSeqRef.current !== loadSeq || activeSessionKeyRef.current !== key) return
      setMessages(detail.messages || [])
    } catch (err: any) {
      if (sessionLoadSeqRef.current !== loadSeq || activeSessionKeyRef.current !== key) return
      setError(err?.message || '加载会话失败')
      setMessages([])
    } finally {
      if (sessionLoadSeqRef.current === loadSeq && activeSessionKeyRef.current === key) {
        setChatLoading(false)
      }
    }
  }

  const createDraftSession = (agentId = '') => {
    sessionLoadSeqRef.current += 1
    setActiveSessionKey(null)
    activeSessionKeyRef.current = null
    setMessages([])
    setPendingFiles([])
    setError('')
    setIsDraftSession(true)
    setDraftAgentId(agentId)
    setSearchParams(agentId ? { new: '1', agent: agentId } : { new: '1' })
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  // File handling
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    addFiles(Array.from(files))
    e.target.value = ''
  }

  const addFiles = (files: File[]) => {
    const newPending: PendingFile[] = files.map(file => {
      const isImg = isImageFile(file)
      const pf: PendingFile = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        name: file.name,
        isImage: isImg,
      }
      if (isImg) {
        pf.previewUrl = URL.createObjectURL(file)
      }
      return pf
    })
    setPendingFiles(prev => [...prev, ...newPending])
  }

  const removePendingFile = (id: string) => {
    setPendingFiles(prev => {
      const removed = prev.find(f => f.id === id)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter(f => f.id !== id)
    })
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      addFiles(imageFiles)
    }
  }

  // SSE connection for real-time chat events (replaces WebSocket)
  const sseRef = useRef<EventSource | null>(null)

  const handleChatEvent = useCallback((payload: any) => {
    const { state, sessionKey: rawSessionKey } = payload
    if (!rawSessionKey) {
      console.log('[SSE] 跳过: sessionKey为空')
      return
    }

    const eventSessionKey = resolveKnownSessionKey(String(rawSessionKey))
    const isVisibleSession = eventSessionKey === activeSessionKeyRef.current
    console.log('[SSE] handleChatEvent:', { state, eventSessionKey, isVisibleSession })

    // Streaming delta — extract text and update incrementally
    if (state === 'delta' && payload.message) {
      const content = payload.message.content
      console.log('[SSE] delta内容:', JSON.stringify(content)?.substring(0, 200))
      if (Array.isArray(content)) {
        const textPart = content.find((c: any) => c.type === 'text')
        if (textPart?.text) {
          setStreamingText(eventSessionKey, textPart.text)
        }
      } else if (typeof content === 'string') {
        setStreamingText(eventSessionKey, content)
      }
      return
    }

    // Started — clear streaming text for new turn
    if (state === 'started') {
      setStreamingText(eventSessionKey, '')
      return
    }

    // Final / error / aborted — load final messages, THEN clear streaming
    if (state === 'final' || state === 'error' || state === 'aborted') {
      // Don't clear streamingText yet — keep it visible until messages load

      if (sseFinalTimersRef.current[eventSessionKey]) {
        clearTimeout(sseFinalTimersRef.current[eventSessionKey])
      }
      sseFinalTimersRef.current[eventSessionKey] = setTimeout(() => {
        // No new "final" events for 3s — agent is truly done
        getSession(eventSessionKey).then(detail => {
          if (activeSessionKeyRef.current === eventSessionKey) {
            setMessages(detail.messages || [])
          }
          clearStreamingText(eventSessionKey)
          setSendingForSession(eventSessionKey, false)
          sseCompletedRef.current[eventSessionKey] = true
          refreshSessions()
        }).catch(() => {
          clearStreamingText(eventSessionKey)
          setSendingForSession(eventSessionKey, false)
          sseCompletedRef.current[eventSessionKey] = true
        })
      }, 3000)
    }
  }, [clearStreamingText, refreshSessions, resolveKnownSessionKey, setSendingForSession, setStreamingText])

  // Connect SSE on mount
  useEffect(() => {
    console.log('[SSE] useEffect 触发')
    const token = getAccessToken()
    if (!token) {
      console.log('[SSE] 没有token，跳过SSE连接')
      return
    }
    // Always use relative URL so SSE goes through Vite proxy, avoiding CORS issues
    const url = `/api/openclaw/events/stream?token=${encodeURIComponent(token)}`
    console.log('[SSE] 正在连接:', url)
    const sse = new EventSource(url)
    sseRef.current = sse

    sse.onopen = () => {
      console.log('[SSE] 连接成功')
    }

    sse.onmessage = (evt) => {
      console.log('[SSE] 收到消息:', evt.data?.substring(0, 100))
      try {
        const msg = JSON.parse(evt.data)
        if (msg.event === 'chat' && msg.payload) {
          handleChatEvent(msg.payload)
        }
      } catch {
        // ignore
      }
    }

    sse.onerror = (e) => {
      console.log('[SSE] 连接错误, readyState:', sse.readyState, e)
    }

    return () => {
      console.log('[SSE] 清理连接')
      Object.values(sseFinalTimersRef.current).forEach(timer => clearTimeout(timer))
      sseFinalTimersRef.current = {}
      Object.values(typewriterTimersRef.current).forEach(timer => clearInterval(timer))
      typewriterTimersRef.current = {}
      sse.close()
      sseRef.current = null
    }
  }, [handleChatEvent])

  const waitForResponse = async (key: string, runId: string | null) => {
    // SSE handles incremental display. Completion should come from runId-based
    // waiting so we don't mistake a partial assistant message for a finished turn.
    sseCompletedRef.current[key] = false
    const maxWaitMs = 240000 // 4 minutes max
    const perRequestTimeoutMs = 25000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      if (sseCompletedRef.current[key]) return
      if (runId) {
        try {
          const remainingMs = maxWaitMs - (Date.now() - startTime)
          const waitResult = await waitForAgentRun(runId, Math.min(perRequestTimeoutMs, remainingMs))

          if (sseCompletedRef.current[key]) return

          if (waitResult.status === 'timeout') {
            continue
          }

          const detail = await getSession(key)
          if (key === activeSessionKeyRef.current) {
            setMessages(detail.messages || [])
          }
          clearStreamingText(key)
          sseCompletedRef.current[key] = true
          return
        } catch {
          await new Promise(r => setTimeout(r, 1500))
          continue
        }
      }

      // Legacy fallback if backend doesn't return a runId.
      await new Promise(r => setTimeout(r, 3000))
      try {
        const detail = await getSession(key)
        const msgs = detail.messages || []
        const lastMsg = msgs[msgs.length - 1]
        if (lastMsg?.role === 'assistant' && !targetTextBySessionRef.current[key]) {
          if (key === activeSessionKeyRef.current) {
            setMessages(msgs)
          }
          clearStreamingText(key)
          sseCompletedRef.current[key] = true
          return
        }
      } catch {
        // ignore and keep waiting
      }
    }

    // Timeout — load final state
    try {
      const detail = await getSession(key)
      if (key === activeSessionKeyRef.current) {
        setMessages(detail.messages || [])
      }
    } catch {}
    clearStreamingText(key)
    sseCompletedRef.current[key] = true
  }

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && pendingFiles.length === 0) || (!activeSessionKey && !isDraftSession)) return

    const sendingSessionKey = activeSessionKey || `agent:${draftAgentId || 'main'}:session-${Date.now()}`
    if (sendingBySession[sendingSessionKey]) return
    if (!activeSessionKey) {
      setActiveSessionKey(sendingSessionKey)
      activeSessionKeyRef.current = sendingSessionKey
      setIsDraftSession(false)
      setAgentPickerOpen(false)
      setSearchParams({ session: sendingSessionKey })
    }
    setSendingForSession(sendingSessionKey, true)
    setError('')

    try {
      const agentId = getAgentIdFromKey(sendingSessionKey)
      const uploadDir = getUploadDir(agentId)

      // Upload all files to agent workspace
      const uploadedPaths: string[] = []
      for (const pf of pendingFiles) {
        const result = await uploadFileToWorkspace(pf.file, uploadDir)
        const uploadedPath = result.path || result.name || pf.name
        uploadedPaths.push(uploadedPath)
      }

      // Build final message with file references
      let finalMessage = text
      if (uploadedPaths.length > 0) {
        const fileRefs = uploadedPaths
          .map(p => `[附件: ~/.openclaw/${p}]`)
          .join('\n')
        finalMessage = finalMessage
          ? `${finalMessage}\n\n${fileRefs}`
          : fileRefs
      }

      // Optimistic UI
      const displayParts: string[] = []
      if (text) displayParts.push(text)
      if (uploadedPaths.length > 0) {
        uploadedPaths.forEach(p => {
          const name = p.split('/').pop() || p
          displayParts.push(`📎 ${name}`)
        })
      }

      const userMsg = {
        role: 'user',
        content: displayParts.join('\n'),
        timestamp: new Date().toISOString(),
      }
      setMessages(prev => [...prev, userMsg])
      setInput('')
      pendingFiles.forEach(pf => {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl)
      })
      setPendingFiles([])

      clearStreamingText(sendingSessionKey)
      const sendResult = await sendChatMessage(sendingSessionKey, finalMessage)
      await waitForResponse(sendingSessionKey, sendResult.runId)
      void refreshSessions()
    } catch (err: any) {
      setError(err?.message || '发送失败')
    } finally {
      setSendingForSession(sendingSessionKey, false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleRefresh = () => {
    if (activeSessionKey) {
      loadSession(activeSessionKey)
    }
  }

  const handleSelectDraftAgent = (agentId: string) => {
    setDraftAgentId(agentId)
    setAgentPickerOpen(false)
    setAgentSearch('')
    setSearchParams({ new: '1', agent: agentId })
  }

  const handleClearDraftAgent = () => {
    setDraftAgentId('')
    setAgentPickerOpen(false)
    setAgentSearch('')
    setSearchParams({ new: '1' })
  }

  const handleAgentCreated = async (agentId: string, displayName: string) => {
    setAgentCreateOpen(false)
    setNotice(`已创建“${displayName}”，可以开始对话了`)
    await loadAgentsCatalog()
    handleSelectDraftAgent(agentId)
    window.setTimeout(() => setNotice(''), 6000)
  }

  const formatTime = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    if (isToday) return time
    return `${d.getMonth() + 1}/${d.getDate()} ${time}`
  }

  const hasContent = input.trim() || pendingFiles.length > 0
  const isCurrentSending = Boolean(activeSessionKey && sendingBySession[activeSessionKey])
  const displayedText = activeSessionKey ? displayedTextBySession[activeSessionKey] || '' : ''
  const isDraftStart = isDraftSession && messages.length === 0 && !activeSessionKey
  const agentOptions = useMemo(() => {
    const hasMain = agents.some(agent => agent.id === 'main')
    const mainAgent: AgentInfo = {
      id: 'main',
      name: '普通对话',
      identity: { name: '普通对话' },
    }
    const visibleAgents = agents.filter(agent => !retiredBuiltInAgentIds.has(agent.id))
    return hasMain ? visibleAgents : [mainAgent, ...visibleAgents]
  }, [agents])
  const currentAgentId = activeSessionKey ? getAgentIdFromKey(activeSessionKey) : draftAgentId
  const selectedAgent = currentAgentId ? agentOptions.find(agent => agent.id === currentAgentId) : null
  const selectedAgentLabel =
    selectedAgent?.identity?.name || selectedAgent?.name || currentAgentId || '选择 Agent'
  const agentQuery = agentSearch.trim().toLowerCase()
  const selectableAgents = agentOptions.filter(agent => agent.id !== 'main')
  const filteredAgents = selectableAgents.filter(agent => {
    if (!agentQuery) return true
    const values = [agent.id, agent.name, agent.identity?.name].filter(Boolean).join(' ').toLowerCase()
    return values.includes(agentQuery)
  })
  const canChangeAgent = isDraftSession && messages.length === 0 && !isCurrentSending

  const pendingFilesPreview = pendingFiles.length > 0 && (
    <div className="flex flex-wrap gap-2">
      {pendingFiles.map(pf => (
        <div
          key={pf.id}
          className="relative group rounded-lg border border-light-border bg-light-card overflow-hidden"
        >
          {pf.isImage && pf.previewUrl ? (
            <div className="relative">
              <img
                src={pf.previewUrl}
                alt={pf.name}
                className="h-16 w-16 object-cover"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5">
                <div className="text-[9px] text-white truncate">{pf.name}</div>
              </div>
            </div>
          ) : (
            <div className="h-16 w-auto flex items-center gap-2 px-3">
              <FileText size={16} className="text-accent-blue shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-light-text truncate max-w-[120px]">{pf.name}</div>
                <div className="text-[10px] text-light-text-secondary">{formatFileSize(pf.file.size)}</div>
              </div>
            </div>
          )}
          <span className="absolute top-0.5 right-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip content={`移除附件 ${pf.name}`}>
              <button
                onClick={() => removePendingFile(pf.id)}
                className="flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/75"
              >
                <X size={10} />
              </button>
            </Tooltip>
          </span>
        </div>
      ))}
    </div>
  )

  const agentPicker = agentPickerOpen && canChangeAgent && (
    <div
      className="z-40 flex flex-col overflow-hidden rounded-2xl border border-light-border bg-white p-3 shadow-xl shadow-slate-200/80"
      style={agentPickerStyle}
    >
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-light-border px-3 py-2 text-sm text-light-text-secondary">
        <Search size={15} />
        <ClearableInput
          value={agentSearch}
          onValueChange={setAgentSearch}
          className="min-w-0 flex-1 bg-transparent text-sm text-light-text outline-none placeholder:text-light-text-secondary"
          placeholder="搜索 Agent"
          autoFocus
          clearLabel="清空 Agent 搜索"
        />
      </div>
      <div className="overflow-y-auto pr-1" style={{ maxHeight: agentPickerListMaxHeight }}>
        {filteredAgents.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-light-text-secondary">没有匹配的 Agent</div>
        ) : filteredAgents.map(agent => {
          const label = agent.identity?.name || agent.name || agent.id
          const description = agentDescriptions[agent.id] || '专属任务助手'
          const selected = Boolean(draftAgentId) && agent.id === draftAgentId
          return (
            <button
              key={agent.id}
              onClick={() => handleSelectDraftAgent(agent.id)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-light-card-hover"
            >
              <Bot size={16} className="text-accent-blue" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-light-text">{label}</div>
                <div className="truncate text-xs text-light-text-secondary">{description}</div>
              </div>
              {selected && <Check size={15} className="text-accent-blue" />}
            </button>
          )
        })}
      </div>
      <div className="mt-2 space-y-1 border-t border-light-border pt-2">
        {draftAgentId && !agentQuery && (
          <button
            onClick={handleClearDraftAgent}
            className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text"
          >
            <X size={16} />
            <span>不指定 Agent</span>
          </button>
        )}
        <button
          onClick={() => {
            setAgentPickerOpen(false)
            setAgentCreateOpen(true)
          }}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text"
        >
          <Plus size={16} />
          <span>创建更匹配的专属 Agent</span>
        </button>
      </div>
    </div>
  )

  const renderAgentSelector = (compact = false) => (
    <div ref={agentPickerRef} className="relative">
      <button
        ref={agentPickerButtonRef}
        onClick={() => {
          if (!canChangeAgent) return
          setAgentPickerOpen(value => !value)
        }}
        disabled={!canChangeAgent}
        className={`flex items-center gap-2 rounded-xl border border-light-border bg-light-card px-3 py-1.5 text-xs transition-colors ${
          canChangeAgent
            ? 'cursor-pointer text-light-text-secondary hover:border-accent-blue/30 hover:text-light-text'
            : 'cursor-not-allowed text-light-text-secondary/60'
        } ${compact && !draftAgentId ? 'text-accent-blue' : ''}`}
        title={canChangeAgent ? '选择 Agent' : '当前对话已锁定 Agent'}
      >
        <Bot size={14} />
        <span className="max-w-[180px] truncate">{selectedAgentLabel}</span>
        <ChevronDown size={13} />
      </button>
      {agentPicker}
    </div>
  )

  const renderComposer = (hero = false) => (
    <div className={hero ? 'relative rounded-[26px] border border-light-border bg-white p-3 shadow-lg shadow-slate-200/80' : 'relative mx-auto max-w-4xl rounded-[26px] border border-light-border bg-white p-3 shadow-lg shadow-slate-200/70'}>
      {pendingFilesPreview && (
        <div className="px-2 pb-2">{pendingFilesPreview}</div>
      )}
      <div className="flex flex-col">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <ClearableTextarea
          ref={inputRef}
          value={input}
          onValueChange={setInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={hero ? '向 OpenClaw 发送消息，或选择一个 Agent 开始' : '要求后续变更'}
          rows={hero ? 3 : 2}
          className="min-h-[72px] w-full resize-none bg-transparent px-2 py-2 text-[15px] text-light-text outline-none placeholder:text-slate-400"
          disabled={isCurrentSending}
          clearLabel="清空消息"
        />
        <div className="mt-2 flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2">
            <IconButton
              label="上传附件（图片/文件）"
              onClick={() => fileInputRef.current?.click()}
              disabled={isCurrentSending}
              size="md"
              tone="primary"
              className="h-9 w-9 rounded-xl"
            >
              <Plus size={18} />
            </IconButton>
            {renderAgentSelector(true)}
          </div>
          <IconButton
            label="发送"
            onClick={handleSend}
            disabled={!hasContent || isCurrentSending}
            className="h-9 w-9 rounded-full bg-slate-800 text-white hover:bg-slate-700 disabled:bg-slate-300"
          >
            {isCurrentSending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </IconButton>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-full">
      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {notice && (
          <div className="pointer-events-none fixed left-1/2 top-4 z-[80] -translate-x-1/2 rounded-xl border border-accent-green/20 bg-light-card px-4 py-2 text-sm text-light-text shadow-xl shadow-slate-200/80">
            {notice}
          </div>
        )}

        {activeSessionKey || isDraftSession ? (
          <>
            {/* Chat header */}
            <div className="px-5 py-3 border-b border-light-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <IconButton
                  label="展开菜单"
                  onClick={openMobileSidebar}
                  size="md"
                  surface="plain"
                  className="-ml-2 lg:hidden"
                >
                  <Menu size={20} />
                </IconButton>
                <Bot size={16} className="text-accent-blue shrink-0" />
                <span className="text-sm font-medium text-light-text truncate">
                  {isDraftStart ? '新对话' : selectedAgentLabel}
                </span>
                {activeSessionKey && (
                  <>
                    <ChevronRight size={12} className="text-light-text-secondary shrink-0" />
                    <span className="text-xs text-light-text-secondary truncate">
                      {activeSessionKey.split(':').pop()}
                    </span>
                  </>
                )}
              </div>
              {activeSessionKey && (
                <IconButton
                  label="刷新"
                  onClick={handleRefresh}
                  size="sm"
                >
                  <RefreshCw size={14} />
                </IconButton>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {chatLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-accent-blue" />
                </div>
              ) : messages.length === 0 && !isDraftSession ? (
                <div className="flex flex-col items-center justify-center py-20 text-light-text-secondary">
                  <MessageSquare size={40} className="mb-3 opacity-30" />
                  <p className="text-sm">发送消息开始对话</p>
                </div>
              ) : isDraftStart ? (
                <div className="flex h-full items-start justify-center px-6 pt-[13vh]">
                  <div className="w-full max-w-4xl">
                    <h1 className="mb-12 text-center text-3xl font-medium tracking-normal text-light-text">
                      我们该做什么？
                    </h1>
                    {renderComposer(true)}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 max-w-3xl mx-auto">
                  {messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}
                    >
                      {msg.role !== 'user' && (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-blue/10 text-accent-blue mt-0.5">
                          <Bot size={14} />
                        </div>
                      )}
                      <div className="flex flex-col items-start max-w-[80%]">
                        <div
                          className={`rounded-xl px-4 py-2.5 w-full ${
                            msg.role === 'user'
                              ? 'bg-accent-blue text-white'
                              : 'bg-light-card border border-light-border text-light-text'
                          }`}
                        >
                          {msg.role === 'user' ? (
                            <div className="text-sm whitespace-pre-wrap break-words">{msg.content}</div>
                          ) : (
                            <MarkdownContent content={msg.content} />
                          )}
                          {msg.timestamp && (
                            <div className={`text-[10px] mt-1 ${
                              msg.role === 'user' ? 'text-white/60' : 'text-light-text-secondary'
                            }`}>
                              {formatTime(msg.timestamp)}
                            </div>
                          )}
                        </div>
                        {msg.role !== 'user' && (
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(msg.content)
                              setCopiedIdx(i)
                              setTimeout(() => setCopiedIdx(null), 2000)
                            }}
                            className="flex items-center gap-1 mt-1 px-2 py-0.5 text-[11px] text-light-text-secondary hover:text-light-text rounded transition-colors"
                          >
                            {copiedIdx === i ? <><Check size={12} /> 已复制</> : <><Copy size={12} /> 复制</>}
                          </button>
                        )}
                      </div>
                      {msg.role === 'user' && (
                        <UserAvatar user={user} size="sm" className="mt-0.5" />
                      )}
                    </div>
                  ))}
                  {isCurrentSending && (
                    <div className="flex gap-3">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-blue/10 text-accent-blue mt-0.5">
                        <Bot size={14} />
                      </div>
                      <div className="rounded-xl px-4 py-2.5 bg-light-card border border-light-border max-w-[80%]">
                        {displayedText ? (
                          <div className="text-light-text">
                            <MarkdownContent content={displayedText} />
                            <span className="inline-block w-1.5 h-4 ml-0.5 bg-accent-blue rounded-sm animate-pulse align-text-bottom" />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-light-text-secondary">
                            <Loader2 size={14} className="animate-spin" />
                            思考中...
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="px-5 py-2">
                <div className="rounded-lg bg-accent-red/10 px-3 py-2 text-xs text-accent-red max-w-3xl mx-auto">
                  {error}
                </div>
              </div>
            )}

            {/* Input */}
            {!isDraftStart && (
              <div className="px-5 py-3 shrink-0">
                {renderComposer()}
              </div>
            )}
          </>
        ) : (
          <div className="relative flex-1 flex flex-col items-center justify-center text-light-text-secondary">
            <IconButton
              label="展开菜单"
              onClick={openMobileSidebar}
              size="md"
              surface="plain"
              className="absolute left-3 top-3 lg:hidden"
            >
              <Menu size={20} />
            </IconButton>
            <MessageSquare size={48} className="mb-4 opacity-20" />
            <p className="text-sm mb-4">选择一个会话或创建新会话</p>
            <button
              onClick={() => createDraftSession()}
              className="flex items-center gap-2 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/90 transition-colors"
            >
              <Plus size={16} />
              新建会话
            </button>
          </div>
        )}
      </div>

      <AgentCreatePanel
        open={agentCreateOpen}
        onClose={() => setAgentCreateOpen(false)}
        onCreated={handleAgentCreated}
      />

    </div>
  )
}
