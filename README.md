# code-server-go

`code-server-go` 是一个 pure Go 原型项目：它直接提供官方 VS Code Web Workbench，并把文件系统和终端能力接到 Go 后端上。

当前目标不是完整复刻 `code-server`，而是先做出一个可用的浏览器开发环境 MVP，至少包含：

- 官方 VS Code 界面
- 打开本地工作区目录
- 浏览、打开、编辑、保存文件
- 在浏览器里打开并使用宿主机终端

当前实现不走 VS Code 默认的远程链路，不使用 `remoteAuthority`，也不依赖 `/oss-dev`。

## 这个项目是干什么的

这个项目把 VS Code 当成“官方前端外壳”，由 Go 进程直接提供后端能力。

当前 Go 服务负责：

- 提供嵌入后的 VS Code 静态资源 `dist/`
- 提供自定义 workbench bootstrap：`web/static/workbench.js`
- 提供文件系统 API：`/api/fs/*`
- 提供终端 websocket：`/ws/terminal`

浏览器端通过自定义的 `code-server://` 文件系统 provider 挂载工作区，而不是走默认 remote server 协议。

## 前置条件

需要：

- Go `1.26.1` 或更新版本
- `PATH` 上可用的 Node.js
- 一个已经完成前端构建产物的 VS Code 源码目录
  - `out/`
  - `resources/`
  - `node_modules/@xterm`

默认情况下，构建脚本会优先把当前仓库目录当作 VS Code 源码目录；如果这里没有这些产物，就需要显式设置 `VSCODE_REPO_ROOT=/path/to/vscode`。

构建脚本会把这些资源复制到 `dist/`，然后由 Go 二进制通过 `embed` 打包进去。

## 如何构建

在仓库根目录执行：

```bash
cd scripts/go-script
VSCODE_REPO_ROOT=/path/to/vscode go run . build
```

这个命令会做两件事：

- 把前端静态资源复制到 `dist/`
- 构建服务端二进制到 `data/bin/code-server-go`

如果当前仓库本身就放在一个带构建产物的 VS Code 工作树里，可以省略 `VSCODE_REPO_ROOT`。

如果 `dist/` 已经存在，只想单独编译 Go 服务端，可以执行：

```bash
go build ./cmd/code-server-go
```

## 如何运行

服务端会把“当前工作目录”当作工作区根目录。

例如：

```bash
cd /path/to/workspace
CODE_SERVER_GO_ADDR=127.0.0.1:8080 /path/to/vscgo/data/bin/code-server-go
```

然后在浏览器里打开：

```text
http://127.0.0.1:8080
```

说明：

- 如果不设置 `CODE_SERVER_GO_ADDR`，默认监听 `:8080`
- 浏览器中打开的工作区，就是你启动服务时所在的目录

如果 `dist/` 已经构建好，也可以直接从源码运行：

```bash
cd /path/to/workspace
go run /path/to/vscgo/cmd/code-server-go
```

## 如何跑 E2E

执行：

```bash
cd scripts/go-script
VSCODE_REPO_ROOT=/path/to/vscode go run . e2e
```

这个 e2e 流程会：

- 构建 `dist/` 和服务端二进制
- 启动一个临时本地服务
- 用 Playwright 打开官方 VS Code workbench
- 校验没有 `/oss-dev` websocket
- 编辑并保存文件
- 创建终端并执行命令

报告输出目录：

```text
data/e2e/runs/
```

## 当前范围

当前已经验证通过的能力：

- 官方 workbench 正常渲染
- 单目录工作区
- 文件打开、编辑、保存
- 终端创建和命令执行

当前还不完整的能力：

- 文件 watch 和外部修改同步
- 搜索
- Git / SCM
- 完整 web 扩展生命周期
- Webview / Notebook
- 会话恢复
- 调试 / 任务 / 测试
