# 实现细节

README 里放不下的东西都在这儿。改代码之前值得看一遍，能省掉几个下午。

---

## TTS 外部编辑器协议

双向 TCP。这边连 TTS 的 `39999`，自己监听 `39998` 收回包。

线格式：`[u32le 长度][i32le tag][json + \0]`，tag `4` = handshake、`3` = command。

编辑器 → TTS 的 messageID：

| ID | 作用 |
|---|---|
| 0 | 取脚本 |
| 1 | saveAndPlay（**会重载存档**，别乱用） |
| 2 | customMessage |
| 3 | executeLua（`guid: '-1'` = Global，**不重载**） |

TTS → 编辑器：`2` print、`3` lua-error、`4` sendExternalMessage、`5` returnValue、`7` objectCreated。

### 回传只有一条路

`returnID` + messageID 5 和 `sendExternalMessage` 在 Global 环境里**都不回传**。唯一可靠的是带标记的 `print`：

```lua
print('JSON|' .. JSON.encode(result))
```

而且**多条 print 会丢会乱序**——必须把结果攒成一条再打。读盘脚本 `gosense.lua` 就是按这个写的。

长连接也别留：同一条 socket 挂十几秒后推送就断。每次发命令新建、发完销毁（`tts-core.mjs` 里的串行闸门顺手解决了并发覆盖的问题）。

### Global 环境里 `self` 是 nil

`self.createButton` 会报 Object reference not set。要装 UI 走 `UI.setXml`，而且**空尺寸的 `<VerticalLayout>` 会撑满整屏**。

反过来说，messageID 3 里定义的全局函数会留在 Global 环境里——所以能在运行时装 UI 而不重载存档。

---

## 棋盘几何

零硬编码的做法：

1. 找 `type == 'Board'` 且带吸附点的对象，取吸附点最多的那个
2. x / z 分别去重排序 → 网格线；相邻差 = 格距；条数 = 路数
3. 落点高度取盘上棋子的稳定高度（0.01 桶取众数再平均）

吸附点是**局部坐标**，而**棋子落点等于局部值、不带棋盘物体的位移**——别自作聪明加偏移。白子会额外偏 0.06（物理残留），所以匹配用容差（< 半步）。

映射：`i` = x 升序、`j` = z 从远到近；围棋列 `A~T` 跳过 `I`，行号 = 路数 − j。

### 两个具体的坑

**棋罐的 type 也是 `GoPiece`。** 按 type 或名字挑棋子会把四格宽的棋罐一起选中，高度全乱。只能靠尺寸排除：跨度超过 1.5 倍格距的不算棋子。

**`spawnObject` 不可靠。** 但棋罐是容器，`bowl.takeObject({ position, callback_function })` 能把一颗子直接放到位。回调可能下一帧才跑，收不到回包就**读盘看目标点有没有子**，别等 guid。

---

## 悬浮窗

WinForms + `UpdateLayeredWindow` 逐像素 alpha。

**圆角**：不能用 `Form.Opacity`——它内部走 `SetLayeredWindowAttributes`，跟 `UpdateLayeredWindow` 抢同一条路，结果是整窗发灰或者干脆画不出来。透明度改在 `Render()` 里由 `SourceConstantAlpha` 控制。

**点击穿透**：靠 `WM_NCHITTEST` 返回 `HTTRANSPARENT` **逐区域**判定，不是整窗 `WS_EX_TRANSPARENT`——不然连解除穿透那个按钮都点不到。

**置顶**：每秒沿 Z 序爬一次（`GetWindow(h, GW_HWNDPREV)`），撞到游戏窗口才 `SetWindowPos`。ACT OverlayPlugin 也是「先判断再修」，不是无脑轮询。

### 坐标：这是最坑的一段

`Form.Location` 在多屏 + 不同 DPI 的环境里**跟真实物理坐标不是一回事**。实测同一时刻：`Form` 报 `(2170,449)`，`GetWindowRect` 报 `(1943,448)`；换一次拖动后 `Form` 报 `(3225,475)`，`GetWindowRect` 报 `(2580,380)`——比值 0.8，而且**不是固定偏移，加不成**。

所以：

- 所有定位走 `GetWindowRect` / `SetWindowPos`，别拿 `Bounds` 去算别的窗口的位置
- 拖动 delta 用 `Cursor.Position`，不用 `PointToScreen`
- 夹紧范围用 `SystemInformation.VirtualScreen`，**别用 `PrimaryScreen`**——副屏上的窗口重启会被拽回主屏
- 拖动主窗时副窗口要同步 delta，否则一拖就撞上

还有：`AutoScaleMode = AutoScaleMode.None`，manifest 里声明 per-monitor-v2，截图进程要先 `SetProcessDPIAware()` 否则截不到它。

---

## KataGo

`bridge/katago.mjs`。**不常驻**：每次调用 spawn 一个进程，喂一条 analysis 请求，拿到结果就杀。

用 `eigenavx2` 版（纯 CPU，零依赖，不跟 ComfyUI 抢显存）。一次分析 8–10 秒，大半花在加载权重上。

请求走 `initialStones`（把盘面一次性摆好）而不是 `moves`，因为 TTS 上没有落子顺序。黑比白多一个子说明黑刚下完，补一手 `["B","pass"]` 把轮次让给白。

输出里两个字段有用：

- `scoreLead` —— **黑方视角、已扣贴目**的净领先目数。正数 = 黑领先。
- `ownership` —— 361 个点各自 -1..1，正值黑。`>0.5` / `<-0.5` 才算稳，中间是未定。

验证过的方法：贴目 7.5 / 0.5 / -0.5 三档对比，`scoreLead` 差值和贴目差值对得上（差 7 目贴目 → `scoreLead` 差 7.32）。

---

## dsh 版本兼容

拿 0.2.1-rc.2 的包跟本机 0.1.5 逐个比过：

| | 0.1.5 | 0.2.1 |
|---|---|---|
| `createUserMessage` 签名 | 同 | 同 |
| `source.kind: 'user'` | 有 | 有 |
| `source.kind: 'plugin'` | 有 | **删了** |
| `agents.roots` / `whenIdle` / `assistant-stream` | 有 | 有 |

**0.2 那个改动会咬人**：往会话注入消息时如果用 `source.kind: 'plugin'`，会报 `format v4 message requires a producer-owned source kind`。本插件注入走的是 `'user'`，不受影响。

因为这些是**非公开内部接口**，不在插件契约里，升大版本前拿 `tts_state` 试一遍最省事。

查 API 时注意：`@deepseek-ai/dsh` 主包只有 25 KB，是个 CLI 壳，真实现都在 `dsh-session` / `dsh-agent` / `dsh-tools` 这些子包里。

---

## 已知限制

- 围棋层**没做**打劫判定和轮次记录。收子是按下子后的气数现场算的，重复提劫这类情况不会拦。
- `tts_judge` 每次重新加载模型，纯 CPU 8–10 秒。要快就把 `bridge/katago/` 换成 OpenCL 版。
- 悬浮窗只编了 Windows 版。
- 同一个端口上只能跑一个 dsh——web 端和桌面端同时开会在 39902 上撞 `EADDRINUSE`，悬浮窗会连到另一个上去。
- 聊天面板跟 dsh 的会话是同一个：你在面板里说话，就是给那个会话发消息。
