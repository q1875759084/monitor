export type MonitorEventType = 'perf' | 'error' | 'track' | 'blank_screen'

export interface MonitorEvent {
  appKey: string
  type: MonitorEventType
  name: string
  value?: number
  props?: Record<string, unknown>
  url: string
  ua: string
  timestamp: number
}

export type MonitorEnv = 'development' | 'staging' | 'production'

export interface MonitorConfig {
  /** 应用标识，用于区分不同项目的数据 */
  appKey: string
  /**
   * 上报接口地址
   * 测试/生产环境通过传不同 URL 隔离数据，SDK 不感知环境差异
   */
  reportUrl: string
  /**
   * 当前环境
   * - development：不上报，仅 debug 模式下打印
   * - staging / production：正常上报，数据隔离由 reportUrl 负责
   * 默认视为 production
   */
  env?: MonitorEnv
  /** 是否开启 debug 模式（console 输出上报内容） */
  debug?: boolean
}
