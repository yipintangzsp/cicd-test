FROM 127.0.0.1:30050/library/nginx-alpine:1.29.7-alpine

COPY index.html /usr/share/nginx/html/
EXPOSE 80
