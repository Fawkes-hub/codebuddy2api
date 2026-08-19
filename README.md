# CodeBuddy2API 接入说明

将 CodeBuddy 中国站（`copilot.tencent.com`）的模型通过 OpenAI 兼容接口暴露给本地应用使用。
本文以本地命令行启动为主，Docker Compose 作为可选部署方式。

## 架构

```
任意 OpenAI 兼容客户端
   │  OpenAI 协议 + Bearer API Key
   ▼
codebuddy2api (本地进程或 Docker, 端口 8001, /openai/v1)
   │  OAuth 凭证转发
   ▼
copilot.tencent.com (CodeBuddy 中国站账户)
```

- OpenAI 兼容端点：`http://127.0.0.1:8001/openai/v1`
- 模型列表：`GET /openai/v1/models`
- 健康检查：`GET /health`
- 管理台：`http://127.0.0.1:8001`（用于 OAuth 授权、API Key 管理）

## 命令行启动（推荐）

```bash
# 请先进入 codebuddy2api 项目目录

# 首次运行：创建虚拟环境并安装依赖
python3 -m venv venv
source venv/bin/activate
python3 -m pip install -r requirements.txt

# 首次运行：创建运行目录和管理用户密码文件
mkdir -p data secrets
python3 scripts/hash_password.py admin --output secrets/users.txt

# 启动服务，默认监听 127.0.0.1:8001
python3 web.py
```

后续启动只需激活虚拟环境并运行 `python3 web.py`。如使用 launchd 或其他进程管理器，
请将工作目录设置为仓库目录，并让管理器负责自动重启。

常用检查命令：

```bash
curl http://127.0.0.1:8001/health
curl http://127.0.0.1:8001/openai/v1/models \
  -H "Authorization: Bearer sk-your-api-key"
```

## 可选 Docker Compose 部署

```bash
# 请先进入 codebuddy2api 项目目录

docker compose up -d
docker compose ps
docker compose logs -f --tail 50
docker compose stop
```

Compose 会持久化 `data/` 和 `secrets/`。其中 `secrets/` 必须可写，因为首次创建或
轮换管理用户时需要更新 `users.txt`。

## 首次配置

1. 复制 `.env.example` 为 `.env`，按需配置：
   - `CODEBUDDY_API_ENDPOINT=https://copilot.tencent.com`（中国站）
   - `CODEBUDDY_ALLOWED_API_ENDPOINTS=https://copilot.tencent.com,https://www.codebuddy.ai`
   - `CODEBUDDY_MODELS=...hy3,hunyuan-t1,...`（与动态列表取并集）
   - `CODEBUDDY_HOST=127.0.0.1`、`CODEBUDDY_PORT=8001`
   - 只有需要局域网访问时才将 host 改为 `0.0.0.0`，并配合防火墙和可信网络使用
2. 启动服务后打开 `http://127.0.0.1:8001`，登录管理台。
3. 在“凭证管理”中启动 CodeBuddy 认证，完成上游账号授权。
4. 在“API Keys”中创建客户端 Key，并只保存到客户端的本地安全配置中。
5. 生产或长期运行时，建议定期轮换管理台密码、客户端 API Key 和上游授权。

## 客户端配置

- OpenAI 兼容 Base URL：`http://127.0.0.1:8001/openai/v1`
- Responses 接口：`http://127.0.0.1:8001/openai/v1/responses`
- Chat Completions 接口：`http://127.0.0.1:8001/openai/v1/chat/completions`
- API Key：填写管理台生成的客户端 Key，例如 `sk-your-api-key`
- Model：填写 `GET /openai/v1/models` 返回的模型 ID，例如 `hy3`

通用配置示例：

```yaml
base_url: http://127.0.0.1:8001/openai/v1
api_key: sk-your-api-key
model: hy3
api_mode: responses  # 不支持 Responses 的客户端可改为 chat_completions
```

如果客户端要求单独填写完整接口地址，请使用上面的 `/responses` 或
`/chat/completions` 地址，不要重复拼接 `/openai/v1`。

请求示例：

```bash
curl http://127.0.0.1:8001/openai/v1/responses \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"hy3","input":"你好"}'
```

不要将真实 API Key、管理台密码、CodeBuddy OAuth 凭证或包含它们的配置文件提交到 Git。

## 管理台和认证说明

管理台地址为 `http://127.0.0.1:8001`，用于 OAuth 授权、管理用户和生成客户端 API Key。
API 请求需要在请求头中携带 `Authorization: Bearer <客户端 API Key>`；该 Key 不等同于
CodeBuddy 账户密码，也不等同于上游 OAuth Token。

多用户认证文件为 `secrets/users.txt`。命令行部署使用脚本生成密码哈希；Docker 部署使用
Compose 挂载的同一目录，避免容器重建后丢失用户数据。

## 故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `health` 无法访问 | 服务未启动或端口被占用 | 检查启动进程、launchd 状态或 `docker compose ps` |
| `/openai/v1/models` 返回 401 | 未带客户端 API Key 或 Key 无效 | 使用管理台生成的 Key，检查 Bearer 请求头 |
| `/responses` 返回 404 | 运行的不是包含 Responses 适配器的版本 | 停止旧进程后重新启动，并确认代码版本 |
| 模型请求返回上游 401/403 | CodeBuddy OAuth 授权过期或无权限 | 在管理台重新完成 CodeBuddy 授权 |
| Docker 容器反复重启 | `secrets/users.txt` 不存在或挂载不可写 | 检查 `secrets/` 权限，并重新生成用户文件 |

## 安全建议

- 仅在本机使用时绑定 `127.0.0.1`；对外提供服务时必须增加网络访问控制。
- 不要把 `.env`、`data/`、`secrets/`、OAuth 导出文件或真实客户端配置加入版本库。
- 发现 Key 或 OAuth 凭证泄露后，立即在管理台撤销并重新生成。

## 备注

- `/responses` 用于兼容支持 OpenAI Responses API 的客户端；不支持该协议的客户端可使用
  `/chat/completions`。
- 模型能力取决于 CodeBuddy 上游账号和当前模型列表，客户端应以 `/openai/v1/models`
  的实际返回值为准。
