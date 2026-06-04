# 架构设计

## 定位

`@q1875759084/monitor` 是一个轻量前端监控 SDK，面向个人项目（video-to-audio、carry-hub、security-quiz-game 等），提供性能采集、错误监控、行为埋点、白屏检测四类能力。

设计目标：**通用 SDK 不含业务逻辑，各项目通过薄封装接入**，对齐企业私有 npm 模式。

---

## 分层结构

```
业务项目（video-to-audio 等）
  └── src/utils/monitor.ts      # 薄封装：组装 appKey、调用 init/trackEvent
        ↓ import
@q1875759084/monitor（本仓库）
  ├── perf.ts                   # 性能采集（web-vitals）
  ├── error.ts                  # 错误捕获
  ├── track.ts                  # 行为埋点
  ├── blank-screen.ts           # 白屏检测
  └── reporter.ts               # 上报队列（所有模块共用）
        ↓ HTTP POST
后端 /monitor/collect           # 接收上报数据，存 SQLite
        ↓
/monitor/stats                  # 聚合查询，供大盘消费
```

---

## 模块职责

| 文件 | 职责 |
|---|---|
| `types.ts` | 公共类型定义（MonitorEvent、MonitorConfig） |
| `reporter.ts` | 上报队列：100ms 批量合并、sendBeacon 优先、fetch 降级 |
| `perf.ts` | 接入 web-vitals，采集 FCP/LCP/CLS/FID/TTFB/INP |
| `error.ts` | 全局 onerror + unhandledrejection 捕获 |
| `track.ts` | PV 自动上报 + trackEvent 手动埋点 |
| `blank-screen.ts` | 对角线多点采样检测白屏 |
| `index.ts` | 统一入口，export init 和各公共 API |

---

## 关键设计决策

### 上报方式：sendBeacon 优先

`sendBeacon` 在页面卸载（关闭/跳转）时也能保证数据送达，不受页面生命周期限制。
`fetch + keepalive` 作为降级方案，兼容 sendBeacon 不支持的场景（如队列已满）。

### 批量合并上报

100ms 内产生的事件合并为一次请求，避免性能指标触发时产生大量并发请求。

### development 环境不上报

`config.env === 'development'` 时跳过上报，开启 `debug: true` 则在 console 打印事件内容，方便本地调试。

### peerDependencies：web-vitals

`web-vitals` 作为 peerDependency 而非 dependency，避免业务项目打包时重复引入两份 web-vitals。

---

## 数据结构

```ts
interface MonitorEvent {
  appKey: string                        // 来源应用标识
  type: 'perf' | 'error' | 'track' | 'blank_screen'
  name: string                          // 指标名：LCP / js_error / pv ...
  value?: number                        // 数值（性能指标）
  props?: Record<string, unknown>       // 附加信息（错误堆栈、自定义属性等）
  url: string                           // 当前页面 URL
  ua: string                            // UserAgent
  timestamp: number                     // 上报时间（unix ms）
}
```
