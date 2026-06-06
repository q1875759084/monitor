import { initReporter, flushImmediate } from './reporter'
import { initPerf } from './perf'
import { initError, trackError } from './error'
import { initTrack, trackEvent } from './track'
import type { MonitorConfig } from './types'

export type { MonitorConfig, MonitorEvent, MonitorEventType, MonitorEnv } from './types'
export { trackError, trackEvent }

/**
 * 初始化监控 SDK，放在应用入口调用一次
 */
export function init(config: MonitorConfig) {
  initReporter(config)
  initPerf(config)
  initError(config)
  initTrack(config)

  // 页面切换到后台时立即上报，防止数据因页面卸载而丢失
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushImmediate()
    }
  })
}
