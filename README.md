# @cmjndy/monitor

轻量前端监控 SDK，提供性能采集、错误监控、行为埋点三类能力，面向多项目接入，不含业务逻辑。

## 安装

```bash
npm install @cmjndy/monitor
```

`web-vitals` 作为 SDK 的内部依赖，随 SDK 一起安装，无需额外操作。

## 快速开始

在应用入口文件（`main.tsx` / `index.tsx`）的**第一行**调用 `init`，确保在 React Router 等路由库实例化之前完成初始化：

```typescript
import { init } from '@cmjndy/monitor'

init({
  appKey: 'your-app-name',
  reportUrl: '/monitor/collect',
  env: 'production',
  debug: false,
})
```

## API

### `init(config)`

初始化 SDK，全局调用一次。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `appKey` | `string` | ✅ | 应用唯一标识，用于区分不同项目的数据 |
| `reportUrl` | `string` | ✅ | 上报接口地址，支持同域相对路径或完整 URL |
| `env` | `'development' \| 'staging' \| 'production'` | — | 控制是否上报。`development` 不上报（仅 debug 打印），其余正常上报。默认视为 `production` |
| `debug` | `boolean` | — | 开启后每条事件在 console 打印，方便本地验证。默认 `false` |

**`env` 与 `reportUrl` 的职责分工**：`env` 只控制"要不要上报"，环境间的数据隔离由 `reportUrl` 指向不同的后端实例来保证，SDK 本身不感知环境差异。

---

### `trackError(error, extraProps?)`

手动上报错误，补充自动捕获覆盖不到的场景。

```typescript
import { trackError } from '@cmjndy/monitor'
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `error` | `Error \| string` | Error 实例或错误描述字符串 |
| `extraProps` | `Record<string, unknown>` | 附加信息，merge 到上报数据的 props 字段 |

**典型用法**：

```typescript
// React ErrorBoundary
componentDidCatch(error: Error, info: React.ErrorInfo) {
  trackError(error, { componentStack: info.componentStack })
}

// axios 响应拦截器（携带 traceId 关联后端日志）
instance.interceptors.response.use(
  (res) => res,
  (error) => {
    const traceId = error.config?.metadata?.traceId
    trackError(error, { traceId, url: error.config?.url, status: error.response?.status })
    return Promise.reject(error)
  }
)
```

**注意**：`trackError` 不去重——业务层已做 try/catch，不会循环触发，且不同调用点的 `extraProps` 各不相同，去重会丢数据。

---

### `trackEvent(eventName, props?)`

手动上报自定义行为事件。

```typescript
import { trackEvent } from '@cmjndy/monitor'
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `eventName` | `string` | 事件名称，建议使用 snake_case |
| `props` | `Record<string, unknown>` | 事件附加属性，SDK 不做约束 |

```typescript
// 按钮点击
trackEvent('button_click', { buttonId: 'submit', page: 'checkout' })

// 搜索行为
trackEvent('search', { keyword: '耳机', resultCount: 42 })
```

---

## 自动采集能力

初始化后以下能力自动开启，无需额外代码：

| 能力 | 说明 |
|---|---|
| **性能指标** | FCP / LCP / CLS / TTFB / INP（基于 web-vitals） |
| **JS 错误** | `window.onerror` 捕获的未处理运行时错误 |
| **Promise 异常** | `unhandledrejection` 捕获的未处理 Promise 失败 |
| **资源加载错误** | 图片 / 脚本 / 样式 404 等加载失败 |
| **PV 上报** | 首次加载 + SPA 路由切换（pushState / replaceState / popstate）全量覆盖 |

**自动捕获的盲区**（需手动调用 `trackError`）：
- React ErrorBoundary 捕获的渲染错误
- axios / fetch 拦截器消化的接口错误
- 业务 try/catch 内处理的错误

---

## 接入示例

```typescript
// src/utils/monitor.ts（业务项目的薄封装）
import { init, trackError, trackEvent } from '@cmjndy/monitor'
import type { MonitorEnv } from '@cmjndy/monitor'

declare const __DEPLOY_ENV__: string

const ENV_MAP: Record<string, MonitorEnv> = {
  dev:        'development',
  test:       'staging',
  production: 'production',
}

const REPORT_URL_MAP: Record<string, string> = {
  test:       '/monitor/collect',
  production: '/monitor/collect',
}

export function initMonitor() {
  init({
    appKey: 'your-app-name',
    env: ENV_MAP[__DEPLOY_ENV__] ?? 'development',
    reportUrl: REPORT_URL_MAP[__DEPLOY_ENV__] ?? '',
    debug: __DEPLOY_ENV__ === 'dev',
  })
}

export { trackError, trackEvent }
```

```typescript
// src/main.tsx
import { initMonitor } from '@/utils/monitor'

initMonitor()  // 必须在第一行，早于路由库实例化

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
```

---

## 数据结构

每条上报事件的结构：

```typescript
interface MonitorEvent {
  appKey: string                                          // 来源应用
  type: 'perf' | 'error' | 'track' | 'blank_screen'     // 事件类型
  name: string                                           // 指标名
  value?: number                                         // 数值（性能指标）
  props?: Record<string, unknown>                        // 附加信息
  url: string                                            // 当前页面 URL
  ua: string                                             // UserAgent
  timestamp: number                                      // 上报时间 unix ms
}
```
