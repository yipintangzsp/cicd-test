Offline Alpine 3.23 aarch64 patch packages for the nginx-alpine runtime image.

These packages remove the current HIGH/CRITICAL findings reported by Trivy for
the local `127.0.0.1:30050/library/nginx-alpine:latest` base image without
requiring network access during `docker build`.

SHA256:

```text
855413e1b69813a1d04ea50465a289cd6efbba7b77a40da2789dcd5f0fadb03d  libcrypto3-3.5.6-r0.apk
a0332c2236443496c1fcb150fd9cb612a849f1a865b240a8f91541f2c793a45b  libpng-1.6.57-r0.apk
135e6b17ce8429b423dc31e084865d5975383890bac68e621cb1b09edbf98d06  libssl3-3.5.6-r0.apk
6a3edd924ead1fad88a69e28c5775809af3026b322f58428001cd02fedc5299e  musl-1.2.5-r23.apk
0d87307c117d4327f4db4ed96b9d403775fe0c1804ae54e7aefcc720f997f573  musl-utils-1.2.5-r23.apk
2e17aa1d7d4a37b2d029210d239b8b2e4ac40748d9a8c8912a6b607011034fd1  nghttp2-libs-1.69.0-r0.apk
ecda4cc94fd18f90182f1d3a615889df5e0db9cf78926d11627dd23e06d2e6e8  zlib-1.3.2-r0.apk
```
