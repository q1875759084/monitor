# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-06-06

### Added

- `init(config)` — SDK 初始化入口，支持 `appKey` / `reportUrl` / `env` / `debug` 配置
- **perf.ts** — 接入 web-vitals，自动采集 FCP / LCP / CLS / TTFB / INP 五项性能指标
- **error.ts** — 自动捕获三类错误：JS 运行时错误、未处理 Promise rejection、资源加载失败
- `trackError(error, extraProps?)` — 手动上报已捕获错误（ErrorBoundary / 接口异常等）
- **track.ts** — SPA 路由 PV 自动上报（pushState / replaceState / popstate 全量覆盖）
- `trackEvent(eventName, props?)` — 手动上报自定义行为事件
- **reporter.ts** — 100ms 批量合并上报，sendBeacon 优先，fetch + keepalive 降级，visibilitychange 提前冲刷
- 错误去重机制：相同指纹（message + filename + lineno）在页面生命周期内只上报一次
