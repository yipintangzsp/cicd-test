FROM 127.0.0.1:30050/library/nginx-alpine:latest

COPY docker/apks/alpine-3.23-aarch64/*.apk /tmp/apks/
RUN apk add --no-network --allow-untrusted /tmp/apks/*.apk && rm -rf /tmp/apks

COPY index.html /usr/share/nginx/html/
EXPOSE 80
