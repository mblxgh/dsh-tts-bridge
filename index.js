/**
 * dsh-tts-bridge —— 让 dsh 陪主人玩桌面游戏（Tabletop Simulator）。
 *
 * 三件事：
 *  1. 工具：tts_board（读盘）/ tts_state（三方状态体检）。
 *     真实实现躺在 bridgeDir 的 golib.mjs 里，插件只做参数映射与输出整理。
 *  2. HTTP 服务（默认 39902）：桌面那块悬浮窗靠它判断 dsh 在不在 ——
 *     轮询 /status 就是「连接检测」，按「敲一下」就是 POST /knock。
 *  3. 被敲时直接往「当前会话」塞一条用户消息（agent.followup），
 *     不靠后台任务退出，也就没有「敲了没人应」的空窗。
 *
 * 三个必须记住的坑：
 *  1. **不能 export default**。cordis 的 loader 是 `exports = exports.default ?? exports`，
 *     一旦有 default，整个命名空间被顶掉，Cordis 拿到的是个没有 apply() 的普通类，
 *     而且不报错 —— 表现为插件「加载了但不工作」。
 *  2. **inject 要写 ["tools"]**，否则第一次取 ctx.tools 就抛
 *     `cannot get property "tools" without inject`，整个 dsh 启动失败。
 *  3. golib 每次读盘都会在 39998 上开监听收回包。插件一旦起来，命令行 `node go.mjs`
 *     就不能同时跑了（端口独占）。要么用这里的工具，要么先把插件停掉。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'tts-bridge';

/**
 * 故意只注入 tools：加载期不依赖 agents / sessionController，
 * 那两个等到真正被敲的时候再惰性取。服务没就绪时错过 apply 是查不出来的坑。
 */
export const inject = ['tools'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(39902),
  bridgeDir: z.string().default(''),
});

const DEFAULTS = {
  enabled: true,
  port: 39902,
  // 留空就用本包旁边的 bridge/ 目录 —— clone 下来开箱即用，不用改路径
  bridgeDir: '',
};

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
};

let logPath = null;

/** stdout + 落盘双写：dsh 的 stdout 在启动窗口里，排错时看不到。 */
function log(...args) {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  console.log('[tts-bridge]', text);
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
  } catch {
    /* 落盘失败绝不拖累主流程 */
  }
}

export function apply(ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) };
  // bridgeDir 没配就认本包旁边的 bridge/ —— 仓库 clone 下来直接能用
  if (!cfg.bridgeDir) {
    cfg.bridgeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge');
  }
  log('apply() 被调用，配置键：', Object.keys(rawConfig ?? {}).join(',') || '(空)');
  if (!cfg.enabled) {
    log('配置里关着，跳过加载');
    return;
  }
  try {
    fs.mkdirSync(cfg.bridgeDir, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  logPath = path.join(cfg.bridgeDir, 'dsh-plugin.log');

  // ── 游戏层：不写死是哪个游戏，扫 bridge/games/ 现认 ──
  let apiPromise = null;
  const getApi = () => {
    if (!apiPromise) {
      const href = pathToFileURL(path.join(cfg.bridgeDir, 'game-api.mjs')).href;
      apiPromise = import(href).catch((e) => {
        apiPromise = null;
        throw new Error(`加载 ${href} 失败：${e.message}`);
      });
    }
    return apiPromise;
  };

  /**
   * 认出桌上是什么游戏。认不出来就抛一条能直接给主人看的话。
   * 每次工具调用现扫 —— 加游戏文件不用重启也能认（模块有缓存，改文件要重启）。
   */
  async function resolveGame() {
    const api = await getApi();
    const d = await api.detect(cfg.bridgeDir, { timeout: 20000 });
    if (!d.game) {
      const known = d.games.map((g) => g.title || g.id).join('、') || '（一个都没有）';
      const lines = ['认不出桌上是什么游戏。', `已装的游戏：${known}`];
      if (d.errors?.length) lines.push('加载出错的：' + d.errors.join('；'));
      lines.push('桌上的对象名（前 20 个）：');
      for (const n of d.names.slice(0, 20)) lines.push(`  ${n} × ${d.kinds[n]}`);
      throw new Error(lines.join('\n'));
    }
    return d;
  }

  // ── 运行态 ──
  let knockCount = 0;
  let lastKnockAt = null;
  let lastKnockSession = '';
  let overlaySeenAt = 0;
  let busyKnock = false;

  // ── 找「主人当前在用的会话」──
  // 优先用上次找到的那个：列表查询在会话正忙时会排队，而敲击多半发生在主人刚说完话、
  // 会话还在跑的时候 —— 每次都去查列表等于每次都撞在忙的时候。
  let cachedSid = '';

  async function findAgent() {
    try {
      const agents = ctx.get('agents');
      if (!agents) {
        log('agents 不可用');
        return null;
      }
      // 快路径 1：上次用过的会话还活着
      if (cachedSid) {
        const live = typeof agents.get === 'function' ? agents.get(cachedSid) : null;
        if (live) return { agent: live, sid: cachedSid };
      }

      // 快路径 2：内存里活着的顶层 agent —— 纯内存遍历，瞬时。
      // 这才是正路。原来直接调 sessionController.list()，那要读所有会话的摘要投影，
      // 会话一多、又赶上 dsh 刚起来，能卡几十秒（实测点完按钮几十秒后消息才注入）。
      const arr =
        typeof agents.roots === 'function'
          ? agents.roots()
          : typeof agents.list === 'function'
            ? agents.list()
            : [];
      if (arr.length) {
        const agent = arr[arr.length - 1]; // 最后注册的 = 最近在用的
        const sid = String(agent?.id ?? agent?.sessionId ?? '');
        if (sid) cachedSid = sid;
        return { agent, sid: sid || '(live)' };
      }

      // 慢路径：一个活着的 agent 都没有（dsh 刚启动，主会话还没被加载）。
      // 这时候只能查列表 + resume，所以两道超时都要有。
      const controller = ctx.get('sessionController');
      if (!controller?.list) {
        log('sessionController 不可用，且没有活着的 agent');
        return null;
      }
      const value = await Promise.race([
        controller.list({}, new AbortController().signal),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('会话列表查询超时（会话多或刚启动时常见）')), 6000),
        ),
      ]);
      const items = [...(value?.items ?? [])]
        .filter((it) => !it.parentSessionId && it.origin !== 'subagent')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const top = items[0];
      if (!top) {
        log('一个会话都没有');
        return null;
      }
      const sid = String(top.sessionId);
      log(`没有活着的 agent，尝试 resume ${sid}`);
      const handle = await Promise.race([
        agents.resume({ resumeSessionId: sid }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('resume 超时')), 10000)),
      ]);
      if (!handle?.agent) {
        log('resume 没拿到 agent');
        return null;
      }
      cachedSid = sid;
      return { agent: handle.agent, sid };
    } catch (e) {
      log('找会话失败:', e);
      return null;
    }
  }

  // ── 三态用的内存标记 ──
  // /status 必须「瞬时」返回：dsh 主线程忙的时候，任何去问会话状态的动作都会排队，
  // 那样连「我还在」都答不上来，前端就只能判掉线 —— 把「忙」误判成「死」。
  // 所以 /status 只读这个变量，真正的探测放到后台（whenIdle 自己会 resolve）。
  let busyFlag = false;
  let watching = false; // 正在被 watchIdle 盯着，这时候不要别的来源去改标记

  // ── 聊天记录 ──
  // 悬浮窗要能当聊天框用，就必须看得到「我」说的话，不只是一来一回的提示。
  // 靠 agent/assistant-stream 收集流式文本，闲置一会儿就落成一条。
  const chatLog = [];
  let chatSeq = 0;
  let streamBuf = '';
  let streamAt = 0;

  function pushChat(role, text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    chatSeq++;
    chatLog.push({ seq: chatSeq, role, text: t, ts: Date.now() });
    if (chatLog.length > 300) chatLog.shift();
  }

  function flushStream() {
    if (streamBuf.trim()) pushChat('agent', streamBuf);
    streamBuf = '';
  }

  function watchIdle(agent) {
    if (!agent || typeof agent.whenIdle !== 'function') {
      busyFlag = false;
      return;
    }
    watching = true;
    busyFlag = true;
    Promise.resolve(agent.whenIdle())
      .catch(() => {})
      .finally(() => {
        flushStream();
        busyFlag = false;
        watching = false;
      });
  }

  // ── 探「agent 现在忙不忙」（给 tts_state 这种诊断用，不挂在 /status 上）──
  // 这是悬浮窗三态的唯一依据：忙 → 思考中；闲 → 待机；连不上 → 掉线。
  // 判据用 agent.whenIdle()：它只在会话空闲时 resolve，跑着的时候一直挂着。
  // 只给 5 毫秒窗口就够分辨 —— 空闲会立刻 resolve，忙的一瞬间不会有结果。
  async function probeBusy() {
    if (!cachedSid) return null; // 还没被敲过，不知道主人在哪个会话
    try {
      const agents = ctx.get('agents');
      const live = typeof agents?.get === 'function' ? agents.get(cachedSid) : null;
      if (!live) return false;
      if (typeof live.whenIdle !== 'function') return null;
      let idle = false;
      await Promise.race([
        Promise.resolve(live.whenIdle()).then(() => {
          idle = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 5)),
      ]);
      return !idle;
    } catch {
      return null;
    }
  }

  // ── 把一段文字塞进当前会话（敲击和聊天共用）──
  async function inject(text, why, opts = {}) {
    const target = await findAgent();
    if (!target) {
      log(`${why}：找不到会话`);
      return false;
    }
    busyFlag = true;
    // 聊天框里要看得见自己说了什么；但敲击带的是整块盘面，那种不进聊天记录
    if (opts.log !== false) pushChat('user', text);
    target.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    );
    watchIdle(target.agent);
    cachedSid = target.sid;
    log(`${why} 已送进会话 ${target.sid}：${String(text).slice(0, 40)}`);
    return true;
  }

  // ── 被敲：读盘 + 塞进会话 ──
  async function handleKnock(opts = {}) {
    knockCount++;
    lastKnockAt = new Date();

    const wantGame = String(opts.game ?? '');
    const color = String(opts.color ?? '');
    const colorName = color === 'B' ? '黑' : color === 'W' ? '白' : '随机 / 未定';

    let body;
    try {
      const { game } = await resolveGame();
      const head = `[对局] 游戏=${game.title || game.id}　我执=${colorName}`;
      const state = await game.read({ timeout: 15000 });
      const rendered = String(game.render(state));
      body = ['=== 被敲了（桌面悬浮窗）===', head, '', rendered, '', '盘面已读，轮到我出手。'].join('\n');
    } catch (e) {
      log('读盘失败:', e);
      body = [
        '=== 被敲了，但读不到盘 ===',
        `[对局] 我执=${colorName}${wantGame ? '　游戏=' + wantGame : ''}`,
        '',
        String(e?.message ?? e),
        '',
        '先看 TTS 是不是还开着、桌上有没有那张棋盘。',
      ].join('\n');
    }

    const ok = await inject(body, `第 ${knockCount} 次敲`, { log: false });
    lastKnockSession = cachedSid || '';
    return { said: ok ? '敲到了' : '找不到会话' };
  }

  // ── 工具 ──
  const register = (def) => ctx.tools.register(defineTool({ output: TEXT_OUTPUT, ...def }));

  register({
    name: 'tts_board',
    description:
      '读一次桌面，返回当前游戏摆成什么样。围棋给的是盘面 + 中国规则数空 + 盘外散子；棋盘路数/格距/坐标原点全部现场扫描，不依赖写死的尺寸。',
    parameters: {},
    timeoutMs: 40000,
    async execute() {
      try {
        const { game } = await resolveGame();
        const state = await game.read({ timeout: 20000 });
        return game.render(state);
      } catch (e) {
        return `读盘失败：${e?.message ?? e}\n（确认 TTS 开着、桌上就是那局棋）`;
      }
    },
  });

  register({
    name: 'tts_state',
    description:
      '给这条陪玩通道做体检：dsh 插件在不在、TTS 连不连得上、桌面悬浮窗最近有没有来问过、被敲过几次。排查「按钮按了没反应」先跑这个。',
    parameters: {},
    timeoutMs: 30000,
    async execute() {
      const lines = [];
      lines.push(`dsh 插件：在线（这个工具就是它答的），监听 127.0.0.1:${cfg.port}`);
      lines.push(`被敲次数：${knockCount}${lastKnockAt ? '，上次 ' + lastKnockAt.toLocaleString('zh-CN', { hour12: false }) : ''}`);
      if (lastKnockSession) lines.push(`上次敲击送进的会话：${lastKnockSession}`);
      lines.push(
        overlaySeenAt
          ? `悬浮窗：${Math.round((Date.now() - overlaySeenAt) / 1000)} 秒前来问过`
          : '悬浮窗：没来问过（没开，或者它瞄的端口不对）',
      );
      try {
        const api = await getApi();
        const d = await api.detect(cfg.bridgeDir, { timeout: 12000 });
        lines.push(`TTS：在线 · 桌上 ${d.total} 个对象`);
        if (d.game) {
          lines.push(`认出游戏：${d.game.title || d.game.id}`);
          const state = await d.game.read({ timeout: 12000 });
          const rendered = String(d.game.render(state)).split('\n')[0];
          lines.push(rendered);
        } else if (d.games.length) {
          lines.push(`认不出游戏。已装的：${d.games.map((g) => g.title || g.id).join('、')}`);
        } else {
          lines.push('一个游戏模块都没有 —— bridge/games/ 是空的');
        }
      } catch (e) {
        lines.push(`TTS：连不上（${e?.message ?? e}）`);
        // 把「接下来该查什么」直接写在这里，省得模型自己去猜端口和进程
        lines.push('  → 按顺序确认三件事，缺一条都不通：');
        lines.push('    ① 游戏开着（Tabletop Simulator 进程在）');
        lines.push('    ② 已经进到那局棋里（不是停在标题/选单界面）');
        lines.push('    ③ TTS 设置里允许外部编辑器（Options → General 里那一栏）');
        lines.push('  → 把这三条说给主人，然后停手等他回；三条都确认过还不行再跟他说「我换个方向查」。');
      }
      return lines.join('\n');
    },
  });

  register({
    name: 'tts_judge',
    description:
      '看一眼现在这局谁领先多少（已扣贴目）、以及逐点的归属。用游戏自己的分析器（围棋走 KataGo，纯 CPU，现起现停不常驻）。主人问「现在谁赢」「这块归谁」「贴目算完差多少」时用它。',
    parameters: {
      komi: { type: 'number', description: '贴目，中国规则常用 7.5。默认 7.5' },
      visits: { type: 'number', description: '搜索量。越大越准越慢，默认 300' },
    },
    timeoutMs: 120000,
    async execute(args) {
      try {
        const { game } = await resolveGame();
        if (typeof game.analyze !== 'function') {
          return `${game.title || game.id} 这边还没有分析器（游戏模块没实现 analyze）。`;
        }
        const state = await game.read({ timeout: 20000 });
        return await game.analyze(state, {
          komi: args?.komi ?? 7.5,
          visits: args?.visits ?? 300,
        });
      } catch (e) {
        return `算不出来：${e?.message ?? e}\n（读盘和引擎都正常吗？先跑 tts_board 确认 TTS 通）`;
      }
    },
  });

  register({
    name: 'tts_scan',
    description:
      '扫一遍 TTS 桌面，认出桌上摆的是哪个游戏。认的是 bridge/games/ 下装了哪些游戏；认不出来就把对象清单列出来让人判断。开局第一步先用它。',
    parameters: {},
    timeoutMs: 40000,
    async execute() {
      try {
        const api = await getApi();
        const d = await api.detect(cfg.bridgeDir, { timeout: 20000 });
        const lines = [`桌上 ${d.total} 个对象`];
        if (d.game) {
          lines.push(`认出游戏：${d.game.title || d.game.id}（id=${d.game.id}）`);
          lines.push(`依据：${d.evidence.join('  ')}`);
        } else {
          lines.push(`认不出是什么游戏。已装的：${d.games.map((g) => g.title || g.id).join('、') || '（一个都没有）'}`);
          if (d.errors?.length) lines.push('加载出错的：' + d.errors.join('；'));
          lines.push('桌上对象名：');
          for (const n of d.names.slice(0, 40)) lines.push(`  ${n} × ${d.kinds[n]}`);
        }
        return lines.join('\n');
      } catch (e) {
        return `扫桌面失败：${e?.message ?? e}\n（TTS 开着吗？外部编辑器 API 是启用的吗？）`;
      }
    },
  });

  register({
    name: 'tts_place',
    description:
      '在棋盘上落一手（围棋）。会自动提掉被吃的对方棋子。坐标用围棋记谱：列 A~T 跳过 I，行号从下往上 1~19（如 D4、Q16）。',
    parameters: {
      color: { type: 'string', required: true, description: 'B（黑）或 W（白）' },
      coord: { type: 'string', required: true, description: '围棋坐标，如 D4' },
    },
    timeoutMs: 90000,
    async execute(args) {
      try {
        const { game } = await resolveGame();
        const act = game.actions?.place;
        if (typeof act !== 'function') {
          return `${game.title || game.id} 没有「落子」这个动作，能用的是：${Object.keys(game.actions || {}).join('、') || '（无）'}`;
        }
        return await act({ color: args?.color, coord: args?.coord });
      } catch (e) {
        return `落子失败：${e?.message ?? e}`;
      }
    },
  });

  register({
    name: 'tts_remove',
    description: '把棋盘上某一颗子收走（围棋）。下错了悔一步、或者替主人收掉被吃的子时用。',
    parameters: {
      coord: { type: 'string', required: true, description: '围棋坐标，如 D4' },
    },
    timeoutMs: 40000,
    async execute(args) {
      try {
        const { game } = await resolveGame();
        const act = game.actions?.remove;
        if (typeof act !== 'function') {
          return `${game.title || game.id} 没有「收子」这个动作，能用的是：${Object.keys(game.actions || {}).join('、') || '（无）'}`;
        }
        return await act({ coord: args?.coord });
      } catch (e) {
        return `收子失败：${e?.message ?? e}`;
      }
    },
  });

  register({
    name: 'tts_act',
    description:
      '对当前游戏执行一个动作，参数原样转给游戏模块。围棋有两个：place（落子）、remove（收子）。接别的游戏时，新加的动作从这个口子调，不用改插件。',
    parameters: {
      action: { type: 'string', required: true, description: '动作名，如 place' },
      color: { type: 'string', description: '给 place 用：B 或 W' },
      coord: { type: 'string', description: '给 place / remove 用：坐标，如 D4' },
    },
    timeoutMs: 90000,
    async execute(args) {
      try {
        const { game } = await resolveGame();
        const name = String(args?.action ?? '').trim();
        const acts = game.actions || {};
        const act = acts[name];
        if (typeof act !== 'function') {
          return `${game.title || game.id} 没有「${name}」这个动作。能用的是：${Object.keys(acts).join('、') || '（无）'}`;
        }
        const { action, ...rest } = args ?? {};
        return await act(rest);
      } catch (e) {
        return `动作失败：${e?.message ?? e}`;
      }
    },
  });

  // ── HTTP：悬浮窗的接口 ──
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const text = (res, code, s) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(s);
  };

  const readBody = (req, limit = 8192) =>
    new Promise((resolve) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
        if (buf.length > limit) buf = buf.slice(0, limit);
      });
      req.on('end', () => resolve(buf));
      req.on('error', () => resolve(''));
    });

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    if (url.startsWith('/status')) {
      overlaySeenAt = Date.now();
      // 只读内存标记，绝不在这里问 agents / whenIdle ——
      // dsh 卡着的时候那些查询自己也排队，前端就会把「卡」读成「掉线」。
      return json(res, 200, {
        ok: true,
        plugin: name,
        port: cfg.port,
        busy: busyFlag,
        session: cachedSid || null,
        knockCount,
        lastKnockAt: lastKnockAt ? lastKnockAt.toISOString() : null,
        lastKnockSession,
      });
    }

    // 悬浮窗的聊天框轮询这个：拉增量，只取比 since 新的
    if (url.startsWith('/chatlog')) {
      overlaySeenAt = Date.now();
      const m = /[?&]since=(\d+)/.exec(url);
      const since = m ? Number(m[1]) : 0;
      return json(res, 200, {
        ok: true,
        seq: chatSeq,
        busy: busyFlag,
        items: chatLog.filter((x) => x.seq > since),
      });
    }

    if (url.startsWith('/knock')) {
      overlaySeenAt = Date.now();
      if (busyKnock) return text(res, 200, '上一次还在处理，等我这一手');
      busyKnock = true;
      // 立刻回话，body 慢慢读、流程后台跑
      text(res, 200, '敲到了');
      readBody(req)
        .then((raw) => {
          let opts = {};
          try {
            opts = JSON.parse(raw || '{}');
          } catch {
            /* 没有 body 也能敲 */
          }
          return handleKnock(opts);
        })
        .catch((e) => log('knock 处理失败:', e))
        .finally(() => {
          busyKnock = false;
        });
      return;
    }

    // 悬浮窗里的聊天框：不走读盘，直接把一句话塞进会话
    if (url.startsWith('/chat')) {
      overlaySeenAt = Date.now();
      text(res, 200, '说给他了');
      readBody(req)
        .then(async (raw) => {
          let msg = '';
          try {
            msg = String(JSON.parse(raw || '{}').text ?? '');
          } catch {
            /* ignore */
          }
          msg = msg.trim().slice(0, 2000);
          if (!msg) return;
          const ok = await inject(msg, '聊天');
          if (!ok) log('聊天没送出去：找不到会话');
        })
        .catch((e) => log('chat 失败:', e));
      return;
    }

    return text(res, 404, 'no');
  });

  ctx.effect(() => {
    // 收集 agent 的流式输出 —— 悬浮窗靠这个把我的回复显示出来
    const off = ctx.on(
      'agent/assistant-stream',
      ({ frame }) => {
        if (!frame || frame.type !== 'chunk') return;
        const c = frame.chunk;
        if (!c || c.type !== 'text-delta' || typeof c.text !== 'string' || !c.text) return;
        streamBuf += c.text;
        streamAt = Date.now();
      },
      { global: true },
    );
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'tts-bridge-stream');

  ctx.effect(() => {
    // 每秒探一次 agent 忙不忙，结果写进内存标记 —— 这样主人直接打字让我干活时，
    // 牌子也能显示「思考中」，不只是被敲的时候。
    // 探测自己可能排队（dsh 忙时），但它跑在后台，不影响 /status 的响应速度。
    const timer = setInterval(() => {
      // 流停了 3 秒还没被 watchIdle 收尾（比如主人直接打字触发的），这里兜一手
      if (streamBuf && Date.now() - streamAt > 3000) flushStream();
      if (watching) return; // knock 那条线正在盯着，别抢
      probeBusy()
        .then((b) => {
          if (b !== null && !watching) busyFlag = b;
        })
        .catch(() => {});
    }, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'tts-bridge-busy');

  ctx.effect(() => {
    server.on('error', (e) => log('HTTP 服务出错:', e));
    server.listen(cfg.port, '127.0.0.1', () => log(`HTTP 起来了：http://127.0.0.1:${cfg.port}`));
    return () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    };
  }, 'tts-bridge-http');

  log('已就绪：工具 tts_board / tts_state，HTTP /status /knock');
}

// ⚠️ 这里绝对不要写 export default：
// cordis 的 loader 是 `exports = exports.default ?? exports`，有 default 就顶掉整个命名空间，
// 拿到的是一个没有 apply() 的普通对象，表现为「插件加载了但不工作」，而且不报错。
