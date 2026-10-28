// 游戏层接口 —— 想让 dsh 玩一款新桌游，在 games/ 下放一个文件就够了，插件不用改。
//
// ── 一个游戏模块要导出 default 对象，形状是这样 ──
//
//   export default {
//     id: 'go',                      // 唯一标识，小写
//     title: '围棋',                  // 显示名，会出现在工具的返回里
//
//     // 从桌面对象名清单认游戏。认不出返回 null。
//     // 返回 { confidence, evidence }，confidence 越高越优先（多款同时命中时用）
//     recognize(names) { … },
//
//     // 读一次桌面，返回什么都行 —— 后面 render / actions 拿到的就是这个
//     async read() { … },
//
//     // 把 read() 的返回值变成模型能读的文字。整个接口里最要紧的一个。
//     render(state) { … },
//
//     // 动作表：name → async (args) => 一句给模型看的结果
//     actions: {
//       place: async ({ color, coord }) => '…',
//     },
//
//     // 可选：形势判断。没有就不接 tts_judge
//     async analyze(state, args) { … },
//   }
//
// 文件名随意，以 _ 开头的会被跳过（留给草稿和内部辅助）。
// 插件启动时不扫目录，是每次调用工具时现扫 —— 所以加完文件重启 dsh 就能用。

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLua } from './tts-core.mjs';

export const GAME_DIR = 'games';

const dirOf = (bridgeDir) => path.join(bridgeDir, GAME_DIR);

/** 有哪些候选游戏文件 */
export function listGameFiles(bridgeDir) {
  const dir = dirOf(bridgeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
}

/** 加载全部游戏模块。单个文件坏了不影响别的，错误带在 errors 里。 */
export async function loadGames(bridgeDir) {
  const files = listGameFiles(bridgeDir);
  const games = [];
  const errors = [];
  for (const file of files) {
    const href = pathToFileURL(path.join(dirOf(bridgeDir), file)).href;
    try {
      const mod = await import(href);
      const g = mod.default ?? mod.game;
      if (!g || !g.id || typeof g.read !== 'function' || typeof g.render !== 'function') {
        errors.push(`${file}：要导出 default，并且带 id / read / render`);
        continue;
      }
      games.push({ ...g, file });
    } catch (e) {
      errors.push(`${file}：${e?.message ?? e}`);
    }
  }
  return { games, errors };
}

/**
 * 认当前桌上是什么游戏。返回 { game, evidence, score } 或 null。
 * 多个命中时按 confidence 取高的。
 */
export function pickGame(games, names) {
  let best = null;
  for (const g of games) {
    let hit = null;
    try {
      hit = typeof g.recognize === 'function' ? g.recognize(names) : null;
    } catch {
      hit = null;
    }
    if (!hit) continue;
    const score = typeof hit === 'number' ? hit : (hit.confidence ?? 1);
    const evidence = typeof hit === 'object' && hit.evidence ? hit.evidence : [];
    if (!best || score > best.score) best = { game: g, score, evidence };
  }
  return best;
}

/** 扫一遍全桌，只拿对象名和数量。跟游戏无关，任何桌游都用得上。 */
export async function scanNames({ timeout = 15000 } = {}) {
  const lua = `
local counts = {}
for _, o in ipairs(getAllObjects()) do
  local n = tostring(o.name)
  counts[n] = (counts[n] or 0) + 1
end
print('JSON|' .. JSON.encode(counts))`;
  const kinds = await runLua(lua, { wantJson: true, timeout });
  if (!kinds) throw new Error('扫桌面超时（TTS 没开？外部编辑器没启用？）');
  const names = Object.keys(kinds).sort();
  const total = names.reduce((a, n) => a + kinds[n], 0);
  return { kinds, names, total };
}

/** 扫桌面 + 认游戏，一次做完。认不出来时 game 为 null，带上候选信息供报错。 */
export async function detect(bridgeDir, opts = {}) {
  const { games, errors } = await loadGames(bridgeDir);
  const { kinds, names, total } = await scanNames(opts);
  const hit = pickGame(games, names);
  return {
    game: hit?.game ?? null,
    evidence: hit?.evidence ?? [],
    games,
    errors,
    kinds,
    names,
    total,
  };
}
