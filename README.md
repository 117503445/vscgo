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

- `PATH` 上可用的 `go-task` 命令
- `PATH` 上可用的 `podman` 命令

默认的 `go-task build` / `go-task e2e` / `go-task run` 都通过仓库根目录的 [Dockerfile](/workspace/project/vscgo/Dockerfile:1) 工作：

- 在容器里 clone `microsoft/vscode`
- checkout 到固定 commit `50f36fc4ffa240e366be854f001d3f1f7461b0bd`
- 执行 `npm ci`
- 执行 `npm run gulp compile-client`
- 构建并运行 `code-server-go`

这意味着从零开始不需要本地预先准备 `data/`、`dist/`，也不需要本地先把 VS Code 构建产物编出来。

## 如何构建

在仓库根目录执行：

```bash
go-task build
```

这个命令会构建运行镜像：

- 镜像名默认是 `localhost/vscgo:dev`
- 使用 Podman 的分层缓存
- 不依赖本地 `data/`

## 如何运行

`go-task run` 会先执行 `go-task build`，然后直接启动容器。

例如：

```bash
cd /path/to/vscgo
go-task run
```

然后在浏览器里打开：

```text
http://127.0.0.1:8080
```

说明：

- 如果不设置 `CODE_SERVER_GO_ADDR`，默认监听 `:8080`
- 浏览器中打开的工作区，就是仓库根目录被挂载到容器内的 `/workspace`

## 如何跑 E2E

执行：

```bash
go-task e2e
```

这个 e2e 流程会：

- 构建运行镜像和 e2e runner 镜像
- 启动一个临时 app 容器
- 在单独的 Playwright 容器里打开官方 VS Code workbench
- 校验没有 `/oss-dev` websocket
- 编辑并保存文件
- 创建终端并执行命令

报告输出目录：

```text
data/e2e/runs/
```

## 如何直接用 Podman 构建

如果不走 `go-task`，也可以直接执行：

```bash
podman build --layers \
  --build-arg VSCODE_COMMIT=<new-commit> \
  -t localhost/vscgo:dev .
```

然后运行：

```bash
podman run --rm -p 8080:8080 -v /path/to/workspace:/workspace -w /workspace localhost/vscgo:dev
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
