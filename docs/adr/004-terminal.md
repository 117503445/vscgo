# ADR-004: 终端设计

**日期**: 2026-08-17  
**状态**: 已采纳

## 背景

对标 code-server 的终端体验。需要宿主机 shell，不在 scratch 容器中提供终端。

## 决策

- **Shell 探测**：优先使用 `$SHELL` 环境变量，其次 `zsh` → `bash` → `sh`
- **PTY**：通过 `creack/pty` 创建伪终端，支持 resize（`SIGWINCH` 等价）
- **WebSocket**：`/ws/terminal?cwd=<path>` 双向转发，JSON 消息格式：
  - `{"type":"input","data":"..."}` 浏览器 → 服务端
  - `{"type":"output","data":"..."}` 服务端 → 浏览器
  - `{"type":"resize","cols":120,"rows":32}` 浏览器 → 服务端
  - `{"type":"exit"}` 服务端 → 浏览器
- **多终端**：每个 WebSocket 连接 = 一个独立 PTY session
- **无 shell 环境**：跳过终端功能，前端不展示终端 tab

## 理由

- 对标 code-server 终端行为：一个 tab 一个 shell，支持 resize
- `creack/pty` 是 Go 生态最成熟的 PTY 库
- scratch 环境自动降级，不报错
