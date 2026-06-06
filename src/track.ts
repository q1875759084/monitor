import { enqueue } from './reporter'
import type { MonitorConfig } from './types'

// initTrack 调用后保存 config 引用，供 trackEvent 使用
// 未初始化时调用 trackEvent 静默失败，不抛异常
let _config: MonitorConfig | null = null

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 获取当前页面路径（不含 query / hash，避免高基数导致数据爆炸）
 *
 * 例：https://example.com/goods/123?tab=1 → /goods/123
 */
function getPagePath(): string {
  return location.pathname
}

// ─── PV 自动上报 ──────────────────────────────────────────────────────────────

/**
 * 上报一次 PV
 *
 * name 固定为 'page_view'，url 记录完整地址（含 query），
 * 用于还原用户进入的具体 URL；分析时按 pathname 聚合。
 */
function reportPV(config: MonitorConfig): void {
  enqueue({
    appKey: config.appKey,
    type: 'track',
    name: 'page_view',
    url: location.href,
    ua: navigator.userAgent,
    timestamp: Date.now(),
    props: {
      // 独立记录 path，方便后端按路径聚合，无需在查询时再截取 url
      path: getPagePath(),
      referrer: document.referrer,
    },
  })
}

/**
 * 劫持 History API，监听 SPA 路由变化
 *
 * 浏览器原生 popstate 只响应浏览器前进/后退，
 * pushState / replaceState 不触发任何事件，需要手动 patch。
 *
 * 通过派发自定义事件 'spa_navigation' 统一收口，
 * 避免 initTrack 内部直接修改 History 原型，职责清晰。
 */
function patchHistory(): void {
  const patchMethod = (
    original: typeof history.pushState,
  ): typeof history.pushState => {
    return function patchedMethod(
      this: History,
      ...args: Parameters<typeof history.pushState>
    ) {
      const result = original.apply(this, args)
      window.dispatchEvent(new Event('spa_navigation'))
      return result
    }
  }

  history.pushState = patchMethod(history.pushState)
  history.replaceState = patchMethod(history.replaceState)
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

/**
 * 初始化行为埋点模块
 *
 * 功能：
 * 1. 自动 PV 上报：页面首次加载 + SPA 路由切换（pushState / replaceState / popstate）
 * 2. 暴露 trackEvent 供业务手动埋点
 *
 * 调用时机：在 init() 中调用，早于首屏渲染，确保首次 PV 不丢失。
 */
export function initTrack(config: MonitorConfig): void {
  _config = config

  // 首次加载上报
  reportPV(config)

  // patch History API，使 pushState / replaceState 可被监听
  patchHistory()

  // SPA 路由切换（pushState / replaceState）
  window.addEventListener('spa_navigation', () => {
    reportPV(config)
  })

  // 浏览器前进/后退
  window.addEventListener('popstate', () => {
    reportPV(config)
  })
}

// ─── 手动埋点 API ─────────────────────────────────────────────────────────────

/**
 * 手动上报自定义事件
 *
 * 用于采集页面中有业务含义的用户行为，如：
 * - 按钮点击（button_click）
 * - 表单提交（form_submit）
 * - 功能模块曝光（module_expose）
 * - 搜索行为（search）
 *
 * props 为自由扩展字段，由调用方定义，SDK 不做约束。
 * 建议团队内部约定 props 命名规范，避免字段散乱。
 *
 * @param eventName  事件名称，建议使用 snake_case（如 'add_to_cart'）
 * @param props      附加属性，描述事件的上下文信息
 *
 * @example
 * // 按钮点击
 * trackEvent('button_click', { buttonId: 'submit', page: 'checkout' })
 *
 * @example
 * // 搜索行为
 * trackEvent('search', { keyword: '耳机', resultCount: 42 })
 *
 * @example
 * // ErrorBoundary 内调用（搭配 error.ts 的 trackError 使用）
 * trackEvent('module_error_boundary', { module: 'GoodsCard', errorMsg: error.message })
 */
export function trackEvent(
  eventName: string,
  props?: Record<string, unknown>,
): void {
  if (!_config) return

  enqueue({
    appKey: _config.appKey,
    type: 'track',
    name: eventName,
    url: location.href,
    ua: navigator.userAgent,
    timestamp: Date.now(),
    props,
  })
}
