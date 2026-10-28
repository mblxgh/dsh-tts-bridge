// KataGo 分析通道 —— 给「现在谁领先几目」和「收官实地归谁」用
//
// 设计取向：**不常驻**。每次调用 spawn 一个 katago 进程，喂一条 analysis 请求，
// 拿到结果就杀掉。磁盘上占 105 MB 左右，平时不占内存、不占显存、不占 CPU。
// 引擎用 eigenavx2 版（纯 CPU，零依赖，不跟 ComfyUI 抢显卡），一次分析约 6~10 秒。

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 引擎和权重放这个子目录里，自己下，不进仓库
export const KATAGO_ROOT = path.join(HERE, 'katago');
// 分析参数跟着代码走
const CONFIG = path.join(HERE, 'katago.cfg');

const COLS = 'ABCDEFGHJKLMNOPQRST';

function enginePath() {
  const eigen = path.join(KATAGO_ROOT, 'eigen', 'katago.exe');
  if (fs.existsSync(eigen)) return eigen;
  const opencl = path.join(KATAGO_ROOT, 'opencl', 'katago.exe');
  if (fs.existsSync(opencl)) return opencl;
  return null;
}

function modelPath() {
  const m = path.join(KATAGO_ROOT, 'model.bin.gz');
  return fs.existsSync(m) ? m : null;
}

export function available() {
  return Boolean(enginePath() && modelPath());
}

/** 盘面（'X'/'O'/'.' 二维数组，j=0 是最上面一行）→ KataGo 的 initialStones */
function toStones(g) {
  const rows = g.length;
  const stones = [];
  let black = 0;
  let white = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < g[j].length; i++) {
      const c = g[j][i];
      if (c === 'X') {
        stones.push(['B', COLS[i] + (rows - j)]);
        black++;
      } else if (c === 'O') {
        stones.push(['W', COLS[i] + (rows - j)]);
        white++;
      }
    }
  }
  return { stones, black, white };
}

/**
 * 分析一个局面。
 * @param {string[][]} g         盘面，'X' 黑、'O' 白、'.' 空
 * @param {object} opt
 * @param {number} opt.komi      贴目，默认 7.5（中国规则）
 * @param {number} opt.visits    搜索量，默认 300
 * @param {number} opt.timeout   超时毫秒，默认 90 秒（含冷启动加载权重）
 * @param {boolean} opt.ownership 是否要逐点归属图，默认 true
 */
export async function judge(g, { komi = 7.5, visits = 300, timeout = 90000, ownership = true } = {}) {
  const exe = enginePath();
  const model = modelPath();
  if (!exe || !model) {
    throw new Error('KataGo 没装全：缺 ' + (!exe ? '引擎' : '权重'));
  }

  const rows = g.length;
  const cols = g[0].length;
  const { stones, black, white } = toStones(g);

  // initialStones 摆完之后默认轮黑。黑比白多一个说明黑刚下完，补一手 pass 把轮次让给白。
  const moves = black === white + 1 ? [['B', 'pass']] : [];

  const req = {
    id: 'judge',
    initialStones: stones,
    moves,
    rules: 'chinese',
    komi,
    boardXSize: cols,
    boardYSize: rows,
    maxVisits: visits,
    includeOwnership: ownership,
  };

  return await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(exe, [
      'analysis',
      '-config', CONFIG,
      '-model', model,
    ], { cwd: path.dirname(exe), windowsHide: true });

    let buf = '';
    let out = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已经退了 */ }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error('KataGo 分析超时（' + Math.round(timeout / 1000) + ' 秒）'));
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 'judge' || !msg.rootInfo) continue;

        const info = msg.rootInfo;
        let own = null;
        let blackPts = 0;
        let whitePts = 0;
        let unclear = 0;
        if (Array.isArray(msg.ownership)) {
          own = [];
          for (let j = 0; j < rows; j++) {
            own.push(msg.ownership.slice(j * cols, (j + 1) * cols));
          }
          for (const v of msg.ownership) {
            if (v > 0.5) blackPts++;
            else if (v < -0.5) whitePts++;
            else unclear++;
          }
        }

        finish(null, {
          scoreLead: info.scoreLead,      // 黑方视角、已扣贴目的净领先目数
          winrate: info.winrate,          // 黑方胜率 0~1
          visits: info.visits,
          komi,
          moves: stones.length,
          blackStones: black,
          whiteStones: white,
          blackPts,
          whitePts,
          unclear,
          ownership: own,
          ms: Date.now() - t0,
        });
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      out += d;
      if (out.length > 4000) out = out.slice(-4000);
    });

    child.on('error', (e) => finish(new Error('起不来 KataGo：' + e.message)));
    child.on('exit', (code) => {
      if (!settled) finish(new Error('KataGo 提前退出（code ' + code + '）：' + out.slice(-400)));
    });

    child.stdin.write(JSON.stringify(req) + '\n');
  });
}

/** 把 ownership 画成一张一眼能看的图：● 黑地 ○ 白地 ＋ 未定 */
export function renderOwnership(own) {
  if (!own) return '（没有逐点归属）';
  return own
    .map((row) =>
      row
        .map((v) => (v > 0.5 ? 'X' : v < -0.5 ? 'O' : '·'))
        .join(' '),
    )
    .join('\n');
}

/** 一句话结论：谁领先多少目 */
export function verdict(r) {
  const lead = r.scoreLead;
  const side = lead >= 0 ? '黑' : '白';
  const n = Math.abs(lead);
  if (n < 0.5) return '基本均势（差 ' + n.toFixed(1) + ' 目）';
  return side + '领先 ' + n.toFixed(1) + ' 目（贴 ' + r.komi + ' 目后）';
}
