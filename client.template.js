/*__FZD_FRAMES__*/

// DSH 合并版桌宠：黏土角色（四态驱动） + 状态面板 + 消息图标球。
//
// 设计要点（与 2026-11-18 的合并决定对齐）：
//   - 一个插件只挂一个组件，宠物和面板同一条数据源。
//   - 状态来自 DSH 真实事件：ctx.remote.$on('api-session/status', (_id, running))，
//     这条通道已在旧版 fzd-pet 上实测有效（不要再退回 ctx.on，那个 API 是错的）。
//   - 不再依赖 C# 子进程 / 本地端口 / endpoint.json / 健康轮询：状态在客户端算，
//     持久化用 localStorage，id 由 seq 统一发号（重启也不会撞号）。
//   - 没消息时宠物打正常乒乓球（白球来回弹）；来消息时那颗球换成对应图标飞过，
//     看一眼就知道「有东西进来了」，不用盯文本。
//
// 契约：可见文本走 locale 服务；所有订阅/定时器/观察器在 apply 里用 ctx.effect 注册。
window.__ModuleLoader__.load({
  id: '@local/fzd-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'fzd-pet'
    const STORE_KEY = 'fzd-pet:store:v1'
    const MAX_TL = 30
    const MAX_ERR = 20
    const STUCK_MS = 5 * 60 * 1000
    const BALL_SHOW_MS = 1400

    const DICT = {
      zh: {
        'pet.title': 'FZD 桌宠',
        'pet.aria': 'FZD 黏土桌宠，点击看状态',
        'pet.idle': '待命',
        'pet.working': '干活中',
        'pet.waiting': '等待确认',
        'pet.error': '出错',
        'panel.title': 'FZD 桌宠 · 状态',
        'panel.timer': '当前状态已持续',
        'panel.lastMsg': '最近一次消息',
        'panel.timeline': '状态时间线',
        'panel.errors': '错误记录',
        'panel.emptyTl': '还没有状态变更',
        'panel.emptyErr': '没有错误记录',
        'panel.stuck': '疑似卡住：干活超过 5 分钟没有新动静',
        'panel.mute': '静音提示',
        'panel.clear': '清空历史',
        'panel.close': '收起',
        'panel.copy': '点击复制',
        'panel.copied': '已复制',
        'panel.hint': '来消息时球会换成对应图标',
      },
      en: {
        'pet.title': 'FZD desk pet',
        'pet.aria': 'FZD clay desk pet, click for status',
        'pet.idle': 'Idle',
        'pet.working': 'Working',
        'pet.waiting': 'Waiting',
        'pet.error': 'Error',
        'panel.title': 'FZD pet · status',
        'panel.timer': 'In this state for',
        'panel.lastMsg': 'Last message',
        'panel.timeline': 'State timeline',
        'panel.errors': 'Error records',
        'panel.emptyTl': 'No state changes yet',
        'panel.emptyErr': 'No error records',
        'panel.stuck': 'Looks stuck: working over 5 minutes with no new activity',
        'panel.mute': 'Mute hints',
        'panel.clear': 'Clear history',
        'panel.close': 'Collapse',
        'panel.copy': 'Click to copy',
        'panel.copied': 'Copied',
        'panel.hint': 'The ball turns into an icon when a message arrives',
      },
    }

    const STATE_COLOR = {
      idle: '#5BE38A',
      working: '#3B82F6',
      waiting: '#F59E0B',
      error: '#EF4444',
    }

    // 消息球的图标：内联 SVG，不额外发文件、不联网。按事件类型切换。
    function svgIcon(body, bg) {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect x="0" y="0" width="32" height="32" rx="9" fill="' + bg + '"/>' +
        body +
        '</svg>'
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    }

    const ICONS = {
      // 普通消息：对话气泡
      message: svgIcon(
        '<path d="M7 9h18a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-8l-5 4v-4H7a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z" fill="#fff"/>' +
        '<circle cx="12" cy="16" r="1.6" fill="#3B82F6"/><circle cx="17" cy="16" r="1.6" fill="#3B82F6"/><circle cx="22" cy="16" r="1.6" fill="#3B82F6"/>',
        '#3B82F6'
      ),
      // 等待确认：问号
      waiting: svgIcon(
        '<path d="M16 7a5.2 5.2 0 0 1 0 10.4v2.2h-2.6v-2.2A5.2 5.2 0 0 1 16 7z" fill="#fff"/>' +
        '<circle cx="14.7" cy="22.8" r="1.9" fill="#fff"/>',
        '#F59E0B'
      ),
      // 出错：叹号
      error: svgIcon(
        '<path d="M16 6l8 16H8z" fill="#fff"/>' +
        '<rect x="15" y="12" width="2" height="6" rx="1" fill="#EF4444"/><circle cx="16" cy="21" r="1.3" fill="#EF4444"/>',
        '#F0A0A0'
      ),
    }

    // ---------------- 数据层（模块级单例） ----------------
    const store = {
      state: 'idle',
      since: Date.now(),
      timeline: [],
      errors: [],
      muted: false,
      lastMsgAt: null,
      stuck: false,
      seq: 0,
      icon: null, // { id, kind }
    }
    const subs = new Set()
    let saveTimer = null
    let ballTimer = null

    function emit() {
      for (const fn of subs) {
        try { fn() } catch { /* 单个订阅失效不影响其它 */ }
      }
    }

    function nextId() {
      store.seq += 1
      return store.seq
    }

    function persist() {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify({
            v: 1,
            seq: store.seq,
            muted: store.muted,
            timeline: store.timeline.slice(-MAX_TL),
            errors: store.errors.slice(-MAX_ERR),
            lastMsgAt: store.lastMsgAt,
          }))
        } catch { /* 隐私模式/配额满：不持久化也不影响使用 */ }
      }, 250)
    }

    function restore() {
      try {
        const raw = localStorage.getItem(STORE_KEY)
        if (!raw) return
        const data = JSON.parse(raw)
        if (!data || typeof data !== 'object') return
        if (Array.isArray(data.timeline)) store.timeline = data.timeline
        if (Array.isArray(data.errors)) store.errors = data.errors
        if (typeof data.muted === 'boolean') store.muted = data.muted
        if (typeof data.lastMsgAt === 'number') store.lastMsgAt = data.lastMsgAt
        // 关键修正：seq 必须从历史的最大 id 续上，否则重启后从 1 重发，
        // 会和已有条目撞号，React 的 key 重复导致列表错位。
        let maxId = 0
        for (const item of store.timeline) if (item && Number.isFinite(item.id)) maxId = Math.max(maxId, item.id)
        for (const item of store.errors) if (item && Number.isFinite(item.id)) maxId = Math.max(maxId, item.id)
        store.seq = Number.isFinite(data.seq) ? Math.max(data.seq, maxId) : maxId
      } catch { /* 坏数据按空历史启动 */ }
    }

    function pushTimeline(entry) {
      store.timeline.push(entry)
      while (store.timeline.length > MAX_TL) store.timeline.shift()
      persist()
    }

    function setState(next, source) {
      if (next === store.state) return
      const now = Date.now()
      pushTimeline({
        id: nextId(),
        at: now,
        state: store.state,
        source: source || 'event',
        durationMs: Math.max(0, now - store.since),
      })
      store.state = next
      store.since = now
      if (next !== 'working') store.stuck = false
      persist()
      emit()
    }

    function pushError(summary) {
      const record = {
        id: nextId(),
        at: Date.now(),
        summary: String(summary || '运行出错').slice(0, 200),
      }
      store.errors.push(record)
      while (store.errors.length > MAX_ERR) store.errors.shift()
      persist()
      return record
    }

    // 来了「东西」：把球换成对应图标飞过去。muted 只影响显形，不影响状态记录。
    function markMessage(kind) {
      store.lastMsgAt = Date.now()
      if (store.muted) { emit(); return }
      const key = kind || 'message'
      store.icon = { id: Date.now() + '|' + key, kind: key }
      if (ballTimer !== null) clearTimeout(ballTimer)
      ballTimer = setTimeout(() => {
        ballTimer = null
        store.icon = null
        emit()
      }, BALL_SHOW_MS)
      emit()
    }

    // ---------------- 组件 ----------------
    const STYLE = `
      .fzd-pet-wrap{position:relative;width:92px;height:92px;flex:0 0 auto;cursor:pointer;
        display:flex;align-items:center;justify-content:center;user-select:none;
        -webkit-tap-highlight-color:transparent;}
      .fzd-pet-img{width:92px;height:92px;object-fit:contain;pointer-events:none;
        filter:drop-shadow(0 3px 6px rgba(0,0,0,.28));}
      .fzd-pet-ring{position:absolute;left:6px;top:10px;width:80px;height:74px;border-radius:26px;
        box-shadow:0 0 0 2px var(--fzd-c) inset,0 0 14px var(--fzd-c);opacity:0;
        transition:opacity .25s;pointer-events:none;}
      .fzd-pet-ring.on{opacity:.55;}
      .fzd-pet-ball{position:absolute;right:6px;top:44px;width:9px;height:9px;border-radius:50%;
        background:#fff;box-shadow:0 0 7px rgba(255,255,255,.9);
        animation:fzd-bounce 1.6s cubic-bezier(.4,0,.6,1) infinite;pointer-events:none;}
      @keyframes fzd-bounce{0%{transform:translate(-34px,-6px)}50%{transform:translate(-2px,4px)}
        100%{transform:translate(-34px,-6px)}}
      .fzd-pet-icon{position:absolute;right:-4px;top:8px;width:26px;height:26px;border-radius:8px;
        background:#fff;box-shadow:0 6px 16px rgba(0,0,0,.3);display:flex;align-items:center;
        justify-content:center;pointer-events:none;animation:fzd-fly 1.25s cubic-bezier(.2,.7,.3,1);}
      .fzd-pet-icon img{width:22px;height:22px;display:block;}
      @keyframes fzd-fly{0%{transform:translate(-58px,26px) scale(.55);opacity:0}
        28%{transform:translate(-40px,6px) scale(1.12);opacity:1}
        60%{transform:translate(4px,-8px) scale(1)}
        100%{transform:translate(18px,-16px) scale(.92);opacity:0}}
      .fzd-pet-flash{position:absolute;inset:0;pointer-events:none;opacity:0;
        background:radial-gradient(circle at 68% 32%,rgba(120,200,255,.6),transparent 62%);
        animation:fzd-flash .55s ease-out;}
      @keyframes fzd-flash{0%{opacity:.9}100%{opacity:0}}
      .fzd-pet-chip{position:absolute;left:50%;bottom:-2px;transform:translateX(-50%);
        font-size:10px;line-height:14px;padding:0 6px;border-radius:8px;color:#fff;
        white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25);pointer-events:none;}

      .fzd-panel{position:absolute;right:0;bottom:calc(100% + 8px);width:308px;
        max-height:min(460px,calc(100vh - 140px));display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary,#1f2329);
        border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;
        box-shadow:0 10px 30px rgba(0,0,0,.24);z-index:70;overflow:hidden;font-size:13px;
        animation:fzd-pop .16s ease-out;}
      @keyframes fzd-pop{0%{transform:translateY(6px) scale(.97);opacity:0}100%{opacity:1}}
      .fzd-panel-head{display:flex;align-items:center;gap:10px;padding:11px 12px;
        border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}
      .fzd-panel-head img{width:38px;height:38px;object-fit:contain;}
      .fzd-panel-title{font-weight:600;font-size:13px;}
      .fzd-panel-sub{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:11px;margin-top:2px;}
      .fzd-panel-chip{margin-left:auto;font-size:11px;color:#fff;padding:1px 8px;border-radius:999px;}
      .fzd-row{display:flex;justify-content:space-between;padding:5px 12px;gap:10px;
        color:var(--dsw-alias-label-secondary,#4e5969);}
      .fzd-row b{font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);font-variant-numeric:tabular-nums;}
      .fzd-stuck{margin:7px 12px;padding:7px 9px;border-radius:8px;font-size:11.5px;
        background:#FEF3C2;color:#8A6100;border:1px solid #FACC15;}
      .fzd-sec{padding:0 12px 6px;}
      .fzd-sec-title{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);margin:8px 0 5px;font-weight:600;}
      .fzd-list{max-height:132px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;}
      .fzd-item{display:grid;grid-template-columns:52px 58px 1fr 50px;gap:6px;align-items:center;
        padding:4px 7px;border-radius:7px;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.03));
        font-size:11.5px;}
      .fzd-item .t{color:var(--dsw-alias-label-tertiary,#8a9099);}
      .fzd-item .s{font-weight:600;}
      .fzd-item .d{text-align:right;color:var(--dsw-alias-label-tertiary,#8a9099);}
      .fzd-err{padding:6px 8px;border-radius:7px;background:#FEECEB;border:1px solid #F5A39E;
        cursor:pointer;font-size:11.5px;line-height:1.45;word-break:break-word;}
      .fzd-err.copied{background:#E7F6EC;border-color:#5BE38A;}
      .fzd-empty{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9099);padding:4px 0;}
      .fzd-foot{display:flex;gap:6px;flex-wrap:wrap;padding:9px 12px;
        border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}
      .fzd-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:transparent;
        border-radius:7px;padding:4px 9px;font-size:11.5px;cursor:pointer;color:inherit;}
      .fzd-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
      .fzd-tip{padding:0 12px 9px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);}
    `

    function pad2(n) { return String(n).padStart(2, '0') }

    function clockOf(ts) {
      if (!ts) return '—'
      const d = new Date(ts)
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    function elapsedText(ms) {
      if (!Number.isFinite(ms) || ms < 0) ms = 0
      const total = Math.floor(ms / 1000)
      return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60)
    }

    function durationText(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const total = Math.round(ms / 1000)
      if (total < 60) return total + 's'
      return Math.floor(total / 60) + 'm' + pad2(total % 60) + 's'
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        return true
      } catch {
        return false
      }
    }

    function Pet(props) {
      const t = (key) => (props && typeof props.t === 'function') ? props.t(key) : (DICT.zh[key] || key)
      const [, bump] = React.useReducer((c) => c + 1, 0)
      const [open, setOpen] = React.useState(false)
      const [copiedId, setCopiedId] = React.useState(null)
      const [frame, setFrame] = React.useState(0)
      const [now, setNow] = React.useState(Date.now())

      React.useEffect(() => {
        const fn = () => bump()
        subs.add(fn)
        return () => { subs.delete(fn) }
      }, [])

      // 帧驱动：待机 8fps 循环，干活 16fps 循环挥拍。一个定时器按状态取帧率。
      React.useEffect(() => {
        const started = performance.now()
        const step = () => {
          const fps = store.state === 'working' ? FZD_FRAMES.hitFps : FZD_FRAMES.idleFps
          const elapsed = (performance.now() - started) / 1000
          setFrame(Math.floor(elapsed * fps))
        }
        step()
        const timer = setInterval(step, 55)
        return () => clearInterval(timer)
      }, [])

      // 面板开着时，计时每 0.5 秒刷新，别让秒数卡住。
      React.useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => setNow(Date.now()), 500)
        return () => clearInterval(timer)
      }, [open])

      const working = store.state === 'working'
      const pool = working ? FZD_FRAMES.hit : FZD_FRAMES.idle
      const src = pool[frame % pool.length]
      const color = STATE_COLOR[store.state] || STATE_COLOR.idle
      const icon = store.icon
      const iconSrc = icon ? (ICONS[icon.kind] || ICONS.message) : null

      function onClear() {
        store.timeline = []
        store.errors = []
        store.stuck = false
        persist()
        emit()
      }

      function onMute() {
        store.muted = !store.muted
        persist()
        emit()
      }

      function onCopyError(record) {
        copyText(record.summary + '\n' + clockOf(record.at))
        setCopiedId(record.id)
        setTimeout(() => setCopiedId((cur) => (cur === record.id ? null : cur)), 1500)
      }

      return h('div', {
        className: 'fzd-pet-wrap',
        onClick: () => setOpen((v) => !v),
        title: t('pet.title'),
        role: 'button',
        'aria-label': t('pet.aria'),
      },
        h('style', null, STYLE),
        h('div', { className: 'fzd-pet-ring' + (store.stuck || working ? ' on' : ''), style: { '--fzd-c': color } }),
        h('img', { className: 'fzd-pet-img', src, alt: t('pet.aria'), draggable: false }),
        iconSrc ? h('div', { className: 'fzd-pet-icon', key: icon.id }, h('img', { src: iconSrc, alt: '', draggable: false })) : h('div', { className: 'fzd-pet-ball' }),
        icon && icon.kind === 'message' ? h('div', { className: 'fzd-pet-flash', key: icon.id + 'f' }) : null,
        h('div', { className: 'fzd-pet-chip', style: { background: color } }, t('pet.' + store.state)),

        open ? h('div', { className: 'fzd-panel', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'fzd-panel-head' },
            h('img', { src: FZD_FRAMES.idle[0], alt: '' }),
            h('div', null,
              h('div', { className: 'fzd-panel-title' }, t('panel.title')),
              h('div', { className: 'fzd-panel-sub' }, t('panel.hint'))),
            h('span', { className: 'fzd-panel-chip', style: { background: color } }, t('pet.' + store.state))),

          h('div', { className: 'fzd-row' },
            h('span', null, t('panel.timer')),
            h('b', null, elapsedText(working ? now - store.since : 0))),
          h('div', { className: 'fzd-row' },
            h('span', null, t('panel.lastMsg')),
            h('b', null, clockOf(store.lastMsgAt))),

          store.stuck ? h('div', { className: 'fzd-stuck' }, t('panel.stuck')) : null,

          h('div', { className: 'fzd-sec' },
            h('div', { className: 'fzd-sec-title' }, t('panel.timeline')),
            store.timeline.length === 0
              ? h('div', { className: 'fzd-empty' }, t('panel.emptyTl'))
              : h('div', { className: 'fzd-list' },
                store.timeline.slice().reverse().map((item) => h('div', { className: 'fzd-item', key: item.id },
                  h('span', { className: 't' }, clockOf(item.at)),
                  h('span', { className: 's', style: { color: STATE_COLOR[item.state] || '#666' } }, t('pet.' + item.state)),
                  h('span', null, item.source || ''),
                  h('span', { className: 'd' }, durationText(item.durationMs)))))),

          h('div', { className: 'fzd-sec' },
            h('div', { className: 'fzd-sec-title' }, t('panel.errors')),
            store.errors.length === 0
              ? h('div', { className: 'fzd-empty' }, t('panel.emptyErr'))
              : h('div', { className: 'fzd-list' },
                store.errors.slice().reverse().map((item) => h('div', {
                  key: item.id,
                  className: 'fzd-err' + (copiedId === item.id ? ' copied' : ''),
                  title: t('panel.copy'),
                  onClick: () => onCopyError(item),
                }, item.summary,
                  copiedId === item.id ? ' · ' + t('panel.copied') : '')))),

          h('div', { className: 'fzd-foot' },
            h('button', { className: 'fzd-btn', onClick: onMute }, (store.muted ? '🔕 ' : '🔔 ') + t('panel.mute')),
            h('button', { className: 'fzd-btn', onClick: onClear }, t('panel.clear')),
            h('button', { className: 'fzd-btn', onClick: () => setOpen(false) }, t('panel.close'))),
        ) : null,
      )
    }

    // ---------------- 挂载 ----------------
    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        restore()

        ctx.effect(() => ctx.locale.register(NS, DICT), 'fzd-pet: dictionaries')

        // 状态源：running=true 表示 agent 在干活，false 回待命。
        // 这条通道是旧版插件实测有效的，别换成 ctx.on。
        const remote = ctx.remote
        function on(target, name, handler) {
          if (!target || typeof target.$on !== 'function') return
          try {
            ctx.effect(() => target.$on(name, handler), 'fzd-pet: ' + name)
          } catch { /* 事件不存在就算了，插件其余功能照常 */ }
        }

        on(remote, 'api-session/status', (_sessionId, running) => {
          if (running === true) {
            setState('working', 'session')
            markMessage('message')
          } else {
            setState('idle', 'session')
          }
        })

        on(remote, 'agent/error', (payload) => {
          const raw = payload && payload.error
          const message = typeof raw === 'string' ? raw : (raw && (raw.message || raw.code)) || '运行出错'
          pushError(message)
          setState('error', 'error')
          markMessage('error')
        })

        on(remote, 'approval/request', () => {
          setState('waiting', 'approval')
          markMessage('waiting')
        })

        on(remote, 'user-questions/request', () => {
          setState('waiting', 'question')
          markMessage('waiting')
        })

        // 兜底：会话区新增了像正文的节点，就当来了一条消息（只负责提示，不改状态）。
        ctx.effect(() => {
          const startedAt = Date.now()
          let last = 0
          const observer = new MutationObserver((records) => {
            if (Date.now() - startedAt < 2000) return
            let added = false
            for (const r of records) {
              for (const node of r.addedNodes) {
                if (node.nodeType !== 1 || !node.textContent) continue
                if (node.textContent.trim().length <= 6) continue
                if (typeof node.closest === 'function' && node.closest('.fzd-pet-wrap')) continue
                added = true
                break
              }
              if (added) break
            }
            if (!added) return
            const at = Date.now()
            if (at - last < 1200) return
            last = at
            markMessage('message')
          })
          observer.observe(document.body, { childList: true, subtree: true })
          return () => observer.disconnect()
        }, 'fzd-pet: conversation observer')

        // 卡住判定：干活超过 5 分钟没有任何新状态 / 新消息。
        ctx.effect(() => {
          const timer = setInterval(() => {
            if (store.state !== 'working' || store.stuck) return
            const since = Math.max(store.since, store.lastMsgAt || 0)
            if (Date.now() - since >= STUCK_MS) {
              store.stuck = true
              emit()
            }
          }, 15000)
          return () => clearInterval(timer)
        }, 'fzd-pet: stuck watch')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fzd-pet',
          order: 5,
          locale: NS,
        }, Pet))
      },
    }
  },
});
