import { enqueue } from './reporter'
import type { MonitorConfig } from './types'

// initError 调用后保存 config 引用，供 trackError 使用
// 未初始化时调用 trackError 静默失败，不抛异常
let _config: MonitorConfig | null = null

/**
 * 错误采样去重
 *
 * 同一条错误在页面生命周期内可能被触发成百上千次（如循环里的 TypeError）。
 * 用 Set 缓存「错误指纹」（message + source + line），相同指纹只上报一次。
 * 不使用 LRU 是因为页面生命周期有限，Set 不会无限膨胀。
 */
const reportedErrors = new Set<string>()

function makeFingerprint(...parts: (string | number | undefined)[]): string {
  return parts.map(String).join('|')
}

function shouldReport(fingerprint: string): boolean {
  if (reportedErrors.has(fingerprint)) return false
  reportedErrors.add(fingerprint)
  return true
}

// ─── 公共工具 ─────────────────────────────────────────────────────────────────

/**
 * 从 Error 实例或字符串提取 message / stack
 * 所有上报路径的基础字段，保证这两个字段一定存在
 */
function extractErrorInfo(error: Error | string | unknown): {
  message: string
  stack: string
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack ?? '',
    }
  }
  if (typeof error === 'string') {
    return { message: error, stack: '' }
  }
  // 非标准 reject 值（如直接 reject(42)、reject({ code: 1 })）
  try {
    return { message: JSON.stringify(error), stack: '' }
  } catch {
    return { message: String(error), stack: '' }
  }
}

// ─── JS 运行时错误 ────────────────────────────────────────────────────────────

function handleJsError(
  config: MonitorConfig,
  event: ErrorEvent,
): void {
  const { message, filename, lineno, colno, error } = event

  // 跨域脚本错误：浏览器出于安全隐藏了详情，message 固定为 "Script error."
  // 这类错误没有 stack，上报意义有限，但保留以便统计跨域脚本异常数量
  const { stack } = extractErrorInfo(error ?? message)
  const fingerprint = makeFingerprint(message, filename, lineno)

  if (!shouldReport(fingerprint)) return

  enqueue({
    appKey: config.appKey,
    type: 'error',
    name: 'js_error',
    url: location.href,
    ua: navigator.userAgent,
    timestamp: Date.now(),
    props: {
      // 基础字段（message / stack）始终存在，特有字段追加在后
      // 调用方如需覆盖可通过 trackError 的 extraProps 传入
      message,
      stack,
      filename: filename ?? '',
      lineno: lineno ?? 0,
      colno: colno ?? 0,
    },
  })
}

// ─── 未处理的 Promise 异常 ────────────────────────────────────────────────────

function handleUnhandledRejection(
  config: MonitorConfig,
  event: PromiseRejectionEvent,
): void {
  const { message, stack } = extractErrorInfo(event.reason)
  const fingerprint = makeFingerprint('promise_rejection', message)

  if (!shouldReport(fingerprint)) return

  enqueue({
    appKey: config.appKey,
    type: 'error',
    name: 'promise_rejection',
    url: location.href,
    ua: navigator.userAgent,
    timestamp: Date.now(),
    props: { message, stack },
  })
}

// ─── 资源加载错误（图片 / 脚本 / 样式 404 等）────────────────────────────────

function handleResourceError(
  config: MonitorConfig,
  event: Event,
): void {
  const target = event.target as HTMLElement | null
  if (!target) return

  // 只处理资源类元素；JS 运行时错误也会冒泡到 window error，
  // 但那类 event.target === window，这里通过 tagName 过滤
  const tagName = target.tagName?.toLowerCase()
  if (!tagName || !['img', 'script', 'link', 'audio', 'video'].includes(tagName)) return

  const src =
    (target as HTMLImageElement).src ||
    (target as HTMLScriptElement).src ||
    (target as HTMLLinkElement).href ||
    ''

  const fingerprint = makeFingerprint('resource_error', tagName, src)
  if (!shouldReport(fingerprint)) return

  enqueue({
    appKey: config.appKey,
    type: 'error',
    name: 'resource_error',
    url: location.href,
    ua: navigator.userAgent,
    timestamp: Date.now(),
    props: {
      // 资源错误没有 JS 堆栈，message 用 src 描述，stack 保留空字符串保持结构一致
      message: `Failed to load ${tagName}: ${src}`,
      stack: '',
      tagName,
      src,
    },
  })
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

/**
 * 初始化错误监控
 *
 * 监听三类错误：
 * - js_error：window.onerror，捕获同步/异步运行时错误
 * - promise_rejection：unhandledrejection，捕获未处理的 Promise 失败
 * - resource_error：capture 阶段 error 事件，捕获资源加载失败
 */
export function initError(config: MonitorConfig): void {
  _config = config

  // JS 运行时错误
  window.addEventListener('error', (event: ErrorEvent) => {
    // ErrorEvent 有 message 字段，区别于普通 Event（资源错误）
    if (event.message !== undefined) {
      handleJsError(config, event)
    }
  })

  // 资源加载错误（必须在 capture 阶段监听，资源错误不冒泡）
  window.addEventListener(
    'error',
    (event: Event) => {
      handleResourceError(config, event)
    },
    true, // capture 阶段
  )

  // 未处理的 Promise 异常
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    handleUnhandledRejection(config, event)
  })
}

// ─── 手动上报 API ─────────────────────────────────────────────────────────────

/**
 * 手动上报错误
 *
 * 用于补充自动捕获覆盖不到的场景：
 * - ErrorBoundary 的 componentDidCatch（React 捕获后不再冒泡到 window）
 * - axios / fetch 拦截器中消化的接口错误（建议携带 traceId）
 * - try/catch 块中需要记录的非预期已处理错误
 *
 * props 结构：{ message, stack } 为基础字段，extraProps 追加在后，
 * 可覆盖基础字段（如 ErrorBoundary 想自定义 message），也可追加新字段（如 traceId）。
 *
 * @param error      Error 实例或错误描述字符串
 * @param extraProps 附加信息，merge 到 props 末尾
 *
 * @example
 * // ErrorBoundary
 * componentDidCatch(error: Error, info: React.ErrorInfo) {
 *   trackError(error, { componentStack: info.componentStack })
 * }
 *
 * @example
 * // axios 拦截器（携带 traceId，便于关联后端日志）
 * trackError(new Error(`${url} → ${code}`), { url, code, method, traceId })
 */
export function trackError(
  error: Error | string,
  extraProps?: Record<string, unknown>,
): void {
  if (!_config) return

  const { message, stack } = extractErrorInfo(error)

  // 手动上报不走去重：
  // 业务层已经做了 try/catch，不会出现循环触发；
  // 且不同调用点的 extraProps 不同（如不同 componentStack），去重反而丢数据
  enqueue({
    appKey: _config.appKey,
    type: 'error',
    name: 'manual_error',
    url: location.href,
    ua: navigator.userAgent,
    timestamp: Date.now(),
    // message / stack 作为基础字段保底，extraProps 追加在后可以覆盖或补充，如traceId
    props: { message, stack, ...extraProps },
  })
}
