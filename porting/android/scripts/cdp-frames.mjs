// ERR-002 复核探针：在 Page 加载前注入 MessagePort 记账，reload 后按 callId 把
// UI→core 的请求帧（OUT_ARR）与 core→UI 的响应帧（IN_ARR）配对，逐个点名核验。
// 只读：只包 postMessage / addEventListener，不改业务逻辑。
const url = process.argv[2]
const NAMES = [
  'getAppInfo',
  'getSetting',
  'getThemeSetting',
  'getExtensionErrorMessage',
  'getHotKey',
  'getCurrentVersionInfo',
]

const INSTRUMENT = `(() => {
  const probe = { frames: [], errors: [] };
  Object.defineProperty(window, '__probe2', { value: probe, configurable: true });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    probe.errors.push('unhandledrejection: ' + ((r && (r.message || r.stack)) || String(r)).slice(0, 200));
  });
  const origPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...args) {
    try {
      const d = args[0];
      if (probe.frames.length < 900) {
        if (Array.isArray(d)) probe.frames.push('OUT_ARR ' + JSON.stringify(d).slice(0, 240));
        else if (typeof d === 'string') probe.frames.push('OUT_STR ' + d.slice(0, 240));
      }
    } catch (err) {}
    return origPost.apply(this, args);
  };
  const origAdd = MessagePort.prototype.addEventListener;
  MessagePort.prototype.addEventListener = function (type, listener, opts) {
    if (type !== 'message' || typeof listener !== 'function') return origAdd.call(this, type, listener, opts);
    const wrapped = function (ev) {
      try {
        const d = ev.data;
        if (probe.frames.length < 900) {
          if (Array.isArray(d)) probe.frames.push('IN_ARR ' + JSON.stringify(d).slice(0, 240));
          else if (typeof d === 'string') probe.frames.push('IN_STR ' + d.slice(0, 240));
        }
      } catch (err) {}
      return listener.call(this, ev);
    };
    return origAdd.call(this, type, wrapped, opts);
  };
})();`

const ws = new WebSocket(url)
let nextId = 1
const pending = new Map()
function call(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

ws.addEventListener('open', async () => {
  try {
    await call('Runtime.enable')
    await call('Page.enable')
    await call('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    await call('Page.reload', { ignoreCache: false })
    await sleep(9000)
    const res = await call('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__probe2 || {missing:true})',
      returnByValue: true,
      awaitPromise: true,
      timeout: 8000,
    })
    const probe = JSON.parse(res.result.value)
    const frames = probe.frames || []
    const outs = frames.filter((f) => f.startsWith('OUT'))
    const ins = frames.filter((f) => f.startsWith('IN'))
    console.log('=== counts ===')
    console.log('out:', outs.length, 'in:', ins.length)
    console.log('=== errors ===')
    console.log(JSON.stringify(probe.errors || [], null, 1))

    // callId -> 响应帧
    const inById = new Map()
    for (const f of ins) {
      const m = f.match(/^IN_ARR \[1,"([^"]+)",(null|"(?:[^"\\]|\\.)*")/)
      if (m) inById.set(m[1], { err: m[2], raw: f.slice(0, 240) })
    }
    console.log('=== 六个帧逐个核验 ===')
    for (const name of NAMES) {
      const req = outs.find((f) => f.includes(`["${name}"]`))
      if (!req) {
        console.log(`${name.padEnd(24)} 未发出`)
        continue
      }
      const idm = req.match(/^OUT_ARR \[0,"([^"]+)"/)
      const id = idm ? idm[1] : '(?)'
      const r = inById.get(id)
      console.log(`${name.padEnd(24)} id=${id} 回帧=${r ? 'YES' : 'NO'} ${r ? 'err=' + r.err : ''}`)
      if (!r) console.log('   req:', req.slice(0, 160))
    }
    // 主题帧的响应体：判断是 core 返回空，还是 UI 侧映射丢字段
    console.log('=== getThemeSetting / getSetting 响应体（截断 240 字）===')
    for (const f of ins) {
      if (f.includes('getThemeSetting') || f.includes('getAppInfo')) console.log(f)
    }
    // 未被点名的响应（确认配对逻辑本身没错）
    console.log('=== IN_ARR 响应帧总数:', inById.size, '===')
    console.log('=== 头 8 条 OUT_ARR ===')
    console.log(outs.filter((f) => f.startsWith('OUT_ARR')).slice(0, 8).map((f) => f.slice(0, 150)).join('\n'))
  } catch (e) {
    console.log('ERROR:', e.message)
  } finally {
    ws.close()
    process.exit(0)
  }
})
ws.addEventListener('error', (e) => {
  console.log('WS ERROR', e.message || '')
  process.exit(1)
})
setTimeout(() => {
  console.log('TIMEOUT')
  process.exit(2)
}, 40000)
