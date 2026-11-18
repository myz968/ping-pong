# ping-pong · DSH 桌宠插件

给 DeepSeek Harness（DSH）桌面端做的一个**有功能**的桌宠：不只是会动的小人，而是把 agent 的真实状态显示出来。

![四态](https://img.shields.io/badge/状态-待命·干活·等待确认·出错-blue)

## 它做什么

| 状态 | 触发 | 表现 |
|---|---|---|
| 待命 | `api-session/status` running=false | 8fps 待机循环（含眨眼），白球来回弹 |
| 干活 | `api-session/status` running=true | 16fps 挥拍，蓝色光环，白球继续弹 |
| 等待确认 | `approval/request`、`user-questions/request` | 黄环，球飞成橙色问号 |
| 出错 | `agent/error` | 红环，球飞成红色叹号 |

点宠物弹出状态面板：当前状态计时、最近消息时间、状态时间线（30 条）、错误记录（点击复制）、静音、清空。

**消息图标球**是这套设计的核心：没有消息时白球在打乒乓，一有东西进来，那颗球就换成对应图标飞过宠物头顶——不盯文字也能知道"有东西进来了"。

## 装法

```bash
# 1) 把仓库放到 D:\dsh-plugins\ping-pong（路径随意，但要和 profile 里的 link 对上）
git clone https://github.com/myz968/ping-pong.git D:\dsh-plugins\fzd-pet

# 2) 在 DSH 的 profile 里加依赖与 bundle
#    C:\Users\<你>\.dsh\profiles\desktop\package.json
#    dependencies: "@local/fzd-pet": "link:D:/dsh-plugins/fzd-pet"
#    bundles:      "@local/fzd-pet"

# 3) 重启 DSH
```

## 改代码

`client.js` 是 376 KB 的生成物（里面约 350 KB 是 base64 帧），**不要手改**。

```powershell
# 改 client.template.js（第 1 行的 /*__FZD_FRAMES__*/ 占位符必须保留）
python tools/build-client.py     # 把 frames/*.webp 重新注入
node --check client.js
# 重启 DSH 生效
```

换形象就把新的 `idle-00..07.webp` / `hit-00..07.webp` 放进 `frames/`，再跑上面这条命令。

## 目录

```
client.template.js   UI 全部逻辑（宠物 / 面板 / 球 / 持久化）
client.js            生成物，别手改
frames/             16 张 256px webp（8 待机 + 8 挥拍）
tools/build-client.py  帧注入脚本
index.js            宿主半：空实现（不起进程、不开端口）
README-合并版.md      架构、四态表、回滚步骤、已知边界（更详细）
```

## 一句必须说清楚的话

这个插件用的是 DSH **未公开的客户端契约**：`window.__ModuleLoader__.load()`、`ctx.slots.inject('conversation.composer.dock')`、`ctx.remote.$on('api-session/status')`。

- 在 DSH 0.2.x 上实测可用
- **DSH 一升级，这些名字可能就变了**，插件会静默失效（不会报错，只是不动）
- 打包时要 `inject: ['slots','locale','remote']`，否则拿不到状态源

排查顺序：先看 `ctx.remote.$on` 是否还是这个事件名 → 再看槽位名 → 最后看 `__ModuleLoader__` 的签名。

## License

MIT（`LICENSE` 见仓库）
