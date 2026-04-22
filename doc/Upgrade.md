  关键点在这几处：

  - platform/app/container/manager.py 里 create_container() 只负责 docker run，挂载的是固定 named volume：openclaw-data-{short_id}。
  - platform/app/container/manager.py 里 destroy_container() 只删容器，不删 volume。
  - openclaw/bridge-entrypoint.sh 的同步策略是“缺什么补什么”，不是“按版本强制覆盖重铺”。
  - manage_front/src/app/(admin)/containers/page.tsx 当前只显示状态、Docker ID、创建时间，没有版本字段。
  - platform/app/db/models.py 的 Container 表也没有版本信息。
  - deploy_docker.py 只是把 deploy_copy 复制到 openclaw/bridge-deploy-copy，供镜像构建和 entrypoint 使用。

  所以你说得对：

  DELETE FROM containers; 不会解决升级问题。
  它只会让 platform 忘记容器；但用户 volume 还在，下一次重建容器时，旧的 ~/.openclaw 仍会挂回来，而 entrypoint 又只补缺失文件，于是旧版本状态继
  续残留。


修改openclaw/bridge-entrypoint.sh呢，进行强制同步拷贝可以吗？在使用deploy_docker.py时，强制删除用户的容器并重新启动呢？这样是否就是强制
  升级了
  2. 升级会变成“每次容器启动都执行”
     如果你只是把 entrypoint 改成无条件覆盖，那么：

  - 容器重启一次，就强制重铺一次
  - 用户刚改完某些文件，下一次 restart 又被覆盖

# 升级openclaw的用户容器的方案
  - .env 里定义 OPENCLAW_DEPLOY_VERSION
  - 传到用户容器
  - entrypoint 读取当前目标版本
  - 检查 /root/.openclaw/version.txt
  - 只有版本不一致时，才执行强制覆盖同步
  - 同步完成后写入新版本标记

  1. 高优先级: 你描述的升级链路还没落到代码里。当前 openclaw/bridge-entrypoint.sh:1 仍然是旧逻辑，只做“缺失时复制”，没有
     OPENCLAW_DEPLOY_VERSION、version.txt、版本比较或强制覆盖同步。按现在代码，删容器重建后仍不会得到你想要的“按版本强制升级”。
  2. 高优先级: dedicated 容器没有接收到版本变量。platform/app/container/manager.py:265 的 container_env 只传了代理地址、token、模型、时区等，没
     有把部署版本传进用户容器；platform/app/config.py:1 也还没有对应配置项。
  3. 高优先级: compose 侧也没把 .env 中的版本传给 gateway。docker-compose.yml:27 的 gateway.environment 没有 PLATFORM_OPENCLAW_DEPLOY_VERSION 一
     类字段，所以即便 .env 里加了 OPENCLAW_DEPLOY_VERSION，platform 现在也读不到。
  4. 中优先级: 你当前工作区里真正的代码改动和这个需求无关。git status 里只有 .env、openclaw/bridge/config.ts:1 和新文档 doc/Upgrade.md；其中
     openclaw/bridge/config.ts 的 diff 只是注释改成中文，不影响升级链路。

  至少还要改这四处：
  - docker-compose.yml:27：把 .env 的版本号传进 gateway
  - platform/app/config.py:1：新增 openclaw_deploy_version
  - platform/app/container/manager.py:265：把版本号传进 dedicated 用户容器环境变量
  - openclaw/bridge-entrypoint.sh:1：读取版本、比较 version.txt、仅在不一致时强制同步并写回版本

更改文件
.env
.env.example
docker-compose.yml
openclaw/bridge-entrypoint.sh
platform/app/config.py
platform/app/container/manager.py
