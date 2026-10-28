# dsh-tts-bridge

让 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 陪你玩 [Tabletop Simulator](https://www.tabletopsimulator.com/) 的桌面桥。

在 dsh 里读盘、落子、算形势；桌面上挂一块半透明的小牌子，点一下「敲一下」就把 dsh 叫过来走一步。

> A bridge that lets DeepSeek Harness actually *play* tabletop games on Tabletop Simulator:
> read the board state, place pieces, and drive a click-through desktop overlay.
> Go is the first (and currently only) implemented game.

---

## 它能做什么

- **读盘**：现场扫描 TTS 桌上的棋盘，不依赖写死的尺寸、路数、坐标原点。你换个棋盘、挪一下位置，它照样认。
- **落子 / 收子**：按围棋记谱走子，自动提掉被吃的对方棋块，拒绝自杀手。
- **算形势**：接 KataGo，一句话说清「贴目算完谁领先多少目」，外加每个交叉点的归属——这就是收官实地。
- **桌面悬浮窗**：一块圆角半透明牌子，显示 dsh 在不在、忙不忙，点一下就能把它叫来走一步。附带一个聊天面板，不用切回浏览器也能跟它说话。

目前实装的游戏只有围棋。

---

## 前置条件

**三条缺一条都连不上**，报错时先按这个顺序查：

1. Tabletop Simulator 正在运行；
2. 已经进到那局棋里（不是停在标题或选单界面）；
3. TTS 设置里允许外部编辑器：`Options → General → External Editor` 那一栏勾上。

另外需要：

- Windows（悬浮窗是 WinForms，靠 .NET Framework 4.x 的 `csc.exe` 编译，系统自带）；
- Node.js 20+；
- dsh `>= 0.1.5-rc.1`。

---

## 安装

```bash
git clone <this-repo> dsh-tts-bridge
cd dsh-tts-bridge
```

然后二选一：

**A. 作为 bundle 装进 profile（推荐）**

```bash
dsh plugin --profile web add /path/to/dsh-tts-bridge
```

装完重启 dsh。装的时候 dsh 会把 `cordis.patch.yml` 里的 `tts-bridge` 条目插进 profile。

**B. 手动挂载**

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: tts-bridge
      name: 'dsh-tts-bridge'
      config:
        port: 39902
        bridgeDir: 'D:\path\to\dsh-tts-bridge\bridge'   # 不写就用本包旁边的 bridge/
```

`patchReload: live` 时改这个文件会热重载；但**插件代码本身改了要重启 dsh**（ESM 有缓存）。

### 悬浮窗（可选）

```bat
cd overlay
build.cmd
```

编译出 `overlay.exe`，双击即可。它需要 dsh 开着才有意义——每秒钟问一次 `/status`，问不到就显示灰色的「掉线」。

牌子上的名字是作者自己那个助手的名（大肥鱼）。想换成你的，改 `overlay.cs` 里 `Text = "大肥鱼"` 那一行，重新 `build.cmd` 就行。

热键：

| 组合 | 作用 |
|---|---|
| `Ctrl+Alt+K` | 敲一下（等同于点主按钮） |
| `Ctrl+Alt+P` | 点击穿透（穿透时只有右上那个圈能点，用来解除） |
| `Ctrl+Alt+I` / `Ctrl+Alt+O` | 调亮 / 调暗 |
| `Ctrl+Shift+L` | 锁定位置 |
| `Ctrl+Alt+Q` | 退出 |

### KataGo（可选，只影响 `tts_judge`）

```bash
node tools/fetch-katago.mjs          # CPU 版引擎 + 78 MB 权重
node tools/fetch-katago.mjs --gpu    # 多下一份 OpenCL 版引擎
node tools/fetch-katago.mjs --net b28c512nbt   # 换更大的网络，更准更慢
```

下完落在 `bridge/katago/`，这个目录在 `.gitignore` 里。分析引擎不常驻：每次调用现起现停，跑完就退，平时不占内存也不占显存。

---

## dsh 里能用的工具

| 工具 | 干什么 |
|---|---|
| `tts_state` | 通道体检。按钮按了没反应先跑这个 |
| `tts_scan` | 认桌上是什么游戏 |
| `tts_board` | 读盘，返回盘面与数空结果 |
| `tts_place` | 落一手（`color: B/W`，`coord: D4`） |
| `tts_remove` | 收走一颗子（悔棋） |
| `tts_judge` | 算形势：领先目数 + 胜率 + 逐点归属图（需要 KataGo） |

---

## 实现要点

想改的话，这几个地方值得先知道。

**TTS 外部编辑器协议**：双向 TCP，线格式是 `[u32le 长度][i32le tag][json + \0]`。这边连 TTS 的 `39999`，自己监听 `39998` 收回包。

- `messageID: 0` 取脚本、`2` customMessage、`3` executeLua（`guid: '-1'` 是 Global，**不会重载存档**）、`1` saveAndPlay（会重载，别乱用）。
- **回传只能靠一条带标记的 `print`**。`returnID` + messageID 5、`sendExternalMessage` 在 Global 环境下都不回传。而且多条 `print` 会丢会乱序，所以读盘脚本把所有结果拼成一条 `JSON|...` 打出来。

**棋盘发现**：找 `type == 'Board'` 且带吸附点的对象，取吸附点最多的那个；x/z 去重排序得到网格线，相邻差就是格距，条数就是路数。棋子落点等于吸附点的局部坐标（**不带棋盘物体的位移**）。

**棋罐也是 `GoPiece`**：按 type 或名字挑棋子会把四格宽的棋罐一起选中。只能靠体积排除——跨度超过 1.5 倍格距的不算棋子。

**空盘落子**：`spawnObject` 不可靠；棋罐是容器，`bowl.takeObject({ position, callback_function })` 能把一颗子直接放到位。回调可能下一帧才跑，收不到回包就读盘看目标点有没有子。

**悬浮窗的坐标**：`Form.Location` 在多屏 + 不同 DPI 的环境里跟真实物理坐标不是一回事（实测差两百多像素）。所有定位都走 `GetWindowRect` / `SetWindowPos`，别拿 `Bounds` 去算别的窗口的位置。

**圆角**：用 `UpdateLayeredWindow` 逐像素 alpha，不能用 `Form.Opacity`——两者抢同一条路，同时用会整窗发灰。

---

## 已知限制

- 围棋层**没做**打劫判定、轮次记录。收子是按下子后的气数现场算的，重复提劫这类情况它不会拦。
- `tts_judge` 每次要重新加载模型，纯 CPU 大概 8–10 秒出结果。想快就把引擎换成 OpenCL 版。
- 悬浮窗只编译了 Windows 版。
- 聊天面板跟 dsh 的会话是同一个——你在面板里说话，就是给那个会话发消息。

---

## 目录

```
.
├── index.js              dsh 插件本体（六个工具 + 给悬浮窗的 HTTP）
├── cordis.patch.yml      bundle patch
├── bridge/
│   ├── tts-core.mjs      协议层：连 39999、收 39998、串行闸门
│   ├── golib.mjs         围棋：读盘、落子、提子、数空、认游戏
│   ├── gosense.lua       推到 TTS 里跑的读盘脚本（零硬编码）
│   ├── katago.mjs        形势分析：起引擎、喂局面、算归属
│   └── katago.cfg        分析参数
├── overlay/
│   ├── overlay.cs        悬浮窗（WinForms）
│   ├── overlay.manifest  per-monitor DPI
│   └── build.cmd         编译
└── tools/
    └── fetch-katago.mjs  下载 KataGo 引擎与权重
```

---

## License

MIT
