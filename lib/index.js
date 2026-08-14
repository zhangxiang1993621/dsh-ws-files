/**
 * dsh-ws-files —— host 半：工作空间文件浏览器 API。
 *
 * 提供 /ws-files 路由（JSON）：
 *   GET  /ws-files?action=workspaces                 -> 列出所有工作区 {id, path}
 *   GET  /ws-files?action=list&root=<id>&path=<rel>  -> 列出工作区目录
 *   GET  /ws-files?action=read&root=<id>&path=<rel>  -> 读取文本文件内容
 *   GET  /ws-files?action=stat&root=<id>&path=<rel>  -> 文件/目录元信息
 *   GET  /ws-files?action=search&root=<id>&q=<词>     -> 按文件名搜索（限深 4 层、2000 条）
 *   GET  /ws-files?action=open&root=<id>&path=<rel>   -> 用系统默认程序打开
 *   POST /ws-files?action=write&root=<id>&path=<rel>  -> 写文件（body: {"content": "..."}，需客户端确认）
 *
 * 安全：
 *   - 只允许在 workspaceRegistry 已登记的工作区根目录内读写（路径围栏）
 *   - 写操作由浏览器端用户确认后发起（宿主不做无确认写入）
 */

import { resolve as pathResolve, sep } from 'node:path'
import { URL } from 'node:url'
import { spawn } from 'node:child_process'

/** Cordis 插件名（与 patch 行名一致）。 */
export const name = 'dsh-ws-files'

/** 依赖的服务：webServer（HTTP 路由）、fs（文件系统）、workspaceRegistry（工作区登记表）。 */
export const inject = ['webServer', 'fs', 'workspaceRegistry']

/** POST body 上限（1 MB）。 */
const MAX_BODY = 1024 * 1024
/** 搜索边界：最多递归深度与命中条数。 */
const SEARCH_DEPTH = 4
const SEARCH_MAX = 2000

/** 统一的 JSON 响应。 */
function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 流式读取请求体（带大小上限）。 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) {
      const err = new Error('body too large')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** 路径围栏：解析结果必须落在工作区根目录内，否则抛 403。 */
function resolveInWorkspace(ws, rel) {
  const base = ws.path.endsWith(sep) ? ws.path : ws.path + sep
  const abs = pathResolve(ws.path, rel)
  if (abs !== ws.path && !abs.startsWith(base)) {
    const err = new Error('outside workspace')
    err.status = 403
    throw err
  }
  return abs
}

/** 用系统默认程序打开文件/目录（Windows: start；其他平台: xdg-open）。 */
function openWithDefaultApp(abs) {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? (process.env.ComSpec ?? 'cmd.exe') : 'xdg-open'
  const args = isWin ? ['/c', 'start', '', abs] : [abs]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

/** 插件主体：注册 /ws-files 前缀路由。 */
export function apply(ctx) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.searchParams.get('action') ?? 'list'

      // 1) 工作区列表（客户端选根目录用）
      if (action === 'workspaces') {
        const items = ctx.workspaceRegistry.list().map(w => ({ id: String(w.id), path: w.path }))
        return sendJson(res, 200, { ok: true, workspaces: items })
      }

      // 2) 其余动作都需要 root 工作区
      const root = url.searchParams.get('root')
      const ws = root === null ? undefined : ctx.workspaceRegistry.get(root)
      if (ws === undefined) {
        return sendJson(res, 400, { ok: false, error: 'unknown workspace' })
      }

      // 3) 搜索：按文件名匹配（递归，带边界）
      if (action === 'search') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        const hits = []
        const walk = async (relPath, depth) => {
          if (hits.length >= SEARCH_MAX || depth > SEARCH_DEPTH) return
          let entries = []
          try {
            const target = await ctx.fs.resolve(resolveInWorkspace(ws, relPath))
            entries = await ctx.fs.listDir(target)
          } catch {
            return
          }
          for (const e of entries) {
            const childPath = relPath ? relPath + '/' + e.name : e.name
            if (e.type === 'directory') {
              if (depth < SEARCH_DEPTH) await walk(childPath, depth + 1)
            } else if (q !== '' && e.name.toLowerCase().includes(q)) {
              hits.push({ path: childPath, name: e.name, type: e.type })
              if (hits.length >= SEARCH_MAX) return
            }
          }
        }
        if (q !== '') await walk('', 0)
        return sendJson(res, 200, { ok: true, matches: hits })
      }

      // 4) 用系统默认程序打开
      if (action === 'open') {
        const abs = resolveInWorkspace(ws, url.searchParams.get('path') ?? '')
        openWithDefaultApp(abs)
        return sendJson(res, 200, { ok: true })
      }

      // 5) 写文件（POST，body: {"content": "..."}；浏览器端已确认）
      if (req.method === 'POST' && action === 'write') {
        const abs = resolveInWorkspace(ws, url.searchParams.get('path') ?? '')
        const target = await ctx.fs.resolve(abs)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type !== 'file') {
          return sendJson(res, 400, { ok: false, error: 'target is not a regular file' })
        }
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        }
        if (typeof body.content !== 'string') {
          return sendJson(res, 400, { ok: false, error: 'content required' })
        }
        // 显式沙箱策略：写入仅限所选工作区根目录内（与路径围栏一致）
        await ctx.fs.writeText(target, body.content, undefined, undefined, {
          mode: 'workspace-write',
          workspaceRoot: ws.path,
        })
        return sendJson(res, 200, { ok: true })
      }

      // 6) 只读动作
      const abs = resolveInWorkspace(ws, url.searchParams.get('path') ?? '')
      const target = await ctx.fs.resolve(abs)

      if (action === 'read') {
        const content = await ctx.fs.readText(target)
        return sendJson(res, 200, { ok: true, content })
      }
      if (action === 'stat') {
        const info = await ctx.fs.stat(target)
        return sendJson(res, 200, { ok: true, info })
      }
      // 默认：列出目录
      const entries = await ctx.fs.listDir(target)
      const list = entries.map(e => ({ name: e.name, type: e.type, size: e.size }))
      return sendJson(res, 200, { ok: true, path: url.searchParams.get('path') ?? '', entries: list })
    } catch (err) {
      const status = err && err.status ? err.status : 500
      const message = err instanceof Error ? err.message : String(err)
      return sendJson(res, status, { ok: false, error: message })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/ws-files', handler }),
    'ws-files: route',
  )
}
