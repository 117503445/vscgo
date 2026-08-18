# ADR-002: 鉴权方案

**日期**: 2026-08-17  
**状态**: 已采纳

## 背景

需要简易鉴权，对标 code-server 的用户体验。不引入多用户系统。

## 决策

采用**环境变量明文 token**：

```bash
CODE_SERVER_GO_AUTH=my-secret-token code-server-go
```

- 浏览器端：首次访问弹出 token 输入表单，验证通过后持久化在 `localStorage`
- 服务端：每次请求校验 `Authorization: Bearer <token>` 头
- 不传环境变量：免密模式，跳过鉴权
- 不做 session 过期、不做 token 刷新

## 理由

- 实现量最小（~50 行 Go），用户体验对标 code-server
- 环境变量避免 token 暴露在进程列表（`/proc`），Cloud Native 友好
- 免密模式覆盖本地开发场景
- 单用户场景不需要 session 管理

## 备选方案

- **启动参数 `--auth`**：与 code-server 一致，但 `argv` 会在 `/proc` 中暴露
- **密码文件**：多一层 indirection，但增加复杂度
