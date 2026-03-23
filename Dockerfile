FROM nginx:alpine

# 修复 zlib 漏洞的正确指令
RUN apk update && apk upgrade --no-cache && apk add --no-cache zlib

COPY index.html /usr/share/nginx/html/
EXPOSE 80