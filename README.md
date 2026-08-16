# dsh-ws-files — 工作空间文件浏览器（DeepSeek Harness 插件）

在 DeepSeek Harness 的 Web 前端直接查看/编辑**工作空间**的文件：树形目录浏览、文件名搜索、系统默认程序打开、在线编辑保存（写前确认）。面板注册进布局的左/右区域（由 `dsh-layout` 渲染），点击文件会在「对话 / 轨迹」同级的标签页中打开内容。

![plugin](https://img.shields.io/badge/dsh-plugin-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## 功能

- **布局区域 pane**：注册进 `layout.left` / `layout.right`（id `ws-files`），可被 `dsh-layout` 分配到左侧或右侧区域；随当前会话工作区自动切换
- **树形目录**：工作区根 → 逐层展开/折叠（懒加载），文件夹加粗、显示大小
- **搜索**：按文件名（不区分大小写）搜索，命中可直达
- **打开**：用系统默认程序打开文件/目录
- **文件标签页**：点击文件在「对话 / 轨迹」同级打开标签页（`conversation.view`）并自动激活、**直接进入编辑模式**；标签条上直接有 × 可关闭
- **编辑器高亮**：编辑时实时**关键词/注释/字符串/数字着色**（叠层高亮，不打断输入）
- **智能缩进**：`Enter` 自动缩进（复制上一行并遇 `{ [ (` 或 Python `:` 加深一层），`Tab` 缩进、`Shift+Tab` 反缩进
- **自动保存**：改动后防抖自动写入（无确认框），状态栏显示 保存中/已保存/失败；`Ctrl+S` 立即保存
- **撤销/重做**：`Ctrl+Z` 撤销、`Ctrl+Y`（或 `Ctrl+Shift+Z`）重做
- **类 IDE 预览**：预览模式带行号、按文件类型做**关键词/注释/字符串高亮**，按缩进层级**折叠代码块（方法体折叠）**，并按类型设置缩进宽度（`tab-size`）
- 多工作区切换（下拉选择 `workspaceRegistry` 中已登记的任一工作区）

## 架构

| 半 | 文件 | 作用 |
|---|---|---|
| host | `lib/index.js` | Cordis 插件行：`inject ['webServer','fs','workspaceRegistry']`，注册 `/ws-files` JSON 路由 |
| client | `lib/client.js` | 浏览器 bundle（`__ModuleLoader__` 协议，纯手工编写，仅 external 平台模块）：`layout.left` / `layout.right` 面板 + `conversation.view` 文件标签页 |
| 声明 | `package.json` | `dsh.bundle.patch`（挂载 host 行）+ `dsh.client`（客户端声明）+ `exports["./client"]` |

## API（host 半）

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/ws-files?action=workspaces` | 所有工作区 `{id, path}` |
| GET | `/ws-files?action=list&root=&path=` | 列目录 `{name, type, size}[]` |
| GET | `/ws-files?action=read&root=&path=` | 读文本内容 |
| GET | `/ws-files?action=stat&root=&path=` | 元信息 |
| GET | `/ws-files?action=search&root=&q=` | 按文件名搜索（限深 4 层 / 2000 条） |
| GET | `/ws-files?action=open&root=&path=` | 系统默认程序打开 |
| POST | `/ws-files?action=write&root=&path=` | 写文件，body `{"content": "..."}`（客户端已确认） |

## 安装

```bash
# 在 deepseek-harness 仓库目录
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add file:/绝对/路径/dsh-ws-files
# 或开发期用 link:（改源码只刷新页面即生效）
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add link:/绝对/路径/dsh-ws-files
# 重启 dsh web 生效
```

## 安全设计

- **路径围栏**：所有读写都限制在 `workspaceRegistry` 已登记的工作区根目录内（realpath 校验，越界返回 403）
- **写沙箱**：写入显式携带 `workspace-write` + 所选工作区根的沙箱策略（宿主 fs 策略层双重把关）
- **写前确认**：浏览器端保存前弹确认框，用户即审批者；不提供删除端点
- **只读优先**：list / read / stat / search / open 默认可用，write 需用户主动操作

## 开发备注

- 客户端 bundle 无构建链：手工维护 `__ModuleLoader__` 协议格式，仅 external 10 个平台模块（react / react-dom / @deepseek-ai/cordis / client-ui-* 等），其余代码全部内联
- 槽位：`layout.left` / `layout.right`（布局区域 pane，list 槽，id=`ws-files`，由 `dsh-layout` 声明渲染）+ `conversation.view`（文件标签页，list 槽，id=`ws-files-<fileId>`，动态注册/注销）
