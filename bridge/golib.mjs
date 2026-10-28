// 围棋的纯逻辑层：读盘、坐标系、数空、提子模拟。没有 process.exit，可以直接被别的脚本 import。
// 命令行在 go.mjs，敲击端在 knock.mjs。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runLua, luaNum } from './tts-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SENSE_LUA = readFileSync(join(HERE, 'gosense.lua'), 'utf8');

export const COLS = 'ABCDEFGHJKLMNOPQRST'; // 围棋跳过 I
export const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 进游戏读一次盘。失败抛错。 */
export async function sense({ timeout = 15000 } = {}) {
  const r = await runLua(SENSE_LUA, { wantJson: true, timeout });
  if (!r) throw new Error('读盘超时，没有收到回复（TTS 没开或 Global 脚本报错）');
  if (r.ok === false) throw new Error('读盘失败：' + (r.error || '未知'));
  return r;
}

/**
 * 扫一遍全桌，按对象名归类，并猜这是哪个游戏。
 * 判据是对象名前缀 —— 围棋桌是 go_game_*（棋盘 go_game_* / 棋子 go_game_piece_* / 棋罐 go_game_bowl_*）。
 */
export async function inventory() {
  const lua = `
local counts = {}
for _, o in ipairs(getAllObjects()) do
  local n = tostring(o.name)
  counts[n] = (counts[n] or 0) + 1
end
print('JSON|' .. JSON.encode(counts))`;
  const kinds = await runLua(lua, { wantJson: true, timeout: 15000 });
  if (!kinds) throw new Error('扫桌面超时（TTS 没开？）');

  const names = Object.keys(kinds).sort();
  const total = names.reduce((a, n) => a + kinds[n], 0);
  const goNames = names.filter((n) => n.startsWith('go_game_'));

  let game = null;
  if (goNames.length) {
    game = { id: 'go', title: '围棋', evidence: goNames, ready: true };
  }

  return { game, kinds, total, names };
}

/** (i,j) → 围棋坐标。i: x 轴左→右，j: z 轴远→近（屏幕上方→下方） */export function toGtp(i, j, rows) {
  if (i < 0 || i >= COLS.length || j < 0 || j >= rows) return null;
  return COLS[i] + (rows - j);
}

export function parseGtp(s, rows, cols) {
  const m = /^([A-HJ-Ta-hj-t])\s*(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const i = COLS.indexOf(m[1].toUpperCase());
  const j = rows - Number(m[2]);
  if (i < 0 || i >= cols || j < 0 || j >= rows) return null;
  return { i, j };
}

/** 读盘结果 → 二维字符盘（X 黑 / O 白 / . 空），附同点冲突列表 */
export function toGrid(data) {
  const { cols, rows } = data.board;
  const g = Array.from({ length: rows }, () => new Array(cols).fill('.'));
  const clash = [];
  for (const s of data.stones) {
    if (g[s.j][s.i] !== '.') clash.push(s);
    g[s.j][s.i] = s.color === 'B' ? 'X' : 'O';
  }
  return { g, clash };
}

export function render(g) {
  const rows = g.length;
  const cols = g[0].length;
  const lines = ['   ' + [...COLS.slice(0, cols)].join(' ')];
  for (let j = 0; j < rows; j++) {
    lines.push(String(rows - j).padStart(2) + ' ' + g[j].join(' '));
  }
  return lines.join('\n');
}

export function score(g) {
  const rows = g.length;
  const cols = g[0].length;
  let blackStones = 0;
  let whiteStones = 0;
  for (const row of g) {
    for (const c of row) {
      if (c === 'X') blackStones++;
      else if (c === 'O') whiteStones++;
    }
  }
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  let blackTerr = 0;
  let whiteTerr = 0;
  let neutral = 0;
  const regions = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (g[j][i] !== '.' || seen[j][i]) continue;
      const stack = [[i, j]];
      seen[j][i] = true;
      let size = 0;
      let tb = false;
      let tw = false;
      while (stack.length) {
        const [x, y] = stack.pop();
        size++;
        for (const [dx, dy] of NEI) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const c = g[ny][nx];
          if (c === 'X') tb = true;
          else if (c === 'O') tw = true;
          else if (!seen[ny][nx]) { seen[ny][nx] = true; stack.push([nx, ny]); }
        }
      }
      let owner = 'N';
      if (tb && !tw) { blackTerr += size; owner = 'B'; }
      else if (tw && !tb) { whiteTerr += size; owner = 'W'; }
      else neutral += size;
      regions.push({ size, owner });
    }
  }
  const black = blackStones + blackTerr;
  const white = whiteStones + whiteTerr;
  return {
    blackStones, whiteStones, blackTerr, whiteTerr, neutral,
    black, white, diff: black - white,
    bigRegions: regions.filter((r) => r.owner !== 'N' && r.size >= 3),
  };
}

/** 取 (i,j) 所在的整块：{cells, libs}。空格或越界返回 null。 */
export function groupAt(g, i, j) {
  const rows = g.length;
  const cols = g[0].length;
  const color = g[j][i];
  if (color !== 'X' && color !== 'O') return null;
  const seen = new Set([`${i},${j}`]);
  const cells = [];
  const libs = new Map();
  const stack = [[i, j]];
  while (stack.length) {
    const [x, y] = stack.pop();
    cells.push([x, y]);
    for (const [dx, dy] of NEI) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const c = g[ny][nx];
      const k = `${nx},${ny}`;
      if (c === '.') { if (!libs.has(k)) libs.set(k, [nx, ny]); }
      else if (c === color && !seen.has(k)) { seen.add(k); stack.push([nx, ny]); }
    }
  }
  return { cells, libs: [...libs.values()] };
}

/** 在内存里走一手，判定合法性与提子。不改动传入的盘。 */
export function simulate(g0, i, j, color) {
  const rows = g0.length;
  const cols = g0[0].length;
  if (i < 0 || i >= cols || j < 0 || j >= rows) return { ok: false, reason: '超出盘面' };
  if (g0[j][i] !== '.') return { ok: false, reason: '这个交叉点已经有子' };
  const g = g0.map((r) => r.slice());
  const me = color === 'B' ? 'X' : 'O';
  const foe = me === 'X' ? 'O' : 'X';
  g[j][i] = me;
  const captured = [];
  for (const [dx, dy] of NEI) {
    const nx = i + dx;
    const ny = j + dy;
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
    if (g[ny][nx] !== foe) continue;
    const grp = groupAt(g, nx, ny);
    if (grp.libs.length === 0) {
      for (const [cx, cy] of grp.cells) {
        g[cy][cx] = '.';
        captured.push([cx, cy]);
      }
    }
  }
  const mine = groupAt(g, i, j);
  if (mine.libs.length === 0) {
    return { ok: false, reason: '自杀手：自己这块没有气，也没提到对方的子', board: g, captured };
  }
  return { ok: true, board: g, captured, libs: mine.libs.length };
}

/** 盘上棋子的稳定高度：取出现最多的那个 0.01 桶，桶内求均值。空盘返回 null。 */
export function surfaceY(stones) {
  if (!stones.length) return null;
  const buckets = new Map();
  for (const s of stones) {
    const k = s.y.toFixed(2);
    const cur = buckets.get(k) || { n: 0, sum: 0 };
    cur.n++;
    cur.sum += s.y;
    buckets.set(k, cur);
  }
  let best = null;
  for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
  return best.sum / best.n;
}

/**
 * 落一手。会自动提掉被吃的对方子。
 * 坐标系跟 sense 同一套（i 沿 x、j 沿 z），这里收围棋记谱再换算。
 */
export async function place(color, coord) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const data = await sense();
  const b = data.board;
  const pt = parseGtp(coord, b.rows, b.cols);
  if (!pt) throw new Error(`坐标不合法：${coord}（列 A~T 跳过 I，行号 1~${b.rows}）`);

  const { g } = toGrid(data);
  const sim = simulate(g, pt.i, pt.j, color);
  if (!sim.ok) throw new Error(`${coord.toUpperCase()} 走不了：${sim.reason}`);

  const deadGuids = data.stones
    .filter((s) => sim.captured.some(([ci, cj]) => ci === s.i && cj === s.j))
    .map((s) => s.guid);

  const wx = b.x0 + pt.i * b.stepX;
  const wz = b.z0 + pt.j * b.stepZ;
  const surface = surfaceY(data.stones);
  const targetY = surface ?? b.y + Math.abs(b.stepX) * 0.17;
  const maxSpan = Math.max(Math.abs(b.stepX), Math.abs(b.stepZ)) * 1.5;

  const lua = `
local COLOR, WX, WY, WZ = '${color}', ${luaNum(wx)}, ${luaNum(targetY)}, ${luaNum(wz)}
local MAX_SPAN = ${luaNum(maxSpan)}
local CAPTURES = { ${deadGuids.map((x) => `'${x}'`).join(', ')} }
local X0, X1 = ${luaNum(b.x0)}, ${luaNum(b.x1)}
local Z0, Z1 = ${luaNum(b.z0)}, ${luaNum(b.z1)}
local PAD = MAX_SPAN
local function colorOf(o)
  local n = tostring(o.name):lower()
  if n:find('black', 1, true) or n:find('dark', 1, true) then return 'B' end
  if n:find('white', 1, true) or n:find('light', 1, true) then return 'W' end
  local ok, c = pcall(function() return o.getColorTint() end)
  if ok and c then return ((c.r + c.g + c.b) / 3 < 0.45) and 'B' or 'W' end
  return '?'
end
-- 棋罐的 type 也是 GoPiece，只能靠体积分开
local function isPiece(o)
  local t = tostring(o.type)
  local n = tostring(o.name):lower()
  local named = (t == 'GoPiece') or (n:find('piece', 1, true) ~= nil) or (n:find('stone', 1, true) ~= nil)
  if not named then return false end
  if n:find('bowl', 1, true) or n:find('canister', 1, true) or n:find('jar', 1, true) then return false end
  local okb, b = pcall(function() return o.getBounds() end)
  if okb and b and b.size and math.max(b.size.x, b.size.y, b.size.z) > MAX_SPAN then return false end
  return true
end
local loose, onBoard = {}, {}
for _, o in ipairs(getAllObjects()) do
  if isPiece(o) and colorOf(o) == COLOR then
    local p = o.getPosition()
    if p.x >= X0 - PAD and p.x <= X1 + PAD and p.z >= Z0 - PAD and p.z <= Z1 + PAD then
      onBoard[#onBoard + 1] = o
    else
      loose[#loose + 1] = o
    end
  end
end
local tmpl = loose[1] or onBoard[1]
if not tmpl then
  -- 盘上一颗子都没有（新开局 / 空盘）—— spawnObject 在 TTS 里对被吃过的棋子不可靠，
  -- 但棋罐是容器，可以直接 takeObject 拿一颗出来放到目标位置。
  local bowl = nil
  for _, o in ipairs(getAllObjects()) do
    local n = tostring(o.name):lower()
    if (n:find('bowl', 1, true) or n:find('canister', 1, true) or n:find('jar', 1, true)) and colorOf(o) == COLOR then
      bowl = o
      break
    end
  end
  if not bowl then
    print('JSON|' .. JSON.encode({ ok = false, error = '盘上没有 ' .. COLOR .. ' 色棋子，也找不到装它的棋罐' }))
  else
    bowl.takeObject({
      position = { x = WX, y = WY + 0.25, z = WZ },
      rotation = { x = 0, y = 180, z = 0 },
      callback_function = function(obj)
        print('JSON|' .. JSON.encode({ ok = true, guid = obj.guid, from = bowl.guid, via = 'takeObject', killed = 0 }))
      end
    })
  end
else
  local tb = tmpl.getBounds()
  local c = tmpl.clone({ position = { x = WX, y = WY, z = WZ } })
  if c == nil then
    print('JSON|' .. JSON.encode({ ok = false, error = 'clone 失败' }))
  else
    local killed = 0
    for _, cg in ipairs(CAPTURES) do
      local d = getObjectFromGUID(cg)
      if d then d.destruct(); killed = killed + 1 end
    end
    print('JSON|' .. JSON.encode({
      ok = true, guid = c.guid, from = tmpl.guid, fromName = tostring(tmpl.name),
      fromSpan = math.max(tb.size.x, tb.size.y, tb.size.z), atY = WY, killed = killed,
    }))
  end
end`;

  const r = await runLua(lua, { wantJson: true, timeout: 12000 });

  // takeObject 的回调可能是下一帧才跑，收不到回包也属正常 —— 直接读盘看目标点上有没有子
  if (!r) {
    await sleep(1800);
    const after = await sense();
    const hit = after.stones.find((s) => s.i === pt.i && s.j === pt.j && s.color === color);
    if (hit) {
      return {
        ok: true,
        color: color === 'B' ? '黑' : '白',
        coord: coord.toUpperCase(),
        landedAt: toGtp(hit.i, hit.j, b.rows),
        offset: Number(hit.err.toFixed(3)),
        captures: [],
        killsConfirmed: 0,
        via: 'takeObject',
      };
    }
    throw new Error('落子超时，而且目标点上没有子');
  }
  if (r.ok === false) throw new Error('落子失败：' + (r.error || '未知'));

  // 物理吸附会带一点点偏差，读回来把高度校正到跟原生子一致
  await sleep(900);
  let after = await sense();
  let hit = after.stones.find((s) => s.guid === r.guid);
  if (hit && Math.abs(hit.y - targetY) > 0.08) {
    await runLua(
      `local o = getObjectFromGUID('${r.guid}') ` +
        `if o then o.setPosition({ x = ${luaNum(wx)}, y = ${luaNum(targetY)}, z = ${luaNum(wz)} }) ` +
        `print('JSON|' .. JSON.encode({ fixed = true })) else print('JSON|' .. JSON.encode({ fixed = false })) end`,
      { wantJson: true, timeout: 8000 },
    );
    await sleep(600);
    after = await sense();
    hit = after.stones.find((s) => s.guid === r.guid);
  }

  return {
    ok: true,
    color: color === 'B' ? '黑' : '白',
    coord: coord.toUpperCase(),
    landedAt: hit ? toGtp(hit.i, hit.j, b.rows) : null,
    offset: hit ? Number(hit.err.toFixed(3)) : null,
    captures: sim.captured.map(([ci, cj]) => toGtp(ci, cj, b.rows)),
    killsConfirmed: r.killed ?? 0,
  };
}

/** 把盘上某一颗收走（下错了悔一步用）。 */
export async function remove(coord) {
  const data = await sense();
  const b = data.board;
  const pt = parseGtp(coord, b.rows, b.cols);
  if (!pt) throw new Error(`坐标不合法：${coord}`);
  const hit = data.stones.find((s) => s.i === pt.i && s.j === pt.j);
  if (!hit) throw new Error(`${coord.toUpperCase()} 上没有子`);
  const r = await runLua(
    `local o = getObjectFromGUID('${hit.guid}') ` +
      `if o then o.destruct() print('JSON|' .. JSON.encode({ ok = true })) else print('JSON|' .. JSON.encode({ ok = false })) end`,
    { wantJson: true, timeout: 8000 },
  );
  if (!r || !r.ok) throw new Error('收子失败');
  return { ok: true, color: hit.color === 'B' ? '黑' : '白', coord: coord.toUpperCase() };
}

/** 把一次读盘压成给人看的一段话 */
export function summarise(data) {
  const { g, clash } = toGrid(data);
  const s = score(g);
  const b = data.board;
  return {
    head: `${b.name}  ${b.cols}×${b.rows}  格距 ${b.stepX.toFixed(4)}`,
    grip: `黑 ${s.blackStones} 子 + ${s.blackTerr} 目 = ${s.black}　白 ${s.whiteStones} 子 + ${s.whiteTerr} 目 = ${s.white}　中立空 ${s.neutral}`,
    result: s.diff > 0 ? `黑胜 ${s.diff}` : s.diff < 0 ? `白胜 ${-s.diff}` : '和棋',
    text: render(g),
    grid: g,
    score: s,
    clash,
    offboard: data.offboard || [],
    unknown: data.unknown || [],
    bigSkip: data.bigSkip || [],
  };
}
