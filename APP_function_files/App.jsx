import { useEffect, useMemo, useRef, useState } from 'react'

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
const VISION_RESULT_STORAGE_KEY = 'robotArmLatestVisionResult'
const VISION_FRAME_TIME_STORAGE_KEY = 'robotArmLatestVisionFrameTime'
const SELECTED_VISION_TARGET_STORAGE_KEY = 'robotArmSelectedVisionTarget'

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

function safeSessionSet(key, value) {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // Session storage is only a cache for page-to-page vision state.
  }
}

function safeSessionGet(key, fallback = null) {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return fallback
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
  arm: {
    calibration: '/arm/calibration',
    calibrationStatus: '/arm/calibration/status',
    grab: '/arm/grab',
    place: '/arm/place',
    light: '/arm/light',
  },
  plan: '/plan',
}

const PLACE_CATEGORIES = [
  { id: 0, className: 'pen', title: '默认区 / 笔', desc: '未匹配类别时使用的兜底放置区' },
  { id: 1, className: 'eraser', title: '橡皮', desc: '橡皮、擦除工具放置区' },
  { id: 2, className: 'cap', title: '笔帽', desc: '笔帽、盖子类物品放置区' },
  { id: 3, className: 'box', title: '盒子', desc: '盒子、小收纳盒放置区' },
  { id: 4, className: 'cosmetic', title: '化妆品', desc: '化妆品类物品放置区' },
  { id: 5, className: 'reserved5', title: '预留 5', desc: '后续类别扩展放置区' },
  { id: 6, className: 'reserved6', title: '预留 6', desc: '后续类别扩展放置区' },
  { id: 7, className: 'reserved7', title: '预留 7', desc: '后续类别扩展放置区' },
]

const PLACE_CATEGORY_BY_CLASS = PLACE_CATEGORIES.reduce((map, item) => {
  map[item.className] = item.id
  return map
}, {})

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
    key: 'calibration',
    title: '视觉校准',
    text: '设置摄像头四角与机械臂坐标映射。',
    status: '可标定',
    action: '进入校准',
    icon: '⌖',
  },
  {
    key: 'place',
    title: '放置区设置',
    text: '为不同识别类别保存机械臂放下位置，抓取后自动按类别放置。',
    status: '0-7 区',
    action: '进入设置',
    icon: '◎',
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
  place: {
    title: '放置区设置',
    subtitle: '按类别保存机械臂放下坐标。先解锁拖动机械臂到放置区，再保存当前位置。',
    endpoint: '/arm/place',
    stats: [
      ['类别数量', '0-7'],
      ['默认兜底', '0 号区'],
      ['发送方式', 'POST /arm/place'],
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
  calibration: {
    title: '视觉校准',
    subtitle: '设置摄像头四角与机械臂坐标映射。',
    endpoint: '/arm/calibration',
    stats: [
      ['标定状态', '手动记录'],
      ['角点数量', '4 个'],
      ['执行方式', 'HTTP / IPC'],
    ],
    actions: [],
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

function normalizeVoiceText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。,.!?！？、]/g, '')
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
    if (path === API_PATHS.arm.grab) {
      console.log('[APP GRAB] POST /arm/grab', payload)
    }
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
    if (path === API_PATHS.arm.grab) {
      console.log('[APP GRAB] response', { httpOk: response.ok, data })
    }
    return { ok: response.ok && data?.ok !== false, httpOk: response.ok, mode: 'json', data }
  } catch (error) {
    if (path === API_PATHS.arm.grab) {
      console.log('[APP GRAB] fetch error', error)
      return { ok: false, mode: 'error', error: error?.message || 'fetch failed' }
    }
    await requestWithTimeout(buildUrl(host, path), {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body,
    })
    return { ok: true, mode: 'no-cors' }
  }
}

function getPlaceCategoryForTarget(target = {}) {
  const explicitCategory = target.placeCategory ?? target.category
  if (Number.isInteger(Number(explicitCategory))) {
    return Math.max(0, Math.min(7, Number(explicitCategory)))
  }

  if (Number.isInteger(Number(target.classId))) {
    return Math.max(0, Math.min(7, Number(target.classId)))
  }

  const className = String(target.className || target.class || target.type || '').trim().toLowerCase()
  return PLACE_CATEGORY_BY_CLASS[className] ?? 0
}

function getPlaceCategoryLabel(category) {
  const item = PLACE_CATEGORIES.find((entry) => entry.id === Number(category))
  return item ? item.title : '默认区 / 笔'
}

function normalizeVisionTargets(data) {
  const targetList = Array.isArray(data?.targets) ? data.targets : []
  const mappedTargets = targetList
    .map((item, index) => {
      const target = {
        id: item.id ?? index + 1,
        className: item.className || item.class || item.type || item.label || 'target',
        classId: item.classId ?? null,
        score: item.score ?? item.confidence ?? null,
        cx: item.cx,
        cy: item.cy,
        bbox: item.bbox || null,
        x0: item.x0 ?? item.bbox?.x0 ?? null,
        y0: item.y0 ?? item.bbox?.y0 ?? null,
        x1: item.x1 ?? item.bbox?.x1 ?? null,
        y1: item.y1 ?? item.bbox?.y1 ?? null,
      }
      return {
        ...target,
        placeCategory: getPlaceCategoryForTarget(target),
      }
    })
    .filter((item) => item.cx !== undefined && item.cx !== null && item.cy !== undefined && item.cy !== null)

  if (mappedTargets.length > 0) return mappedTargets

  if (data?.valid && data.cx !== undefined && data.cx !== null && data.cy !== undefined && data.cy !== null) {
    const target = {
      id: 1,
      className: data.className || data.class || data.type || 'target',
      classId: data.classId ?? null,
      score: data.score ?? null,
      cx: data.cx,
      cy: data.cy,
      bbox: data.bbox || null,
      x0: data.x0 ?? data.bbox?.x0 ?? null,
      y0: data.y0 ?? data.bbox?.y0 ?? null,
      x1: data.x1 ?? data.bbox?.x1 ?? null,
      y1: data.y1 ?? data.bbox?.y1 ?? null,
    }
    return [{ ...target, placeCategory: getPlaceCategoryForTarget(target) }]
  }

  return []
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
  const [floatingVoiceCard, setFloatingVoiceCard] = useState({
    visible: false,
    tone: 'idle',
    title: '语音助手',
    result: '点击悬浮按钮开始识别',
    command: '--',
    status: '待命',
  })
  const [voiceBubblePosition, setVoiceBubblePosition] = useState(() => {
    const savedPosition = safeStorageGet('floatingVoiceAssistantPosition')
    if (!savedPosition) return null

    try {
      const position = JSON.parse(savedPosition)
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        return position
      }
    } catch {
      safeStorageRemove('floatingVoiceAssistantPosition')
    }

    return null
  })
  const [voiceDiag, setVoiceDiag] = useState(() => ({
    microphone: '--',
    speechInitialize: false,
    speechAvailable: false,
    localeId: '--',
    localesCount: 0,
    hasChineseLocale: false,
    lastStatus: '--',
    lastError: '--',
    debug: '--',
    lastErrorPermanent: false,
    listening: false,
    lastText: '--',
    environment: typeof window !== 'undefined' && window.FlutterVoice?.postMessage ? 'Flutter APP' : '非 Flutter APP 环境',
  }))
  const [voiceDebug, setVoiceDebug] = useState({
    rawText: '--',
    normalizedText: '--',
    lastText: '--',
    source: '--',
    commandKey: '--',
    ignoredReason: '--',
    rateLimited: '否',
    rateLimitDetail: '--',
    requestUrl: '--',
    requestBody: '--',
    httpStatus: '--',
    responseText: '--',
    fetchError: '--',
    updatedAt: '--',
  })
  const [visionCoordinate, setVisionCoordinate] = useState({
    status: '等待读取',
    cx: '--',
    cy: '--',
    target: '未识别',
  })
  const [visionTargets, setVisionTargets] = useState([])
  const [selectedVisionTargetIndex, setSelectedVisionTargetIndex] = useState(0)
  const [selectedVisionTarget, setSelectedVisionTarget] = useState(() => {
    const savedTarget = safeSessionGet(SELECTED_VISION_TARGET_STORAGE_KEY)
    if (!savedTarget) return null

    try {
      return JSON.parse(savedTarget)
    } catch {
      return null
    }
  })
  const [calibrationStatus, setCalibrationStatus] = useState('未开始')
  const [calibrationTorqueStatus, setCalibrationTorqueStatus] = useState('已开启')
  const [pendingCalibrationCorner, setPendingCalibrationCorner] = useState(null)
  const [recordedCorners, setRecordedCorners] = useState({
    tl: false,
    tr: false,
    bl: false,
    br: false,
  })
  const [isGrabbingTarget, setIsGrabbingTarget] = useState(false)
  const [placeCommandStatus, setPlaceCommandStatus] = useState({})
  const [visionPreviewActive, setVisionPreviewActive] = useState(false)
  const [visionFrameSrc, setVisionFrameSrc] = useState('')
  const [visionFullFrameSrc, setVisionFullFrameSrc] = useState('')
  const [visionFrameLoading, setVisionFrameLoading] = useState(false)
  const [isFetchingFrame, setIsFetchingFrame] = useState(false)
  const [visionFullFrameLoading, setVisionFullFrameLoading] = useState(false)
  const [isVisionFrameFullscreen, setIsVisionFrameFullscreen] = useState(false)
  const [latestVisionFrameTime, setLatestVisionFrameTime] = useState(() => safeSessionGet(VISION_FRAME_TIME_STORAGE_KEY, ''))
  const missedConnectionChecks = useRef(0)
  const lastFrameFetchRef = useRef(0)
  const frameAbortRef = useRef(null)
  const visionFrameObjectUrl = useRef('')
  const visionFullFrameObjectUrl = useRef('')
  const lastVisionAutoLoadKeyRef = useRef('')
  const lastVoiceCommandAtRef = useRef(0)
  const lastVoiceCommandSourceRef = useRef(null)
  const lastVoiceCommandKeyRef = useRef(null)
  const pendingBoardCommandRef = useRef(null)
  const pendingBoardTimerRef = useRef(null)
  const lastBoardVoiceSeqRef = useRef(null)
  const voiceCardTimerRef = useRef(null)
  const voiceDragRef = useRef({
    active: false,
    moved: false,
    offsetX: 0,
    offsetY: 0,
  })
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

  const selectVisionTarget = (target, index) => {
    setSelectedVisionTargetIndex(index)
    setSelectedVisionTarget(target)
    safeSessionSet(SELECTED_VISION_TARGET_STORAGE_KEY, JSON.stringify(target))
    setVisionCoordinate({
      status: '已选择目标',
      cx: target.cx,
      cy: target.cy,
      target: `${target.className || 'target'} #${target.id || index + 1}`,
    })
    setLastMessage(`已选择目标${target.id || index + 1}: ${target.className || 'target'} cx=${target.cx} cy=${target.cy}`)
  }

  const applyVisionResultData = (data) => {
    const targets = normalizeVisionTargets(data)
    setVisionTargets(targets)
    setSelectedVisionTargetIndex(0)
    safeSessionSet(VISION_RESULT_STORAGE_KEY, JSON.stringify(data || {}))

    if (targets.length > 0) {
      const selectedTarget = targets[0]
      setSelectedVisionTarget(selectedTarget)
      safeSessionSet(SELECTED_VISION_TARGET_STORAGE_KEY, JSON.stringify(selectedTarget))
      setVisionCoordinate({
        status: targets.length > 1 ? `识别完成：${targets.length} 个目标` : '识别完成：1 个目标',
        cx: selectedTarget.cx,
        cy: selectedTarget.cy,
        target: `${selectedTarget.className || 'target'} #${selectedTarget.id || 1}`,
      })
      return targets
    }

    setVisionCoordinate({
      status: '未识别到目标',
      cx: '--',
      cy: '--',
      target: '暂无目标',
    })
    setSelectedVisionTarget(null)
    safeSessionSet(SELECTED_VISION_TARGET_STORAGE_KEY, '')
    return []
  }

  const readVisionResultAndUpdateUI = async () => {
    if (!isConnected) return []

    setVisionCoordinate((current) => ({
      ...current,
      status: '识别中...',
    }))

    try {
      const result = await sendDeviceCommand(deviceHost, API_PATHS.features.vision, {
        cmd: 'read_vision_result',
      })
      const data = result.data || {}
      const targets = applyVisionResultData(data)
      setLastMessage(targets.length > 0 ? `识别完成：${targets.length} 个目标` : '未识别到目标')
      return targets
    } catch {
      setVisionCoordinate((current) => ({
        ...current,
        status: '识别结果读取失败',
      }))
      setLastMessage('识别结果读取失败')
      return []
    }
  }

  const requestVisionRefreshCommand = async () => {
    if (!isConnected) return false

    try {
      await sendDeviceCommand(deviceHost, API_PATHS.features.vision, {
        cmd: 'refresh_frame',
      })
      return true
    } catch {
      setLastMessage('refresh_frame 未响应，继续尝试读取图片')
      return false
    }
  }

  const refreshVisionAndReadTargets = async ({ allowThrottle = true } = {}) => {
    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return false
    }

    setVisionCoordinate((current) => ({
      ...current,
      status: '刷新中...',
    }))
    await requestVisionRefreshCommand()
    return fetchVisionFrame({ allowThrottle, readResult: true })
  }

  const calibrationCorners = [
    { key: 'tl', label: '左上', recordCmd: 'record_tl', hint: '请看板端 LCD 画面，手动移动机械臂到摄像头左上角对应位置。' },
    { key: 'tr', label: '右上', recordCmd: 'record_tr', hint: '请看板端 LCD 画面，手动移动机械臂到摄像头右上角对应位置。' },
    { key: 'bl', label: '左下', recordCmd: 'record_bl', hint: '请看板端 LCD 画面，手动移动机械臂到摄像头左下角对应位置。' },
    { key: 'br', label: '右下', recordCmd: 'record_br', hint: '请看板端 LCD 画面，手动移动机械臂到摄像头右下角对应位置。' },
  ]

  const sendArmCalibrationCommand = async (cmd) => {
    if (!isConnected) {
      setLastMessage('主板未连接')
      return { ok: false }
    }

    try {
      const result = await sendDeviceCommand(deviceHost, API_PATHS.arm.calibration, { cmd })
      if (!result.ok) throw new Error('calibration failed')
      return result
    } catch {
      setLastMessage('标定失败')
      return { ok: false }
    }
  }

  const startCalibrationCorner = async (corner) => {
    if (!isConnected) {
      setLastMessage('主板未连接')
      return
    }

    const result = await sendArmCalibrationCommand('start')
    if (!result.ok) return

    setPendingCalibrationCorner(corner.key)
    setCalibrationStatus('标定中')
    setCalibrationTorqueStatus('已关闭')
    setLastMessage(`${corner.label}角标定中，请看 LCD 画面移动机械臂，APP 已关闭校准图传`)
    addHistory('开始视觉校准', corner.label)
  }

  const completeCalibrationCorner = async () => {
    if (pendingCalibrationCorner === 'exit') {
      const exitResult = await sendArmCalibrationCommand('exit')
      if (!exitResult.ok) return

      setLastMessage('已记录脱离位置')
      addHistory('已记录脱离位置', `POST ${API_PATHS.arm.calibration}`)

      const stopResult = await sendArmCalibrationCommand('stop')
      if (stopResult.ok) {
        setCalibrationStatus('已完成')
        setCalibrationTorqueStatus('已开启')
        setPendingCalibrationCorner(null)
        setLastMessage('已记录脱离位置，并打开机械臂扭矩')
      }
      return
    }

    const corner = calibrationCorners.find((item) => item.key === pendingCalibrationCorner)
    if (!corner) return

    const recordResult = await sendArmCalibrationCommand(corner.recordCmd)
    if (!recordResult.ok) return

    setRecordedCorners((current) => ({
      ...current,
      [corner.key]: true,
    }))
    setLastMessage(`已记录${corner.label}`)
    addHistory(`已记录${corner.label}`, `POST ${API_PATHS.arm.calibration}`)

    const stopResult = await sendArmCalibrationCommand('stop')
    if (stopResult.ok) {
      setCalibrationStatus('已完成')
      setCalibrationTorqueStatus('已开启')
      setPendingCalibrationCorner(null)
      setLastMessage(`已记录${corner.label}，并结束本次标定`)
    }
  }

  const showCalibration = async () => {
    const result = await sendArmCalibrationCommand('show')
    if (result.ok) {
      setLastMessage('已请求显示标定')
      addHistory('查看标定', `POST ${API_PATHS.arm.calibration}`)
    }
  }

  const stopCalibration = async () => {
    const result = await sendArmCalibrationCommand('stop')
    if (result.ok) {
      setCalibrationStatus('已完成')
      setCalibrationTorqueStatus('已开启')
      setPendingCalibrationCorner(null)
      setLastMessage('已结束标定')
    }
  }

  const setCalibrationExit = async () => {
    if (!isConnected) {
      setLastMessage('主板未连接')
      return
    }

    const result = await sendArmCalibrationCommand('exit_start')
    if (!result.ok) return

    setPendingCalibrationCorner('exit')
    setCalibrationStatus('设置脱离位置')
    setCalibrationTorqueStatus('已关闭')
    setLastMessage('请手动移动机械臂到脱离位置，然后点击完成记录')
  }

  const clearCalibrationExit = async () => {
    const result = await sendArmCalibrationCommand('exit_clear')
    if (result.ok) setLastMessage('已清除脱离位置')
  }

  const runPlaceCommand = async (cmd, category) => {
    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return
    }

    const item = PLACE_CATEGORIES.find((entry) => entry.id === category)
    const actionText = {
      unlock: '解锁拖动',
      lock: '保存当前位置',
      clear: '清除放置区',
      show: '刷新/打印状态',
    }[cmd] || cmd

    setPlaceCommandStatus((current) => ({
      ...current,
      [category]: '发送中...',
    }))
    setLastMessage(`${actionText}：${item?.title || category}`)

    try {
      const payload = cmd === 'show' ? { cmd } : { cmd, category, placeCategory: category }
      const result = await sendDeviceCommand(deviceHost, API_PATHS.arm.place, payload)
      if (!result.ok) {
        throw new Error(result.data?.message || result.error || 'place command failed')
      }

      const statusText = cmd === 'lock'
        ? '已发送保存命令'
        : cmd === 'unlock'
          ? '已发送解锁命令'
          : cmd === 'clear'
            ? '已发送清除命令'
            : '已请求打印状态'

      setPlaceCommandStatus((current) => ({
        ...current,
        [category]: statusText,
      }))
      setLastMessage(`${item?.title || `类别 ${category}`}：${statusText}`)
      addHistory('放置区设置', `${actionText} category=${category}`)
    } catch (error) {
      const errorText = error?.message || '发送失败'
      setPlaceCommandStatus((current) => ({
        ...current,
        [category]: `失败：${errorText}`,
      }))
      setLastMessage(`放置区命令失败：${errorText}`)
    }
  }

  const showPlaceStatus = async () => {
    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      return
    }

    try {
      const result = await sendDeviceCommand(deviceHost, API_PATHS.arm.place, { cmd: 'show' })
      if (!result.ok) throw new Error(result.data?.message || result.error || 'show failed')
      setLastMessage('已请求主板打印放置区状态，请查看串口日志')
      addHistory('放置区状态', 'POST /arm/place {"cmd":"show"}')
    } catch (error) {
      setLastMessage(`放置区状态读取失败：${error?.message || '未知错误'}`)
    }
  }

  const buildGrabTargetPayload = (target) => {
    const placeCategory = getPlaceCategoryForTarget(target)
    return {
      id: target.id ?? selectedVisionTargetIndex + 1,
      className: target.className || target.class || target.type || 'target',
      classId: target.classId ?? placeCategory,
      placeCategory,
      cx: Number(target.cx),
      cy: Number(target.cy),
      x0: target.x0 ?? target.bbox?.x0 ?? null,
      y0: target.y0 ?? target.bbox?.y0 ?? null,
      x1: target.x1 ?? target.bbox?.x1 ?? null,
      y1: target.y1 ?? target.bbox?.y1 ?? null,
      bbox: target.bbox || null,
      score: target.score ?? null,
    }
  }

  const grabSelectedVisionTarget = async () => {
    if (!isConnected) {
      setLastMessage('主板未连接')
      return false
    }

    if (!selectedVisionTarget) {
      setLastMessage('请先选择目标')
      showFloatingVoiceCard({
        tone: 'error',
        title: '未选择目标',
        result: '请先选择目标',
        command: 'grab_start',
        status: '未发送',
      }, true)
      return false
    }

    setIsGrabbingTarget(true)
    setLastMessage('抓取中...')

    try {
      const grabTarget = buildGrabTargetPayload(selectedVisionTarget)
      console.log('[APP GRAB] selected target', grabTarget)
      const result = await sendDeviceCommand(deviceHost, API_PATHS.arm.grab, {
        cmd: 'start',
        target: grabTarget,
      })
      if (!result.ok) {
        const backendError = result.data?.error || result.error || 'grab failed'
        throw new Error(backendError)
      }
      setCommandState('抓取中')
      setLastMessage('已发送抓取指令')
      addHistory('抓取选中目标', `${grabTarget.className || 'target'} cx=${grabTarget.cx} cy=${grabTarget.cy} place=${grabTarget.placeCategory}`)
      return true
    } catch (error) {
      setLastMessage(`抓取失败：${error?.message || '未知错误'}`)
      return false
    } finally {
      setIsGrabbingTarget(false)
    }
  }

  const stopGrab = async () => {
    if (!isConnected) {
      setLastMessage('主板未连接')
      return false
    }

    try {
      const result = await sendDeviceCommand(deviceHost, API_PATHS.arm.grab, { cmd: 'stop' })
      if (!result.ok) throw new Error('grab stop failed')
      setCommandState('待命')
      setLastMessage('已停止抓取')
      addHistory('停止抓取', `POST ${API_PATHS.arm.grab}`)
      return true
    } catch {
      setLastMessage('停止抓取失败')
      return false
    }
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

  const fetchVisionFrame = async ({ allowThrottle = true, readResult = false } = {}) => {
    const now = Date.now()

    if (!isConnected) return false

    if (isFetchingFrame) {
      setVisionCoordinate((current) => ({
        ...current,
        status: '正在获取图片，请不要连续刷新',
      }))
      setLastMessage('正在获取图片，请不要连续刷新')
      return false
    }

    if (allowThrottle && now - lastFrameFetchRef.current < MIN_FRAME_INTERVAL_MS) {
      setVisionCoordinate((current) => ({
        ...current,
        status: '刷新太频繁，请稍后再试',
      }))
      setLastMessage('刷新太频繁，请稍后再试')
      return false
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
      setVisionPreviewActive(true)
      {
        const frameTime = String(Date.now())
        setLatestVisionFrameTime(frameTime)
        safeSessionSet(VISION_FRAME_TIME_STORAGE_KEY, frameTime)
      }
      setVisionCoordinate((current) => ({
        ...current,
        status: '画面已刷新',
      }))
      setLastMessage('画面已刷新')
      if (readResult) {
        setVisionCoordinate((current) => ({
          ...current,
          status: '识别中...',
        }))
        await readVisionResultAndUpdateUI()
      }
      return true
    } catch (error) {
      const message = error?.name === 'AbortError' ? '刷新超时，主控可能忙碌' : error?.message || '刷新失败'
      setVisionCoordinate((current) => ({
        ...current,
        status: message,
      }))
      setLastMessage(message)
      return false
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
      setVisionTargets([])
      setSelectedVisionTargetIndex(0)
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
    if (activeFeature !== 'vision' || !isConnected) return

    const autoLoadKey = `${deviceHost}:${latestVisionFrameTime || 'no-frame'}`
    if (lastVisionAutoLoadKeyRef.current === autoLoadKey) return
    lastVisionAutoLoadKeyRef.current = autoLoadKey

    if (visionFrameSrc) {
      readVisionResultAndUpdateUI()
      return
    }

    fetchVisionFrame({ allowThrottle: false, readResult: true })
  }, [activeFeature, deviceHost, isConnected])

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
    if (control.command === 'scan') {
      setActiveSection('features')
      setActiveFeature('calibration')
      window.scrollTo(0, 0)
      setLastMessage('进入视觉校准')
      return
    }

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
    if (feature.key === 'voice') {
      requestNativeVoice('start')
      return
    }

    if (feature.key === 'calibration') {
      setActiveFeature('calibration')
      window.scrollTo(0, 0)
      return
    }

    if (feature.key === 'place') {
      setActiveFeature('place')
      window.scrollTo(0, 0)
      setLastMessage('进入放置区设置')
      return
    }

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

    if (featureKey === 'calibration') {
      setActiveFeature('calibration')
      return
    }

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
      await refreshVisionAndReadTargets()
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
      if (featureKey === 'vision' && commandPayload.cmd === 'start_camera') {
        await new Promise((resolve) => window.setTimeout(resolve, 800))
        await fetchVisionFrame({ allowThrottle: false, readResult: true })
      }
      if (featureKey === 'vision' && buildFeatureActionPayload(featureKey, actionLabel).cmd === 'read_vision_result') {
        const data = result.data || {}
        const targets = normalizeVisionTargets(data)
        setVisionTargets(targets)
        setSelectedVisionTargetIndex(0)
        if (targets.length > 0) {
          const selectedTarget = targets[0]
          setVisionCoordinate({
            status: targets.length > 1 ? `已读取 ${targets.length} 个目标` : '已读取 1 个目标',
            cx: selectedTarget.cx,
            cy: selectedTarget.cy,
            target: `${selectedTarget.className || 'target'} #${selectedTarget.id || 1}`,
          })
        } else {
          setVisionCoordinate({
            status: '未识别到目标',
            cx: '--',
            cy: '--',
            target: '请调整画面',
          })
        }
      }
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
    const normalizedText = normalizeVoiceText(text)

    if (!normalizedText) return null

    const cameraTargetMatched =
      normalizedText.includes('摄像头') ||
      normalizedText.includes('相机') ||
      normalizedText.includes('视觉') ||
      normalizedText.includes('camera')
    const cameraOpenMatched =
      normalizedText.includes('打开') ||
      normalizedText.includes('开启') ||
      normalizedText.includes('启动') ||
      normalizedText.includes('开')

    if (
      cameraTargetMatched &&
      cameraOpenMatched
    ) {
      return { key: 'camera_start', label: '打开摄像头', type: 'feature', featureKey: 'vision', actionLabel: '开启摄像头' }
    }

    if (normalizedText.includes('刷新画面') || normalizedText.includes('刷新图片') || normalizedText.includes('拍一张') || normalizedText.includes('获取图片')) {
      return { key: 'camera_refresh', label: '刷新画面', type: 'frame' }
    }

    if (normalizedText.includes('读取坐标') || normalizedText.includes('显示坐标') || normalizedText.includes('目标在哪里') || normalizedText.includes('坐标')) {
      return { key: 'read_coords', label: '读取坐标', type: 'feature', featureKey: 'vision', actionLabel: '显示坐标' }
    }

    if (normalizedText.includes('开始标定') || normalizedText.includes('开始视觉校准')) {
      return { key: 'calibration_start', label: '开始标定', type: 'armCalibration', cmd: 'start' }
    }

    if (normalizedText.includes('标定左上') || normalizedText.includes('记录左上')) {
      return { key: 'calibration_tl', label: '记录左上', type: 'armCalibration', cmd: 'record_tl' }
    }

    if (normalizedText.includes('标定右上') || normalizedText.includes('记录右上')) {
      return { key: 'calibration_tr', label: '记录右上', type: 'armCalibration', cmd: 'record_tr' }
    }

    if (normalizedText.includes('标定左下') || normalizedText.includes('记录左下')) {
      return { key: 'calibration_bl', label: '记录左下', type: 'armCalibration', cmd: 'record_bl' }
    }

    if (normalizedText.includes('标定右下') || normalizedText.includes('记录右下')) {
      return { key: 'calibration_br', label: '记录右下', type: 'armCalibration', cmd: 'record_br' }
    }

    if (normalizedText.includes('结束标定')) {
      return { key: 'calibration_stop', label: '结束标定', type: 'armCalibration', cmd: 'stop' }
    }

    if (normalizedText.includes('查看标定') || normalizedText.includes('显示标定')) {
      return { key: 'calibration_show', label: '查看标定', type: 'armCalibration', cmd: 'show' }
    }

    if (normalizedText.includes('抓取这个') || normalizedText.includes('抓取目标') || normalizedText.includes('抓取选中目标')) {
      return { key: 'grab_selected', label: '抓取选中目标', type: 'grabSelected' }
    }

    if (normalizedText.includes('停止抓取')) {
      return { key: 'grab_stop', label: '停止抓取', type: 'armGrabStop' }
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

  const updateVoiceDebug = (patch) => {
    setVoiceDebug((current) => ({
      ...current,
      ...patch,
      updatedAt: new Date().toLocaleTimeString(),
    }))
  }

  const showFloatingVoiceCard = (patch, autoHide = false) => {
    if (voiceCardTimerRef.current) {
      window.clearTimeout(voiceCardTimerRef.current)
      voiceCardTimerRef.current = null
    }

    setFloatingVoiceCard((current) => ({
      ...current,
      visible: true,
      ...patch,
    }))

    if (autoHide) {
      voiceCardTimerRef.current = window.setTimeout(() => {
        setFloatingVoiceCard((current) => ({
          ...current,
          visible: false,
        }))
      }, 3600)
    }
  }

  const closeFloatingVoiceCard = () => {
    if (voiceCardTimerRef.current) {
      window.clearTimeout(voiceCardTimerRef.current)
      voiceCardTimerRef.current = null
    }
    setFloatingVoiceCard((current) => ({ ...current, visible: false }))
  }

  const navigateToVisionPage = () => {
    setActiveSection('features')
    setActiveFeature('vision')
    window.scrollTo(0, 0)
  }

  const isVisionRelatedCommand = (command) =>
    Boolean(command && ['camera_start', 'camera_refresh', 'read_coords', 'scan', 'grab_selected'].includes(command.key))

  const handleVoiceBubblePointerDown = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    voiceDragRef.current = {
      active: true,
      moved: false,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handleVoiceBubblePointerMove = (event) => {
    if (!voiceDragRef.current.active) return

    const size = 60
    const margin = 10
    const maxX = Math.max(margin, window.innerWidth - size - margin)
    const maxY = Math.max(margin, window.innerHeight - size - 88)
    const x = Math.min(Math.max(event.clientX - voiceDragRef.current.offsetX, margin), maxX)
    const y = Math.min(Math.max(event.clientY - voiceDragRef.current.offsetY, margin), maxY)

    voiceDragRef.current.moved = true
    setVoiceBubblePosition({ x, y })
  }

  const handleVoiceBubblePointerUp = (event) => {
    if (!voiceDragRef.current.active) return

    const wasMoved = voiceDragRef.current.moved
    voiceDragRef.current.active = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)

    if (voiceBubblePosition) {
      const size = 60
      const margin = 10
      const snapX = voiceBubblePosition.x + size / 2 < window.innerWidth / 2 ? margin : window.innerWidth - size - margin
      const y = Math.min(Math.max(voiceBubblePosition.y, margin), Math.max(margin, window.innerHeight - size - 88))
      const nextPosition = { x: snapX, y }
      setVoiceBubblePosition(nextPosition)
      safeStorageSet('floatingVoiceAssistantPosition', JSON.stringify(nextPosition))
    }

    if (!wasMoved) {
      requestNativeVoice('start')
    }
  }

  const sendCameraStartDebug = async (source = 'debug') => {
    const url = `${normalizeHost(deviceHost)}/feature/vision`
    const body = JSON.stringify({ cmd: 'start_camera' })

    updateVoiceDebug({
      source,
      commandKey: 'camera_start',
      requestUrl: url,
      requestBody: body,
      httpStatus: 'pending',
      responseText: '--',
      fetchError: '--',
    })

    setVisionPreviewActive(true)
    setVisionCoordinate((current) => ({
      ...current,
      status: '正在开启摄像头',
    }))

    try {
      const response = await requestWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await response.text()

      updateVoiceDebug({
        httpStatus: String(response.status),
        responseText: text || '(empty response)',
        fetchError: '--',
      })

      if (!response.ok) {
        throw new Error(text || `HTTP ${response.status}`)
      }

      setConnectionState('connected')
      setVisionCoordinate((current) => ({
        ...current,
        status: '摄像头已打开，点击刷新画面',
      }))
      setLastMessage('camera_start 已发送到主板')
      addHistory('打开摄像头', 'POST /feature/vision {"cmd":"start_camera"}')
      await new Promise((resolve) => window.setTimeout(resolve, 800))
      await fetchVisionFrame({ allowThrottle: false, readResult: true })
      return { ok: true, status: response.status, text }
    } catch (error) {
      const message = error?.message || 'camera_start 请求失败'
      updateVoiceDebug({
        httpStatus: '--',
        fetchError: message,
      })
      setVisionCoordinate((current) => ({
        ...current,
        status: '摄像头打开失败',
      }))
      setLastMessage(`camera_start 失败：${message}`)
      throw error
    }
  }

  const testDeviceStatusDebug = async () => {
    const url = `${normalizeHost(deviceHost)}/status`

    updateVoiceDebug({
      source: 'debug',
      commandKey: 'status',
      requestUrl: url,
      requestBody: '(GET)',
      httpStatus: 'pending',
      responseText: '--',
      fetchError: '--',
    })

    try {
      const response = await requestWithTimeout(url, {
        method: 'GET',
        cache: 'no-store',
      })
      const text = await response.text()

      updateVoiceDebug({
        httpStatus: String(response.status),
        responseText: text || '(empty response)',
        fetchError: '--',
      })

      setConnectionState(response.ok ? 'connected' : 'disconnected')
      setLastMessage(response.ok ? '/status 测试成功' : `/status 返回 HTTP ${response.status}`)
    } catch (error) {
      const message = error?.message || '/status 请求失败'
      updateVoiceDebug({
        httpStatus: '--',
        fetchError: message,
      })
      setConnectionState('disconnected')
      setLastMessage(`/status 测试失败：${message}`)
    }
  }

  const executeVoiceCommand = async (command, source) => {
    const now = Date.now()
    const delta = now - lastVoiceCommandAtRef.current

    updateVoiceDebug({
      source,
      commandKey: command.key,
      ignoredReason: 'none',
      rateLimited: '否',
      rateLimitDetail: `now=${now}, last=${lastVoiceCommandAtRef.current}, delta=${delta}ms, source=${source}, commandKey=${command.key}`,
      fetchError: '--',
    })

    if (lastVoiceCommandAtRef.current > 0 && delta < VOICE_COMMAND_INTERVAL_MS) {
      const reason = `命令被限流忽略：delta=${delta} ms`
      updateVoiceDebug({
        rateLimited: '是',
        ignoredReason: 'throttle',
        rateLimitDetail: `${reason}, now=${now}, last=${lastVoiceCommandAtRef.current}, source=${source}, commandKey=${command.key}`,
      })
      setVoiceStatusMessage(reason)
      setLastMessage(reason)
      return
    }

    lastVoiceCommandAtRef.current = now
    lastVoiceCommandSourceRef.current = source
    lastVoiceCommandKeyRef.current = command.key
    setCurrentVoiceSource(source === 'app' ? 'APP' : '主板')
    setCurrentVoiceCommand(command.key)
    setLastVoiceExecuteTime(new Date(now).toLocaleTimeString())
    setVoiceStatusMessage(`${source === 'app' ? 'APP' : '主板'} 执行：${command.label}`)
    showFloatingVoiceCard({
      tone: 'running',
      title: '正在执行',
      result: source === 'app' ? appVoiceText : boardVoiceText,
      command: command.key,
      status: '发送中',
    })

    if (!isConnected) {
      setLastMessage('主板未连接，请先连接主板网络或检查设备地址')
      showFloatingVoiceCard({
        tone: 'error',
        title: '主板未连接',
        result: source === 'app' ? appVoiceText : boardVoiceText,
        command: command.key,
        status: '请检查设备地址',
      }, true)
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
        if (command.key === 'camera_start') {
          await sendCameraStartDebug(source)
        } else {
          await runFeatureDetailAction(command.featureKey, command.actionLabel)
        }
      } else if (command.type === 'frame') {
        await refreshVisionAndReadTargets({ allowThrottle: false })
        addHistory(command.label, `VOICE ${source} -> GET /camera/frame`)
      } else if (command.type === 'armCalibration') {
        setActiveSection('features')
        setActiveFeature('calibration')
        window.scrollTo(0, 0)
        const result = await sendArmCalibrationCommand(command.cmd)
        if (!result.ok) throw new Error('calibration failed')
        if (command.cmd === 'start') {
          setCalibrationStatus('标定中')
          setCalibrationTorqueStatus('已关闭')
        } else if (command.cmd === 'stop') {
          setCalibrationStatus('已完成')
          setCalibrationTorqueStatus('已开启')
          setPendingCalibrationCorner(null)
        } else if (command.cmd.startsWith('record_')) {
          const cornerKey = command.cmd.replace('record_', '')
          setRecordedCorners((current) => ({ ...current, [cornerKey]: true }))
        }
        addHistory(command.label, `VOICE ${source} -> POST ${API_PATHS.arm.calibration}`)
      } else if (command.type === 'grabSelected') {
        const ok = await grabSelectedVisionTarget()
        if (!ok) throw new Error('grab failed')
      } else if (command.type === 'armGrabStop') {
        const ok = await stopGrab()
        if (!ok) throw new Error('grab stop failed')
      }
      if (isVisionRelatedCommand(command)) {
        navigateToVisionPage()
      }
      showFloatingVoiceCard({
        tone: 'success',
        title: '识别完成',
        result: source === 'app' ? appVoiceText : boardVoiceText,
        command: command.key,
        status: '已发送',
      }, true)
      setLastMessage(`${source === 'app' ? 'APP' : '主板'} 语音指令已执行：${command.label}`)
    } catch {
      showFloatingVoiceCard({
        tone: 'error',
        title: '执行失败',
        result: source === 'app' ? appVoiceText : boardVoiceText,
        command: command.key,
        status: '主控暂未响应',
      }, true)
      setLastMessage(`${command.label} 执行失败，主控暂未响应`)
    }
  }

  const handleVoiceText = (text, source) => {
    const normalizedText = normalizeVoiceText(text)
    const command = mapVoiceCommand(text)

    updateVoiceDebug({
      rawText: text || '--',
      normalizedText: normalizedText || '--',
      lastText: text || '--',
      source,
      commandKey: command?.key || '未匹配',
      ignoredReason: command ? 'none' : 'no_match',
      requestUrl: command ? voiceDebug.requestUrl : '--',
      requestBody: command ? voiceDebug.requestBody : '--',
      httpStatus: command ? voiceDebug.httpStatus : '--',
      responseText: command ? voiceDebug.responseText : '--',
      fetchError: command ? voiceDebug.fetchError : '--',
    })

    if (source === 'app') {
      setAppVoiceText(text)
      setReceivedVoiceCommand(text)
    } else {
      setBoardVoiceText(text)
    }

    if (!command) {
      setVoiceStatusMessage('未识别到可执行命令')
      setLastMessage(`未匹配语音指令：${text}`)
      showFloatingVoiceCard({
        tone: 'error',
        title: '未识别到语音',
        result: text || '请重说',
        command: '--',
        status: '请重说',
      }, true)
      updateVoiceDebug({
        fetchError: `未匹配语音命令：${text}`,
      })
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

      showFloatingVoiceCard({
      tone: isStart ? 'listening' : 'idle',
      title: isStart ? '正在监听...' : '已停止监听',
      result: isStart ? '请说出指令' : appVoiceText,
      command: currentVoiceCommand,
      status: isStart ? '识别中' : '已停止',
    }, !isStart)

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
      showFloatingVoiceCard({
        tone: 'error',
        title: '语音不可用',
        result: '当前设备不支持系统语音识别',
        command: '--',
        status: '请更换设备或使用小智',
      }, true)
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
        setVoiceStatusMessage(detail.message || '手机语音状态已更新')
        setLastMessage(detail.message || '手机语音状态已更新')
        setVoiceDiag((previous) => ({
          ...previous,
          localeId: detail.localeId || previous.localeId,
          lastStatus: detail.lastStatus || detail.message || previous.lastStatus,
          lastError: detail.lastError || previous.lastError,
          debug: detail.debug || previous.debug,
          listening: Boolean(detail.listening),
          environment: 'Flutter APP',
        }))
        if (detail.debug) {
          updateVoiceDebug({
            fetchError: detail.debug,
          })
        }
        return
      }

      if (detail.type === 'error') {
        const rawMessage = detail.error || detail.message || '手机语音识别错误'
        const message =
          rawMessage.includes('speech_unavailable') ||
          rawMessage.includes('No Android speech recognition service found')
            ? '当前设备不支持系统语音识别，请更换支持语音识别的安卓设备，或使用小智语音控制。'
            : rawMessage
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
        showFloatingVoiceCard({
          tone: detail.isFinal ? 'success' : 'listening',
          title: detail.isFinal ? '识别结果' : '正在识别',
          result: detail.text,
          command: currentVoiceCommand,
          status: detail.isFinal ? '处理中' : '识别中',
        }, false)
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

        handleVoiceText(detail.text, 'app')
      }
    }

    const handleNativeVoiceStatus = (event) => {
      const detail = event.detail || {}
      const message = detail.message || detail.lastStatus || '手机语音状态已更新'
      setVoiceStatusMessage(message)
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
      const rawMessage = detail.error || detail.message || '手机语音识别错误'
      const message =
        rawMessage.includes('speech_unavailable') ||
        rawMessage.includes('No Android speech recognition service found')
          ? '当前设备不支持系统语音识别，请更换支持语音识别的安卓设备，或使用小智语音控制。'
          : rawMessage
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
                <span>桌面整理</span>
                <span>机械臂</span>
              </h1>
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
          <section id="features" className={`page-section control-section ${activeFeature ? 'feature-detail-section' : ''}`}>
            {!activeFeature ? (
              <>
                <div className="section-hero">
                  <div>
                    <p className="eyebrow">Intelligent Control</p>
                    <h2>功能控制</h2>
                  </div>
                  <span className="section-pill">{featureModules.filter((feature) => feature.key !== 'voice').length} 项能力</span>
                </div>
                <div className="feature-module-grid">
                  {featureModules.filter((feature) => feature.key !== 'voice').map((feature) => (
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
                        ?.items.filter((item) => item.command !== 'read_vision_result').map((item, index) => (
                          <button
                            type="button"
                            className={index === 0 ? 'primary-vision-action' : ''}
                            key={item.label}
                            disabled={item.command === 'refresh_frame' && isFetchingFrame}
                            onClick={() => runFeatureDetailAction('vision', item.label)}
                          >
                            <strong>
                              {item.command === 'refresh_frame'
                                ? isFetchingFrame ? '刷新中...' : '刷新识别'
                                : item.label}
                            </strong>
                            <em>{item.command === 'refresh_frame' ? '刷新图片并读取目标' : item.detail}</em>
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

                    <div className="vision-target-list-card">
                      <div className="module-top compact-module-top">
                        <h3>识别目标</h3>
                        <span className="module-status">{visionTargets.length ? `${visionTargets.length} 个目标` : '待读取'}</span>
                      </div>
                      <div className="vision-target-list">
                        {visionTargets.length > 0 ? (
                          visionTargets.map((target, index) => (
                            <button
                              type="button"
                              key={`${target.id}-${target.className}-${index}`}
                              className={selectedVisionTargetIndex === index ? 'active' : ''}
                              onClick={() => selectVisionTarget(target, index)}
                            >
                              <span>目标{target.id || index + 1}</span>
                              <strong>{target.className}</strong>
                              <em>
                                cx={target.cx} cy={target.cy}
                                {target.score !== null ? ` · ${target.score}%` : ''}
                              </em>
                            </button>
                          ))
                        ) : (
                          <p>点击“显示坐标”读取识别目标</p>
                        )}
                      </div>
                    </div>

                    <div className="vision-grab-card">
                      <div>
                        <span>当前选中</span>
                        <strong>
                          {selectedVisionTarget
                            ? `${selectedVisionTarget.className || 'target'} #${selectedVisionTarget.id || selectedVisionTargetIndex + 1}`
                            : '暂无目标'}
                        </strong>
                        <em>
                          {selectedVisionTarget
                            ? `cx=${selectedVisionTarget.cx} cy=${selectedVisionTarget.cy}`
                            : '请先读取并选择目标'}
                        </em>
                      </div>
                      <div className="vision-grab-actions">
                        <button type="button" disabled={!selectedVisionTarget || isGrabbingTarget} onClick={grabSelectedVisionTarget}>
                          {isGrabbingTarget ? '抓取中...' : '抓取选中目标'}
                        </button>
                        <button type="button" onClick={stopGrab}>
                          停止抓取
                        </button>
                      </div>
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

                {activeFeature === 'calibration' && (
                  <>
                    <div className="calibration-status-grid">
                      <div className="calibration-status-card dark">
                        <span>标定状态</span>
                        <strong>{calibrationStatus}</strong>
                      </div>
                      <div className="calibration-status-card">
                        <span>扭矩状态</span>
                        <strong>{calibrationTorqueStatus}</strong>
                      </div>
                      <div className="calibration-status-card">
                        <span>四角记录</span>
                        <strong>{Object.values(recordedCorners).filter(Boolean).length}/4</strong>
                      </div>
                    </div>

                    <div className="calibration-lcd-card">
                      <div className="calibration-lcd-icon" aria-hidden="true" />
                      <div>
                        <span>LCD 本地预览</span>
                        <strong>校准时请查看板端 LCD 摄像头画面</strong>
                        <em>APP 端图片传输已关闭，只保留校准指令与状态，降低主控压力。</em>
                      </div>
                    </div>

                    <div className="calibration-panel">
                      <div className="module-top compact-module-top">
                        <h3>四角标定</h3>
                        <span className="module-status">{pendingCalibrationCorner === 'exit' ? '记录脱离点' : pendingCalibrationCorner ? '记录中' : '手动选择'}</span>
                      </div>
                      <div className="calibration-corner-grid">
                        {calibrationCorners.map((corner) => (
                          <button
                            type="button"
                            key={corner.key}
                            className={pendingCalibrationCorner === corner.key ? 'active' : ''}
                            onClick={() => startCalibrationCorner(corner)}
                          >
                            <span>{corner.label}</span>
                            <strong>{recordedCorners[corner.key] ? '已记录' : '未记录'}</strong>
                          </button>
                        ))}
                      </div>
                      <div className="calibration-guide-card">
                        <span>操作提示</span>
                        <strong>
                          {pendingCalibrationCorner
                            ? pendingCalibrationCorner === 'exit'
                              ? '请手动移动机械臂到抓取后的脱离位置，然后点击完成记录。'
                              : calibrationCorners.find((corner) => corner.key === pendingCalibrationCorner)?.hint
                            : '点击任意角点开始标定，板端会启动摄像头并在 LCD 显示画面，APP 不拉取图片。'}
                        </strong>
                        <button type="button" disabled={!pendingCalibrationCorner} onClick={completeCalibrationCorner}>
                          完成记录
                        </button>
                      </div>
                    </div>

                    <div className="calibration-action-grid">
                      <button type="button" onClick={showCalibration}>
                        <strong>查看标定</strong>
                        <em>显示四角与转换参数</em>
                      </button>
                      <button type="button" onClick={stopCalibration}>
                        <strong>结束标定</strong>
                        <em>开启扭矩并保留记录</em>
                      </button>
                      <button type="button" onClick={setCalibrationExit}>
                        <strong>设置脱离位置</strong>
                        <em>记录抓取后的退出点</em>
                      </button>
                      <button type="button" onClick={clearCalibrationExit}>
                        <strong>清除脱离位置</strong>
                        <em>不清除四角记录</em>
                      </button>
                    </div>
                  </>
                )}

                {activeFeature === 'place' && (
                  <div className="place-setting-panel">
                    <div className="place-guide-card">
                      <span>SET PLACE POINT</span>
                      <strong>先解锁拖动，再保存当前位置</strong>
                      <p>至少先设置 0 号默认区。抓取时 APP 会按目标类别自动携带 placeCategory，M33 抓取完成后会自动选择对应放置区。</p>
                      <button type="button" onClick={showPlaceStatus}>刷新/打印状态</button>
                    </div>

                    <div className="place-category-list">
                      {PLACE_CATEGORIES.map((item) => (
                        <article className="place-category-card" key={item.id}>
                          <div className="place-category-main">
                            <span>#{item.id}</span>
                            <div>
                              <strong>{item.title}</strong>
                              <em>{item.className}</em>
                              <p>{item.desc}</p>
                            </div>
                          </div>
                          <div className="place-category-actions">
                            <button type="button" onClick={() => runPlaceCommand('unlock', item.id)}>
                              解锁拖动
                            </button>
                            <button type="button" className="primary-place-action" onClick={() => runPlaceCommand('lock', item.id)}>
                              保存当前位置
                            </button>
                            <button type="button" onClick={() => runPlaceCommand('clear', item.id)}>
                              清除
                            </button>
                          </div>
                          <small>{placeCommandStatus[item.id] || '状态未知，等待设置命令'}</small>
                        </article>
                      ))}
                    </div>
                  </div>
                )}

                {activeFeature === 'voice' && (
                  <div className="voice-assistant-notice">
                    <div className="voice-orb-small" aria-hidden="true">
                      <span className="voice-wave">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                    <div>
                      <span>/VOICE ASSISTANT</span>
                      <h3>语音助手已启用</h3>
                      <p>请点击右下角悬浮语音按钮开始识别。识别到视觉相关指令后，APP 会自动进入视觉识别页面。</p>
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

      <div className="floating-voice-assistant" aria-live="polite">
        {floatingVoiceCard.visible && (
          <div className={`floating-voice-card ${floatingVoiceCard.tone}`}> 
            <button type="button" className="floating-voice-close" onClick={closeFloatingVoiceCard} aria-label="关闭语音状态">
              ×
            </button>
            <span>{floatingVoiceCard.title}</span>
            <strong>{floatingVoiceCard.result}</strong>
            <div>
              <em>执行命令：{floatingVoiceCard.command || '--'}</em>
              <em>状态：{floatingVoiceCard.status}</em>
            </div>
          </div>
        )}
        <button
          type="button"
          className={`voice-float-button ${isVoiceListening ? 'listening' : ''} ${floatingVoiceCard.tone}`}
          style={voiceBubblePosition ? { left: voiceBubblePosition.x, top: voiceBubblePosition.y, right: 'auto', bottom: 'auto' } : undefined}
          onPointerDown={handleVoiceBubblePointerDown}
          onPointerMove={handleVoiceBubblePointerMove}
          onPointerUp={handleVoiceBubblePointerUp}
          onPointerCancel={handleVoiceBubblePointerUp}
          aria-label="启动语音助手"
        >
          <span className="voice-ring" />
          <span className="voice-ring voice-ring-two" />
          <span className="voice-wave" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
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
