# dsh-tts-bridge

让 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 真的能玩 [Tabletop Simulator](https://www.tabletopsimulator.com/) 的桥。

> A bridge that lets DeepSeek Harness play tabletop games on Tabletop Simulator.
> **Go is the first finished game; the plumbing underneath is meant for any game.**

---

## 这是什么

Tabletop Simulator 有一个 External Editor API：双向 TCP，能读桌上每个对象的脚本，能在游戏里执行 Lua，能靠一条 `print` 把结果打回来。

这个项目把那条通道接到 dsh 的插件系统上。接上之后，模型不再是「看不见桌上有什么」——它能扫桌面、读位置、看棋盘吸附点、动手摆东西，桌面旁边还有一块能敲的小牌子把它叫过来。

**围棋是第一个把这条线完整跑通的游戏**：读盘、判断、落子、提子、数空、算形势，全套。

但底下的东西跟围棋没关系。通道、工具注册、桌面窗口、敲击唤醒、聊天面板——这些是壳。换个游戏，要重写的只有「游戏层」那一个文件。

---

## 分层

```
┌───────────────────────────────────────────┐
│  dsh 模型                                  │
├───────────────────────────────────────────┤
│  index.js        插件层：注册工具 + HTTP    │  ← 跟游戏无关
├───────────────────────────────────────────┤
│  bridge/golib.mjs   游戏层：围棋            │  ← 换游戏只动这里
│  bridge/gosense.lua 读盘脚本（推进 TTS 里跑）│
├───────────────────────────────────────────┤
│  bridge/tts-core.mjs  协议层：TCP + Lua     │  ← 跟游戏无关
├───────────────────────────────────────────┤
│  bridge/katago.mjs    外部引擎（可选）      │
└───────────────────────────────────────────┘
        ↕ 39999 / 39998           ↕ 39902
   Tabletop Simulator          overlay.exe（桌面窗口）
```

各层现在提供什么：

| 能力 | 在哪 |
|---|---|
| 连 TTS、跑 Lua、收 `print` 回包 | `bridge/tts-core.mjs` |
| 桌面对象清单、类型、体积、位置扫描 | `bridge/gosense.lua`（写法可复用） |
| 六个 dsh 工具 | `index.js` |
| 给桌面窗口的 HTTP：状态、敲击、聊天收发 | `index.js` |
| 圆角半透明悬浮窗、三态指示、聊天面板、点击穿透 | `overlay/overlay.cs` |
| 围棋规则与棋盘几何 | `bridge/golib.mjs` |
| 形势判断（胜率 / 领先目数 / 逐点归属） | `bridge/katago.mjs` |

---

## 围棋这一层做完了什么

- **读盘**：现场扫描棋盘吸附点，不依赖写死的路数、格距、坐标原点。换个棋盘、挪个位置，照样认。
- **落子 / 收子**：按记谱走子，自动提掉被吃的对方棋块，拒绝自杀手。
- **数空**：中国规则，子空皆地。
- **算形势**：接 KataGo，给出「贴目算完谁领先多少目」，外加每个交叉点的归属——就是收官实地。

---

## 接一个新游戏

游戏层要交出的东西是四件事。照着 `bridge/golib.mjs` 的骨架写一份就行：

**1. 认游戏** —— `inventory()` 里按对象名前缀判断桌上是什么。
现在的写法是 `go_game_*` 认成围棋；加一个分支，另一套前缀认成你的游戏。

**2. 读盘** —— 一个 `sense()`：往 TTS 里推一段 Lua，让它把桌面状态拼成一条 `print` 打回来，再解析成你的数据结构。
注意协议层的硬约束：**回传只能靠一条带标记的 `print`**，多条会丢会乱序。所以读盘脚本必须把结果攒成一条再打。

**3. 渲染** —— 一个 `render()`：把读到的状态变成模型能读的文字盘面。
这条决定了模型看得懂多少，比想象中重要。

**4. 动作** —— 落子、拿子、放子，一步一个函数。TTS 里能做的事基本都能做：`takeObject` / `placeObject` / `setPosition` / `setRotation` / `destroy`。

绕不开的两个坑，先写在前面：

- **容器对象（棋罐、牌堆、袋子）的 `type` 跟里面的东西是一样的。** 围棋这边就是棋罐也是 `GoPiece`，按类型挑棋子会把四格宽的罐子一起选中。只能靠体积/尺寸排除。
- **`spawnObject` 不可靠**，但从容器里拿是可靠的：`bowl.takeObject({ position, callback_function })`。回调可能下一帧才跑，收不到回包就读盘看目标点有没有东西。

现在的状态得说清楚：**游戏层还是硬接的**——`index.js` 里的六个工具直接调 `golib`，没有「按当前游戏分发」的中间层。想让第二款游戏跟围棋并存，得把游戏层抽成一个统一的 `{ sense, render, act }` 接口，插件按认出来的游戏分发。这步还没做，但目录和职责已经按这个方向分开了。

---

## 安装

**前置条件，三条缺一条都连不上**：

1. Tabletop Simulator 正在运行；
2. 已经进到那局棋里（不是停在标题或选单界面）；
3. TTS 设置里允许外部编辑器：`Options → General → External Editor` 勾上。

另外需要 Windows（悬浮窗靠 .NET Framework 4.x 的 `csc.exe`，系统自带）、Node.js 20+、dsh `>= 0.1.5-rc.1`。

```bash
git clone https://github.com/mblxgh/dsh-tts-bridge.git
```

然后二选一：

**A. 作为 bundle 装进 profile（推荐）**

```bash
dsh plugin --profile web add /path/to/dsh-tts-bridge
```

装完重启 dsh。

**B. 手动挂载**

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: tts-bridge
      name: 'dsh-tts-bridge'
      config:
        port: 39902
        # bridgeDir 不填就用本包旁边的 bridge/
```

`patchReload: live` 时改这个文件会热重载；**插件代码本身改了要重启 dsh**（ESM 有缓存）。

### 悬浮窗（可选）

```bat
cd overlay
build.cmd
```

编译出 `overlay.exe`，双击即可。它靠每秒问一次 `/status` 判断 dsh 在不在，问不到就显示灰色的「掉线」。

牌子上的名字是作者自己那个助手的名（大肥鱼）。想换成你的，改 `overlay.cs` 里 `Text = "大肥鱼"` 那一行，重新 `build.cmd`。

热键：

| 组合 | 作用 |
|---|---|
| `Ctrl+Alt+K` | 敲一下（等同点主按钮） |
| `Ctrl+Alt+P` | 点击穿透（穿透时只有右上那个圈能点，用来解除） |
| `Ctrl+Alt+I` / `Ctrl+Alt+O` | 调亮 / 调暗 |
| `Ctrl+Shift+L` | 锁定位置 |
| `Ctrl+Alt+Q` | 退出 |

### KataGo（可选，只影响 `tts_judge`）

```bash
node tools/fetch-katago.mjs                    # CPU 版引擎 + 78 MB 权重
node tools/fetch-katago.mjs --gpu               # 多下一份 OpenCL 版引擎
node tools/fetch-katago.mjs --net b28c512nbt    # 换更大的网络，更准更慢
```

落在 `bridge/katago/`，这个目录在 `.gitignore` 里。引擎不常驻：每次调用现起现停，平时不占内存也不占显存。

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

改之前值得先知道的几件事。

**协议线格式**：`[u32le 长度][i32le tag][json + \0]`。这边连 TTS 的 `39999`，自己监听 `39998` 收回包。

- `messageID: 0` 取脚本、`2` customMessage、`3` executeLua（`guid: '-1'` 是 Global，**不重载存档**）、`1` saveAndPlay（会重载，别乱用）。
- **回传只能靠一条带标记的 `print`**。`returnID` + messageID 5、`sendExternalMessage` 在 Global 环境下都不回传，而且多条 `print` 会丢会乱序。所以读盘脚本把所有结果拼成一条 `JSON|...` 打出来。
- **长连接会死**：同一条 socket 挂十几秒后推送就断。每次发命令新建、发完销毁。

**Global 环境里 `self` 是 nil**：`self.createButton` 会报 Object reference not set。想装 UI 走 `UI.setXml`，而且空尺寸的 `<VerticalLayout>` 会撑满整屏。

**棋盘几何**：找 `type == 'Board'` 且带吸附点的对象，取吸附点最多的那个；x/z 去重排序得到网格线，相邻差就是格距，条数就是路数。棋子落点等于吸附点的**局部坐标**，不带棋盘物体的位移。

**空盘第一手**：`spawnObject` 不可靠；棋罐是容器，`bowl.takeObject({ position, callback_function })` 能把一颗子直接放到位。回调可能下一帧才跑，收不到回包就读盘看目标点有没有子。

**悬浮窗坐标**：`Form.Location` 在多屏 + 不同 DPI 的环境里跟真实物理坐标不是一回事（实测差两百多像素，而且比例不固定，不能靠加偏移修）。所有定位走 `GetWindowRect` / `SetWindowPos`，别拿 `Bounds` 去算别的窗口的位置。夹紧范围用 `SystemInformation.VirtualScreen`，不然副屏上的窗口重启会被拽回主屏。

**圆角**：`UpdateLayeredWindow` 逐像素 alpha。不能跟 `Form.Opacity` 同时用——两者抢同一条路，结果是整窗发灰或者干脆画不出来。

**点击穿透**：靠 `WM_NCHITTEST` 返回 `HTTRANSPARENT` 逐区域判定，不是整窗 `WS_EX_TRANSPARENT`——不然连解除穿透的那个按钮都点不到。

---

## 已知限制

- 围棋层**没做**打劫判定和轮次记录。收子是按下子后的气数现场算的，重复提劫这类情况不会拦。
- `tts_judge` 每次要重新加载模型，纯 CPU 大概 8–10 秒出结果。
- 悬浮窗只编译了 Windows 版。
- **游戏层没有统一接口**，第二款游戏要接进来得先做接口抽取（见上一节）。
- 聊天面板跟 dsh 的会话是同一个——你在面板里说话，就是给那个会话发消息。

---

## 目录

```
.
├── index.js              dsh 插件：六个工具 + 给桌面窗口的 HTTP
├── cordis.patch.yml      bundle patch
├── bridge/
│   ├── tts-core.mjs      协议层：连 39999、收 39998、串行闸门
│   ├── golib.mjs         围棋：读盘、落子、提子、数空、认游戏
│   ├── gosense.lua       推进 TTS 里跑的读盘脚本（零硬编码）
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
