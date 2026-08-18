# ADR-003: 文件系统设计

**日期**: 2026-08-17  
**状态**: 已采纳

## 背景

对标 code-server 的文件浏览体验，支持多工作区，不隐藏 `.git`。

## 决策

- **多工作区**：启动时可通过参数或环境变量指定多个 workspace root，前端文件树可切换
- **路径安全**：每个文件操作校验目标路径在工作区范围内，防止目录穿越
- **`.git` 可见**：不再过滤 `.git` 目录，用户可浏览版本控制元数据
- **API 设计**：

| 方法 | 路由 | 功能 |
|---|---|---|
| GET/POST | `/api/fs/stat` | 文件/目录元信息 |
| GET/POST | `/api/fs/readdir` | 目录列表 |
| GET/POST | `/api/fs/tree` | 递归目录树 |
| GET/PUT | `/api/fs/file` | 读写文件 |
| POST | `/api/fs/mkdir` | 创建目录 |
| DELETE | `/api/fs/entry` | 删除 |
| POST | `/api/fs/rename` | 重命名/移动 |

## 理由

- REST 风格 API 易于调试，前端 File System Provider 直接映射
- 路径安全在服务端做，不信任浏览器端输入
- 多工作区能力对标 code-server 的 "Add Folder to Workspace"
