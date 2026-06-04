import type { MonitorEvent, MonitorConfig } from './types'

let config: MonitorConfig | null = null
const queue: MonitorEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function initReporter(cfg: MonitorConfig) {
  config = cfg
}

/**
 * 将事件加入队列，100ms 内批量合并后一次上报
 * 避免每个事件单独发一个请求
 */
export function enqueue(event: MonitorEvent) {
  if (!config) return

  // development 环境不上报，未设置 env 时默认视为 production
  if (config.env === 'development') {
    if (config.debug) console.log('[monitor]', event)
    return
  }

  // staging / production 均正常上报，数据隔离由 reportUrl 区分

  if (config.debug) console.log('[monitor]', event)

  queue.push(event)

  // 已有 timer 等待中，不重复创建
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flush()
    flushTimer = null
  }, 100)
}

function flush() {
  if (!config || queue.length === 0) return

  // splice 取出全部，清空原队列
  const events = queue.splice(0, queue.length)
  const body = JSON.stringify({ events })
  const url = config.reportUrl

  // 优先 sendBeacon：页面卸载时不丢数据
  // sendBeacon 返回 false 表示队列满，降级到 fetch
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' })
    const sent = navigator.sendBeacon(url, blob)
    if (!sent) fetchReport(url, body)
  } else {
    fetchReport(url, body)
  }
}

function fetchReport(url: string, body: string) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true, // 允许请求在页面卸载后继续存活
  }).catch(() => {
    // 上报失败静默处理，不影响业务流程
  })
}

/**
 * 页面卸载前立即上报剩余队列（不等 100ms timer）
 * 在 visibilitychange hidden 时调用
 */
export function flushImmediate() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flush()
}
