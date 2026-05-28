#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-audit}"
INGRESS_CLASS="${INGRESS_CLASS:-traefik}"
TRAEFIK_NAMESPACE="${TRAEFIK_NAMESPACE:-kube-system}"
TMP_DIR="$(mktemp -d /tmp/devops-local-access.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

RED="$(printf '\033[0;31m')"
GREEN="$(printf '\033[0;32m')"
YELLOW="$(printf '\033[1;33m')"
BLUE="$(printf '\033[0;34m')"
NC="$(printf '\033[0m')"

log()  { printf "%b[%s]%b %s\n" "$BLUE" "$(date '+%H:%M:%S')" "$NC" "$*"; }
ok()   { printf "%b[OK]%b %s\n" "$GREEN" "$NC" "$*"; }
warn() { printf "%b[WARN]%b %s\n" "$YELLOW" "$NC" "$*"; }
err()  { printf "%b[ERR]%b %s\n" "$RED" "$NC" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash fix_devops_local_access.sh audit
  sudo bash fix_devops_local_access.sh repair
  sudo bash fix_devops_local_access.sh enable-gitlab-signup
  sudo bash fix_devops_local_access.sh all

Modes:
  audit                 Show Traefik, Service, Ingress, and route health.
  repair                Audit and create/update missing Ingresses for known apps.
  enable-gitlab-signup  Turn on GitLab self-signup.
  all                   Repair Ingresses and enable GitLab self-signup.

Environment overrides:
  INGRESS_CLASS=traefik
  TRAEFIK_NAMESPACE=kube-system
  HOST_IP=192.168.1.58
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_cluster() {
  kubectl get nodes >/dev/null 2>&1 || die "kubectl cannot reach the cluster"
}

detect_host_ip() {
  if [[ -n "${HOST_IP:-}" ]]; then
    printf '%s\n' "$HOST_IP"
    return
  fi

  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1 2>/dev/null | awk '/src/ {for (i = 1; i <= NF; i++) if ($i == "src") {print $(i+1); exit}}')"
  fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -z "$ip" ]] && command -v getent >/dev/null 2>&1; then
    ip="$(getent hosts "$(hostname)" 2>/dev/null | awk '{print $1; exit}')"
  fi

  printf '%s\n' "$ip"
}

find_service() {
  local namespace="$1"
  local regex="$2"

  kubectl get svc -n "$namespace" -o name 2>/dev/null \
    | sed 's#service/##' \
    | grep -E "$regex" \
    | head -n 1 || true
}

choose_port() {
  local namespace="$1"
  local service="$2"
  local hints_csv="$3"
  local ports_file="$TMP_DIR/${namespace}-${service}-ports.txt"

  kubectl get svc "$service" -n "$namespace" \
    -o jsonpath='{range .spec.ports[*]}{.name}{"|"}{.port}{"|"}{.targetPort}{"\n"}{end}' \
    >"$ports_file"

  if [[ ! -s "$ports_file" ]]; then
    return 1
  fi

  local hint
  IFS=',' read -r -a hints <<<"$hints_csv"
  for hint in "${hints[@]}"; do
    local matched
    matched="$(awk -F'|' -v hint="$hint" '$1 == hint || $2 == hint || $3 == hint { print $2; exit }' "$ports_file")"
    if [[ -n "$matched" ]]; then
      printf '%s\n' "$matched"
      return 0
    fi
  done

  local common
  common="$(awk -F'|' '$1 ~ /(http|https|web|ui|api)/ { print $2; exit }' "$ports_file")"
  if [[ -n "$common" ]]; then
    printf '%s\n' "$common"
    return 0
  fi

  awk -F'|' 'NR == 1 { print $2; exit }' "$ports_file"
}

find_ingress_by_host() {
  local host="$1"

  kubectl get ingress -A \
    -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,HOSTS:.spec.rules[*].host' \
    --no-headers 2>/dev/null \
    | awk -v host="$host" '$3 == host { print $1 "/" $2; exit }'
}

http_probe() {
  local url="$1"
  local host="$2"
  curl -sS -o /dev/null -H "Host: $host" --connect-timeout 3 --max-time 5 \
    -w 'code=%{http_code} connect=%{time_connect}s total=%{time_total}s' \
    "$url" 2>/dev/null || printf 'code=FAIL connect=- total=-'
}

create_or_update_ingress() {
  local app="$1"
  local namespace="$2"
  local host="$3"
  local service="$4"
  local port="$5"
  local ingress_name="${app}-public"

  cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${ingress_name}
  namespace: ${namespace}
  annotations:
    kubernetes.io/ingress.class: ${INGRESS_CLASS}
spec:
  ingressClassName: ${INGRESS_CLASS}
  rules:
  - host: ${host}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${service}
            port:
              number: ${port}
EOF
}

print_hosts_hint() {
  local host_ip="$1"
  cat <<EOF

Suggested /etc/hosts entry on your client machine:
${host_ip} gitlab.devops.local jenkins.devops.local argocd.devops.local registry.devops.local sonar.devops.local grafana.devops.local kibana.devops.local kafka.devops.local flink.devops.local prometheus.devops.local airflow.devops.local minio.devops.local trino.devops.local superset.devops.local jaeger.devops.local
EOF
}

audit_platform() {
  local host_ip="$1"

  log "Cluster connectivity"
  kubectl get nodes -o wide

  log "Traefik"
  kubectl get pods -n "$TRAEFIK_NAMESPACE" -o wide | grep -E 'traefik|svclb-traefik' || true
  kubectl get svc -n "$TRAEFIK_NAMESPACE" traefik -o wide 2>/dev/null || warn "Traefik service not found in ${TRAEFIK_NAMESPACE}"
  kubectl get ingressclass 2>/dev/null || true

  if command -v ss >/dev/null 2>&1; then
    log "Local listeners on 80/443"
    ss -lntp '( sport = :80 or sport = :443 )' || true
  fi

  printf '\n%-12s %-14s %-28s %-24s %-8s %-24s %-24s\n' "APP" "NAMESPACE" "HOST" "SERVICE" "PORT" "127.0.0.1" "${host_ip:-HOST_IP?}"
  printf '%.0s-' {1..140}
  printf '\n'

  while IFS='|' read -r app namespace host service_regex hints; do
    [[ -n "$app" ]] || continue
    local service
    local port
    local ingress
    local local_probe="code=SKIP"
    local ip_probe="code=SKIP"

    service="$(find_service "$namespace" "$service_regex")"
    if [[ -z "$service" ]]; then
      printf '%-12s %-14s %-28s %-24s %-8s %-24s %-24s\n' "$app" "$namespace" "$host" "NOT-FOUND" "-" "-" "-"
      continue
    fi

    port="$(choose_port "$namespace" "$service" "$hints" || true)"
    ingress="$(find_ingress_by_host "$host" || true)"
    if [[ -n "$port" ]]; then
      local_probe="$(http_probe "http://127.0.0.1/" "$host")"
      if [[ -n "$host_ip" ]]; then
        ip_probe="$(http_probe "http://${host_ip}/" "$host")"
      fi
    fi

    printf '%-12s %-14s %-28s %-24s %-8s %-24s %-24s\n' \
      "$app${ingress:+*}" "$namespace" "$host" "$service" "${port:--}" "$local_probe" "$ip_probe"
  done < <(app_matrix)

  printf '\n'
  print_hosts_hint "$host_ip"
  printf '\n'
  cat <<'EOF'
Registration notes:
- GitLab can support self-signup if you explicitly enable it.
- Grafana, Airflow, Argo CD, SonarQube, Kibana, MinIO, and many other DevOps tools usually use admin-created users or SSO rather than public signup.
- If routes work but account creation is still blocked, fix access first, then configure each app's auth policy separately.
EOF
}

repair_ingresses() {
  log "Repairing known devops.local Ingresses"

  while IFS='|' read -r app namespace host service_regex hints; do
    [[ -n "$app" ]] || continue

    local service
    local port
    service="$(find_service "$namespace" "$service_regex")"
    if [[ -z "$service" ]]; then
      warn "${app}: no matching Service in ${namespace}"
      continue
    fi

    port="$(choose_port "$namespace" "$service" "$hints" || true)"
    if [[ -z "$port" ]]; then
      warn "${app}: cannot determine port for ${namespace}/${service}"
      continue
    fi

    create_or_update_ingress "$app" "$namespace" "$host" "$service" "$port" >/dev/null
    ok "${app}: ${host} -> ${namespace}/${service}:${port}"
  done < <(app_matrix)
}

enable_gitlab_signup() {
  log "Enabling GitLab self-signup"

  local pod
  pod="$(kubectl get pods -n ns-devops -o name 2>/dev/null | sed 's#pod/##' | grep -E '^gitlab-' | head -n 1 || true)"
  [[ -n "$pod" ]] || die "GitLab pod not found in namespace ns-devops"

  kubectl exec -n ns-devops "$pod" -- gitlab-rails runner '
    setting = ApplicationSetting.current
    setting.signup_enabled = true
    if setting.respond_to?(:require_admin_approval_after_user_signup=)
      setting.require_admin_approval_after_user_signup = false
    end
    setting.save!
    puts "signup_enabled=#{setting.signup_enabled}"
  '
}

app_matrix() {
  cat <<'EOF'
argocd|argocd|argocd.devops.local|^argocd-server$|80,443
gitlab|ns-devops|gitlab.devops.local|^gitlab(-service)?$|80,8080
jenkins|ns-devops|jenkins.devops.local|^jenkins$|8080,80
registry|ns-devops|registry.devops.local|^(docker-registry|registry)$|5000,80
sonar|sonarqube|sonar.devops.local|^(sonarqube-sonarqube|sonarqube)$|9000,80
grafana|monitoring|grafana.devops.local|^kube-stack-grafana$|80,3000
kibana|default|kibana.devops.local|^kibana$|5601,80
prometheus|monitoring|prometheus.devops.local|^prometheus-kube-stack-kube-prometheus-prometheus$|9090,80
airflow|data-infra|airflow.devops.local|^(airflow-api-server|airflow-webserver)$|8080,80
minio|data-infra|minio.devops.local|^minio$|9001,9000
trino|data-infra|trino.devops.local|^(trino-coordinator|trino)$|8080,80
superset|data-infra|superset.devops.local|^superset$|8088,80
jaeger|monitoring|jaeger.devops.local|^(jaeger|jaeger-query)$|16686,80
kafka|ns-bigdata|kafka.devops.local|^kafka-ui$|8080,80
flink|ns-bigdata|flink.devops.local|^flink-jobmanager$|8081,80
hello|default|hello.devops.local|^hello-app-service$|80
EOF
}

main() {
  require_cmd kubectl
  require_cmd curl
  require_cluster

  local host_ip
  host_ip="$(detect_host_ip)"
  [[ -n "$host_ip" ]] || warn "Host IP detection failed; LAN probe output will be incomplete"

  case "$MODE" in
    audit)
      audit_platform "$host_ip"
      ;;
    repair)
      repair_ingresses
      audit_platform "$host_ip"
      ;;
    enable-gitlab-signup)
      enable_gitlab_signup
      ;;
    all)
      repair_ingresses
      enable_gitlab_signup
      audit_platform "$host_ip"
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
