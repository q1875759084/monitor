import { onFCP, onLCP, onCLS, onTTFB, onINP } from 'web-vitals'
import { enqueue } from './reporter'
import type { MonitorConfig } from './types'

/**
 * 初始化性能监控
 *
 * 各指标说明：
 * - FCP (First Contentful Paint)：首次内容绘制，ms
 * - LCP (Largest Contentful Paint)：最大内容绘制，ms
 * - CLS (Cumulative Layout Shift)：累计布局偏移，无单位小数，存储时 ×1000 转整数
 * - TTFB (Time to First Byte)：首字节时间，ms
 * - INP (Interaction to Next Paint)：交互到下一帧绘制，ms（Core Web Vitals 新指标）
 */
export function initPerf(config: MonitorConfig) {
  const report = (name: string, value: number) => {
    enqueue({
      appKey: config.appKey,
      type: 'perf',
      name,
      // CLS 是小数（如 0.023），放大 1000 倍存为整数，读取时除以 1000 还原
      value: name === 'CLS' ? Math.round(value * 1000) : Math.round(value),
      url: location.href,
      ua: navigator.userAgent,
      timestamp: Date.now(),
    })
  }

  onFCP(({ name, value }) => report(name, value))
  onLCP(({ name, value }) => report(name, value))
  onCLS(({ name, value }) => report(name, value))
  onTTFB(({ name, value }) => report(name, value))
  onINP(({ name, value }) => report(name, value))
}
