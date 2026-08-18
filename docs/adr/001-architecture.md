# ADR-001: 整体架构

**日期**: 2026-08-17  
**状态**: 已采纳

## 背景

需要一款给人类开发者使用的轻量 IDE，运行在容器中，不依赖 Node.js 运行时和 Linux 发行版。

## 决策

采用 **Go 单进程内嵌 VS Code Workbench** 架构：

```
┌──────────────────────────────────┐
│  code-server-go (single binary)  │
│                                  │
│  embed.FS: VS Code Workbench     │
│  ┌────────────────────────────┐  │
│  │ Go HTTP Server             │  │
│  │  /                  → HTML │  │
│  │  /static/*          → 静态 │  │
│  │  /api/fs/*          → 文件 │  │
│  │  /ws/terminal       → 终端 │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

- **前端**：复用官方 VS Code `compile-client` 产物，通过自定义 `workbench.js` 注入 `code-server://` FS provider
- **后端**：Go HTTP server 提供文件系统 REST API 和终端 WebSocket
- **不实现**：Remote Server 协议、Extension Host、LSP 桥接

## 理由

- 不走 VS Code 的 remote server 协议，避免逆向非公开协议
- 浏览器端保留 Monaco 编辑器的语法高亮（TextMate），无需后端
- 单二进制部署，`CGO_ENABLED=0`，兼容 scratch/alpine

## 后果

- 不支持 VS Code 扩展市场
- 语言智能仅限 Monaco 内置语法高亮
- 前端构建依赖 Node.js（构建时），运行时 0 依赖
