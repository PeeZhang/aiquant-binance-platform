# aiquant 中文控制台

本控制台是 Freqtrade 的本地中文界面。它不修改 FreqUI，而是通过 Docker
Compose 中的本地 Python 代理读取 Freqtrade API。

## 启动

```powershell
.\scripts\console.ps1 start
```

打开：

```text
http://127.0.0.1:8090
```

## 端口

- 中文控制台：`127.0.0.1:8090`
- Freqtrade API/UI：`127.0.0.1:8081`

## 安全边界

- 浏览器端不保存 Freqtrade 密码。
- 控制台只读取本地 `binance_spot_dryrun.json` 中的本地 API 凭据。
- 启动和重载操作会先检查 `dry_run=true`、`spot`、`sandbox=true`、禁止做空。
