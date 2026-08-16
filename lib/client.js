/**
 * dsh-ws-files —— client 半（浏览器）。
 *
 * 产物协议：window.__ModuleLoader__.load({ id, factory: (require) => ... })，
 * 外部模块（react 等）经注入的 require 从加载器模块表解析，其余全部内联。
 *
 * UI：侧栏底部"文件"按钮（sidebar.footer.action）+ 右侧停靠面板（details 列，自带可拖动分割线）。
 * 面板：工作区选择 + 文件搜索 + 树形目录浏览（懒加载/展开折叠），由 layout 服务开合。
 * 点击文件 → 在"对话/轨迹"同级打开标签页（conversation.view）并直接进入编辑模式。
 * 编辑模式：叠层高亮（关键词/注释/字符串/数字实时着色）+ 智能缩进（Enter 自动缩进、Tab/Shift+Tab），
 * 标签条上直接有 × 可关闭；改动自动保存（防抖），Ctrl+Z/Ctrl+Y 撤销/重做，Ctrl+S 立即保存。
 * 预览模式：行号 + 按文件类型高亮 + 按缩进层级折叠代码块（方法体折叠）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ws-files',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /* ---------- 轻量共享状态（按钮 ↔ 面板） ---------- */
    const store = {
      open: false,
      listeners: new Set(),
      set(v) {
        if (this.open === v) return
        this.open = v
        for (const fn of [...this.listeners]) fn(v)
      },
      toggle() { this.set(!this.open) },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
    }

    function useOpen() {
      const [open, setOpen] = React.useState(store.open)
      React.useEffect(() => store.subscribe(setOpen), [])
      return open
    }

    /* ---------- API ---------- */
    async function api(params) {
      const q = new URLSearchParams(params).toString()
      const res = await fetch('/ws-files?' + q)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || '请求失败')
      return data
    }

    async function apiPost(params) {
      const q = new URLSearchParams({ action: params.action, root: params.root, path: params.path }).toString()
      const res = await fetch('/ws-files?' + q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: params.content }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || '请求失败')
      return data
    }

    function fmtSize(n) {
      if (n === undefined) return ''
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1048576).toFixed(1) + ' MB'
    }

    /* ---------- 打开的文件（标签页）状态 ---------- */
    // 每个打开的文件 = 一个 conversation.view 标签页（与"对话/轨迹"同级）。
    // 内容在此集中加载 / 编辑 / 关闭，标签页注册由 apply() 里的 inject 同步。
    const openFiles = {
      files: {},                     // id -> { id, root, path, name, content, loading, error, editing, draft, folded }
      order: [],                     // 打开顺序（决定标签顺序）
      _seq: 0,
      listeners: new Set(),
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
      emit() { for (const fn of [...this.listeners]) fn() },
      list() { return this.order.map(id => this.files[id]).filter(Boolean) },
      get(id) { return this.files[id] },
      open(root, path, name, rootPath) {
        // 去重：同一工作区内的同一路径只开一个标签（已存在则复用其 id）
        const existing = this.list().find(f => f.root === root && f.path === path)
        if (existing) return existing.id
        const id = 'wsf-' + (++this._seq) + '-' + Date.now().toString(36)
        // 全路径：工作区根目录 + 相对路径（Windows 下统一转反斜杠展示）
        const fullPath = rootPath
          ? rootPath.replace(/[\\/]+$/, '') + '\\' + path.split('/').join('\\')
          : path
        this.files[id] = {
          id, root, path, name, fullPath, content: null, loading: true, error: null,
          editing: true, draft: '', folded: new Set(),               // 打开即编辑模式
          undoStack: [], redoStack: [],                               // 撤销/重做
          saving: false, saveError: null, savedAt: null, _saveTimer: null,
        }
        this.order.push(id)
        this.emit()
        this.load(id)
        return id
      },
      toggleFold(id, lineIndex) {
        const f = this.files[id]
        if (!f) return
        const set = f.folded || (f.folded = new Set())
        if (set.has(lineIndex)) set.delete(lineIndex)
        else set.add(lineIndex)
        this.emit()
      },
      // 防抖自动保存（改动后 800ms 静默写入）
      scheduleSave(id) {
        const f = this.files[id]
        if (!f || f.loading) return
        if (f._saveTimer) clearTimeout(f._saveTimer)
        f._saveTimer = setTimeout(() => { this.save(id) }, 800)
      },
      async save(id) {
        const f = this.files[id]
        if (!f || f.loading || f.saving) return
        const draftNow = f.draft
        if (draftNow === f.content) return
        // 还原原始换行符再写盘（CRLF 文件写回 CRLF，避免把 .bat 等写成 LF）
        const toSave = f.eol === '\r\n' ? draftNow.replace(/\n/g, '\r\n') : draftNow
        f.saving = true
        f.saveError = null
        this.emit()
        try {
          await apiPost({ action: 'write', root: f.root, path: f.path, content: toSave })
          const g = this.files[id]
          if (!g) return
          g.content = draftNow
          g.saving = false
          g.savedAt = Date.now()
          g.folded = new Set()                                // 行布局变化，重置折叠位置
          this.emit()
          if (g.draft !== g.content) this.scheduleSave(id)   // 保存期间又产生新改动
        } catch (e) {
          const g = this.files[id]
          if (!g) return
          g.saving = false
          g.saveError = String(e.message || e)
          this.emit()
        }
      },
      // 记录一步撤销快照：把「上一次内容」压栈（用于输入前调用）
      pushUndo(id, prevDraft) {
        const f = this.files[id]
        if (!f) return
        if (f.undoStack.length === 0 || f.undoStack[f.undoStack.length - 1] !== prevDraft) {
          f.undoStack.push(prevDraft)
          if (f.undoStack.length > 100) f.undoStack.shift()
        }
        f.redoStack.length = 0
      },
      undo(id) {
        const f = this.files[id]
        if (!f || f.undoStack.length === 0) return
        f.redoStack.push(f.draft)
        f.draft = f.undoStack.pop()
        this.emit()
        this.scheduleSave(id)
      },
      redo(id) {
        const f = this.files[id]
        if (!f || f.redoStack.length === 0) return
        f.undoStack.push(f.draft)
        f.draft = f.redoStack.pop()
        this.emit()
        this.scheduleSave(id)
      },
      async load(id) {
        const f = this.files[id]
        if (!f) return
        try {
          const d = await api({ action: 'read', root: f.root, path: f.path })
          if (!this.files[id]) return   // 加载完成前已关闭
          // 记录原始换行符，编辑器内部统一用 LF（保存时还原，避免 CRLF 影响编辑器渲染/分词）
          f.eol = d.content.indexOf('\r\n') !== -1 ? '\r\n' : '\n'
          const normalized = d.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          f.content = normalized
          f.draft = normalized
          f.loading = false
          f.error = null
        } catch (e) {
          if (!this.files[id]) return
          f.loading = false
          f.error = String(e.message || e)
        }
        this.emit()
      },
      update(id, patch) {
        const f = this.files[id]
        if (!f) return
        Object.assign(f, patch)
        this.emit()
      },
      close(id) {
        if (!this.files[id]) return
        delete this.files[id]
        this.order = this.order.filter(x => x !== id)
        this.emit()
      },
    }

    // 订阅 openFiles 的版本号（组件用它触发重渲染并读取最新文件数据）
    function useFilesVersion() {
      const [v, setV] = React.useState(0)
      React.useEffect(() => openFiles.subscribe(() => setV(x => x + 1)), [])
      return v
    }

    // 从标签按钮文本里去掉注入的关闭 ×（DOM 注入会在文件名后追加 ×）
    function tabName(btn) {
      return (btn.textContent || '').replace(/[×✕]/g, '').trim()
    }

    // 激活刚打开的文件标签：标签条由会话头渲染，按文件名匹配并点击（末个匹配 = 最新打开）
    function activateTab(name, tries) {
      tries = tries || 0
      let target = null
      const tabs = document.querySelectorAll('[role="tab"]')
      for (let i = 0; i < tabs.length; i++) {
        if (tabName(tabs[i]) === name) target = tabs[i]
      }
      if (target) { target.click(); return }
      if (tries < 20) setTimeout(() => activateTab(name, tries + 1), 50)
    }

    /* ---------- IDE 风格 SVG 文件图标（VS Code 式：彩色页面 + 折叠角 + 类型缩写） ---------- */
    // 扩展名 -> [底色, 缩写, 深色文字?]
    const ICON_TYPES = {
      ts: ['#3178c6', 'TS'], tsx: ['#3178c6', 'TSX'], mts: ['#3178c6', 'MTS'], cts: ['#3178c6', 'CTS'],
      js: ['#f7df1e', 'JS', 1], jsx: ['#f7df1e', 'JSX', 1], mjs: ['#f7df1e', 'MJS', 1], cjs: ['#f7df1e', 'CJS', 1],
      py: ['#3776ab', 'PY'], pyc: ['#3776ab', 'PYC'], pyi: ['#3776ab', 'PYI'],
      java: ['#b07219', 'JA'], jar: ['#b07219', 'JAR'],
      c: ['#555555', 'C'], h: ['#555555', 'H'], cpp: ['#f34b7d', 'C++'], hpp: ['#f34b7d', 'H++'], cc: ['#f34b7d', 'CC'],
      go: ['#00add8', 'GO'], rs: ['#dea584', 'RS'], rb: ['#701516', 'RB'], php: ['#4f5d95', 'PHP'],
      cs: ['#178600', 'CS'], swift: ['#f05138', 'SW'], kt: ['#a97bff', 'KT'], kts: ['#a97bff', 'KTS'],
      lua: ['#000080', 'LUA'], r: ['#198ce7', 'R'], dart: ['#0175c2', 'DART'], scala: ['#c22d40', 'SCALA'],
      sh: ['#89e051', 'SH'], bash: ['#89e051', 'SH'], zsh: ['#89e051', 'ZSH'], bat: ['#4d5a5e', 'BAT'], cmd: ['#4d5a5e', 'CMD'], ps1: ['#012456', 'PS1'],
      html: ['#e34c26', 'HTML'], htm: ['#e34c26', 'HTML'], css: ['#563d7c', 'CSS'], scss: ['#cd6799', 'SCSS'], sass: ['#cd6799', 'SASS'], less: ['#1d365d', 'LESS'], vue: ['#42b883', 'VUE'], svelte: ['#ff3e00', 'SVELT'],
      md: ['#083fa1', 'MD'], markdown: ['#083fa1', 'MD'], mdx: ['#083fa1', 'MDX'], txt: ['#6b7280', 'TXT'], rst: ['#6b7280', 'RST'], tex: ['#3d6117', 'TEX'],
      pdf: ['#e74c3c', 'PDF'], doc: ['#2b579a', 'DOC'], docx: ['#2b579a', 'DOCX'], ppt: ['#d24726', 'PPT'], pptx: ['#d24726', 'PPTX'], xls: ['#217346', 'XLS'], xlsx: ['#217346', 'XLSX'],
      json: ['#cbcb41', 'JSON'], yaml: ['#cb171e', 'YAML'], yml: ['#cb171e', 'YML'], toml: ['#8a9a5b', 'TOML'], ini: ['#8a9a5b', 'INI'], cfg: ['#8a9a5b', 'CFG'], conf: ['#8a9a5b', 'CONF'], xml: ['#e08e00', 'XML'],
      csv: ['#27ae60', 'CSV'], sql: ['#a31f34', 'SQL'], db: ['#a31f34', 'DB'], sqlite: ['#0f80cc', 'SQL'],
      lock: ['#c0392b', 'KEY'], env: ['#c0392b', 'ENV'], pem: ['#c0392b', 'PEM'], key: ['#c0392b', 'KEY'],
      png: ['#a074c4', 'PNG'], jpg: ['#a074c4', 'JPG'], jpeg: ['#a074c4', 'JPG'], gif: ['#a074c4', 'GIF'], svg: ['#a074c4', 'SVG'], webp: ['#a074c4', 'WEBP'], ico: ['#a074c4', 'ICO'], bmp: ['#a074c4', 'BMP'],
      mp3: ['#e91e63', 'MP3'], wav: ['#e91e63', 'WAV'], flac: ['#e91e63', 'FLAC'], ogg: ['#e91e63', 'OGG'], m4a: ['#e91e63', 'M4A'],
      mp4: ['#8e44ad', 'MP4'], avi: ['#8e44ad', 'AVI'], mkv: ['#8e44ad', 'MKV'], mov: ['#8e44ad', 'MOV'], webm: ['#8e44ad', 'WEBM'],
      zip: ['#e67e22', 'ZIP'], rar: ['#e67e22', 'RAR'], '7z': ['#e67e22', '7Z'], tar: ['#e67e22', 'TAR'], gz: ['#e67e22', 'GZ'], bz2: ['#e67e22', 'BZ2'], xz: ['#e67e22', 'XZ'], tgz: ['#e67e22', 'TGZ'],
      log: ['#6b7280', 'LOG'], map: ['#6b7280', 'MAP'], wasm: ['#654ff0', 'WASM'],
    }

    // 生成 16x16 文件图标 SVG（data URI）
    function fileIconSvg(name) {
      const dot = name.lastIndexOf('.')
      const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
      const t = ICON_TYPES[ext]
      const color = t ? t[0] : '#9ca3af'
      const label = t ? t[1] : ''
      const dark = !!(t && t[2])
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">'
        + '<path d="M4 1h6l3 3v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="' + color + '"/>'
        + '<path d="M10 1v3h3z" fill="rgba(0,0,0,0.18)"/>'
        + (label
            ? '<text x="7.6" y="11.2" font-family="Segoe UI,Arial,sans-serif" font-size="5" font-weight="700" text-anchor="middle" fill="' + (dark ? '#000' : '#fff') + '">' + label + '</text>'
            : '')
        + '</svg>'
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
    }

    // 生成文件夹图标 SVG（展开/折叠两种色调）
    function folderSvg(open) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">'
        + '<path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.3 1.5h7.1a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" fill="' + (open ? '#e8a33d' : '#f0c060') + '" stroke="rgba(0,0,0,0.18)"/>'
        + '</svg>'
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
    }

    const iconImgStyle = { width: 14, height: 14, verticalAlign: '-2px', marginRight: 4, flexShrink: 0 }

    /* ---------- 样式 ---------- */
    const S = {
      panel: {
        flex: 1, height: '100%', minHeight: 0, minWidth: 0,
        background: '#ffffff', color: '#1f1f1f',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif', fontSize: 13,
      },
      header: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', borderBottom: '1px solid #eee', fontWeight: 600,
      },
      close: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#888' },
      body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
      tree: { flex: 1, overflow: 'auto', padding: '4px 8px' },
      contentPane: {
        flexShrink: 0, maxHeight: '48%', display: 'flex', flexDirection: 'column',
        borderTop: '1px solid #eee', background: '#fafbfc', minHeight: 0,
      },
      contentHead: {
        fontSize: 12, color: '#666', padding: '6px 8px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      },
      contentPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      btn: {
        background: '#f0f2f5', border: '1px solid #d0d5dd', borderRadius: 4,
        padding: '2px 8px', fontSize: 12, cursor: 'pointer', color: '#1f1f1f',
      },
      btnPrimary: {
        background: '#2563eb', border: '1px solid #2563eb', borderRadius: 4,
        padding: '2px 8px', fontSize: 12, cursor: 'pointer', color: '#fff',
      },
      select: { width: '100%', marginBottom: 6, padding: 4, fontSize: 12, boxSizing: 'border-box' },
      searchRow: { display: 'flex', gap: 6, marginBottom: 6 },
      searchInput: { flex: 1, padding: 4, fontSize: 12, boxSizing: 'border-box', border: '1px solid #d0d5dd', borderRadius: 4 },
      row: { padding: '3px 2px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      hint: { color: '#999', fontSize: 12, padding: '2px 2px' },
      err: { color: '#d33', fontSize: 12, marginBottom: 6 },
      toast: {
        position: 'absolute', left: 8, right: 8, bottom: 8, zIndex: 10001,
        background: 'rgba(31,31,31,0.92)', color: '#fff', borderRadius: 6,
        padding: '8px 10px', fontSize: 12,
      },
      pre: {
        flex: 1, overflow: 'auto', background: '#f6f8fa', borderTop: '1px solid #e3e6ea',
        padding: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
      },
      textarea: {
        flex: 1, overflow: 'auto', border: 'none', outline: 'none', padding: 8,
        fontSize: 12, lineHeight: 1.5, fontFamily: 'Consolas, monospace', resize: 'none',
        background: '#ffffff', color: '#1f1f1f',
      },
      // 文件标签页视图（在"对话/轨迹"同级标签中渲染；高度由 JS 按可视区测量后固定）
      fileView: {
        display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
        boxSizing: 'border-box',
        background: '#ffffff', color: '#1f1f1f', fontSize: 13,
      },
      fileHead: {
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 6, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid #eee',
        fontSize: 12, color: '#666', background: '#ffffff',
      },
      fileFoot: {
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '4px 12px', borderTop: '1px solid #eee', background: '#fafbfc',
        fontSize: 11, color: '#9ca3af', minHeight: 22,
      },
      fileLoading: { padding: 12, color: '#999', fontSize: 12 },
      filePre: {
        flex: 1, overflow: 'auto', margin: 0, padding: 12, fontSize: 12, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        fontFamily: 'Consolas, "SF Mono", Menlo, monospace',
      },
      fileTextarea: {
        flex: 1, overflow: 'auto', border: 'none', outline: 'none', padding: 12,
        fontSize: 12, lineHeight: 1.5, fontFamily: 'Consolas, "SF Mono", Menlo, monospace',
        resize: 'none', background: '#ffffff', color: '#1f1f1f',
      },
    }

    /* ---------- 侧栏底部按钮 ---------- */
    function FooterActionButton(props) {
      const open = useOpen()
      const openPanel = props.openPanel
      return h('button', {
        onClick: () => (openPanel ? openPanel() : store.toggle()),
        title: '工作空间文件',
        style: {
          width: '100%', textAlign: 'left', background: 'none', border: 'none',
          cursor: 'pointer', padding: '8px 12px', fontSize: 13, color: open ? '#2563eb' : 'inherit',
        },
      }, '📁 文件')
    }

    /* ---------- 文件面板（布局区域内容：搜索 + 树；点击文件在标签页打开） ---------- */
    function WsFilesPanel(props) {
      const useSessions = props.useSessions
      const [workspaces, setWorkspaces] = React.useState([])
      const [wsId, setWsId] = React.useState(null)
      // tree: 相对路径 -> { loaded, loading, children, error }
      const [tree, setTree] = React.useState({})
      const [query, setQuery] = React.useState('')
      const [matches, setMatches] = React.useState(null)   // null=树模式；数组=搜索结果
      const [searching, setSearching] = React.useState(false)
      const [error, setError] = React.useState(null)
      // 当前工作区 id 的实时镜像：用于丢弃「切换工作区后返回的过期结果」
      const wsIdRef = React.useRef(null)
      React.useEffect(() => { wsIdRef.current = wsId }, [wsId])

      // 当前会话所属工作区根路径（跟随左侧工作区/会话切换）
      const currentCwd = useSessions
        ? useSessions(s => {
            const cur = s.current
            return cur !== undefined && s.byId[cur] !== undefined ? s.byId[cur].cwd : undefined
          })
        : undefined

      // 挂载即拉工作区列表（面板常驻 details 列，仅列宽决定显隐）
      React.useEffect(() => {
        api({ action: 'workspaces' }).then(d => {
          setWorkspaces(d.workspaces)
          if (wsId === null && d.workspaces.length > 0) setWsId(d.workspaces[0].id)
        }).catch(e => setError(String(e.message || e)))
      }, [])

      // 左侧切换工作区/会话后，自动把右侧面板选中的工作区同步过去（并刷新目录树）
      React.useEffect(() => {
        if (!currentCwd || workspaces.length === 0) return
        const norm = (p) => (p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
        const ws = workspaces.find(w => norm(w.path) === norm(currentCwd))
        if (ws && ws.id !== wsId) setWsId(ws.id)
      }, [currentCwd, workspaces])

      // 工作区切换：重置并强制重载根目录
      React.useEffect(() => {
        if (wsId === null) return
        setTree({})
        setMatches(null)
        setError(null)
        loadDir('', true)
      }, [wsId])

      const loadDir = async (path, force) => {
        const rootId = wsId
        if (rootId === null) return
        // 已加载/加载中则跳过（force 强制重载，用于切换工作区后清空旧树）
        if (!force && tree[path] && (tree[path].loaded || tree[path].loading)) return
        setTree(t => ({ ...t, [path]: { loaded: false, loading: true, children: [] } }))
        try {
          const d = await api({ action: 'list', root: rootId, path })
          if (wsIdRef.current !== rootId) return   // 已切换工作区，丢弃过期结果
          setTree(t => ({ ...t, [path]: { loaded: true, loading: false, children: d.entries } }))
        } catch (e) {
          if (wsIdRef.current !== rootId) return
          setTree(t => ({ ...t, [path]: { loaded: false, loading: false, children: [], error: String(e.message || e) } }))
        }
      }

      // 点击文件：在"对话/轨迹"同级打开标签页并自动激活（面板已停靠右侧，不再遮挡内容）
      const openFileTab = (path, name) => {
        const ws = workspaces.find(w => w.id === wsId)
        openFiles.open(wsId, path, name, ws ? ws.path : null)
        activateTab(name)
      }

      const toggle = (node, path) => {
        if (node.type === 'directory') {
          if (tree[path] && tree[path].loaded) {
            setTree(t => {
              const next = { ...t }
              delete next[path]
              return next
            })
          } else {
            loadDir(path)
          }
        } else {
          openFileTab(path, node.name)
        }
      }

      const doSearch = async () => {
        if (!wsId || !query.trim()) return
        setSearching(true)
        setError(null)
        try {
          const d = await api({ action: 'search', root: wsId, q: query.trim() })
          setMatches(d.matches)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setSearching(false)
        }
      }

      const renderNode = (node, path, depth, isLast) => {
        const isDir = node.type === 'directory'
        const st = tree[path]
        const expanded = !!(st && st.loaded)
        // 树形引导线：每一层用 │ 延续，末位用 └─，其余用 ├─，层级一目了然
        const guide = depth === 0
          ? ''
          : ('│  '.repeat(depth - 1) + (isLast ? '└─ ' : '├─ '))
        const kids = isDir && expanded && st.children && st.children.length > 0
          ? st.children.map((c, i) => renderNode(c, path ? path + '/' + c.name : c.name, depth + 1, i === st.children.length - 1))
          : null
        const emptyHint = isDir && expanded && st && st.children && st.children.length === 0
          ? h('div', { style: { ...S.hint, paddingLeft: 22 + (depth + 1) * 12 } }, '│  '.repeat(depth) + '（空目录）')
          : null
        return h('div', { key: path },
          h('div', {
            style: { ...S.row, paddingLeft: 4, fontWeight: isDir ? 600 : 400 },
            onClick: () => toggle(node, path),
            title: path,
          },
            h('span', { style: { color: '#94a3b8', fontSize: 12 } }, guide),
            // 展开标记：目录可展开时显示 ▸（折叠）/ ▾（展开），文件留空对齐
            h('span', {
              style: { width: 16, display: 'inline-block', textAlign: 'center', color: '#64748b', fontSize: 11 },
            }, isDir ? (expanded ? '▾' : '▸') : ''),
            isDir
              ? h('img', { src: folderSvg(expanded), style: iconImgStyle, draggable: false, alt: '' })
              : h('img', { src: fileIconSvg(node.name), style: iconImgStyle, draggable: false, alt: '' }),
            h('span', { style: { display: 'inline-block', verticalAlign: 'top' } },
              node.name + (isDir ? '' : '  ' + fmtSize(node.size)))),
          isDir && st && st.loading
            ? h('div', { style: { ...S.hint, paddingLeft: 22 + (depth + 1) * 12 } }, '│  '.repeat(depth) + '加载中…')
            : null,
          isDir && st && st.error
            ? h('div', { style: { ...S.err, paddingLeft: 22 + (depth + 1) * 12 } }, '│  '.repeat(depth) + '⚠ ' + st.error)
            : null,
          emptyHint,
          kids,
        )
      }

      return h('div', { style: S.panel },
        h('div', { style: S.body },
          h('select', {
            style: S.select,
            value: wsId ?? '',
            onChange: e => setWsId(e.target.value),
          },
            workspaces.map(w => h('option', { key: w.id, value: w.id }, w.path))),
          h('div', { style: S.searchRow },
            h('input', {
              style: S.searchInput,
              placeholder: '按文件名搜索…（Enter）',
              value: query,
              onChange: e => setQuery(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') doSearch() },
            }),
            h('button', { style: S.btnPrimary, onClick: doSearch }, '搜索'),
            matches !== null ? h('button', { style: S.btn, onClick: () => { setMatches(null); setQuery('') } }, '清除') : null,
          ),
          error ? h('div', { style: { ...S.err, padding: '0 8px' } }, '⚠ ' + error) : null,
          h('div', { style: S.tree },
            matches !== null
              ? (searching
                  ? h('div', { style: S.hint }, '搜索中…')
                  : (matches.length === 0
                      ? h('div', { style: S.hint }, '没有匹配的文件')
                      : h('div', null,
                          h('div', { style: S.hint }, '共 ' + matches.length + ' 个匹配'),
                          matches.map(m => h('div', {
                            key: m.path,
                            style: { ...S.row, paddingLeft: 8 },
                            onClick: () => { if (m.type === 'directory') { loadDir(m.path); setMatches(null); setQuery('') } else { openFileTab(m.path, m.name) } },
                            title: m.path,
                          },
                            m.type === 'directory'
                              ? h('img', { src: folderSvg(false), style: iconImgStyle, draggable: false, alt: '' })
                              : h('img', { src: fileIconSvg(m.name), style: iconImgStyle, draggable: false, alt: '' }),
                            h('span', { style: { display: 'inline-block', verticalAlign: 'top' } },
                              m.name + '  (' + m.path + ')'))))))
              : (!wsId
                  ? h('div', { style: S.hint }, '请先在界面选择/创建工作区')
                  : (tree[''] && tree[''].loading
                      ? h('div', { style: S.hint }, '加载中…')
                      : (tree[''] && tree[''].loaded
                          ? tree[''].children.map((c, i) => renderNode(c, c.name, 0, i === tree[''].children.length - 1))
                          : null))),
          ),
        ),
      )
    }

    /* ---------- 语言高亮（关键词 / 注释 / 字符串 / 数字） ---------- */
    const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield let static async await of get set'.split(' ')
    const TS_KW = JS_KW.concat('interface type enum namespace declare abstract implements readonly keyof infer never unknown any as is satisfies module global'.split(' '))
    const PY_KW = 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' ')
    const SH_KW = 'if then else elif fi for while do done case esac function in select until time coproc'.split(' ')
    const SQL_KW = 'select from where insert update delete create table drop alter join inner left right outer on group by having order limit offset as and or not null distinct union all count sum avg min max into values set primary key references index view'.split(' ')
    const GO_KW = 'func package import return if else for range break continue switch case default defer go struct interface map chan type var const nil true false make new select fallthrough'.split(' ')
    const RS_KW = 'fn let mut const static pub use mod struct enum impl trait for while loop if else match return break continue where type ref as in self Self crate super dyn async await move unsafe'.split(' ')
    const JAVA_KW = 'public private protected static final void class interface extends implements import package return new if else for while do switch case break continue try catch finally throw throws abstract enum native synchronized volatile transient instanceof this super null true false'.split(' ')
    const C_KW = 'if else for while do switch case break continue return int char float double long short unsigned signed void const static extern struct union enum typedef sizeof class namespace using template public private protected virtual new delete this nullptr true false try catch throw'.split(' ')
    const CS_KW = 'public private protected internal static void class interface struct enum namespace using return new if else for foreach while do switch case break continue try catch finally throw var async await const readonly virtual override abstract sealed partial delegate event get set value null true false this base is as typeof nameof'.split(' ')
    const RB_KW = 'def end if elsif else unless while until for do class module return yield break next super self nil true false require begin rescue ensure'.split(' ')
    const PHP_KW = 'function class public private protected static return echo if else elseif for foreach while do switch case break continue new extends implements namespace use require include try catch finally throw var const'.split(' ')
    const KT_KW = 'fun val var class interface object return if else for while do when in is as import package companion init constructor override open final abstract sealed data enum typealias suspend this super null true false'.split(' ')
    const SWIFT_KW = 'func class struct enum protocol extension return if else for while repeat switch case break continue var let import guard defer do try catch throw in as is self super nil true false init deinit override final open public private fileprivate internal static mutating lazy weak unowned'.split(' ')
    const LUA_KW = 'function local return if then elseif else end for while do repeat until break and or not in nil true false require'.split(' ')

    // 扩展名 -> { k:关键词, lc:行注释符, block:块注释, bt:模板字符串, html/md:专用高亮, tab:缩进宽度 }
    const LANG_DEF = {
      js: { k: JS_KW, lc: '//', bt: true, tab: 2 }, jsx: { k: JS_KW, lc: '//', bt: true, tab: 2 },
      mjs: { k: JS_KW, lc: '//', bt: true, tab: 2 }, cjs: { k: JS_KW, lc: '//', bt: true, tab: 2 },
      ts: { k: TS_KW, lc: '//', bt: true, tab: 2 }, tsx: { k: TS_KW, lc: '//', bt: true, tab: 2 },
      mts: { k: TS_KW, lc: '//', bt: true, tab: 2 }, cts: { k: TS_KW, lc: '//', bt: true, tab: 2 },
      py: { k: PY_KW, lc: '#', tab: 4 }, pyw: { k: PY_KW, lc: '#', tab: 4 }, pyi: { k: PY_KW, lc: '#', tab: 4 },
      json: { k: ['true', 'false', 'null'], tab: 2 },
      jsonc: { k: ['true', 'false', 'null'], lc: '//', tab: 2 },
      yaml: { k: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'], lc: '#', tab: 2 },
      yml: { k: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'], lc: '#', tab: 2 },
      toml: { k: ['true', 'false'], lc: '#', tab: 2 },
      css: { k: ['@media', '@import', '@keyframes', '@font-face', '@charset', '@supports', '@layer'], block: true, tab: 2 },
      scss: { k: ['@mixin', '@include', '@extend', '@import', '@use', '@forward', '@media', '!important'], lc: '//', block: true, tab: 2 },
      less: { k: ['@import', '@media', '!important'], lc: '//', block: true, tab: 2 },
      sass: { k: ['@import', '@mixin', '@include', '!important'], lc: '//', tab: 2 },
      html: { html: true, tab: 2 }, htm: { html: true, tab: 2 }, xml: { html: true, tab: 2 },
      vue: { html: true, tab: 2 }, svelte: { html: true, tab: 2 },
      md: { md: true, tab: 2 }, markdown: { md: true, tab: 2 }, mdx: { md: true, tab: 2 },
      sh: { k: SH_KW, lc: '#', tab: 2 }, bash: { k: SH_KW, lc: '#', tab: 2 }, zsh: { k: SH_KW, lc: '#', tab: 2 },
      sql: { k: SQL_KW, ci: true, lc: '--', tab: 2 },
      go: { k: GO_KW, lc: '//', block: true, tab: 4 },
      rs: { k: RS_KW, lc: '//', block: true, tab: 4 },
      java: { k: JAVA_KW, lc: '//', block: true, tab: 4 },
      c: { k: C_KW, lc: '//', block: true, tab: 4 }, h: { k: C_KW, lc: '//', block: true, tab: 4 },
      cpp: { k: C_KW, lc: '//', block: true, tab: 4 }, hpp: { k: C_KW, lc: '//', block: true, tab: 4 }, cc: { k: C_KW, lc: '//', block: true, tab: 4 },
      cs: { k: CS_KW, lc: '//', block: true, tab: 4 },
      rb: { k: RB_KW, lc: '#', tab: 2 },
      php: { k: PHP_KW, lc: '//', block: true, tab: 4 },
      kt: { k: KT_KW, lc: '//', block: true, tab: 4 },
      swift: { k: SWIFT_KW, lc: '//', block: true, tab: 4 },
      lua: { k: LUA_KW, lc: '--', tab: 2 },
      r: { k: ['if', 'else', 'for', 'while', 'function', 'return', 'in', 'NULL', 'TRUE', 'FALSE', 'library', 'require'], lc: '#', tab: 2 },
    }
    const DEFAULT_TAB_SIZE = 2
    const CODE_FONT = 'Consolas, "SF Mono", Menlo, "Cascadia Code", monospace'
    const CODE_LINE_HEIGHT = '20px'
    const TOKEN_COLOR = {
      kw: '#0000ff',   // 关键字
      str: '#a31515',  // 字符串
      cmt: '#008000',  // 注释
      num: '#098658',  // 数字
      tag: '#800000',  // HTML/XML 标签
      mdh: '#0969da',  // Markdown 标题/链接
      mdc: '#d63384',  // Markdown 行内代码
    }

    // 由文件名推断语言定义 / 缩进宽度 / 标签
    function fileFormat(name) {
      const dot = name.lastIndexOf('.')
      const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
      const def = LANG_DEF[ext]
      const tabSize = def && def.tab ? def.tab : DEFAULT_TAB_SIZE
      const label = (ext === '' ? 'TXT' : ext.toUpperCase()) + ' · ' + tabSize
      return { ext, def, tabSize, label }
    }

    // 1..count 的行号文本（编辑视图 gutter 用）
    function lineNumbers(count) {
      const out = []
      for (let i = 1; i <= count; i++) out.push(i)
      return out.join('\n')
    }

    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

    // 分词正则：组1=行注释 组2=块注释 组3=字符串 组4=数字 组5=标识符
    function buildRe(def) {
      // 占位捕获组：永不匹配（保证组 1..5 下标固定，避免按语言有无注释/块注释而错位）
      const never = '((?!x)x)'
      const lc = def.lc ? '(' + escapeRe(def.lc) + '.*$)' : never
      const bc = def.block ? '(\\/\\*[\\s\\S]*?\\*\\/)' : never
      const str = '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'' + (def.bt ? '|`(?:[^`\\\\]|\\\\.)*`' : '') + ')'
      const num = '(\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)'
      const id = '([A-Za-z_$][A-Za-z0-9_$]*)'
      return new RegExp(lc + '|' + bc + '|' + str + '|' + num + '|' + id, 'g')
    }

    function tokenizeHtml(line) {
      const out = []
      const re = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][^>]*>)/g
      let last = 0, m
      while ((m = re.exec(line))) {
        if (m.index > last) out.push({ t: line.slice(last, m.index), c: null })
        if (m[1] !== undefined) out.push({ t: m[1], c: 'cmt' })
        else out.push({ t: m[2], c: 'tag' })
        last = m.index + m[0].length
      }
      if (last < line.length) out.push({ t: line.slice(last), c: null })
      return out
    }

    function tokenizeMarkdown(line) {
      const out = []
      const h = /^(#{1,6})\s+(.*)$/.exec(line)
      if (h) return [{ t: h[1] + ' ', c: 'mdh' }, { t: h[2], c: 'mdh' }]
      const re = /(`[^`]*`)|(\*\*[^*]+\*\*)|(\[[^\]]*\]\([^)]*\))/g
      let last = 0, m
      while ((m = re.exec(line))) {
        if (m.index > last) out.push({ t: line.slice(last, m.index), c: null })
        if (m[1] !== undefined) out.push({ t: m[1], c: 'mdc' })
        else if (m[2] !== undefined) out.push({ t: m[2], c: 'kw' })
        else out.push({ t: m[3], c: 'mdh' })
        last = m.index + m[0].length
      }
      if (last < line.length) out.push({ t: line.slice(last), c: null })
      return out
    }

    // 单行分词：返回 [{ t:文本, c:颜色键|null }]，拼接后与原行完全一致
    function tokenizeLine(line, def) {
      if (!def) return [{ t: line, c: null }]
      if (def.html) return tokenizeHtml(line)
      if (def.md) return tokenizeMarkdown(line)
      const re = def._re || (def._re = buildRe(def))
      re.lastIndex = 0
      const out = []
      let last = 0, m
      while ((m = re.exec(line))) {
        if (m.index > last) out.push({ t: line.slice(last, m.index), c: null })
        const full = m[0]
        let c = null
        if (m[1] !== undefined) c = 'cmt'
        else if (m[2] !== undefined) c = 'cmt'
        else if (m[3] !== undefined) c = 'str'
        else if (m[4] !== undefined) c = 'num'
        else if (m[5] !== undefined) {
          const w = def.ci ? m[5].toLowerCase() : m[5]
          if (def.k && def.k.indexOf(w) !== -1) c = 'kw'
        }
        out.push({ t: full, c })
        last = m.index + full.length
        if (full.length === 0) re.lastIndex++
      }
      if (last < line.length) out.push({ t: line.slice(last), c: null })
      return out
    }

    // 行首缩进（制表符按 tabSize 展开后的视觉列数），用于折叠
    function indentColumns(line, tabSize) {
      let cols = 0
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === ' ') cols += 1
        else if (ch === '\t') cols += tabSize - (cols % tabSize)
        else break
      }
      return cols
    }

    // 缩进式折叠：每行可折叠其后续"更深缩进"的连续行
    function computeFolds(lines, tabSize) {
      const folds = new Map()
      const ind = lines.map(l => indentColumns(l, tabSize))
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue
        const d = ind[i]
        let end = i
        let child = false
        for (let k = i + 1; k < lines.length; k++) {
          if (lines[k].trim() === '') { end = k; continue }
          if (ind[k] > d) { end = k; child = true; continue }
          break
        }
        if (child) folds.set(i, { end })
      }
      return folds
    }

    /* ---------- 文件标签页视图（在"对话/轨迹"同级标签中渲染） ---------- */
    function FileView(props) {
      const fileId = props.fileId
      const onClose = props.onClose
      useFilesVersion()                      // openFiles 变化时重渲染
      const f = openFiles.get(fileId)
      if (!f) return null                    // 已关闭

      const fmt = fileFormat(f.name)
      const editGutterRef = React.useRef(null)
      const editTaRef = React.useRef(null)
      const editHlRef = React.useRef(null)
      const viewGutterRef = React.useRef(null)
      const fileRootRef = React.useRef(null)
      const [viewH, setViewH] = React.useState(0)

      // 测量可视高度：取对话滚动区可见高度，减掉底部 sticky 输入框，固定文件视图高度
      // （该槽位是"内容撑高 + 外层滚动"布局，无法用纯 CSS height:100% 约束，改用 JS 测量）
      React.useEffect(() => {
        const el = fileRootRef.current
        if (!el) return
        const scroller = el.closest('[data-conversation-scroll]')
        if (!scroller) return
        const measure = () => {
          const composerH = parseFloat(getComputedStyle(scroller).getPropertyValue('--dsh-composer-height')) || 0
          setViewH(Math.max(120, scroller.clientHeight - composerH))
        }
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(scroller)
        return () => ro.disconnect()
      }, [])

      const openInSystem = async () => {
        try {
          await api({ action: 'open', root: f.root, path: f.path })
        } catch (e) {
          openFiles.update(fileId, { error: String(e.message || e) })
        }
      }

      const codeBase = { fontFamily: CODE_FONT, fontSize: 12, lineHeight: CODE_LINE_HEIGHT, color: '#1f1f1f' }
      const onEditorScroll = (e) => {
        if (editGutterRef.current) editGutterRef.current.scrollTop = e.target.scrollTop
        if (editHlRef.current) { editHlRef.current.scrollTop = e.target.scrollTop; editHlRef.current.scrollLeft = e.target.scrollLeft }
      }
      const onViewScroll = (e) => { if (viewGutterRef.current) viewGutterRef.current.scrollTop = e.target.scrollTop }

      // ---- 编辑辅助：程序化改动提交 + 光标复位 ----
      const commitDraft = (next, selStart, selEnd) => {
        openFiles.pushUndo(fileId, f.draft)
        openFiles.update(fileId, { draft: next, saveError: null })
        openFiles.scheduleSave(fileId)
        requestAnimationFrame(() => {
          const ta = editTaRef.current
          if (ta) {
            ta.focus()
            try { ta.setSelectionRange(selStart, selEnd) } catch { /* 忽略非法选区 */ }
          }
        })
      }
      // 行首缩进风格：用 tab 还是空格
      const lineIndentStyle = (indent) => (indent.indexOf('\t') !== -1 ? '\t' : ' '.repeat(fmt.tabSize))
      // 光标所在行行首缩进
      const currentLineIndent = (text, pos) => {
        const start = text.lastIndexOf('\n', pos - 1) + 1
        const end = text.indexOf('\n', pos)
        const line = end === -1 ? text.slice(start) : text.slice(start, end)
        return { start, line, indent: (line.match(/^[\t ]*/) || [''])[0] }
      }
      // 光标前最后一个非空白字符是否触发「更深一层」缩进
      const shouldIndentMore = (text, pos) => {
        const start = text.lastIndexOf('\n', pos - 1) + 1
        const prefix = text.slice(start, pos).replace(/\s+$/, '')
        if (prefix === '') return false
        const ch = prefix[prefix.length - 1]
        if (ch === '{' || ch === '[' || ch === '(') return true
        if (ch === ':' && (fmt.ext === 'py' || fmt.ext === 'pyw' || fmt.ext === 'pyi')) return true
        return false
      }
      // Enter：自动缩进（复制上一行缩进，开括号/冒号后加深一层）
      const onEnterIndent = (e) => {
        e.preventDefault()
        const ta = e.target
        const pos = ta.selectionStart
        const { indent } = currentLineIndent(f.draft, pos)
        const extra = shouldIndentMore(f.draft, pos) ? lineIndentStyle(indent) : ''
        const next = f.draft.slice(0, pos) + '\n' + indent + extra + f.draft.slice(pos)
        commitDraft(next, pos + 1 + indent.length + extra.length, pos + 1 + indent.length + extra.length)
      }
      // Tab：缩进（单行在光标处插入；多行选中给每行行首加一层）
      const onTabIndent = (e) => {
        e.preventDefault()
        const ta = e.target
        const start = ta.selectionStart, end = ta.selectionEnd
        const sel = f.draft.slice(start, end)
        const unit = lineIndentStyle(currentLineIndent(f.draft, start).indent)
        let next, ns
        if (sel.indexOf('\n') !== -1) {
          const indented = sel.split('\n').map(l => unit + l).join('\n')
          next = f.draft.slice(0, start) + indented + f.draft.slice(end)
          ns = start + indented.length
        } else {
          next = f.draft.slice(0, start) + unit + f.draft.slice(end)
          ns = start + unit.length
        }
        commitDraft(next, ns, ns)
      }
      // Shift+Tab：取消缩进（当前行去掉一层）
      const onShiftTabIndent = (e) => {
        e.preventDefault()
        const ta = e.target
        const pos = ta.selectionStart
        const { start, line, indent } = currentLineIndent(f.draft, pos)
        let newIndent = indent
        if (indent.startsWith('\t')) newIndent = indent.slice(1)
        else newIndent = indent.slice(0, Math.max(0, indent.length - fmt.tabSize))
        const removed = indent.length - newIndent.length
        const next = f.draft.slice(0, start) + newIndent + line.slice(indent.length) + f.draft.slice(start + line.length)
        commitDraft(next, Math.max(start, pos - removed), Math.max(start, pos - removed))
      }

      // 只读视图：分词 + 折叠结构随内容缓存
      const view = React.useMemo(() => {
        const lines = f.content.split('\n')
        const folds = computeFolds(lines, fmt.tabSize)
        const tokens = lines.map(l => tokenizeLine(l, fmt.def))
        return { lines, folds, tokens }
      }, [f.content, fmt.tabSize, fmt.def])

      // 折叠后的可见行（依赖可变 f.folded，逐次重算）
      const visible = []
      for (let i = 0; i < view.lines.length; ) {
        const fold = view.folds.get(i)
        const folded = !!(fold && f.folded.has(i))
        visible.push({ index: i, tokens: view.tokens[i], fold, folded, hidden: folded ? fold.end - i : 0 })
        i = folded ? fold.end + 1 : i + 1
      }

      const foldBtn = {
        width: 14, flexShrink: 0, padding: 0, margin: 0, border: 'none',
        background: 'transparent', cursor: 'pointer', color: '#64748b',
        fontSize: 10, height: 20, lineHeight: CODE_LINE_HEIGHT, fontFamily: CODE_FONT,
      }
      const tokenSpan = (tk, idx) => tk.c
        ? h('span', { key: idx, style: { color: TOKEN_COLOR[tk.c] } }, tk.t)
        : tk.t

      // 行号 + 折叠开关列
      const gutterRow = (v) => h('div', {
        key: v.index,
        style: { display: 'flex', alignItems: 'center', height: 20, lineHeight: CODE_LINE_HEIGHT },
      },
        h('button', {
          style: foldBtn,
          onClick: v.fold ? () => openFiles.toggleFold(fileId, v.index) : undefined,
          title: v.fold ? (v.folded ? '展开' : '折叠') : '',
        }, v.fold ? (v.folded ? '▸' : '▾') : ''),
        h('span', { style: { flex: 1, textAlign: 'right', color: '#9ca3af', paddingRight: 10, userSelect: 'none' } }, String(v.index + 1)),
      )

      // 高亮代码行（可折叠时追加折叠提示）
      const codeRow = (v) => h('div', {
        key: v.index,
        style: { height: 20, lineHeight: CODE_LINE_HEIGHT, whiteSpace: 'pre', padding: '0 0 0 10px' },
      },
        v.tokens.map(tokenSpan),
        v.folded ? h('span', { style: { color: '#9ca3af', fontStyle: 'italic' } }, '   ⋯ ' + v.hidden + ' 行已折叠') : null,
      )

      const viewBody = h('div', { style: { flex: 1, display: 'flex', minHeight: 0, ...codeBase } },
        h('div', {
          ref: viewGutterRef,
          style: {
            flexShrink: 0, overflow: 'hidden', background: '#f6f8fa',
            borderRight: '1px solid #e5e7eb', userSelect: 'none',
          },
        }, visible.map(gutterRow)),
        h('div', {
          style: { flex: 1, overflow: 'auto', minWidth: 0, tabSize: fmt.tabSize },
          onScroll: onViewScroll,
        }, visible.map(codeRow)),
      )

      // 编辑视图：行号 gutter + 叠层高亮编辑器（textarea 透明文字 + 高亮背景），支持自动缩进
      const draftLines = f.draft.split('\n').length
      const editHl = React.useMemo(() => {
        const lines = f.draft.split('\n')
        return { lines, tokens: lines.map(l => tokenizeLine(l, fmt.def)) }
      }, [f.draft, fmt.def])
      // 高亮背景内容（token span + 行间换行，与 textarea 内容逐字符对齐）
      const hlChildren = []
      for (let i = 0; i < editHl.lines.length; i++) {
        editHl.tokens[i].forEach((tk, j) => {
          hlChildren.push(tk.c ? h('span', { key: i + ':' + j, style: { color: TOKEN_COLOR[tk.c] } }, tk.t) : tk.t)
        })
        if (i < editHl.lines.length - 1) hlChildren.push('\n')
      }
      const editorBox = {
        margin: 0, padding: '0 0 0 10px', whiteSpace: 'pre', tabSize: fmt.tabSize,
        fontSize: 12, lineHeight: CODE_LINE_HEIGHT, fontFamily: CODE_FONT,
        boxSizing: 'border-box',
      }
      const editBody = h('div', { style: { flex: 1, display: 'flex', minHeight: 0, ...codeBase } },
        h('pre', {
          ref: editGutterRef,
          style: {
            flexShrink: 0, margin: 0, padding: '0 10px 0 0', textAlign: 'right',
            color: '#9ca3af', background: '#f6f8fa', borderRight: '1px solid #e5e7eb',
            userSelect: 'none', boxSizing: 'border-box', whiteSpace: 'pre', overflow: 'hidden',
            fontSize: 12, lineHeight: CODE_LINE_HEIGHT, fontFamily: CODE_FONT,
          },
        }, lineNumbers(draftLines)),
        h('div', { style: { flex: 1, display: 'grid', minWidth: 0 } },
          h('pre', {
            ref: editHlRef,
            'aria-hidden': true,
            style: { ...editorBox, gridArea: '1 / 1', overflow: 'hidden', pointerEvents: 'none', color: '#1f1f1f' },
          }, hlChildren),
          h('textarea', {
            ref: editTaRef,
            className: 'ws-editor-ta',
            style: {
              ...editorBox, gridArea: '1 / 1', overflow: 'auto',
              width: '100%', height: '100%',
              border: 'none', outline: 'none', resize: 'none',
              color: 'transparent', WebkitTextFillColor: 'transparent',
              caretColor: '#1f1f1f', background: 'transparent',
            },
            wrap: 'off',
            value: f.draft,
            onChange: (e) => {
              const next = e.target.value
              openFiles.pushUndo(fileId, f.draft)     // 记录上一步（用于撤销）
              openFiles.update(fileId, { draft: next, saveError: null })
              openFiles.scheduleSave(fileId)          // 改动后自动保存
            },
            onKeyDown: (e) => {
              const mod = e.ctrlKey || e.metaKey
              if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); openFiles.undo(fileId); return }
              if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); openFiles.redo(fileId); return }
              if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); openFiles.redo(fileId); return }
              if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openFiles.save(fileId); return }
              if (e.key === 'Tab') { e.shiftKey ? onShiftTabIndent(e) : onTabIndent(e); return }
              if (e.key === 'Enter') { onEnterIndent(e); return }
            },
            onScroll: onEditorScroll,
            spellCheck: false,
          }),
        ),
      )

      // 保存状态：保存中 / 失败 / 已保存（自动保存无手写确认）
      const saveStatus = f.saving
        ? '保存中…'
        : f.saveError
          ? '保存失败'
          : (f.draft === f.content ? '已保存' : '…')

      return h('div', { ref: fileRootRef, style: { ...S.fileView, height: viewH ? viewH + 'px' : undefined } },
        h('div', { style: S.fileHead },
          h('span', { style: { ...S.contentPath, fontWeight: 600, color: '#1f1f1f' }, title: f.path },
            f.name,
            h('span', { style: { marginLeft: 8, color: '#9ca3af', fontWeight: 400, fontSize: 11 } }, fmt.label)),
          h('span', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h('span', {
              style: { fontSize: 11, color: f.saveError ? '#d33' : '#9ca3af', whiteSpace: 'nowrap' },
              title: f.saveError ? f.saveError : '',
            }, saveStatus),
            h('span', { style: { display: 'flex', gap: 4 } },
              h('button', { style: S.btn, onClick: () => openFiles.update(fileId, { editing: !f.editing }), title: f.editing ? '预览（高亮/折叠）' : '编辑' }, f.editing ? '预览' : '编辑'),
              h('button', { style: S.btn, onClick: openInSystem }, '打开'),
              h('button', { style: S.close, onClick: onClose, title: '关闭标签页' }, '✕'),
            ),
          ),
        ),
        f.loading
          ? h('div', { style: S.fileLoading }, '加载中…')
          : f.error
            ? h('div', { style: { ...S.err, padding: 12 } }, '⚠ ' + f.error)
            : f.editing
              ? editBody
              : viewBody,
        // 底部状态栏：左下角文件全路径，右下角编码 + 换行符
        h('div', { style: S.fileFoot },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f.fullPath || f.path }, f.fullPath || f.path),
          h('span', { style: { flexShrink: 0, whiteSpace: 'nowrap' } },
            f.content === null ? '' : 'UTF-8 · ' + (f.eol === '\r\n' ? 'CRLF' : 'LF')),
        ),
      )
    }

    /* ---------- 插件主体 ---------- */
    const name = 'dsh-ws-files'
    const inject = ['slots']

    function apply(ctx) {
      // 编辑器叠层高亮：隐藏 textarea 滚动条（避免与高亮背景错位）
      if (!document.getElementById('ws-files-editor-style')) {
        const st = document.createElement('style')
        st.id = 'ws-files-editor-style'
        st.textContent = '.ws-editor-ta::-webkit-scrollbar{width:0;height:0}.ws-editor-ta{scrollbar-width:none}'
        document.head.appendChild(st)
      }

      // 注册进布局槽位（由 dsh-layout 声明），可被分配到左/右区域
      const registerInto = (slotName) => ctx.slots.inject(slotName, () => ctx.slots.register({
        name: slotName,
        id: 'ws-files',
      }, WsFilesPanel))
      registerInto('layout.left')
      registerInto('layout.right')

      // 打开的文件 → "对话/轨迹"同级的 conversation.view 标签页。
      // inject 等到 conversation.view 声明后生效；openFiles 增删时同步注册/注销标签，
      // 声明塌缩（会话卸载）时清理全部标签，下次声明时按 openFiles 重新注册。
      ctx.slots.inject('conversation.view', () => {
        const disposers = new Map()   // fileId -> 标签注册 disposer
        const sync = () => {
          const files = openFiles.list()
          const live = new Set(files.map(f => f.id))
          for (const [id, dispose] of [...disposers]) {
            if (!live.has(id)) { dispose(); disposers.delete(id) }
          }
          for (const f of files) {
            if (disposers.has(f.id)) continue
            const id = f.id
            const dispose = ctx.slots.register({
              name: 'conversation.view',
              id: 'ws-files-' + id,
              order: 20,
              label: f.name,
              inject: () => ({
                fileId: id,
                onClose: () => openFiles.close(id),
              }),
            }, FileView)
            disposers.set(id, dispose)
          }
        }
        const unsubscribe = openFiles.subscribe(sync)
        sync()
        return () => {
          unsubscribe()
          for (const dispose of disposers.values()) dispose()
          disposers.clear()
        }
      })

      // 给文件标签注入关闭 ×（标签条是框架渲染的纯文本，只能 DOM 注入 + 观察重渲染兜底）
      const CLOSE_X_CLS = 'ws-file-tab-close'
      const ensureTabClose = () => {
        const byName = new Map(openFiles.list().map(f => [f.name, f.id]))
        const tabs = document.querySelectorAll('[role="tab"]')
        for (let i = 0; i < tabs.length; i++) {
          const btn = tabs[i]
          const fid = byName.get(tabName(btn))
          if (fid === undefined || btn.querySelector('.' + CLOSE_X_CLS)) continue
          const x = document.createElement('span')
          x.className = CLOSE_X_CLS
          x.textContent = '×'
          x.title = '关闭标签页'
          x.setAttribute('style', 'display:inline-flex;align-items:center;justify-content:center;margin-left:6px;width:16px;height:16px;border-radius:3px;font-size:14px;line-height:1;color:inherit;opacity:.55;cursor:pointer;flex:0 0 auto;')
          x.addEventListener('mouseenter', () => { x.style.opacity = '1'; x.style.background = 'rgba(0,0,0,0.10)' })
          x.addEventListener('mouseleave', () => { x.style.opacity = '.55'; x.style.background = 'transparent' })
          x.addEventListener('click', (ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            openFiles.close(fid)
          })
          btn.appendChild(x)
        }
      }
      let tabXraf = null
      const scheduleEnsure = () => {
        if (tabXraf !== null) return
        tabXraf = requestAnimationFrame(() => { tabXraf = null; ensureTabClose() })
      }
      const unsubTabX = openFiles.subscribe(scheduleEnsure)
      const tabXMo = new MutationObserver(scheduleEnsure)
      tabXMo.observe(document.body, { childList: true, subtree: true })
      ensureTabClose()
      ctx.effect(() => () => {
        tabXMo.disconnect()
        unsubTabX()
        if (tabXraf !== null) cancelAnimationFrame(tabXraf)
      }, 'ws-files: tab close X')
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
