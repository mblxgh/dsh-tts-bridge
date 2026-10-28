// 围棋 —— 游戏层的一个实现，也是「怎么接一款新游戏」的活样板。
//
// 想接别的桌游：把这个文件复制一份改名，把 recognize / read / render / actions
// 换掉就行。插件那边不用动。

import * as go from '../golib.mjs';
import * as katago from '../katago.mjs';

const PREFIX = 'go_game_';

export default {
  id: 'go',
  title: '围棋',

  recognize(names) {
    const hit = names.filter((n) => n.startsWith(PREFIX));
    if (!hit.length) return null;
    return { confidence: hit.length, evidence: hit };
  },

  async read({ timeout = 20000 } = {}) {
    return await go.sense({ timeout });
  },

  render(state) {
    const s = go.summarise(state);
    const lines = [s.head, '', s.text, '', s.grip, s.result];
    if (s.offboard.length) {
      lines.push(
        '盘外: ' +
          s.offboard.map((o) => `${o.name}@(${o.x.toFixed(1)},${o.z.toFixed(1)})`).join('  '),
      );
    }
    if (s.clash.length) lines.push(`⚠ 同一交叉点上有 ${s.clash.length} 颗子`);
    if (s.unknown.length) lines.push(`⚠ 颜色不明 ${s.unknown.length} 颗`);
    return lines.join('\n');
  },

  actions: {
    /** 落一手。args: { color: 'B'|'W', coord: 'D4' } */
    place: async ({ color, coord } = {}) => {
      const c = String(color ?? '').toUpperCase();
      if (c !== 'B' && c !== 'W') return 'color 只能是 B 或 W';
      const r = await go.place(c, String(coord ?? ''));
      const cap = r.captures.length
        ? `，提掉 ${r.captures.length} 子（${r.captures.join(' ')}）`
        : '，没提子';
      return `已落 ${r.color} ${r.coord}${cap}。落点偏差 ${r.offset}。`;
    },
    /** 收走一颗子。args: { coord: 'D4' } */
    remove: async ({ coord } = {}) => {
      const r = await go.remove(String(coord ?? ''));
      return `已收走 ${r.coord} 的${r.color}子`;
    },
  },

  /** 形势判断。需要 KataGo，没装就说明白，别让人以为是坏了。 */
  async analyze(state, { komi = 7.5, visits = 300 } = {}) {
    if (!katago.available()) {
      return '没装 KataGo（引擎或权重缺一个），算不了形势。装法见 README，放到 bridge/katago/ 里。';
    }
    const grid = go.toGrid(state);
    const r = await katago.judge(grid, { komi, visits });
    const lines = [
      katago.verdict(r),
      `黑方胜率 ${(r.winrate * 100).toFixed(1)}%　·　盘面 黑 ${r.blackStones} 子 / 白 ${r.whiteStones} 子　·　${(r.ms / 1000).toFixed(1)} 秒`,
      `归属已定：黑 ${r.blackPts} 点 / 白 ${r.whitePts} 点 / 未定 ${r.unclear} 点（>0.5 才算稳）`,
    ];
    if (r.ownership) {
      lines.push('', 'X=黑地  O=白地  ·=未定', katago.renderOwnership(r.ownership));
    }
    return lines.join('\n');
  },
};
