# dsh-lan-gateway

**DeepSeek Harness (`dsh`) 局域网访问插件**：在 WebUI 设置页里一键开启，把 dsh WebUI 通过**独立 HTTPS 网关**安全地暴露给局域网设备。主服务始终只监听 `127.0.0.1`，风险边界清晰、默认关闭。

> 设计目标：让手机/平板/同网段设备安全使用 WebUI，同时**绝不**让局域网设备改动任何配置或凭据。

## ✨ 特性

- **精美登录页 + Cookie 会话**：未认证的浏览器访问重定向到网关自带的登录页（自动跟随系统明暗主题、按 `Accept-Language` 显示中/英），登录后签发 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie，7 天滑动续期；HTTP Basic 继续支持 curl 等非浏览器客户端。
- **TLS 全程加密**：只提供 HTTPS/WSS。自签证书（ECDSA P-256）自动生成，指纹在设置页展示供核对；也可改用自定义证书。
- **首次开启 OOBE 引导**：无凭据时打开主开关，弹出「设置访问凭据」模态框（用户名 + 密码 + 确认密码），保存后自动开启。
- **凭据管理模态框**：设置页「用户名与密码」一键修改，密码确认双输校验。
- **IP 白名单（CIDR）**：进一步收窄来源网段。
- **纵深防御**：网关把 `Host`/`Origin` 重写为 loopback 转发，主服务 `/api` 信任围栏原样生效；`settings.update/replace/mutate`、`credentials.*`、插件自身 `/lan-gateway` 等**特权与管理 RPC 在网关上直接 403**——局域网设备可读取脱敏后的当前配置（`settings.describe`，含密码在内的秘密字段永不出现），但**永远不能改配置、读凭据**。
- **默认关闭 / 失败关闭**：密码为空时拒绝开启；端口占用、证书错误等以 `error` 状态展示，绝不降级成明文。
- **登录限流**：同一来源 10 分钟内登录失败超过 5 次即被拒绝，防暴力破解。

## 🧱 架构

```
局域网设备 ──https://192.168.1.5:8443──▶ dsh-lan-gateway（独立 HTTPS 反向代理）
   │ 登录页/Cookie 会话 · TLS · IP 白名单 · Host/Origin 重写 · 特权 RPC 拦截
   └──http://127.0.0.1:3080──▶ dsh 主 WebServer（保持仅本机监听，不改动）
```

```
dsh-lan-gateway/
├── src/
│   ├── index.ts                 # Cordis host 半：配置存储 + 引擎 + loopback RPC
│   ├── config-store.ts          # config.json 持久化（0600，部署默认 + 用户层）
│   ├── gateway.ts               # 纯 Node 网关引擎（TLS/登录页/会话/白名单/代理）
│   ├── login-page.ts            # 自包含登录页（明暗主题 + 中英双语）
│   ├── selfsigned.ts            # 零依赖自签 X.509 生成（ECDSA P-256 / SHA-256）
│   ├── auth.ts                  # Basic 解析 + 恒定时间比较
│   ├── cidr.ts                  # CIDR / IPv4/IPv6 匹配
│   └── client/                  # 浏览器半：设置页 section（Switch/状态卡/凭据模态）
├── cordis.patch.yml             # bundle patch：把插件挂进组合
├── scripts/build.mjs            # esbuild：lib/index.js + lib/client.js + 类型
├── docs/security.md             # 安全模型全文
└── tests/                       # vitest（30 个用例：证书/认证/会话/登录/代理/胶水层）
```

## 🔧 构建

```sh
pnpm install        # 若提示 esbuild 构建脚本被忽略，先运行 pnpm approve-builds 批准 esbuild
pnpm run build      # 产出 lib/index.js、lib/client.js 与 lib/types
pnpm run typecheck  # 对照本地 dsh checkout 的类型声明校验（路径见 tsconfig.json 的 paths）
pnpm test           # vitest
```

> 类型检查通过 `tsconfig.json` 的 `paths` 指向 `/home/majunhi/deepseek-harness` 各包的
> `lib/types/*.d.ts`。如果 checkout 路径不同，请修改 `paths`。

## 📦 安装到 dsh profile

以 `web` profile（`~/.dsh/profiles/web`）为例：

```sh
# 1. 把插件声明为 profile 的依赖（本地链接）
cd ~/.dsh/profiles/web
pnpm add link:/home/majunhi/文档/dsh-lan-gateway

# 2. 把插件加入 package.json 的 dsh.profile.bundles，让它的 cordis.patch.yml 生效：
#      "dsh-lan-gateway"
#    追加到 bundles 数组末尾即可。

# 3. 重启 dsh web，打开 WebUI「设置 → 局域网访问」
```

## 🚀 使用

1. 打开 WebUI **设置 → 局域网访问**，打开主开关。
2. **首次开启**：弹出「设置访问凭据」模态框，设置用户名与密码（二次确认）后点击「保存并开启」。
3. 状态卡显示运行状态、访问地址（`https://<主机IP>:8443`）、证书 SHA-256 指纹与活动连接数。
4. 局域网设备访问该地址 → 看到登录页 → 输入凭据登录。
5. 修改凭据：**设置 → 局域网访问 → 用户名与密码**（改密后所有已登录会话立即失效）。
6. 自签证书首次访问会有浏览器警告，**核对指纹后信任**；生产环境建议在设置里改用 CA 签发证书。

## 💾 数据与持久化

| 路径 | 内容 | 权限 |
|---|---|---|
| `$DSH_HOME/lan-gateway/config.json` | 网关配置（含密码） | `0600` |
| `$DSH_HOME/lan-gateway/cert.pem` / `key.pem` | 自签证书与私钥 | `0644` / `0600` |
| `$DSH_HOME/lan-gateway/session.key` | Cookie 签名密钥 | `0600` |

配置在启动时读取，运行中通过设置页实时生效。`config.json` 删除即回到出厂默认（关闭、无密码）。

## 🔌 插件 RPC（仅本机 loopback 可达）

通道 `/lan-gateway`，`authority: 'loopback'`——局域网设备经网关访问一律 403：

| 端点 | 请求 | 说明 |
|---|---|---|
| `status` | `{}` | 运行状态、实际端口、指纹、LAN 地址、活动连接 |
| `config.get` | `{}` | 公开配置（密码只返回 `hasPassword` 布尔） |
| `config.set` | `{ field, value }` | 单字段写入；宿主侧校验（开启前必须有密码） |

## 🛡️ 安全模型

摘要见上，完整威胁模型、剩余风险与缓解见 [docs/security.md](docs/security.md)。核心不变量：

- 主服务**从不**绑定非回环地址；
- 密码**永不**离开宿主机（RPC 不返回、登录只比对）；
- 配置与管理面**永远**只对宿主机本机开放；
- 一切失败**关闭**而非降级。

## ⚠️ 已知边界（V1）

- 单一用户名/密码；IPv6 白名单仅支持精确匹配（IPv4 支持 CIDR）。
- Cookie 会话 7 天滑动续期；改密码会立即吊销全部会话。
- 插件在 checkout 外开发：改代码后需 `pnpm run build`，客户端改动需**重启 dsh web + 刷新页面**（不享受 `dev:web` 的 HMR）。
- 状态卡采用 2s 轮询，无事件推送。
- 未实现多用户、mTLS 与审计日志（见 security.md 的 V2 计划）。

## 📜 变更记录

- `8c5fbc7` 登录页 + Cookie 会话取代浏览器原生 Basic 弹窗；登录限流。
- `37297fa` 凭据 OOBE + 管理模态框；Switch 对比度修复；状态卡布局修复。
- `0313f72` 首个可用版本：HTTPS 网关、config/status RPC、设置页、特权 RPC 拦截、30 项测试。

## License

MIT
