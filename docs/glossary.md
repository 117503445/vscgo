# vscgo 术语表

| 术语 | 定义 |
|---|---|
| **vscgo** | 项目代号，pure Go 实现的 VS Code Web 轻量 IDE。单一静态二进制，内嵌 VS Code Workbench 前端，Go 后端提供文件系统与终端能力。 |
| **Workbench** | VS Code 的浏览器端 UI 壳，包含编辑器、侧边栏、状态栏等。vscgo 复用官方构建产物，不走 remote server 协议。 |
| **File System Provider** | 浏览器端注册的 `code-server://` scheme 文件系统。VS Code 通过此 provider 与 Go 后端的 `/api/fs/*` REST 接口通信，替代默认的 Node.js 文件服务。 |
| **Workbench Bootstrap** | 自定义 `workbench.js`，在 Workbench 启动时注入 `code-server://` FS provider 和终端 websocket 连接，劫持默认远程链路。 |
| **Embed FS** | Go 1.16+ 的 `embed.FS`，将 VS Code 前端构建产物（`dist/`）编译进二进制，实现零外部依赖部署。 |
| **PTY** | Pseudo-Terminal，伪终端。Go 后端通过 `creack/pty` 创建宿主 shell 进程，WebSocket 双向转发输入输出。 |
| **Workspace** | 工作区目录，即用户打开的代码仓库根路径。vscgo 支持多工作区，文件操作限制在工作区范围内。 |
| **Auth Token** | 简易鉴权。通过环境变量 `CODE_SERVER_GO_AUTH` 传入明文 token，浏览器端持久化存储。不传则免密。 |
| **Scratch** | Docker 的空白基础镜像，无 shell、无 libc。vscgo 二进制兼容 scratch，但终端功能需 shell 环境（如 alpine）。 |
