# ADR-005: 构建与分发

**日期**: 2026-08-17  
**状态**: 已采纳

## 背景

需要将 VS Code 前端构建产物嵌入 Go 二进制，同时最大化构建缓存利用率。

## 决策

- **构建流程**：Docker 容器内 clone `microsoft/vscode`（固定 commit），`npm ci` + `gulp compile-client`，产物复制到 `data/dist/`，Go 侧 `embed.FS` 嵌入
- **缓存策略**：VS Code 前端构建产物作为独立构建层，仅 commit 变更时重编。Go 代码变更复用前端缓存
- **VS Code 版本锁定**：固定 commit，不自动追上游。更新频率按需
- **分发**：`go-task build` 一键构建，产出单一静态二进制
- **基础镜像**：推荐 alpine（~5MB），二进制兼容 scratch 但不提供终端

## 构建优化（待实现）

```
# 伪代码
if data/dist/ 已存在 && VS Code commit 未变:
    skip npm ci + gulp compile-client
else:
    重新构建前端
go build -o code-server-go
```

## 理由

- 前端构建（`npm ci` + `gulp`）是耗时大头，缓存可节省 90% 构建时间
- 固定 commit 保证可复现，避免上游 breakage
- 单二进制分发符合 "scratch/alpine 无依赖" 目标
