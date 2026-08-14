/**
 * dsh-ws-files —— client 半（浏览器）。
 *
 * 产物协议：window.__ModuleLoader__.load({ id, factory: (require) => ... })，
 * 外部模块（react 等）经注入的 require 从加载器模块表解析，其余全部内联。
 *
 * UI：侧栏底部"文件"按钮（sidebar.footer.action）+ 全框浮层面板（shell.overlay）。
 * 面板：工作区选择 + 文件搜索 + 树形目录浏览（懒加载/展开折叠）+ 内容预览（编辑保存/系统打开）。
 * 写操作前弹确认框（用户即审批者）。
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
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 440,
        background: '#ffffff', color: '#1f1f1f', borderLeft: '1px solid #ddd',
        boxShadow: '-6px 0 18px rgba(0,0,0,0.18)', display: 'flex',
        flexDirection: 'column', zIndex: 9999,
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
    }

    /* ---------- 侧栏底部按钮 ---------- */
    function FooterActionButton() {
      const open = useOpen()
      return h('button', {
        onClick: () => store.toggle(),
        title: '工作空间文件',
        style: {
          width: '100%', textAlign: 'left', background: 'none', border: 'none',
          cursor: 'pointer', padding: '8px 12px', fontSize: 13, color: open ? '#2563eb' : 'inherit',
        },
      }, '📁 文件')
    }

    /* ---------- 文件面板（搜索 + 树 + 内容） ---------- */
    function WsFilesPanel() {
      const open = useOpen()
      const [workspaces, setWorkspaces] = React.useState([])
      const [wsId, setWsId] = React.useState(null)
      // tree: 相对路径 -> { loaded, loading, children, error }
      const [tree, setTree] = React.useState({})
      const [content, setContent] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [matches, setMatches] = React.useState(null)   // null=树模式；数组=搜索结果
      const [searching, setSearching] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const [panelW, setPanelW] = React.useState(440)   // 面板宽度
      const [contentH, setContentH] = React.useState(null)  // 内容区高度（null=默认 45%）

      // 拖动面板左边缘：调整宽度
      const onEdgeDown = (e) => {
        e.preventDefault()
        const move = (ev) => {
          setPanelW(Math.max(300, Math.min(900, window.innerWidth - ev.clientX)))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      // 拖动树/内容分隔条：调整内容区高度
      const onSplitDown = (e) => {
        e.preventDefault()
        const move = (ev) => {
          // 面板底边 = 视口底边，内容区高度 = 视口底 - 鼠标 Y
          setContentH(Math.max(80, Math.min(window.innerHeight * 0.72, window.innerHeight - ev.clientY)))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      // 首次打开：拉工作区列表
      React.useEffect(() => {
        if (!open) return
        api({ action: 'workspaces' }).then(d => {
          setWorkspaces(d.workspaces)
          if (wsId === null && d.workspaces.length > 0) setWsId(d.workspaces[0].id)
        }).catch(e => setError(String(e.message || e)))
      }, [open])

      // 工作区切换：重置
      React.useEffect(() => {
        if (!open || wsId === null) return
        setTree({})
        setContent(null)
        setEditing(false)
        setMatches(null)
        setError(null)
        loadDir('')
      }, [open, wsId])

      React.useEffect(() => {
        if (!toast) return
        const t = setTimeout(() => setToast(null), 2600)
        return () => clearTimeout(t)
      }, [toast])

      const loadDir = async (path) => {
        if (wsId === null) return
        if (tree[path] && (tree[path].loaded || tree[path].loading)) return
        setTree(t => ({ ...t, [path]: { loaded: false, loading: true, children: [] } }))
        try {
          const d = await api({ action: 'list', root: wsId, path })
          setTree(t => ({ ...t, [path]: { loaded: true, loading: false, children: d.entries } }))
        } catch (e) {
          setTree(t => ({ ...t, [path]: { loaded: false, loading: false, children: [], error: String(e.message || e) } }))
        }
      }

      const readFile = async (path) => {
        try {
          const d = await api({ action: 'read', root: wsId, path })
          setContent({ path, text: d.content })
          setDraft(d.content)
          setEditing(false)
        } catch (e) {
          setError(String(e.message || e))
        }
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
          readFile(path)
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

      const openInSystem = async (path) => {
        try {
          await api({ action: 'open', root: wsId, path })
          setToast('已调用系统默认程序打开：' + path)
        } catch (e) {
          setError(String(e.message || e))
        }
      }

      const saveFile = async () => {
        if (!content) return
        // 写操作前确认：用户即审批者
        if (!window.confirm('确认将以下内容写入文件？\n\n' + content.path)) return
        try {
          await apiPost({ action: 'write', root: wsId, path: content.path, content: draft })
          setContent({ path: content.path, text: draft })
          setEditing(false)
          setToast('已保存：' + content.path)
        } catch (e) {
          setError(String(e.message || e))
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
        const kids = isDir && expanded && st.children
          ? st.children.map((c, i) => renderNode(c, path ? path + '/' + c.name : c.name, depth + 1, i === st.children.length - 1))
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
          kids,
        )
      }

      if (!open) return null

      return h('div', { style: { ...S.panel, width: panelW } },
        // 面板左边缘拖柄：调整面板宽度
        h('div', {
          style: {
            position: 'absolute', left: -4, top: 0, bottom: 0, width: 8,
            cursor: 'col-resize', zIndex: 10002, background: 'transparent',
          },
          onMouseDown: onEdgeDown,
          title: '拖动调整宽度',
        }, null),
        h('div', { style: S.header },
          h('span', null, '📁 工作空间文件'),
          h('button', { style: S.close, onClick: () => store.set(false) }, '✕'),
        ),
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
                            onClick: () => { if (m.type === 'directory') { loadDir(m.path); setMatches(null); setQuery('') } else { readFile(m.path) } },
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
          content
            ? [
                // 树/内容分隔条：拖动调整内容区高度
                h('div', {
                  key: 'split',
                  style: {
                    flexShrink: 0, height: 6, cursor: 'row-resize',
                    background: '#eef1f5', borderTop: '1px solid #e3e6ea',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  },
                  onMouseDown: onSplitDown,
                  title: '拖动调整内容区高度',
                }, h('span', { style: { color: '#b6bcc6', fontSize: 10 } }, '≡')),
                h('div', {
                  key: 'content',
                  style: contentH !== null
                    ? { ...S.contentPane, height: contentH, maxHeight: 'none' }
                    : S.contentPane,
                },
                  h('div', { style: S.contentHead },
                    h('span', { style: S.contentPath, title: content.path }, content.path),
                    h('span', { style: { display: 'flex', gap: 4 } },
                      editing ? null : h('button', { style: S.btn, onClick: () => setEditing(true) }, '编辑'),
                      editing ? h('button', { style: S.btnPrimary, onClick: saveFile }, '保存') : null,
                      editing ? h('button', { style: S.btn, onClick: () => { setEditing(false); setDraft(content.text) } }, '取消') : null,
                      h('button', { style: S.btn, onClick: () => openInSystem(content.path) }, '打开'),
                      h('button', { style: S.close, onClick: () => setContent(null) }, '✕'),
                    ),
                  ),
                  editing
                    ? h('textarea', { style: S.textarea, value: draft, onChange: e => setDraft(e.target.value), spellCheck: false })
                    : h('pre', { style: S.pre }, content.text)),
              ]
            : null,
        ),
        toast ? h('div', { style: S.toast }, toast) : null,
      )
    }

    /* ---------- 插件主体 ---------- */
    const name = 'dsh-ws-files'
    const inject = ['slots']

    function apply(ctx) {
      // register 的 name 必须是槽位名本身（父级 children 表声明过的），list 槽用 id 区分条目
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'ws-files',
      }, FooterActionButton))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'ws-files',
      }, WsFilesPanel))
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
