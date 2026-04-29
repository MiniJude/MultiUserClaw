# 前端报错: Agent 执行出错:请检查当前模型是否可用
发现是posgresql和容器缓存等问题，python deploy_docker.py --clean 进行完全清理和重建修复

# 网关认证错误，应该是你启动了其它的openclaw实例，导致和现有openclaw冲突，停止其它openclaw即可
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...
[  bridge] [gateway-client] Connection closed (unauthorized: gateway token missing (provide gateway auth token)), reconnecting in 2s...

⏺ Update(~/.openclaw/openclaw.json)
  ⎿  Added 2 lines, removed 1 line
      57      "port": 18789,
      58      "bind": "loopback",
      59      "auth": {
      60 -      "mode": "none"
      60 +      "mode": "none",
      61 +      "token": "
      62      },
      63      "controlUi": {
      64        "allowedOrigins": [



