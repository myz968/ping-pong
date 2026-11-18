# fzd-pet（合并版）· 2026-11-18

DSH 里只有一个桌宠插件了。它同时承担三件事：**形象**、**状态**、**消息提示**。

## 1. 结构

```
D:\dsh-plugins\fzd-pet\
├─ package.json          name=@local/fzd-pet  version 1.1.0
├─ index.js              宿主半：空实现（不起子进程、不开端口）
├─ client.template.js    源文件（改这个）
├─ client.js             生成物（376 KB，帧数据已注入，别手改）
├─ frames\               16 张 256px webp（8 待机 + 8 挥拍）
├─ tools\build-client.py 把 frames 打包成 data URL 注入模板
├─ locale\ icon.svg cordis.patch.yml
```

## 2. 表现

| 状态 | 触发条件 | 宠物表现 |
|---|---|---|
| 待命 idle | `api-session/status(running=false)` 或初始 | 8fps 待机循环（含眨眼），白球来回弹 |
| 干活 working | `api-session/status(running=true)` | 16fps 循环挥拍，蓝色光环亮起，白球继续弹 |
| 等待确认 waiting | `approval/request`、`user-questions/request` | 黄环，球飞成橙色问号图标 |
| 出错 error | `agent/error` | 红环，球飞成红色叹号图标 |

**消息图标球**：任何「来东西了」的事件（新消息、待确认、报错），那颗白球会瞬间换成对应图标飞过宠物头顶，1.25 秒后消失、白球回来。这样不用盯文字也能知道有东西进来了。

点宠物 → 弹出状态面板：当前状态已持续计时、最近消息时间、状态时间线（30 条）、错误记录（点击复制）、静音、清空。

## 3. 状态源（重要）

```js
ctx.remote.$on('api-session/status', (_sessionId, running) => ...)
```

这条通道是旧版 fzd-pet 实测有效的。**不要写成 `ctx.on('api-session/status')`** —— agent-pet 当初就是这么写的，永远收不到，导致面板一直停在待命。

## 4. 改代码的正确姿势

```powershell
# 1) 改 client.template.js（第 1 行的 /*__FZD_FRAMES__*/ 不能动）
# 2) 重新注入帧数据
python D:\dsh-plugins\fzd-pet\tools\build-client.py
# 3) 语法检查
node --check D:\dsh-plugins\fzd-pet\client.js
# 4) 重启 DSH 才生效
```

`client.js` 是 376 KB 的生成物（约 350 KB 全是 base64 帧），手改必然出错。
换帧时把新的 `idle-00..07.webp` / `hit-00..07.webp` 放进 `frames\` 再跑上面第 2 步。

## 5. 这次合并去掉的东西

| 去掉 | 原因 |
|---|---|
| C# `AgentPet.Server.exe` + `AgentPet.Core.dll` | 状态不再需要本地服务中转 |
| 9800 端口、`endpoint.json`、`/health` 轮询 | 同上，少一个常驻进程和三个故障点 |
| `agent-pet` 插件本身 | 功能已并入，留着会出现两个头像 |
| `%APPDATA%\agent-pet\history.json` | 历史改存 `localStorage`（key `fzd-pet:store:v1`） |

## 6. 回滚

合并前的两个插件与 profile 都备份在：

```
D:\dsh-plugins\_backup-merge-20261118\
├─ fzd-pet\                       旧装饰插件
├─ agent-pet\                     旧状态面板插件
└─ package.json.bak-merge-20261118
```

回滚三步：把 `fzd-pet` 与 `agent-pet` 复制回 `D:\dsh-plugins\`，用备份覆盖 profile 的 `package.json`，重启 DSH。

## 7. 已知边界

- 计时按「当前状态已持续」算，状态一换就归零，不是任务总时长。
- 卡住判定 5 分钟，只在 `working` 下生效；判定结果只显示在面板，不弹系统通知（系统通知交给 `dsh-desktop-notify`，避免一个错误弹两次）。
- 消息图标只有三枚内置 SVG（消息 / 待确认 / 出错）。要换成应用图标（微信、QQ 等），改 `ICONS` 里对应项即可，其余逻辑不用动。
