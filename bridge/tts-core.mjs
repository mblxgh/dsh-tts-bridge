// TTS 外部编辑器 API 的连接层。被 tts.mjs / go.mjs 共用。
// 实测要点：
//   · 每次发命令都新建 socket、发完销毁 —— 长连接挂十几秒后 TTS 会断推送
//   · 结果回传只能靠「一条带标记的 print」；returnID+messageID 5 与 sendExternalMessage 在 Global 环境都不回传
//   · 所有调用方做完必须 process.exit()，否则 inbound server 会吊住事件循环

import net from 'node:net';

export const TTS_PORT = 39999;
export const OUR_PORT = 39998;
export const TAG = 'JSON|';

function extractJson(buf) {
  const msgs = [];
  let i = 0;
  while (i < buf.length) {
    while (i < buf.length && /\s/.test(buf[i])) i++;
    if (i >= buf.length) break;
    if (buf[i] !== '{') { i++; continue; }
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < buf.length; j++) {
      const c = buf[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    if (depth !== 0) break;
    msgs.push(buf.slice(i, j));
    i = j;
  }
  return { msgs, rest: buf.slice(i) };
}

let inbound = null;
let pending = null;
let sawError = false;
const logLines = [];

/**
 * 串行闸：同一时刻只允许一个「要回包」的调用在飞。
 *
 * 为什么必须有：回包靠 TTS 把 JSON 打回来，而匹配方式只有一个全局 pending 槽位。
 * 两个调用并发时后到的会覆盖前一个的 resolve，先发起的那个永远等不到结果；
 * 加上超时分支曾用 `if (pending === resolve)` 才 resolve，连兜底都不触发 ——
 * 实测表现是工具调用卡死四分多钟不带返回值。闸门是治本的那一刀。
 */
let gate = Promise.resolve();

export function getLog() { return logLines.slice(); }
export function hadError() { return sawError; }

function ensureInbound() {
  if (inbound) return Promise.resolve();
  inbound = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const { msgs, rest } = extractJson(buf);
      buf = rest;
      for (const raw of msgs) {
        try {
          const m = JSON.parse(raw);
          if (m.messageID === 2 && typeof m.message === 'string') {
            const text = m.message;
            if (text.startsWith(TAG) && pending) {
              const r = pending;
              pending = null;
              const body = text.slice(TAG.length);
              try { r(JSON.parse(body)); } catch { r({ raw: body }); }
            } else {
              logLines.push(text);
            }
          } else if (m.messageID === 3) {
            sawError = true;
            logLines.push('[lua-error] ' + m.error);
          }
        } catch { /* ignore */ }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    inbound.once('error', reject);
    inbound.listen(OUR_PORT, '127.0.0.1', resolve);
  });
}

function send(msg) {
  return new Promise((resolve, reject) => {
    const s = net.connect(TTS_PORT, '127.0.0.1');
    s.on('connect', () => {
      s.write(JSON.stringify(msg), (err) => {
        try { s.destroy(); } catch { /* ignore */ }
        err ? reject(err) : resolve();
      });
    });
    s.on('error', reject);
  });
}

/** 执行 Lua，等一条 JSON| print。wantJson=false 时只发不等结果。 */
export async function runLua(code, opts = {}) {
  const prev = gate;
  let release;
  gate = new Promise((r) => {
    release = r;
  });
  await prev;
  try {
    return await runLuaOnce(code, opts);
  } finally {
    release();
  }
}

async function runLuaOnce(code, { wantJson = false, timeout = 12000 } = {}) {
  await ensureInbound();
  let waiter = null;
  if (wantJson) {
    waiter = new Promise((resolve) => {
      pending = resolve;
      setTimeout(() => {
        if (pending === resolve) pending = null;
        // 无条件放行：等不到就是等不到，绝不能让调用方永远挂着
        resolve(undefined);
      }, timeout);
    });
  }
  await send({ messageID: 3, returnID: 0, guid: '-1', script: code });
  if (!wantJson) {
    await new Promise((r) => setTimeout(r, 400));
    return undefined;
  }
  return waiter;
}

/** 把「算一个值 + 打一条 JSON|」包成 Lua 片段 */
export function jsonLua(expr) {
  return `local ok, r = pcall(function() return (${expr}) end) ` +
    `if ok then print('${TAG}' .. JSON.encode(r)) ` +
    `else print('${TAG}' .. JSON.encode({ error = tostring(r) })) end`;
}

/** 数字 → Lua 字面量，保证有小数点 */
export function luaNum(n) {
  const s = Number(n).toPrecision(12).replace(/0+$/, '').replace(/\.$/, '');
  return s.includes('.') || s.includes('e') ? s : s + '.0';
}
