#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-verify}"
HARBOR_HOST="${HARBOR_HOST:-harbor.devops.local}"
LOCAL_REGISTRY="${LOCAL_REGISTRY:-127.0.0.1:30050}"

image_map() {
  cat <<MAP
${LOCAL_REGISTRY}/library/ansible-core:2.20.0-r0-arm64 ${HARBOR_HOST}/library/ansible-core:2.20.0-r0-arm64 ansible --version
${LOCAL_REGISTRY}/library/opentelemetry-collector:0.152.1 ${HARBOR_HOST}/library/opentelemetry-collector:0.152.1 --version
cgr.dev/chainguard/cosign:latest ${HARBOR_HOST}/library/cosign:3.0.6-arm64 version
ghcr.io/yannh/kubeconform:v0.7.0 ${HARBOR_HOST}/library/kubeconform:0.7.0-arm64 -v
aquasec/trivy:0.68.2 ${HARBOR_HOST}/library/trivy:0.68.2-arm64 --version
${LOCAL_REGISTRY}/hello-app-v12-portal:d3a1104 ${HARBOR_HOST}/library/hello-app-v12-portal:d3a1104 portal-smoke
MAP
}

push_images() {
  image_map | while read -r source target _; do
    echo "push ${source} -> ${target}"
    docker image inspect "${source}" >/dev/null
    docker tag "${source}" "${target}"
    docker push "${target}"
  done
}

verify_images() {
  image_map | while read -r _ target command args; do
    echo "verify ${target}"
    docker pull "${target}" >/dev/null
    if [ "${command}" = "portal-smoke" ]; then
      cid="$(docker run -d --rm --platform linux/arm64 "${target}")"
      trap 'docker rm -f "${cid}" >/dev/null 2>&1 || true' EXIT
      sleep 2
      docker exec "${cid}" wget -qO- http://127.0.0.1/ | grep 'ZhangLab DevOps V12 Control Surface' >/dev/null
      docker rm -f "${cid}" >/dev/null
      trap - EXIT
      echo "portal=ok"
    else
      docker run --rm --platform linux/arm64 "${target}" "${command}" ${args:-} | head -20
    fi
  done
}

restore_local_tags() {
  image_map | while read -r source target _; do
    echo "restore ${target} -> ${source}"
    docker pull "${target}" >/dev/null
    docker tag "${target}" "${source}"
  done
}

print_digests() {
  image_map | while read -r _ target _; do
    docker image inspect "${target}" --format '{{index .RepoTags 0}} {{json .RepoDigests}} {{.Architecture}} {{.Size}}'
  done
}

case "${MODE}" in
  push) push_images ;;
  verify) verify_images ;;
  restore-local-tags) restore_local_tags ;;
  digests) print_digests ;;
  all) push_images; verify_images; print_digests ;;
  *)
    echo "usage: $0 [push|verify|restore-local-tags|digests|all]" >&2
    exit 2
    ;;
esac
