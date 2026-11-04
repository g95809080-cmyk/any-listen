const url = process.argv[2]

const INSTRUMENT = `(() => {
  const probe = { frames: [], errors: [] };
  Object.defineProperty(window, '__probe', { value: probe, configurable: true });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    probe.errors.push('unhandledrejection: ' + ((r && (r.message || r.stack)) || String(r)));
  });
  window.addEventListener('error', (e) => {
    probe.errors.push('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  const origPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...args) {
    try {
      const d = args[0];
      if (probe.frames.length < 600) {
        if (typeof d === 'string') probe.frames.push('OUT ' + d.slice(0, 260));
        else if (Array.isArray(d)) probe.frames.push('OUT_ARR ' + JSON.stringify(d).slice(0, 260));
        else probe.frames.push('OUT_OTHER ' + Object.prototype.toString.call(d));
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
        if (probe.frames.length < 600) {
          if (typeof d === 'string') probe.frames.push('IN ' + d.slice(0, 260));
          else if (Array.isArray(d)) probe.frames.push('IN_ARR ' + JSON.stringify(d).slice(0, 260));
          else probe.frames.push('IN_OTHER ' + Object.prototype.toString.call(d));
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
      expression: 'JSON.stringify(window.__probe || {missing:true})',
      returnByValue: true,
      awaitPromise: true,
      timeout: 8000,
    })
    const raw = res.result.value
    const probe = JSON.parse(raw)
    console.log('=== errors ===')
    console.log(JSON.stringify(probe.errors || [], null, 1))
    const frames = probe.frames || []
    const outs = frames.filter((f) => f.startsWith('OUT'))
    const ins = frames.filter((f) => f.startsWith('IN'))
    console.log('=== counts ===')
    console.log('out:', outs.length, 'in:', ins.length)
    const names = new Map()
    for (const f of outs) {
      const m = f.match(/^OUT \[0,"([^"]+)"/)
      if (m) names.set(m[1], (names.get(m[1]) || 0) + 1)
    }
    console.log('=== outgoing method names ===')
    for (const [k, v] of names) console.log(v, k)
    console.log('=== first 12 out / last 12 in ===')
    console.log(outs.slice(0, 12).join('\n'))
    console.log('---')
    console.log(ins.slice(-12).join('\n'))
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
