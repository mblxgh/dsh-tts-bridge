# dsh-tts-bridge

让 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 真的能玩 [Tabletop Simulator](https://www.tabletopsimulator.com/)。

读桌面、落子、算形势；桌边挂一块牌子，点「敲一下」它就走一步。

**围棋是第一个做完的游戏，底下的通道对任何桌游都通用。**

---

## 装

前置三条，**缺一条都连不上**：

1. TTS 开着
2. 已经进到那局棋里（不是停在标题界面）
3. `Options → General → External Editor` 勾上

然后：

```bash
git clone https://github.com/mblxgh/dsh-tts-bridge.git
dsh plugin --profile web add ./dsh-tts-bridge
```

重启 dsh。Windows + Node 20+，没别的依赖。

<details>
<summary>手动挂载（不用 dsh plugin）</summary>

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: tts-bridge
      name: 'dsh-tts-bridge'
      config:
        port: 39902
```

`bridgeDir` 不用写，默认认本包旁边的 `bridge/`。
</details>

## 用

| 工具 | 干什么 |
|---|---|
| `tts_overlay` | 开桌面牌子（**先跑它**） |
| `tts_state` | 体检：插件 / TTS / 认出什么游戏 / 牌子在不在 |
| `tts_scan` | 桌上是什么游戏 |
| `tts_board` | 读盘 |
| `tts_place` / `tts_remove` | 落子 / 收子（围棋） |
| `tts_judge` | 谁领先几目 + 逐点归属（要 KataGo） |
| `tts_act` | 任意动作，参数原样转给游戏模块 |

牌子上：`敲一下`（叫它走一步）、`围棋` / `执色`（**选好再敲**）、`聊`（不用切回浏览器）。

## 接一个新游戏

**往 `bridge/games/` 扔一个 `.mjs`，插件一行不用改。**

```js
export default {
  id: 'go',
  title: '围棋',

  recognize(names) {                      // 从对象名认游戏，认不出返回 null
    const hit = names.filter((n) => n.startsWith('go_game_'));
    return hit.length ? { confidence: hit.length, evidence: hit } : null;
  },
  async read() { /* 读一次桌面 */ },
  render(state) { /* 变成模型能读的文字 */ },
  actions: {
    place: async ({ color, coord }) => '…',
  },
  async analyze(state, args) { /* 可选，没有就用不了 tts_judge */ },
};
```

`bridge/games/go.mjs` 就是这个形状，抄一份改名最快。

## 三个会当场咬人的坑

- **容器对象的 `type` 跟里面的东西一样。** 围棋这边棋罐也是 `GoPiece`，只能靠尺寸排除。
- **`spawnObject` 不可靠**，`bowl.takeObject({ position, callback })` 可靠。回调可能下一帧才跑。
- **回传只能靠一条带标记的 `print`。** 多条会丢会乱序，读盘脚本必须把结果攒成一条再打。

## 版本

`0.1.5` 实跑，`0.2.x` 接口对照过（唯一变化是 `source.kind: 'plugin'` 被删，本插件没用到）。

## 再往下挖

协议细节、坐标系统、悬浮窗的多屏坐标坑、KataGo 接法 → [docs/INTERNAL.md](docs/INTERNAL.md)

## License

MIT
