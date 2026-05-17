FROM 127.0.0.1:30050/library/nginx-alpine:latest

# 使用本地已验证运行时基线，避免构建阶段依赖外部 Alpine 仓库。

COPY index.html /usr/share/nginx/html/
EXPOSE 80
