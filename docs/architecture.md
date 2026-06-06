# 架构设计

## 定位

`@cmjndy/monitor` 是一个轻量前端监控 SDK，面向个人项目（video-to-audio、carry-hub、security-quiz-game 等），提供性能采集、错误监控、行为埋点、白屏检测四类能力。

设计目标：**通用 SDK 不含业务逻辑，各项目通过薄封装接入**，对齐企业私有 npm 模式。

---

## 分层结构

```
业务项目（video-to-audio 等）
  └── src/utils/monitor.ts      # 薄封装：组装 appKey、调用 init/trackEvent
        ↓ import
@cmjndy/monitor（本仓库）
  ├── perf.ts                   # 性能采集（web-vitals）
  ├── error.ts                  # 错误捕获
  ├── track.ts                  # 行为埋点
  ├── blank-screen.ts           # 白屏检测（待实现）
  └── reporter.ts               # 上报队列（所有模块共用）
        ↓ HTTP POST
后端 /monitor/collect           # 接收上报数据，存 SQLite
        ↓
/monitor/stats                  # 聚合查询，供大盘消费
```

---

## 模块设计

### types.ts —— 公共类型

SDK 的唯一类型出口，所有模块从这里 import，不得在各模块内自行定义重复类型。

```typescript
// 事件类型枚举：对应四个采集模块
type MonitorEventType = 'perf' | 'error' | 'track' | 'blank_screen'

// 上报事件的统一结构，所有模块共用
interface MonitorEvent {
  appKey: string                    // 应用标识，区分不同项目数据（微前端场景下是唯一隔离手段）
  type: MonitorEventType            // 模块归属
  name: string                      // 具体指标名：LCP / js_error / page_view ...
  value?: number                    // 数值（性能指标用，其他类型不填）
  props?: Record<string, unknown>   // 附加信息：错误堆栈、自定义埋点属性等
  url: string                       // 事件发生时的完整页面 URL（含 query）
  ua: string                        // UserAgent
  timestamp: number                 // 上报时间 unix ms
}

// 初始化配置
interface MonitorConfig {
  appKey: string       // 应用标识
  reportUrl: string    // 上报接口地址，SDK 不感知环境，由业务层传入对应地址
  env?: MonitorEnv     // 控制是否上报：development 不上报，staging/production 正常上报
  debug?: boolean      // 开启后 console 打印每条事件，方便本地验证
}
```

**设计要点**：`env` 字段只控制"要不要上报"，不控制上报到哪里——环境隔离由 `reportUrl` 指向不同后端实例完成，SDK 本身无需感知环境差异。

---

### reporter.ts —— 上报队列

所有模块的唯一上报出口，其他模块只调用 `enqueue`，不直接发请求。

**核心机制**：

```
enqueue(event)
  → 推入内存队列
  → 启动 100ms 定时器（已有 timer 则跳过，防重复）
  → 100ms 后 flush()：批量序列化为一次 POST 请求
```

**上报方式优先级**：

```
sendBeacon（优先）
  优点：页面卸载时也能送达，不受生命周期限制
  限制：队列满时返回 false
    ↓ 降级
fetch + keepalive
  优点：兼容 sendBeacon 不支持的场景
  keepalive: true 允许请求在页面卸载后继续存活
```

**visibilitychange 提前冲刷**：

`init()` 中监听 `visibilitychange`，页面切到后台时立即调用 `flushImmediate()`——清除 timer，立即执行 flush。防止用户关闭标签页时 100ms 的 timer 还没触发、队列里的事件丢失。

**development 环境处理**：

```typescript
if (config.env === 'development') {
  if (config.debug) console.log('[monitor]', event)
  return   // 不进队列，不上报
}
```

dev 环境只打印不上报，避免本地调试数据污染测试/生产库。

---

### perf.ts —— 性能采集

接入 `web-vitals` 库，采集 Core Web Vitals 五项指标：

| 指标 | 全称 | 含义 | 单位 |
|---|---|---|---|
| FCP | First Contentful Paint | 首次内容绘制 | ms |
| LCP | Largest Contentful Paint | 最大内容绘制 | ms |
| CLS | Cumulative Layout Shift | 累计布局偏移 | 无单位小数 |
| TTFB | Time to First Byte | 首字节时间 | ms |
| INP | Interaction to Next Paint | 交互到下一帧绘制 | ms |

**CLS 的存储处理**：CLS 是小数（如 `0.023`），存储时 `×1000` 转整数（`23`），读取时 `/1000` 还原，避免浮点数精度问题和 SQLite INTEGER 列类型的约束。

**dependencies**：`web-vitals` 作为 dependency 而非 peerDependency，随 SDK 一起安装，业务项目无需额外操作。`peerDependencies` 适合 React、Vue 这类"业务项目一定已经安装"的包；`web-vitals` 是 SDK 的内部实现细节，业务项目通常不会自己用它，不适合做 peer，否则接入方每次都要手动安装一个自己不关心的包。

---

### error.ts —— 错误捕获

#### 职责定位

监听**逃逸到 `window` 的未处理错误**——没有任何业务代码接住它们，页面通常已经白屏或功能完全失效。这是被动兜底，不是主动采集。

```
能被自动捕获：
✅ 未被 try/catch 的运行时错误（TypeError、ReferenceError）
✅ 未被 .catch() 的 Promise rejection
✅ 图片 / 脚本 / 样式资源 404

不能自动捕获（需手动调用 trackError）：
❌ axios/fetch 拦截器消化的接口错误
❌ React ErrorBoundary 捕获的渲染错误（被 React 拦截，不冒泡到 window）
❌ 业务 try/catch 内处理的错误
```

#### 三类错误的监听方式

| 错误类型 | 监听方式 | 说明 |
|---|---|---|
| JS 运行时错误 | `window.addEventListener('error', handler)` | `ErrorEvent` 有 `message` 字段，以此区分资源错误 |
| 未处理 Promise | `window.addEventListener('unhandledrejection', handler)` | `event.reason` 可能是任意类型，需统一提取 |
| 资源加载错误 | `window.addEventListener('error', handler, true)` | **capture 阶段**，资源错误不冒泡，必须捕获阶段监听 |

#### 去重机制

同一条错误在循环里可能触发成百上千次（如 `setInterval` 里的 TypeError），用 `Set<string>` 缓存错误指纹（`message + filename + lineno`），相同指纹只上报一次。

```typescript
const reportedErrors = new Set<string>()  // 页面生命周期内不 GC，不使用 LRU
```

手动上报的 `trackError` **不走去重**：业务层已做 try/catch，不会循环触发；且不同调用点的 `extraProps` 不同（如不同 `componentStack`），去重反而丢数据。

#### trackError —— 手动上报 API

补充自动捕获覆盖不到的场景：

```typescript
// ErrorBoundary
componentDidCatch(error, info) {
  trackError(error, { componentStack: info.componentStack })
}

// axios 拦截器（携带 traceId 关联后端日志）
trackError(new Error(`${url} → ${code}`), { url, code, traceId })
```

`props` 结构：`{ message, stack }` 为基础字段保底，`extraProps` 追加在后，可覆盖基础字段，也可追加新字段（如 `traceId`）。

---

### track.ts —— 行为埋点

详见 [track.md](./track.md)。

**核心能力**：
- PV 自动上报：首次加载 + pushState/replaceState/popstate 全覆盖
- `trackEvent`：手动埋点，业务侧主动上报自定义事件

---

### blank-screen.ts —— 白屏检测（待实现）

**当前状态**：占位设计，尚未实现。

**解决的问题**：`error.ts` 能捕获 JS 崩溃导致的白屏，但无法发现"页面逻辑没报错、接口全部 pending、骨架屏永远不消失"这类沉默性白屏——用户看到的是空白，但 error 队列里什么都没有。

**设计方案**：在 `load` 事件或 FCP 触发后延迟采样，用 `document.elementsFromPoint` 对页面对角线上的多个坐标点取元素，若超过阈值比例的点命中的都是 `body` / `html` / `#root` 等根容器，判定为白屏并上报 `type: 'blank_screen'`。

**当前不实现的原因**：
1. 现有的 `error.ts`（JS 崩溃兜底）+ ErrorBoundary `trackError`（渲染层崩溃）已覆盖当前项目的主要白屏场景
2. 白屏检测的误报问题复杂——骨架屏、全屏 loading 在采样时也是"白屏"，需要业务侧额外约定（如在骨架屏上加特定 attribute）
3. 当前项目页面结构简单，沉默性白屏概率极低

**后续实现时的关键决策点**：
- 采样时机：`load` 后固定延迟（如 3s）还是 LCP 触发后？
- 误报抑制：如何区分骨架屏和真正的白屏？
- 采样密度：对角线几个点？

---

### index.ts —— 统一入口

对外暴露的内容：

```typescript
// 初始化函数（业务侧唯一必须调用的入口）
export function init(config: MonitorConfig): void

// 手动上报 API（按需使用）
export { trackError }   // 主动上报已捕获的错误
export { trackEvent }   // 主动上报自定义行为事件

// 类型导出
export type { MonitorConfig, MonitorEvent, MonitorEventType, MonitorEnv }
```

`init()` 内部按顺序调用各模块初始化：

```
initReporter(config)   // 1. 先初始化上报队列，后续模块的 enqueue 才有效
initPerf(config)       // 2. 注册 web-vitals 回调
initError(config)      // 3. 注册 window error / unhandledrejection 监听
initTrack(config)      // 4. 上报首次 PV，patch History API
```

**顺序约束**：`initReporter` 必须第一个，其余模块的 `enqueue` 调用依赖 reporter 已初始化。`initTrack` 必须在 React Router 实例化之前完成（见 track.md 时序说明）。

---

## 数据结构

### 上报事件（MonitorEvent）

```typescript
interface MonitorEvent {
  appKey: string                        // 来源应用标识
  type: 'perf' | 'error' | 'track' | 'blank_screen'
  name: string                          // 指标名：LCP / js_error / page_view ...
  value?: number                        // 数值（性能指标）
  props?: Record<string, unknown>       // 附加信息（错误堆栈、自定义属性等）
  url: string                           // 当前页面 URL（含 query）
  ua: string                            // UserAgent
  timestamp: number                     // 上报时间（unix ms）
}
```

### name 字段约定

| type | name 取值 | 说明 |
|---|---|---|
| `perf` | `FCP` `LCP` `CLS` `TTFB` `INP` | web-vitals 原始指标名 |
| `error` | `js_error` | window.error 捕获的运行时错误 |
| `error` | `promise_rejection` | unhandledrejection |
| `error` | `resource_error` | 资源加载失败 |
| `error` | `manual_error` | trackError 手动上报 |
| `track` | `page_view` | PV 自动上报 |
| `track` | 业务自定义 | trackEvent 传入，如 `button_click` |
| `blank_screen` | `blank_screen` | 白屏检测命中（待实现） |
