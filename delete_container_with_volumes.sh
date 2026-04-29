#!/bin/bash

# 脚本：删除 Docker 容器及其关联的卷,方便删除某个用户的容器，测试时使用，或者用户的openclaw损坏了，彻底删除数据
# 用法：./delete_container_with_volumes.sh <容器名称>

set -e  # 遇到错误时退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 显示使用说明
show_usage() {
    echo "用法: $0 <容器名称>"
    echo "示例: $0 my_container"
    exit 1
}

# 检查参数
if [ $# -ne 1 ]; then
    echo -e "${RED}错误：请提供容器名称${NC}"
    show_usage
fi

CONTAINER_NAME="$1"

# 检查 Docker 是否运行
if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}错误：Docker 未运行或当前用户没有权限访问 Docker${NC}"
    exit 1
fi

# 检查容器是否存在
if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}错误：容器 '${CONTAINER_NAME}' 不存在${NC}"
    exit 1
fi

echo -e "${YELLOW}正在处理容器: ${CONTAINER_NAME}${NC}"

# 获取容器关联的卷
VOLUMES=$(docker inspect --format='{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep -v '^$' | sort -u)

# 停止容器（如果正在运行）
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}停止容器 ${CONTAINER_NAME}...${NC}"
    docker stop "$CONTAINER_NAME" >/dev/null
    echo -e "${GREEN}✓ 容器已停止${NC}"
else
    echo -e "${YELLOW}容器未运行，跳过停止步骤${NC}"
fi

# 删除容器
echo -e "${YELLOW}删除容器 ${CONTAINER_NAME}...${NC}"
docker rm "$CONTAINER_NAME" >/dev/null
echo -e "${GREEN}✓ 容器已删除${NC}"

# 删除关联的卷
if [ -n "$VOLUMES" ]; then
    echo -e "${YELLOW}发现以下关联的卷:${NC}"
    echo "$VOLUMES" | while read -r volume; do
        echo "  - $volume"
    done
    
    read -p "是否删除这些卷？(y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "$VOLUMES" | while read -r volume; do
            if [ -n "$volume" ]; then
                echo -e "${YELLOW}删除卷 ${volume}...${NC}"
                docker volume rm "$volume" >/dev/null 2>&1
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}✓ 卷 ${volume} 已删除${NC}"
                else
                    echo -e "${RED}✗ 无法删除卷 ${volume}（可能被其他容器使用）${NC}"
                fi
            fi
        done
    else
        echo -e "${YELLOW}跳过删除卷${NC}"
    fi
else
    echo -e "${YELLOW}该容器没有关联的卷${NC}"
fi

echo -e "${GREEN}完成！${NC}"
