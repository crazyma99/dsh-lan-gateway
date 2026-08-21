# dsh-lan-gateway

一个 **DeepSeek Harness (`dsh`) 插件**：按需把 dsh WebUI 通过**独立 HTTPS 网关**暴露给局域网设备。主服务始终只监听 `127.0.0.1`，风险边界清晰：

- **默认关闭**，在 WebUI「设置 → 局域网访问」页实时开启/关闭（无需重启 dsh）；
- 网关自带 **TLS 加密**（自签证书自动生成，或使用自定义证书）；
- **HTTP Basic 认证**（密码以 `role('secret')` 存储，永不离开宿主机）；
- 可选 **IP 白名单**（CIDR）；
- 网关只做 loopback 转发并重写 `Host`/`Origin`，后端 `/api` 信任围栏与「设置/凭据仅本机可改」的约束原样保留——**局域网设备能使用 WebUI，但永远无法修改设置或读取凭据**。

## 结构

```
dsh-lan-gateway/
├── src/
│   ├── index.ts                 # Cordis host 半：引擎 + 设置命名空间 + 状态 RPC
│   ├── settings.ts              # lan-gateway 设置 schema（扁平，password 为 secret）
│   ├── gateway.ts               # 纯 Node 网关引擎（TLS/认证/白名单/反向代理）
│   ├── selfsigned.ts            # 零依赖自签 X.509 生成（ECDSA P-256 / SHA-256）
│   ├── auth.ts                  # Basic 认证解析 + 恒定时间比较
│   ├── cidr.ts                  # CIDR / IPv4/IPv6 匹配
│   └── client/                  # 浏览器半：设置页 section + 文案
├── cordis.patch.yml             # bundle patch：把插件挂进组合
├── scripts/build.mjs            # esbuild：lib/index.js（Node ESM）+ lib/client.js（浏览器工厂）
└── tests/                       # vitest 单元/集成测试（纯 Node，无需 dsh）
```

## 构建

```sh
pnpm install        # 若提示 esbuild 构建脚本被忽略，先运行 pnpm approve-builds 批准 esbuild
pnpm run build      # 产出 lib/index.js、lib/client.js 与 lib/types
pnpm run typecheck  # 对照本地 dsh checkout 的类型声明校验
pnpm test           # vitest
```

> 类型检查通过 `tsconfig.json` 的 `paths` 指向 `/home/majunhi/deepseek-harness` 各包的
> `lib/types/*.d.ts`。如果 checkout 路径不同，请修改 `paths`。

## 安装到 dsh profile

以当前 `web` profile（`~/.dsh/profiles/web`）为例：

```sh
# 1. 把插件声明为 profile 的依赖（本地链接）
cd ~/.dsh/profiles/web
pnpm add link:/home/majunhi/文档/dsh-lan-gateway

# 2. 在 cordis.patch.yml 里挂载插件行（或把 "dsh-lan-gateway" 追加进
#    package.json 的 dsh.profile.bundles，让插件的 cordis.patch.yml 生效）
cat >> cordis.patch.yml <<'EOF'
- insert:
    - id: lan-gateway
      name: 'dsh-lan-gateway'
EOF

# 3. 重启 dsh web，打开 WebUI「设置 → 局域网访问」
```

之后在设置页设置密码并开启，即可从局域网设备访问
`https://<主机IP>:<端口>`（默认端口 8443）。

## 安全模型（摘要）

- **加密**：只提供 HTTPS/WSS，不提供明文 HTTP。自签证书首次访问需在浏览器核对设置页展示的 SHA-256 指纹后信任；也可在设置里改用已有证书。
- **认证**：HTTP Basic（浏览器原生支持，fetch/SSE/WebSocket 自动携带），比较采用恒定时间哈希。
- **纵深**：后端只看到 loopback 请求；`settings.*`/`credentials.*` 等特权 RPC 对局域网客户端依旧 403；状态查询 RPC 仅 loopback 可调。
- **默认关闭**：`enabled` 默认 `false`；密码为空时 `validate` 拒绝开启。

详见 [docs/security.md](docs/security.md)。

## 已知边界（V1）

- IPv6 白名单仅支持精确匹配；IPv4 支持 CIDR。
- 局域网客户端无法修改任何设置（这是设计目标，不是缺陷）。
- 插件在 checkout 外开发，改客户端代码后需要 `pnpm run build` 并**刷新页面**（不享受 `dev:web` 的 HMR）。
- 状态页采用 2s 轮询；不做事件推送。
