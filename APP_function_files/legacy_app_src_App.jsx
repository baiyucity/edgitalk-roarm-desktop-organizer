import { useEffect, useMemo, useRef, useState } from 'react'
import heroTitle from './assets/hero-title.png'

const DEFAULT_DEVICE_HOST = 'http://192.168.43.123'
const CONNECTION_TIMEOUT_MS = 4500
const CONNECTION_MISSES_BEFORE_DISCONNECT = 8
const MIN_FRAME_INTERVAL_MS = 2500
const FRAME_TIMEOUT_MS = 8000
const VOICE_COMMAND_INTERVAL_MS = 2500
const BOARD_COMMAND_GRACE_MS = 700
const PLAN_LIST_STORAGE_KEY = 'robotArmPlanList'
const PLAN_SYNC_STORAGE_KEY = 'robotArmPlanPendingSync'
const HISTORY_STORAGE_KEY = 'robotArmTaskHistory'
const MEMORY_STORAGE_KEY = 'robotArmMemoryAreas'
const MEMORY_SYNC_STORAGE_KEY = 'robotArmMemoryPendingSync'

function safeStorageGet(key, fallback = null) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return fallback
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Some Android WebView local asset contexts can block localStorage.
  }
}

function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Storage is optional; the app must still open.
  }
}

const API_PATHS = {
  status: '/status',
  control: {
    start: '/control/start',
    home: '/control/home',
    stop: '/control/stop',
    scan: '/control/scan',
  },
  features: {
    vision: '/feature/vision',
    voice: '/feature/voice',
    memory: '/feature/memory',
    history: '/history',
    plan: '/plan',
  },
  plan: '/plan',
}

const featureModules = [
  {
    key: 'vision',
    title: '视觉',
    text: '识别桌面物品、边界与可抓取目标。',
    status: '待接入',
    action: '启动摄像头',
    icon: '◉',
  },
  {
    key: 'voice',
    title: '语音控制',
    text: '通过自然语音下达整理、暂停、复位指令。',
    status: '待接入',
    action: '开启监听',
    icon: '≋',
  },
  {
    key: 'memory',
    title: '记忆功能',
    text: '记住常用物品位置与用户整理习惯。',
    status: '待接入',
    action: '同步记忆',
    icon: '◆',
  },
  {
    key: 'history',
    title: '历史记录',
    text: '记录每次整理任务、识别结果与执行状态。',
    status: '本地框架',
    action: '读取记录',
    icon: '↗',
  },
  {
    key: 'plan',
    title: '整理计划',
    text: '设置自动整理时间、周期和执行模式。',
    status: '可设定',
    action: '设置计划',
    icon: '◷',
  },
]

const defaultMemoryAreas = [
  { id: 'keyboard', name: '键盘区域', slot: 'A01' },
  { id: 'cup', name: '杯子区域', slot: 'A02' },
  { id: 'tool', name: '工具区域', slot: 'A03' },
  { id: 'misc', name: '杂物区域', slot: 'A04' },
]

const repeatOptions = [
  { value: 'weekdays', label: '工作日' },
  { value: 'weekend', label: '周末' },
]

const planModeOptions = [
  { value: 'auto', label: '自动整理', desc: '按区域直接执行' },
  { value: 'scan', label: '先扫描', desc: '识别后再整理' },
]

const visionControlGroups = [
  {
    title: '背景设置',
    items: [
      { label: '重采样背景', command: 'bg_reset', detail: '重新记录当前桌面背景' },
      { label: '自动背景', command: 'bg_auto', detail: '自动维护背景模型' },
    ],
  },
  {
    title: '画面控制',
    items: [
      { label: '开启摄像头', command: 'start_camera', detail: '启动 UVC 摄像头' },
      { label: '刷新画面', command: 'refresh_frame', detail: '抓取一张实时图片' },
      { label: '显示坐标', command: 'read_vision_result', detail: '读取目标中心点' },
    ],
  },
]

const voicePipeline = [
  { label: '云端服务', value: 'api.tenclass.net /xiaozhi/v1' },
  { label: '传输方式', value: 'WebSocket + Opus' },
  { label: '音频参数', value: '16kHz / 单声道 / 60ms' },
  { label: '消息类型', value: 'stt / tts / iot / mcp' },
]

const voiceCommandMap = [
  { phrase: '开始整理', action: 'control.start', payload: '{"cmd":"start"}' },
  { phrase: '暂停任务', action: 'control.stop', payload: '{"cmd":"stop"}' },
  { phrase: '回到原点', action: 'control.home', payload: '{"cmd":"home"}' },
  { phrase: '扫描桌面', action: 'control.scan', payload: '{"cmd":"scan"}' },
]

const integrationGaps = {
  vision: [
    '固件当前模型常量仍是 320×240 摄像头输入，420×242 需要确认摄像头描述符、预处理缩放和模型输入是否同步修改。',
    'APP 还缺少真实预览帧接口，例如 /camera/frame 或 WebSocket/SSE 推送，否则只能显示识别框架。',
    '背景设置需板端开放 bg_reset、bg_auto、set_dark_threshold 的 HTTP/JSON 映射和返回格式。',
    '抓取前还需要摄像头坐标到机械臂坐标的标定矩阵，以及 M55→M33→RoArm 的最终字段定义。',
  ],
  voice: [
    '小智云端 Token、设备 ID、Client ID 后续不能写死，需要正式配置来源或绑定流程。',
    '板端目前能打印 stt 文本，但还需要把文本或解析后的命令通过 Wi-Fi 接口返回给 APP。',
    '语音命令到机械臂动作的安全规则还未定，例如是否需要二次确认、急停优先级和误识别处理。',
    '如果语音输入布置在云端，需要确认 APP 只显示状态，还是也要参与账号/网络配置。',
  ],
}

const featureDetailConfig = {
  vision: {
    title: '视觉识别',
    subtitle: '摄像头预览、背景重采样、阈值调节和目标坐标输出框架。',
    endpoint: '/feature/vision',
    stats: [
      ['目标分辨率', '420 × 242'],
      ['稳定参考', '424 × 240'],
      ['输出结果', '坐标 / 类别 / 置信度'],
    ],
    actions: ['启动摄像头', '重采样背景', '自动背景'],
  },
  voice: {
    title: '语音控制',
    subtitle: '调用手机麦克风识别语音，并转换成机械臂控制指令。',
    endpoint: '/feature/voice',
    stats: [
      ['接入方式', '手机麦克风'],
      ['监听状态', '手动控制'],
      ['指令来源', '本机识别'],
    ],
    actions: [],
  },
  memory: {
    title: '记忆功能',
    subtitle: '保存桌面物品常用位置和用户整理偏好。',
    endpoint: '/feature/memory',
    stats: [
      ['记忆槽位', '12 组'],
      ['学习方式', '手动确认'],
      ['同步状态', '待主控'],
    ],
    actions: ['同步记忆', '保存当前位置', '清理缓存'],
  },
  history: {
    title: '历史记录',
    subtitle: '查看整理任务、控制指令和主控返回记录。',
    endpoint: '/history',
    stats: [
      ['记录来源', 'APP / 主控'],
      ['保留数量', '最近 5 条'],
      ['同步方式', '按需读取'],
    ],
    actions: ['读取记录', '导出摘要', '清空本地'],
  },
  plan: {
    title: '整理计划',
    subtitle: '设置机械臂自动整理的时间、周期和执行模式。',
    endpoint: '/plan',
    stats: [
      ['计划状态', '可启用'],
      ['默认时间', '20:30'],
      ['发送方式', 'POST /plan'],
    ],
    actions: ['保存计划', '立即试运行', '暂停计划'],
  },
}

const controls = [
  { command: 'start', label: '开始整理', value: '智能模式', tone: 'primary' },
  { command: 'home', label: '回到原点', value: '安全复位' },
  { command: 'stop', label: '暂停任务', value: '立即停止' },
  { command: 'scan', label: '扫描桌面', value: '视觉校准' },
]

const products = [
  {
    name: '机械臂主体',
    desc: '六轴桌面机械臂，适配轻量物品抓取、分类与归位。',
    meta: '核心硬件',
  },
  {
    name: '视觉识别套件',
    desc: '摄像头与识别算法组合，支持桌面区域检测和目标定位。',
    meta: 'AI 感知',
  },
  {
    name: 'WebView 控制面板',
    desc: '面向 Flutter APP 的移动端控制界面，可接入真实设备接口。',
    meta: '移动控制',
  },
]

const navItems = [
  { id: 'home', label: '首页', icon: '⌂' },
  { id: 'features', label: '功能', icon: '✦' },
  { id: 'services', label: '产品', icon: '□' },
]

function normalizeHost(host) {
  return host.trim().replace(/\/$/, '')
}

function buildUrl(host, path) {
  return `${normalizeHost(host)}${path}`
}

function formatTimePart(value) {
  return String(value).padStart(2, '0')
}

async function requestWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS)

  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      ...options,
    })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function readResponseText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function getResponseErrorText(response) {
  const text = await readResponseText(response)

  if (!text) return `HTTP ${response.status}`

  try {
    const data = JSON.parse(text)
    return data.error || data.message || `HTTP ${response.status}`
  } catch {
    return text.slice(0, 40) || `HTTP ${response.status}`
  }
}

async function pingDevice(host) {
  const baseUrl = normalizeHost(host)
  if (!baseUrl) return false

  try {
    const response = await requestWithTimeout(buildUrl(baseUrl, API_PATHS.status), {
      method: 'GET',
    })
    return response.ok
  } catch {
    try {
      await requestWithTimeout(buildUrl(baseUrl, API_PATHS.status), {
        method: 'GET',
        mode: 'no-cors',
      })
      return true
    } catch (error) {
      return false
    }
  }
}

async function sendDeviceCommand(host, path, payload = {}) {
  const body = JSON.stringify({
    ...payload,
    source: 'flutter-webview-app',
    timestamp: new Date().toISOString(),
  })

  try {
    const response = await requestWithTimeout(buildUrl(host, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    return { ok: response.ok, mode: 'json', data }
  } catch {
    await requestWithTimeout(buildUrl(host, path), {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body,
    })
    return { ok: true, mode: 'no-cors' }
  }
}

function buildFeatureActionPayload(featureKey, actionLabel) {
  if (featureKey === 'vision') {
    const matchedItem = visionControlGroups.flatMap((group) => group.items).find((item) => item.label === actionLabel)
    const command = matchedItem?.command

    if (actionLabel === '一键启动视觉') {
      return {
        cmd: 'vision_bootstrap',
        sequence: ['usbh_init', 'lsusb', 'usbh_uvc_start 0 424 240', 'uvc_ai_bg_reset', 'uvc_ai_bg_auto 1'],
      }
    }

    if (actionLabel === '读取结果' || actionLabel === '显示坐标') {
      return { cmd: 'read_vision_result' }
    }

    if (command === 'start_camera') {
      return { cmd: command, fmt: 0, width: 424, height: 240 }
    }

    if (command === 'set_resolution') {
      return { cmd: command, fmt: 0, width: 424, height: 240 }
    }

    if (command === 'refresh_frame') {
      return { cmd: command }
    }

    if (command === 'bg_auto') {
      return { cmd: command, enable: true }
    }

    if (command === 'set_dark_threshold') {
      const thresholdMap = { 低误检: 95, 默认: 115, 高灵敏: 135 }
      return { cmd: command, value: thresholdMap[actionLabel] || 115 }
    }

    return { cmd: command || 'bg_reset' }
  }

  if (featureKey === 'voice') {
    const voiceCommandMapByLabel = {
      开启监听: 'voice_listen_start',
      停止监听: 'voice_listen_stop',
      同步命令词: 'voice_sync_commands',
    }

    return {
      cmd: voiceCommandMapByLabel[actionLabel] || 'voice_action',
      transport: 'xiaozhi_cloud',
      commands: voiceCommandMap.map((item) => ({ phrase: item.phrase, action: item.action })),
    }
  }

  return {}
}

function App() {
  const [activeSection, setActiveSection] = useState('home')
  const [activeFeature, setActiveFeature] = useState(null)
  const [isDevicePanelOpen, setIsDevicePanelOpen] = useState(false)
  const [deviceHost, setDeviceHost] = useState(() => {
    const savedHost = safeStorageGet('robotArmDeviceHost')
    if (!savedHost || savedHost === 'http://192.168.4.1') return DEFAULT_DEVICE_HOST
    return savedHost
  })
  const [draftHost, setDraftHost] = useState(deviceHost)
  const [connectionState, setConnectionState] = useState('checking')
  const [commandState, setCommandState] = useState('待命')
  const [lastMessage, setLastMessage] = useState('通信框架已就绪')
  const [receivedVoiceCommand, setReceivedVoiceCommand] = useState('等待语音输入')
  const [isVoiceListening, setIsVoiceListening] = useState(false)
  const [appVoiceText, setAppVoiceText] = useState('等待 APP 语音')
  const [boardVoiceText, setBoardVoiceText] = useState('等待主板语音')
  const [currentVoiceSource, setCurrentVoiceSource] = useState('--')
  const [currentVoiceCommand, setCurrentVoiceCommand] = useState('--')
  const [lastVoiceExecuteTime, setLastVoiceExecuteTime] = useState('--')
  const [voiceStatusMessage, setVoiceStatusMessage] = useState('未监听')
  const [voiceDiag, setVoiceDiag] = useState(() => ({
    microphone: '--',
    speechInitialize: false,
    speechAvailable: false,
    localeId: '--',
    localesCount: 0,
    hasChineseLocale: false,
    lastStatus: '--',
    lastError: '--',
    lastErrorPermanent: false,
    listening: false,
    lastText: '--',
    environment: typeof window !== 'undefined' && window.FlutterVoice?.postMessage ? 'Flutter APP' : '非 Flutter APP 环境',
  }))
  const [visionCoordinate, setVisionCoordinate] = useState({
    status: '等待读取',
    cx: '--',
    cy: '--',
    target: '未识别',
  })
  const [visionPreviewActive, setVisionPreviewActive] = useState(false)
  const [visionFrameSrc, setVisionFrameSrc] = useState('')
  const [visionFullFrameSrc, setVisionFullFrameSrc] = useState('')
  const [visionFrameLoading, setVisionFrameLoading] = useState(false)
  const [isFetchingFrame, setIsFetchingFrame] = useState(false)
  const [visionFullFrameLoading, setVisionFullFrameLoading] = useState(false)
  const [isVisionFrameFullscreen, setIsVisionFrameFullscreen] = useState(false)
  const missedConnectionChecks = useRef(0)
  const lastFrameFetchRef = useRef(0)
  const frameAbortRef = useRef(null)
  const visionFrameObjectUrl = useRef('')
  const visionFullFrameObjectUrl = useRef('')
  const lastVoiceCommandAtRef = useRef(0)
  const lastVoiceCommandSourceRef = useRef(null)
  const lastVoiceCommandKeyRef = useRef(null)
  const pendingBoardCommandRef = useRef(null)
  const pendingBoardTimerRef = useRef(null)
  const lastBoardVoiceSeqRef = useRef(null)
  const [activeTimePart, setActiveTimePart] = useState(null)
  const [timeInputDraft, setTimeInputDraft] = useState({ part: null, text: '' })
  const [activePlanTable, setActivePlanTable] = useState('weekdays')
  const [taskHistory, setTaskHistory] = useState(() => {
    const savedHistory = safeStorageGet(HISTORY_STORAGE_KEY)

    if (savedHistory) {
      try {
        return JSON.parse(savedHistory)
      } catch {
        safeStorageRemove(HISTORY_STORAGE_KEY)
      }
    }

    return []
  })
  const [pendingPlanSync, setPendingPlanSync] = useState(() => {
    return safeStorageGet(PLAN_SYNC_STORAGE_KEY) === 'true'
  })
  const [pendingMemorySync, setPendingMemorySync] = useState(() => {
    return safeStorageGet(MEMORY_SYNC_STORAGE_KEY) === 'true'
  })
  const [memoryAreas, setMemoryAreas] = useState(() => {
    const savedMemoryAreas = safeStorageGet(MEMORY_STORAGE_KEY)

    if (savedMemoryAreas) {
      try {
        const parsed = JSON.parse(savedMemoryAreas)
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultMemoryAreas
      } catch {
        safeStorageRemove(MEMORY_STORAGE_KEY)
      }
    }

    return defaultMemoryAreas
  })
  const [memoryDraft, setMemoryDraft] = useState({ name: '', slot: '' })
  const [planConfig, setPlanConfig] = useState({
    enabled: true,
    time: '20:30',
    repeat: 'weekdays',
    mode: 'auto',
    areas: ['keyboard', 'misc'],
  })
  const [planList, setPlanList] = useState(() => {
    const savedPlans = safeStorageGet(PLAN_LIST_STORAGE_KEY)

    if (savedPlans) {
      try {
        return JSON.parse(savedPlans)
      } catch {
        safeStorageRemove(PLAN_LIST_STORAGE_KEY)
      }
    }

    return [
      {
        id: 1,
        time: '08:30',
        repeat: '工作日',
        mode: '先扫描',
        areas: ['键盘区域', '杯子区域'],
        enabled: true,
      },
      { id: 2, time: '20:30', repeat: '周末', mode: '自动整理', areas: ['杂物区域'], enabled: true },
    ]
  })

  const isConnected = connectionState === 'connected'
  const weekdayPlans = planList.filter((plan) => plan.repeat === '工作日')
  const weekendPlans = planList.filter((plan) => plan.repeat === '周末')
  const visiblePlans = activePlanTable === 'weekdays' ? weekdayPlans : weekendPlans
  const connectionText = useMemo(() => {
    if (connectionState === 'checking') return '正在检测'
    return isConnected ? '设备已连接' : '设备未连接'
  }, [connectionState, isConnected])

  const addHistory = (title, detail) => {
    setTaskHistory((items) => [
      {
        title,
        detail,
        time: new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
      ...items.slice(0, 4),
    ])
  }

  const checkConnection = async (host = deviceHost) => {
    const normalizedHost = normalizeHost(host)
    if (!normalizedHost) {
      setConnectionState('disconnected')
      return
    }

    if (connectionState !== 'connected') {
      setConnectionState('checking')
    }
    const connected = await pingDevice(normalizedHost)
    if (connected) {
      missedConnectionChecks.current = 0
      setConnectionState('connected')
      setLastMessage('主控状态接口已响应')
      return
    }

    missedConnectionChecks.current += 1
    if (visionPreviewActive && missedConnectionChecks.current < CONNECTION_MISSES_BEFORE_DISCONNECT) {
      setConnectionState('connected')
      setLastMessage('摄像头预览中，主控忙碌响应较慢')
      return
    }

    setConnectionState('disconnected')
    setLastMessage('主板离线 / 等待连接')
  }

  const fetchVisionFrame = async () => {
    const now = Date.now()

    if (!isConnected) return

    if (isFetchingFrame) {
      setVisionCoordinate((current) => ({
        ...current,
        status: '正在获取图片，请不要连续刷新',
      }))
      setLastMessage('正在获取图片，请不要连续刷新')
      return
    }

    if (now - lastFrameFetchRef.current < MIN_FRAME_INTERVAL_MS) {
      setVisionCoordinate((current) => ({
        ...current,
        status: '刷新太频繁，请稍后再试',
      }))
      setLastMessage('刷新太频繁，请稍后再试')
      return
    }

    lastFrameFetchRef.current = now
    setIsFetchingFrame(true)
    setVisionFrameLoading(true)
    setVisionCoordinate((current) => ({
      ...current,
      status: '正在刷新画面...',
    }))
    setLastMessage('正在刷新画面...')

    if (frameAbortRef.current) {
      frameAbortRef.current.abort()
    }

    const controller = new AbortController()
    frameAbortRef.current = controller
    const timeoutId = window.setTimeout(() => {
      controller.abort()
    }, FRAME_TIMEOUT_MS)

    try {
      const frameUrl = `${normalizeHost(deviceHost)}/camera/frame?t=${Date.now()}`
      console.log('fetch camera frame:', frameUrl)

      const response = await fetch(frameUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      })
      const contentType = response.headers.get('Content-Type') || ''

      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }

      if (!contentType.includes('image/')) {
        const text = await response.text()
        throw new Error(text || 'camera frame not ready')
      }

      const blob = await response.blob()
      const objectUrl = window.URL.createObjectURL(blob)

      if (visionFrameObjectUrl.current) {
        window.URL.revokeObjectURL(visionFrameObjectUrl.current)
      }

      visionFrameObjectUrl.current = objectUrl
      setVisionFrameSrc(objectUrl)
      setVisionCoordinate((current) => ({
        ...current,
        status: '画面已刷新',
      }))
      setLastMessage('画面已刷新')
    } catch (error) {
      const message = error?.name === 'AbortError' ? '刷新超时，主控可能忙碌' : error?.message || '刷新失败'
      setVisionCoordinate((current) => ({
        ...current,
        status: message,
      }))
      setLastMessage(message)
    } finally {
      window.clearTimeout(timeoutId)
      if (frameAbortRef.current === controller) {
        frameAbortRef.current = null
      }
      setIsFetchingFrame(false)
      setVisionFrameLoading(false)
    }
  }

  const openVisionFullscreen = async () => {
    if (!visionFrameSrc) return

    setIsVisionFrameFullscreen(true)
    if (!isConnected) return

    setVisionFullFrameLoading(true)
    try {
      const response = await requestWithTimeout(`${normalizeHost(deviceHost)}/camera/frame?full=1&t=${Date.now()}`, {
        method: 'GET',
      })
      const contentType = response.headers.get('Content-Type') || ''

      if (!response.ok || !contentType.includes('image/')) {
        throw new Error('full frame not ready')
      }

      const blob = await response.blob()
      const objectUrl = window.URL.createObjectURL(blob)

      if (visionFullFrameObjectUrl.current) {
        window.URL.revokeObjectURL(visionFullFrameObjectUrl.current)
      }

      visionFullFrameObjectUrl.current = objectUrl
      setVisionFullFrameSrc(objectUrl)
    } catch {
      setVisionFullFrameSrc('')
    } finally {
      setVisionFullFrameLoading(false)
    }
  }

  useEffect(() => {
    checkConnection(deviceHost)
    const intervalId = window.setInterval(() => {
      checkConnection(deviceHost)
    }, 8000)

    return () => window.clearInterval(intervalId)
  }, [connectionState, deviceHost, visionPreviewActive])

  useEffect(() => {
    safeStorageSet(PLAN_LIST_STORAGE_KEY, JSON.stringify(planList))
  }, [planList])

  useEffect(() => {
    safeStorageSet(PLAN_SYNC_STORAGE_KEY, String(pendingPlanSync))
  }, [pendingPlanSync])

  useEffect(() => {
    safeStorageSet(HISTORY_STORAGE_KEY, JSON.stringify(taskHistory))
  }, [taskHistory])

  useEffect(() => {
    safeStorageSet(MEMORY_STORAGE_KEY, JSON.stringify(memoryAreas))
  }, [memoryAreas])

  useEffect(() => {
    safeStorageSet(MEMORY_SYNC_STORAGE_KEY, String(pendingMemorySync))
  }, [pendingMemorySync])

  useEffect(() => {
    if (!isConnected || !pendingPlanSync) return undefined

    let isCancelled = false

    const syncPlans = async () => {
      setLastMessage('正在同步规划表到主控')

      try {
        await sendDeviceCommand(deviceHost, API_PATHS.plan, {
          plans: planList,
        })

        if (!isCancelled) {
          setPendingPlanSync(false)
          setLastMessage('规划表已同步到主控')
          addHistory('规划表同步', `POST ${API_PATHS.plan}`)
        }
      } catch {
        if (!isCancelled) {
          setLastMessage('规划表等待下次连接后同步')
        }
      }
    }

    syncPlans()

    return () => {
      isCancelled = true
    }
  }, [deviceHost, isConnected, pendingPlanSync, planList])

  useEffect(() => {
    if (!isConnected || !pendingMemorySync) return undefined

    let isCancelled = false

    const syncMemory = async () => {
      setLastMessage('正在同步记忆区域到主控')

      try {
        await sendDeviceCommand(deviceHost, API_PATHS.features.memory, {
          cmd: 'memory_sync',
          areas: memoryAreas,
        })

        if (!isCancelled) {
          setPendingMemorySync(false)
          setLastMessage('记忆区域已同步到主控')
          addHistory('记忆同步', `POST ${API_PATHS.features.memory}`)
        }
      } catch {
        if (!isCancelled) {
          setLastMessage('记忆区域等待下次连接后同步')
        }
      }
    }

    syncMemory()

    return () => {
      isCancelled = true
    }
  }, [deviceHost, isConnected, memoryAreas, pendingMemorySync])

  useEffect(() => {
    if (activeFeature !== 'vision') {
      setVisionPreviewActive(false)
      setIsVisionFrameFullscreen(false)
    }
  }, [activeFeature])

  useEffect(() => {
    return () => {
      if (visionFrameObjectUrl.current) {
        window.URL.revokeObjectURL(visionFrameObjectUrl.current)
      }
      if (visionFullFrameObjectUrl.current) {
        window.URL.revokeObjectURL(visionFullFrameObjectUrl.current)
      }
      if (frameAbortRef.current) {
        frameAbortRef.current.abort()
      }
    }
  }, [])

  const openSection = (sectionId) => {
    setActiveSection(sectionId)
    setActiveFeature(null)
    window.scrollTo(0, 0)
  }

  const openFeatureDetail = (feature) => {
    setActiveFeature(feature.key)
    window.scrollTo(0, 0)
  }

  const getSelectedAreaNames = (areas = planConfig.areas) => {
    return areas
      .map((areaId) => memoryAreas.find((area) => area.id === areaId)?.name)
      .filter(Boolean)
  }

  const togglePlanArea = (areaId) => {
    setPlanConfig((config) => {
      const nextAreas = config.areas.includes(areaId)
        ? config.areas.filter((item) => item !== areaId)
        : [...config.areas, areaId]

      return {
        ...config,
        areas: nextAreas.length > 0 ? nextAreas : config.areas,
      }
    })
  }

  const updatePlanTimeInput = (part, value) => {
    const numericValue = value.replace(/\D/g, '').slice(0, 2)
    const [hourText, minuteText] = planConfig.time.split(':')
    setTimeInputDraft({ part, text: numericValue })

    if (numericValue === '') {
      setPlanConfig({
        ...planConfig,
        time: `${part === 'hour' ? '00' : hourText}:${part === 'minute' ? '00' : minuteText}`,
      })
      return
    }

    const max = part === 'hour' ? 23 : 59
    const safeValue = Math.min(Number(numericValue), max)
    const nextHour = part === 'hour' ? formatTimePart(safeValue) : hourText
    const nextMinute = part === 'minute' ? formatTimePart(safeValue) : minuteText

    setPlanConfig({
      ...planConfig,
      time: `${nextHour}:${nextMinute}`,
    })
  }

  const handleTimeKeyDown = (part, event) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur()
      setActiveTimePart(null)
      setTimeInputDraft({ part: null, text: '' })
    }
  }

  const createPlanItem = () => ({
    id: Date.now(),
    time: planConfig.time,
    repeat: planConfig.repeat === 'weekdays' ? '工作日' : '周末',
    mode: planConfig.mode === 'auto' ? '自动整理' : '先扫描',
    areas: getSelectedAreaNames(),
    enabled: planConfig.enabled,
  })

  const appendPlanItem = () => {
    setPlanList((items) => [...items, createPlanItem()].sort((first, second) => first.time.localeCompare(second.time)))
  }

  const savePlanLocally = () => {
    appendPlanItem()
    setPendingPlanSync(true)
    addHistory('整理计划', `${planConfig.time} / ${planConfig.repeat}`)
    setLastMessage(isConnected ? '计划已保存，正在准备同步' : '未连接，计划已保存到本地')
  }

  const markMemoryChanged = (message) => {
    setPendingMemorySync(true)
    setLastMessage(isConnected ? `${message}，正在准备同步` : `${message}，已保存到本地`)
  }

  const addMemoryArea = (event) => {
    event.preventDefault()
    const name = memoryDraft.name.trim()
    const slot = memoryDraft.slot.trim().toUpperCase()

    if (!name || !slot) {
      setLastMessage('请填写记忆区域名称和槽位')
      return
    }

    setMemoryAreas((areas) => [
      ...areas,
      {
        id: `area-${Date.now()}`,
        name,
        slot,
      },
    ])
    setMemoryDraft({ name: '', slot: '' })
    addHistory('新增记忆区域', `${name} / ${slot}`)
    markMemoryChanged('记忆区域已新增')
  }

  const updateMemoryArea = (id, field, value) => {
    setMemoryAreas((areas) =>
      areas.map((area) => (area.id === id ? { ...area, [field]: field === 'slot' ? value.toUpperCase() : value } : area)),
    )
    setPendingMemorySync(true)
  }

  const deleteMemoryArea = (id) => {
    const area = memoryAreas.find((item) => item.id === id)

    if (memoryAreas.length <= 1) {
      setLastMessage('至少保留一个整理区域')
      return
    }

    setMemoryAreas((areas) => areas.filter((item) => item.id !== id))
    setPlanConfig((config) => ({
      ...config,
      areas: config.areas.filter((areaId) => areaId !== id),
    }))
    addHistory('删除记忆区域', area ? `${area.name} / ${area.slot}` : id)
    markMemoryChanged('记忆区域已删除')
  }

  const saveMemoryAreas = () => {
    setMemoryAreas((areas) =>
      areas.map((area, index) => ({
        ...area,
        name: area.name.trim() || `区域 ${index + 1}`,
        slot: area.slot.trim().toUpperCase() || `A${String(index + 1).padStart(2, '0')}`,
      })),
    )
    addHistory('保存记忆区域', `${memoryAreas.length} 个区域`)
    markMemoryChanged('记忆区域已保存')
  }

  const saveDeviceHost = (event) => {
    event.preventDefault()
    const normalizedHost = normalizeHost(draftHost)
    if (!normalizedHost) return

    safeStorageSet('robotArmDeviceHost', normalizedHost)
    setDeviceHost(normalizedHost)
    checkConnection(normalizedHost)
  }

  const runControlCommand = async (control) => {
    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return
    }

    setCommandState('发送中')
    setLastMessage(`正在发送：${control.label}`)

    try {
      await sendDeviceCommand(deviceHost, API_PATHS.control[control.command], {
        command: control.command,
      })
      setCommandState(control.value)
      setLastMessage(`${control.label} 指令已发送`)
      addHistory(control.label, `POST ${API_PATHS.control[control.command]}`)
    } catch {
      setCommandState('待命')
      setLastMessage('主控接口未响应，框架已保留调用入口')
    }
  }

  const runFeatureCommand = async (feature) => {
    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return
    }

    setLastMessage(`正在请求：${feature.title}`)

    try {
      const commandPayload = buildFeatureActionPayload(feature.key, feature.action)
      await sendDeviceCommand(deviceHost, API_PATHS.features[feature.key], {
        feature: feature.key,
        action: feature.action,
        ...commandPayload,
      })
      setLastMessage(`${feature.title} 功能请求已发送`)
      addHistory(feature.title, `POST ${API_PATHS.features[feature.key]}`)
    } catch {
      setLastMessage(`${feature.title} 接口等待主控实现`)
    }
  }

  const runFeatureDetailAction = async (featureKey, actionLabel) => {
    const path = API_PATHS.features[featureKey] || API_PATHS.plan

    if (featureKey === 'voice') {
      setReceivedVoiceCommand(actionLabel === '开启监听' ? '正在监听...' : '已停止监听')
    }

    if (featureKey === 'history' && actionLabel === '清空本地') {
      setTaskHistory([])
      setLastMessage('本地历史记录已清空')
      return
    }

    if (featureKey === 'plan' && actionLabel === '保存计划') {
      savePlanLocally()
      return
    }

    if (featureKey === 'memory') {
      if (actionLabel === '同步记忆') {
        saveMemoryAreas()
        if (!isConnected) return
      }

      if (actionLabel === '保存当前位置') {
        addHistory('保存当前位置', `${memoryAreas.length} 个记忆区域`)
        markMemoryChanged('当前位置已记录到记忆区域')
        if (!isConnected) return
      }

      if (actionLabel === '清理缓存') {
        setMemoryAreas(defaultMemoryAreas)
        setPlanConfig((config) => ({
          ...config,
          areas: config.areas.filter((areaId) => defaultMemoryAreas.some((area) => area.id === areaId)),
        }))
        addHistory('重置记忆区域', '恢复默认区域')
        markMemoryChanged('记忆区域已恢复默认')
        return
      }
    }

    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return
    }

    if (featureKey === 'vision' && actionLabel === '刷新画面') {
      await fetchVisionFrame()
      addHistory(actionLabel, 'GET /camera/frame')
      return
    }

    if (featureKey === 'vision' && actionLabel === '开启摄像头') {
      setVisionPreviewActive(true)
      if (visionFrameObjectUrl.current) {
        window.URL.revokeObjectURL(visionFrameObjectUrl.current)
        visionFrameObjectUrl.current = ''
      }
      if (visionFullFrameObjectUrl.current) {
        window.URL.revokeObjectURL(visionFullFrameObjectUrl.current)
        visionFullFrameObjectUrl.current = ''
      }
      setVisionFrameSrc('')
      setVisionFullFrameSrc('')
      setVisionCoordinate((current) => ({
        ...current,
        status: '正在开启摄像头',
      }))
    }

    try {
      const commandPayload = buildFeatureActionPayload(featureKey, actionLabel)
      const result = await sendDeviceCommand(deviceHost, path, {
        feature: featureKey,
        action: actionLabel,
        ...commandPayload,
      })
      if (featureKey === 'vision' && actionLabel === '显示坐标') {
        const data = result.data || {}
        const hasCoordinate = data.valid && data.cx !== undefined && data.cx !== null && data.cy !== undefined && data.cy !== null
        setVisionCoordinate({
          status: hasCoordinate ? '已读取' : '未识别到目标',
          cx: hasCoordinate ? data.cx : '--',
          cy: hasCoordinate ? data.cy : '--',
          target: hasCoordinate ? data.class || data.type || '目标' : '请调整画面',
        })
      }
      if (featureKey === 'vision' && actionLabel === '开启摄像头') {
        setVisionCoordinate((current) => ({
          ...current,
          status: '摄像头已开启，点击刷新取图',
        }))
      }
      setLastMessage(`${actionLabel} 请求已发送`)
      addHistory(actionLabel, `POST ${path}`)
    } catch {
      setLastMessage(`${actionLabel} 等待主控接口实现`)
    }
  }

  const savePlan = async (event) => {
    event.preventDefault()
    savePlanLocally()
  }

  const mapVoiceCommand = (text) => {
    const normalizedText = text.replace(/\s/g, '')

    if (!normalizedText) return null

    if (
      normalizedText.includes('打开摄像头') ||
      normalizedText.includes('开启摄像头') ||
      normalizedText.includes('启动摄像头') ||
      normalizedText.includes('启动视觉')
    ) {
      return { key: 'camera_start', label: '打开摄像头', type: 'feature', featureKey: 'vision', actionLabel: '开启摄像头' }
    }

    if (normalizedText.includes('刷新画面') || normalizedText.includes('刷新图片') || normalizedText.includes('拍一张') || normalizedText.includes('获取图片')) {
      return { key: 'camera_refresh', label: '刷新画面', type: 'frame' }
    }

    if (normalizedText.includes('读取坐标') || normalizedText.includes('显示坐标') || normalizedText.includes('目标在哪里') || normalizedText.includes('坐标')) {
      return { key: 'read_coords', label: '读取坐标', type: 'feature', featureKey: 'vision', actionLabel: '显示坐标' }
    }

    if (normalizedText.includes('开始整理') || normalizedText.includes('开始工作') || normalizedText.includes('整理桌面')) {
      return { key: 'start', label: '开始整理', type: 'control', control: { command: 'start', label: '开始整理', value: '智能模式' } }
    }

    if (normalizedText.includes('停止整理') || normalizedText.includes('停止') || normalizedText.includes('暂停') || normalizedText.includes('别动')) {
      return { key: 'stop', label: '停止整理', type: 'control', control: { command: 'stop', label: '停止整理', value: '立即停止' } }
    }

    if (normalizedText.includes('回到原点') || normalizedText.includes('回原点') || normalizedText.includes('复位') || normalizedText.includes('归位') || normalizedText.includes('回家')) {
      return { key: 'home', label: '回到原点', type: 'control', control: { command: 'home', label: '回到原点', value: '安全复位' } }
    }

    if (normalizedText.includes('扫描桌面') || normalizedText.includes('看看桌面') || normalizedText.includes('扫描')) {
      return { key: 'scan', label: '扫描桌面', type: 'control', control: { command: 'scan', label: '扫描桌面', value: '视觉校准' } }
    }

    return null
  }

  const clearPendingBoardCommand = () => {
    if (pendingBoardTimerRef.current) {
      window.clearTimeout(pendingBoardTimerRef.current)
      pendingBoardTimerRef.current = null
    }
    pendingBoardCommandRef.current = null
  }

  const executeVoiceCommand = async (command, source) => {
    const now = Date.now()

    if (now - lastVoiceCommandAtRef.current < VOICE_COMMAND_INTERVAL_MS) {
      setVoiceStatusMessage('语音命令太频繁，已忽略')
      setLastMessage('语音命令太频繁，已忽略')
      return
    }

    lastVoiceCommandAtRef.current = now
    lastVoiceCommandSourceRef.current = source
    lastVoiceCommandKeyRef.current = command.key
    setCurrentVoiceSource(source === 'app' ? 'APP' : '主板')
    setCurrentVoiceCommand(command.key)
    setLastVoiceExecuteTime(new Date(now).toLocaleTimeString())
    setVoiceStatusMessage(`${source === 'app' ? 'APP' : '主板'} 执行：${command.label}`)

    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return
    }

    try {
      if (command.type === 'control') {
        await sendDeviceCommand(deviceHost, API_PATHS.control[command.control.command], {
          command: command.control.command,
          source,
        })
        setCommandState(command.control.value)
        addHistory(command.label, `VOICE ${source} -> POST ${API_PATHS.control[command.control.command]}`)
      } else if (command.type === 'feature') {
        await runFeatureDetailAction(command.featureKey, command.actionLabel)
      } else if (command.type === 'frame') {
        await fetchVisionFrame()
        addHistory(command.label, `VOICE ${source} -> GET /camera/frame`)
      }
      setLastMessage(`${source === 'app' ? 'APP' : '主板'} 语音指令已执行：${command.label}`)
    } catch {
      setLastMessage(`${command.label} 执行失败，主控暂未响应`)
    }
  }

  const handleVoiceText = (text, source) => {
    const command = mapVoiceCommand(text)

    if (source === 'app') {
      setAppVoiceText(text)
      setReceivedVoiceCommand(text)
    } else {
      setBoardVoiceText(text)
    }

    if (!command) {
      setVoiceStatusMessage('未识别到可执行命令')
      setLastMessage(`未匹配语音指令：${text}`)
      return
    }

    if (source === 'app') {
      const pending = pendingBoardCommandRef.current
      if (pending) {
        clearPendingBoardCommand()
        setVoiceStatusMessage('APP 语音识别优先，已取消主板等待命令')
      }
      executeVoiceCommand(command, 'app')
      return
    }

    clearPendingBoardCommand()
    pendingBoardCommandRef.current = { command, text }
    setVoiceStatusMessage('主板语音结果等待 APP 优先窗口')
    pendingBoardTimerRef.current = window.setTimeout(() => {
      const pending = pendingBoardCommandRef.current
      pendingBoardCommandRef.current = null
      pendingBoardTimerRef.current = null
      if (pending) executeVoiceCommand(pending.command, 'board')
    }, BOARD_COMMAND_GRACE_MS)
  }

  const requestNativeVoice = async (type) => {
    const hasFlutterVoice = Boolean(window.FlutterVoice?.postMessage)

    if (type === 'diag') {
      setVoiceStatusMessage(hasFlutterVoice ? '正在诊断语音模块...' : '当前不是 Flutter APP 环境，无法调用手机麦克风')
      setVoiceDiag((previous) => ({
        ...previous,
        environment: hasFlutterVoice ? 'Flutter APP' : '非 Flutter APP 环境',
        lastStatus: hasFlutterVoice ? previous.lastStatus : 'not_flutter_app',
        lastError: hasFlutterVoice ? previous.lastError : '当前不是 Flutter APP 环境，无法调用手机麦克风',
      }))

      if (hasFlutterVoice) {
        window.FlutterVoice.postMessage('voice_diag')
      }
      return
    }

    const isStart = type === 'start'
    const nativeCommand = isStart ? 'start_listening' : 'stop_listening'

    setIsVoiceListening(isStart)
    setReceivedVoiceCommand(isStart ? '正在监听...' : '已停止监听')
    setVoiceStatusMessage(isStart ? '监听中' : '未监听')

    if (hasFlutterVoice) {
      window.FlutterVoice.postMessage(nativeCommand)
    } else {
      const message = '当前不是 Flutter APP 环境，无法调用手机麦克风'
      setLastMessage(message)
      setVoiceStatusMessage(message)
      setVoiceDiag((previous) => ({
        ...previous,
        environment: '非 Flutter APP 环境',
        lastStatus: 'not_flutter_app',
        lastError: message,
      }))
    }

    if (!isConnected) return

    try {
      await sendDeviceCommand(deviceHost, API_PATHS.features.voice, {
        cmd: nativeCommand,
        source: 'app',
      })
      setLastMessage(isStart ? 'APP 与主板已进入监听状态' : 'APP 与主板已停止监听')
    } catch {
      setLastMessage(isStart ? 'APP 已监听，主板语音接口暂未响应' : 'APP 已停止，主板语音接口暂未响应')
    }

    if (!isStart) {
      clearPendingBoardCommand()
    }
  }

  useEffect(() => {
    const handleNativeVoiceResult = (event) => {
      const detail = event.detail || {}

      if (detail.type === 'status') {
        setReceivedVoiceCommand(detail.message || '等待语音输入')
        setVoiceStatusMessage(detail.message || '手机语音状态已更新')
        setLastMessage(detail.message || '手机语音状态已更新')
        setVoiceDiag((previous) => ({
          ...previous,
          localeId: detail.localeId || previous.localeId,
          lastStatus: detail.lastStatus || detail.message || previous.lastStatus,
          lastError: detail.lastError || previous.lastError,
          listening: Boolean(detail.listening),
          environment: 'Flutter APP',
        }))
        return
      }

      if (detail.type === 'error') {
        const message = detail.error || detail.message || '手机语音识别错误'
        setReceivedVoiceCommand(message)
        setVoiceStatusMessage(message)
        setLastMessage(message)
        setIsVoiceListening(Boolean(detail.listening))
        setVoiceDiag((previous) => ({
          ...previous,
          localeId: detail.localeId || previous.localeId,
          lastStatus: detail.lastStatus || previous.lastStatus,
          lastError: message,
          lastErrorPermanent: Boolean(detail.permanent),
          listening: Boolean(detail.listening),
          environment: 'Flutter APP',
        }))
        return
      }

      if (detail.type === 'result' && detail.text) {
        setAppVoiceText(detail.text)
        setReceivedVoiceCommand(detail.text)
        setLastMessage(detail.isFinal ? `APP 识别完成：${detail.text}` : `APP 正在识别：${detail.text}`)
        setVoiceStatusMessage(detail.isFinal ? '识别完成' : '正在识别')
        setIsVoiceListening(Boolean(detail.listening))
        setVoiceDiag((previous) => ({
          ...previous,
          localeId: detail.localeId || previous.localeId,
          lastStatus: detail.lastStatus || previous.lastStatus,
          lastError: detail.lastError || previous.lastError,
          listening: Boolean(detail.listening),
          lastText: detail.text,
          environment: 'Flutter APP',
        }))

        if (detail.isFinal) {
          handleVoiceText(detail.text, 'app')
        }
      }
    }

    const handleNativeVoiceStatus = (event) => {
      const detail = event.detail || {}
      const message = detail.message || detail.lastStatus || '手机语音状态已更新'
      setVoiceStatusMessage(message)
      setReceivedVoiceCommand(message)
      setIsVoiceListening(Boolean(detail.listening))
      setVoiceDiag((previous) => ({
        ...previous,
        localeId: detail.localeId || previous.localeId,
        lastStatus: detail.lastStatus || message,
        lastError: detail.lastError || previous.lastError,
        listening: Boolean(detail.listening),
        environment: 'Flutter APP',
      }))
    }

    const handleNativeVoiceError = (event) => {
      const detail = event.detail || {}
      const message = detail.error || detail.message || '手机语音识别错误'
      setVoiceStatusMessage(message)
      setReceivedVoiceCommand(message)
      setLastMessage(message)
      setIsVoiceListening(Boolean(detail.listening))
      setVoiceDiag((previous) => ({
        ...previous,
        localeId: detail.localeId || previous.localeId,
        lastStatus: detail.lastStatus || previous.lastStatus,
        lastError: message,
        lastErrorPermanent: Boolean(detail.permanent),
        listening: Boolean(detail.listening),
        environment: 'Flutter APP',
      }))
    }

    const handleNativeVoiceDiag = (event) => {
      const detail = event.detail || {}
      setVoiceDiag((previous) => ({
        ...previous,
        ...detail,
        localeId: detail.localeId || '--',
        lastStatus: detail.lastStatus || '--',
        lastError: detail.lastError || '--',
        environment: 'Flutter APP',
      }))
      setVoiceStatusMessage(detail.speechAvailable ? '语音诊断完成：SpeechRecognizer 可用' : '语音诊断完成：SpeechRecognizer 不可用')
      setIsVoiceListening(Boolean(detail.listening))
    }

    window.addEventListener('flutter-voice-result', handleNativeVoiceResult)
    window.addEventListener('flutterVoiceResult', handleNativeVoiceResult)
    window.addEventListener('flutter-voice-status', handleNativeVoiceStatus)
    window.addEventListener('flutter-voice-error', handleNativeVoiceError)
    window.addEventListener('flutter-voice-diag', handleNativeVoiceDiag)
    return () => {
      window.removeEventListener('flutter-voice-result', handleNativeVoiceResult)
      window.removeEventListener('flutterVoiceResult', handleNativeVoiceResult)
      window.removeEventListener('flutter-voice-status', handleNativeVoiceStatus)
      window.removeEventListener('flutter-voice-error', handleNativeVoiceError)
      window.removeEventListener('flutter-voice-diag', handleNativeVoiceDiag)
    }
  })

  useEffect(() => {
    if (!isVoiceListening || !isConnected) return undefined

    const pollBoardVoice = async () => {
      try {
        const result = await sendDeviceCommand(deviceHost, API_PATHS.features.voice, {
          cmd: 'read_voice_result',
        })
        const data = result.data || result
        if (!data?.hasResult || data.seq === lastBoardVoiceSeqRef.current) return

        lastBoardVoiceSeqRef.current = data.seq
        handleVoiceText(data.text || '', 'board')
      } catch {
        setVoiceStatusMessage('主板语音结果轮询暂未响应')
      }
    }

    pollBoardVoice()
    const timerId = window.setInterval(pollBoardVoice, 1000)
    return () => window.clearInterval(timerId)
  }, [isVoiceListening, isConnected, deviceHost])

  const deletePlan = (id) => {
    setPlanList((items) => items.filter((item) => item.id !== id))
    setPendingPlanSync(true)
    setLastMessage(isConnected ? '计划已删除，正在准备同步' : '未连接，删除已保存到本地')
  }

  return (
    <main className="app-shell">
      <div className="page-view">
        {activeSection === 'home' && (
          <section id="home" className="hero-section">
            <div className="top-bar">
              <div>
                <span className="device-label">当前设备</span>
                <strong>桌面整理机械臂</strong>
              </div>
              <span className={`online-pill ${isConnected ? 'online' : 'offline'}`}>
                {isConnected ? '在线' : '离线'}
              </span>
            </div>

            <div className="hero-content">
              <h1 className="hero-title">
                <img src={heroTitle} alt="桌面整理机械臂" />
              </h1>
              <p className="hero-text">智能识别 · 自动归位 · 桌面管理</p>
            </div>

            <button
              type="button"
              className={`device-card ${isDevicePanelOpen ? 'device-card-open' : ''}`}
              aria-expanded={isDevicePanelOpen}
              aria-label="设备连接状态"
              onClick={() => setIsDevicePanelOpen((isOpen) => !isOpen)}
            >
              <div className="device-card-header">
                <span className={`pulse-dot ${isConnected ? 'connected' : 'disconnected'}`} />
                <span>{connectionText}</span>
                <strong>{isConnected ? 'Wi-Fi 连接正常' : '等待 Wi-Fi 连接'}</strong>
                <span className="expand-mark">{isDevicePanelOpen ? '收起' : '详情'}</span>
              </div>
              {isDevicePanelOpen && (
                <div className="device-panel-body" onClick={(event) => event.stopPropagation()}>
                  <form className="wifi-form" onSubmit={saveDeviceHost}>
                    <label htmlFor="device-host">设备地址</label>
                    <div className="wifi-input-row">
                      <input
                        id="device-host"
                        value={draftHost}
                        inputMode="url"
                        placeholder="http://192.168.4.1"
                        onChange={(event) => setDraftHost(event.target.value)}
                      />
                      <button type="submit">连接</button>
                    </div>
                  </form>

                  <div className="device-metrics">
                    <div>
                      <span>连接方式</span>
                      <strong>Wi-Fi</strong>
                    </div>
                    <div>
                      <span>检测接口</span>
                      <strong>/status</strong>
                    </div>
                    <div>
                      <span>控制地址</span>
                      <strong>{deviceHost.replace(/^https?:\/\//, '')}</strong>
                    </div>
                  </div>
                  <div className="connection-actions">
                    <span>通信状态</span>
                    <strong>{lastMessage}</strong>
                  </div>
                </div>
              )}
            </button>

            <div className="control-grid" aria-label="快捷控制">
              {controls.map((control) => (
                <button
                  type="button"
                  className={control.tone === 'primary' ? 'control-card primary-control' : 'control-card'}
                  key={control.label}
                  onClick={() => runControlCommand(control)}
                >
                  <span>{control.label}</span>
                  <strong>{control.value}</strong>
                </button>
              ))}
            </div>

            <div className="command-strip">
              <span>任务状态</span>
              <strong>{commandState}</strong>
            </div>
          </section>
        )}

        {activeSection === 'features' && (
          <section id="features" className="page-section control-section">
            {!activeFeature ? (
              <>
                <div className="section-hero">
                  <div>
                    <p className="eyebrow">Intelligent Control</p>
                    <h2>功能控制</h2>
                  </div>
                  <span className="section-pill">5 项能力</span>
                </div>
                <div className="feature-module-grid">
                  {featureModules.map((feature) => (
                    <article className="module-card" key={feature.title}>
                      <button type="button" className="module-entry" onClick={() => openFeatureDetail(feature)}>
                        <div className="module-top">
                          <span className="module-icon">{feature.icon}</span>
                          <span className="module-status">{feature.status}</span>
                        </div>
                        <h3>{feature.title}</h3>
                        <p>{feature.text}</p>
                      </button>
                      <button type="button" className="module-action" onClick={() => runFeatureCommand(feature)}>
                        {feature.action}
                      </button>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="feature-detail">
                <div className="detail-topbar">
                  <button type="button" className="back-button" onClick={() => setActiveFeature(null)}>
                    返回
                  </button>
                  <span className={`mini-status ${isConnected ? 'online' : 'offline'}`}>
                    {isConnected ? '已连接' : '未连接'}
                  </span>
                </div>

                <div className="detail-hero-card">
                  <span className="module-icon">
                    {featureModules.find((feature) => feature.key === activeFeature)?.icon}
                  </span>
                  <div>
                    <p className="eyebrow">{featureDetailConfig[activeFeature].endpoint}</p>
                    <h2>{featureDetailConfig[activeFeature].title}</h2>
                    <p>{featureDetailConfig[activeFeature].subtitle}</p>
                  </div>
                </div>

                {activeFeature !== 'vision' && (
                  <div className="detail-stat-grid">
                    {featureDetailConfig[activeFeature].stats.map(([label, value]) => (
                      <div className="detail-stat" key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                )}

                {activeFeature === 'vision' && (
                  <>
                    <div className="vision-preview">
                      <div className="scan-frame camera-frame">
                        <div className="camera-toolbar">
                          <span>实时图片</span>
                          <strong>{isConnected ? '在线' : '未连接'}</strong>
                        </div>
                        {isConnected && visionPreviewActive && visionFrameSrc ? (
                          <button
                            type="button"
                            className="camera-frame-button"
                            onClick={openVisionFullscreen}
                            aria-label="打开全屏预览"
                          >
                            <img
                              className="camera-frame-image"
                              src={visionFrameSrc}
                              alt="摄像头画面"
                              onLoad={() =>
                                setVisionCoordinate((current) => ({
                                  ...current,
                                  status: '画面已接入',
                                }))
                              }
                              onError={() =>
                                setVisionCoordinate((current) => ({
                                  ...current,
                                  status: '等待摄像头帧',
                                }))
                              }
                            />
                            <span className="camera-frame-tip">点开全屏</span>
                          </button>
                        ) : (
                          <div className="video-placeholder">
                            <span />
                            <strong>{visionFrameLoading ? '正在抓取图片' : '点击刷新获取图片'}</strong>
                          </div>
                        )}
                        <div className="vision-hud">
                          <span>{visionCoordinate.status}</span>
                          <strong>{visionCoordinate.target}</strong>
                          <em>cx {visionCoordinate.cx} / cy {visionCoordinate.cy}</em>
                        </div>
                      </div>
                    </div>

                    {isVisionFrameFullscreen && visionFrameSrc && (
                      <div
                        className="vision-fullscreen"
                        role="dialog"
                        aria-modal="true"
                        onClick={() => setIsVisionFrameFullscreen(false)}
                      >
                        <button
                          type="button"
                          className="vision-fullscreen-close"
                          onClick={() => setIsVisionFrameFullscreen(false)}
                        >
                          关闭
                        </button>
                        <div className="vision-fullscreen-frame" onClick={(event) => event.stopPropagation()}>
                          <img src={visionFullFrameSrc || visionFrameSrc} alt="全屏摄像头画面" />
                          <span>{visionFullFrameLoading ? '读取高清图' : visionFullFrameSrc ? 'full frame' : 'preview frame'}</span>
                        </div>
                      </div>
                    )}

                    <div className="vision-quick-actions">
                      {visionControlGroups
                        .find((group) => group.title === '画面控制')
                        ?.items.map((item, index) => (
                          <button
                            type="button"
                            className={index === 0 ? 'primary-vision-action' : ''}
                            key={item.label}
                            disabled={item.label === '刷新画面' && isFetchingFrame}
                            onClick={() => runFeatureDetailAction('vision', item.label)}
                          >
                            <strong>{item.label === '刷新画面' && isFetchingFrame ? '刷新中...' : item.label}</strong>
                            <em>{item.detail}</em>
                          </button>
                        ))}
                    </div>

                    <div className="vision-coordinate-card">
                      <span>目标坐标</span>
                      <strong>
                        cx {visionCoordinate.cx} / cy {visionCoordinate.cy}
                      </strong>
                      <em>{visionCoordinate.status}</em>
                    </div>

                    <div className="vision-control-card">
                      <div className="module-top compact-module-top">
                        <h3>背景设置</h3>
                        <span className="module-status">可控制</span>
                      </div>
                      <div className="vision-control-buttons two-columns">
                        {visionControlGroups
                          .find((group) => group.title === '背景设置')
                          ?.items.map((item) => (
                            <button
                              type="button"
                              key={item.label}
                              onClick={() => runFeatureDetailAction('vision', item.label)}
                            >
                              <strong>{item.label}</strong>
                              <em>{item.detail}</em>
                            </button>
                          ))}
                      </div>
                    </div>
                  </>
                )}

                {activeFeature === 'voice' && (
                  <div className="voice-simple-panel">
                    <div className="received-command-card voice-command-display">
                      <span>接收到的指令</span>
                      <strong>{receivedVoiceCommand}</strong>
                    </div>

                    <div className="voice-source-grid">
                      <div className="voice-source-card">
                        <span>监听状态</span>
                        <strong>{isVoiceListening ? '监听中' : '未监听'}</strong>
                      </div>
                      <div className="voice-source-card">
                        <span>APP 识别结果</span>
                        <strong>{appVoiceText}</strong>
                      </div>
                      <div className="voice-source-card">
                        <span>主板识别结果</span>
                        <strong>{boardVoiceText}</strong>
                      </div>
                      <div className="voice-source-card">
                        <span>当前执行来源</span>
                        <strong>{currentVoiceSource}</strong>
                      </div>
                      <div className="voice-source-card">
                        <span>当前执行命令</span>
                        <strong>{currentVoiceCommand}</strong>
                      </div>
                      <div className="voice-source-card">
                        <span>上次执行时间</span>
                        <strong>{lastVoiceExecuteTime}</strong>
                      </div>
                    </div>

                    <div className="voice-listen-actions">
                      <button
                        type="button"
                        className="module-action primary-module-action"
                        onClick={() => requestNativeVoice('start')}
                      >
                        开始监听
                      </button>
                      <button
                        type="button"
                        className="module-action"
                        onClick={() => requestNativeVoice('stop')}
                      >
                        停止监听
                      </button>
                      <button
                        type="button"
                        className="module-action"
                        onClick={() => requestNativeVoice('diag')}
                      >
                        语音诊断
                      </button>
                    </div>

                    <div className="voice-status-card">
                      <span>状态提示</span>
                      <strong>{voiceStatusMessage}</strong>
                      <i className={isConnected ? 'pulse-dot online' : 'pulse-dot'} />
                    </div>

                    <div className="voice-status-card compact-voice-status-card">
                      <span>通信状态</span>
                      <strong>{isConnected ? '已连接' : connectionState === 'checking' ? '检测中' : '未连接'}</strong>
                      <i className={isConnected ? 'pulse-dot online' : 'pulse-dot'} />
                    </div>

                    <div className="voice-diag-card">
                      <div>
                        <span>运行环境</span>
                        <strong>{voiceDiag.environment}</strong>
                      </div>
                      <div>
                        <span>麦克风权限</span>
                        <strong>{voiceDiag.microphone}</strong>
                      </div>
                      <div>
                        <span>speech initialize</span>
                        <strong>{voiceDiag.speechInitialize ? '成功' : '失败/未执行'}</strong>
                      </div>
                      <div>
                        <span>speech available</span>
                        <strong>{voiceDiag.speechAvailable ? 'true' : 'false'}</strong>
                      </div>
                      <div>
                        <span>localeId</span>
                        <strong>{voiceDiag.localeId || '--'}</strong>
                      </div>
                      <div>
                        <span>localesCount</span>
                        <strong>{voiceDiag.localesCount}</strong>
                      </div>
                      <div>
                        <span>中文 locale</span>
                        <strong>{voiceDiag.hasChineseLocale ? '存在' : '未找到'}</strong>
                      </div>
                      <div>
                        <span>lastStatus</span>
                        <strong>{voiceDiag.lastStatus || '--'}</strong>
                      </div>
                      <div className="wide-voice-diag-item">
                        <span>lastError</span>
                        <strong>{voiceDiag.lastError || '--'}{voiceDiag.lastErrorPermanent ? ' / permanent' : ''}</strong>
                      </div>
                      <div className="wide-voice-diag-item">
                        <span>最后识别文本</span>
                        <strong>{voiceDiag.lastText || '--'}</strong>
                      </div>
                    </div>
                  </div>
                )}

                {activeFeature === 'memory' && (
                  <>
                    <form className="memory-editor-card" onSubmit={addMemoryArea}>
                      <div className="module-top compact-module-top">
                        <h3>新增记忆区域</h3>
                        <span className="module-status">{pendingMemorySync ? '待同步' : `${memoryAreas.length} 个`}</span>
                      </div>
                      <div className="memory-add-row">
                        <input
                          value={memoryDraft.name}
                          placeholder="区域名称"
                          onChange={(event) => setMemoryDraft({ ...memoryDraft, name: event.target.value })}
                        />
                        <input
                          value={memoryDraft.slot}
                          placeholder="槽位"
                          maxLength="4"
                          onChange={(event) => setMemoryDraft({ ...memoryDraft, slot: event.target.value })}
                        />
                        <button type="submit">添加</button>
                      </div>
                    </form>

                    <div className="memory-list-card">
                      <div className="module-top compact-module-top">
                        <h3>记忆区域</h3>
                        <span className="module-status">本地保存</span>
                      </div>
                      <div className="memory-list">
                        {memoryAreas.map((area) => (
                          <div className="memory-row" key={area.id}>
                            <input
                              value={area.name}
                              aria-label={`${area.name} 名称`}
                              onChange={(event) => updateMemoryArea(area.id, 'name', event.target.value)}
                              onBlur={() => markMemoryChanged('记忆区域已更新')}
                            />
                            <input
                              value={area.slot}
                              aria-label={`${area.name} 槽位`}
                              maxLength="4"
                              onChange={(event) => updateMemoryArea(area.id, 'slot', event.target.value)}
                              onBlur={() => markMemoryChanged('记忆槽位已更新')}
                            />
                            <button type="button" onClick={() => deleteMemoryArea(area.id)}>
                              删除
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="memory-sync-card">
                      <div>
                        <span>同步状态</span>
                        <strong>{pendingMemorySync ? '记忆区域待同步' : '记忆区域已保存'}</strong>
                      </div>
                      <button type="button" onClick={saveMemoryAreas}>
                        保存修改
                      </button>
                    </div>
                  </>
                )}

                {activeFeature === 'history' && (
                  <div className="history-card detail-history">
                    {taskHistory.length === 0 ? (
                      <p>暂无指令记录，发送控制命令后会显示在这里。</p>
                    ) : (
                      taskHistory.map((item) => (
                        <div className="history-row" key={`${item.time}-${item.title}`}>
                          <span>{item.time}</span>
                          <strong>{item.title}</strong>
                          <em>{item.detail}</em>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeFeature === 'plan' && (
                  <>
                    <form className="plan-card detail-plan" onSubmit={savePlan}>
                      <div className="plan-setting-panel">
                        <div className="time-setting">
                          <span>执行时间</span>
                          <div className="time-stepper" aria-label="执行时间">
                            <label className={`time-input-box ${activeTimePart === 'hour' ? 'selected' : ''}`}>
                              <input
                                type="text"
                                value={activeTimePart === 'hour' ? timeInputDraft.text : planConfig.time.split(':')[0]}
                                inputMode="numeric"
                                maxLength="2"
                                placeholder="00"
                                aria-label="小时"
                                onFocus={(event) => {
                                  setActiveTimePart('hour')
                                  setTimeInputDraft({ part: 'hour', text: '' })
                                }}
                                onBlur={() => {
                                  setActiveTimePart(null)
                                  setTimeInputDraft({ part: null, text: '' })
                                }}
                                onKeyDown={(event) => handleTimeKeyDown('hour', event)}
                                onChange={(event) => updatePlanTimeInput('hour', event.target.value)}
                              />
                              <span>时</span>
                            </label>
                            <span>:</span>
                            <label className={`time-input-box ${activeTimePart === 'minute' ? 'selected' : ''}`}>
                              <input
                                type="text"
                                value={activeTimePart === 'minute' ? timeInputDraft.text : planConfig.time.split(':')[1]}
                                inputMode="numeric"
                                maxLength="2"
                                placeholder="00"
                                aria-label="分钟"
                                onFocus={(event) => {
                                  setActiveTimePart('minute')
                                  setTimeInputDraft({ part: 'minute', text: '' })
                                }}
                                onBlur={() => {
                                  setActiveTimePart(null)
                                  setTimeInputDraft({ part: null, text: '' })
                                }}
                                onKeyDown={(event) => handleTimeKeyDown('minute', event)}
                                onChange={(event) => updatePlanTimeInput('minute', event.target.value)}
                              />
                              <span>分</span>
                            </label>
                          </div>
                        </div>
                        <label className="enable-setting">
                          <span>计划启用</span>
                          <input
                            type="checkbox"
                            checked={planConfig.enabled}
                            onChange={(event) => setPlanConfig({ ...planConfig, enabled: event.target.checked })}
                          />
                        </label>
                      </div>

                      <div className="segmented-setting">
                        <span>执行周期</span>
                        <div>
                          {repeatOptions.map((option) => (
                            <button
                              type="button"
                              className={planConfig.repeat === option.value ? 'selected' : ''}
                              key={option.value}
                              onClick={() => setPlanConfig({ ...planConfig, repeat: option.value })}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="mode-setting">
                        <span>整理模式</span>
                        <div>
                          {planModeOptions.map((option) => (
                            <button
                              type="button"
                              className={planConfig.mode === option.value ? 'selected' : ''}
                              key={option.value}
                              onClick={() => setPlanConfig({ ...planConfig, mode: option.value })}
                            >
                              <strong>{option.label}</strong>
                              <em>{option.desc}</em>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="area-selector">
                        <span>整理区域</span>
                        <div>
                          {memoryAreas.map((area) => (
                            <button
                              type="button"
                              className={planConfig.areas.includes(area.id) ? 'selected' : ''}
                              key={area.id}
                              onClick={() => togglePlanArea(area.id)}
                            >
                              <strong>{area.name}</strong>
                              <em>{area.slot}</em>
                            </button>
                          ))}
                        </div>
                      </div>
                    </form>
                    <div className="schedule-table-card">
                      <div className="module-top">
                        <h3>规划表</h3>
                        <span className="module-status">{pendingPlanSync ? '待同步' : `${planList.length} 条`}</span>
                      </div>
                      <div className="schedule-table">
                        <div className="schedule-switch" aria-label="规划表周期切换">
                          {repeatOptions.map((option) => (
                            <button
                              type="button"
                              className={activePlanTable === option.value ? 'selected' : ''}
                              key={option.value}
                              onClick={() => setActivePlanTable(option.value)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        <div className="schedule-group">
                          <div className="schedule-group-title">
                            <strong>{activePlanTable === 'weekdays' ? '工作日计划' : '周末计划'}</strong>
                            <span>{visiblePlans.length} 条</span>
                          </div>
                          {visiblePlans.length === 0 ? (
                            <p className="empty-schedule">暂无计划</p>
                          ) : (
                            visiblePlans.map((plan) => (
                              <div className="schedule-row" key={plan.id}>
                                <strong>{plan.time}</strong>
                                <div>
                                  <span>{plan.mode}</span>
                                  <em>{plan.areas.join('、')} · {plan.enabled ? '启用' : '停用'}</em>
                                </div>
                                <button type="button" onClick={() => deletePlan(plan.id)}>
                                  删除
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {activeFeature !== 'vision' && activeFeature !== 'voice' && (
                  <div className="detail-action-grid">
                    {featureDetailConfig[activeFeature].actions.map((action, index) => (
                      <button
                        type="button"
                        className={index === 0 ? 'module-action primary-module-action' : 'module-action'}
                        key={action}
                        onClick={() => runFeatureDetailAction(activeFeature, action)}
                      >
                        {action}
                      </button>
                    ))}
                  </div>
                )}

                <div className="connection-actions detail-message">
                  <span>通信状态</span>
                  <strong>{lastMessage}</strong>
                </div>
              </div>
            )}
          </section>
        )}

        {activeSection === 'services' && (
          <section id="services" className="page-section tinted-section">
            <div className="section-hero">
              <div>
                <p className="eyebrow">Device Suite</p>
                <h2>产品 / 套件</h2>
              </div>
              <span className="section-pill">已适配</span>
            </div>
            <div className="product-list">
              {products.map((product, index) => (
                <article className="product-row" key={product.name}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <em>{product.meta}</em>
                    <h3>{product.name}</h3>
                    <p>{product.desc}</p>
                  </div>
                </article>
              ))}
              <article className="customer-card">
                <div>
                  <em>客服支持</em>
                  <h3>在线客服</h3>
                  <p>设备接入、算法调试、APP 集成问题，可联系项目服务团队。</p>
                </div>
                <a href="tel:13800000000">立即联系</a>
              </article>
            </div>
          </section>
        )}
      </div>

      <nav className="bottom-nav" aria-label="底部导航">
        {navItems.map((item) => (
          <button
            type="button"
            className={activeSection === item.id ? 'active' : ''}
            onClick={() => openSection(item.id)}
            key={item.id}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </main>
  )
}

export default App
