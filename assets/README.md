# assets/ —— 放你自己的音乐和音效

这个目录**默认不在 Git 仓库里**（`.gitignore` 已忽略除本文件以外的一切），
所以你往这里放任何音频都不会被提交、也不会被推到 GitHub Pages。

## 用法

把文件丢进这个目录，**刷新页面即可生效，不需要改任何代码**。

### 背景音乐（自动循环，按场景切换）

| 文件名 | 用在哪 |
|---|---|
| `bgm-lobby.mp3` | **主界面 / 大厅** |
| `bgm-table.mp3` | **牌桌默认**（没配具体场次时用它） |
| `bgm-easy.mp3` | 简单场 |
| `bgm-normal.mp3` | 普通场 |
| `bgm-hard.mp3` | 困难场 |
| `bgm-champion.mp3` | 冠军场 |

主界面和牌桌是**两套独立的曲子**，进游戏时会自动切换。
某个场次没配就回落到 `bgm-table.mp3`；全都没有则回落到内置合成引擎。

### 音效（可选，缺省用内置合成音）

| 文件名 | 用在哪 |
|---|---|
| `sfx-deal.mp3` | 发牌 |
| `sfx-chip.mp3` | 筹码 |
| `sfx-win.mp3` | 胜利 |
| `sfx-lose.mp3` | 失败 |

### 格式

支持 `mp3` / `ogg` / `m4a`。代码按这个顺序逐个尝试，加载成功就用。

## 关于版权

- **不要放你没有使用权的音频**到会被公开分发的地方。
- 本目录已被 `.gitignore` 排除，放这里的音频**只会留在你本机**，不会被推到 GitHub，
  所以仅供个人娱乐地放入商业游戏音频，风险基本可控。
- 但如果你要把整个项目（含音频）打包发给别人、或部署到公开站点，请务必换成
  有授权的素材，例如：
  - [Kenney](https://kenney.nl/assets) — CC0（无需署名，最省心）
  - [Pixabay Music](https://pixabay.com/music/) — 免费商用
  - [OpenGameArt](https://opengameart.org/) — 注意逐项看 CC0 / CC-BY
  - [Free Music Archive](https://freemusicarchive.org/) — 注意逐项看授权

## 想让音频跟着仓库走？

如果你放的是**有授权、可分发**的素材，想让它进 Git 和 Pages，
删掉 `.gitignore` 里的这几行即可：

```
assets/*
!assets/README.md
```

同时建议在仓库根目录补一份授权说明（比如 `assets/LICENSE-audio.md`），
写明每个文件的来源与授权方式（CC-BY 需要署名）。
