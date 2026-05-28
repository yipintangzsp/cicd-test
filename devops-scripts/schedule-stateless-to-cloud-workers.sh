#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-dry-run}"

if [[ "$MODE" != "dry-run" && "$MODE" != "apply" ]]; then
  echo "usage: $0 [dry-run|apply]" >&2
  exit 2
fi

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require kubectl

CLOUD_NODES=(aliyun-worker ucloud-worker)

echo "== Cloud node state =="
kubectl get nodes "${CLOUD_NODES[@]}" -o wide

echo
echo "== Ensure cloud-worker labels and taint =="
for node in "${CLOUD_NODES[@]}"; do
  if [[ "$MODE" == "apply" ]]; then
    kubectl label node "$node" \
      node.zhanglab.io/scheduling=limited-cloud \
      node.zhanglab.io/expiry-risk=true \
      node.zhanglab.io/important-workloads=avoid \
      --overwrite
    kubectl taint node "$node" cloud=true:NoSchedule --overwrite
  else
    echo "dry-run: label/taint $node as limited cloud worker"
  fi
done

echo
echo "== Candidate deployments =="
kubectl get deploy -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" pvc="}{.spec.template.spec.volumes[*].persistentVolumeClaim.claimName}{" nodeSelector="}{.spec.template.spec.nodeSelector}{" tolerations="}{.spec.template.spec.tolerations}{"\n"}{end}' \
  | awk '
    /jenkins|gitlab|harbor|argocd|prometheus|grafana|kibana|elastic|kafka|zookeeper|mysql|postgres|minio|redis|spark|flink|airflow|trino|superset/ { next }
    /pvc=[^ ]/ { next }
    { print }
  '

echo
echo "== Applying conservative stateless scheduling =="

patch_deploy() {
  local ns="$1"
  local name="$2"

  echo "candidate: ${ns}/${name}"
  if [[ "$MODE" == "apply" ]]; then
    kubectl -n "$ns" patch deploy "$name" --type='merge' -p '{
      "spec": {
        "template": {
          "metadata": {
            "labels": {
              "node.zhanglab.io/cloud-worker-eligible": "true"
            }
          },
          "spec": {
            "tolerations": [
              {
                "key": "cloud",
                "operator": "Equal",
                "value": "true",
                "effect": "NoSchedule"
              }
            ],
            "affinity": {
              "nodeAffinity": {
                "preferredDuringSchedulingIgnoredDuringExecution": [
                  {
                    "weight": 40,
                    "preference": {
                      "matchExpressions": [
                        {
                          "key": "node.zhanglab.io/scheduling",
                          "operator": "In",
                          "values": ["limited-cloud"]
                        }
                      ]
                    }
                  }
                ],
                "requiredDuringSchedulingIgnoredDuringExecution": {
                  "nodeSelectorTerms": [
                    {
                      "matchExpressions": [
                        {
                          "key": "node.zhanglab.io/important-workloads",
                          "operator": "NotIn",
                          "values": ["required"]
                        }
                      ]
                    }
                  ]
                }
              }
            }
          }
        }
      }
    }'
  fi
}

# Explicit allowlist: only lightweight, stateless frontends/preview portals.
# Add candidates here after checking they do not use PVCs and can be rebuilt from Git/image registry.
ALLOWLIST=(
  "ns-apps hello-app-v10-portal"
)

for item in "${ALLOWLIST[@]}"; do
  ns="${item%% *}"
  name="${item#* }"
  if kubectl -n "$ns" get deploy "$name" >/dev/null 2>&1; then
    patch_deploy "$ns" "$name"
  else
    echo "skip missing deployment: ${ns}/${name}"
  fi
done

echo
echo "== Final check =="
kubectl get nodes "${CLOUD_NODES[@]}" --show-labels
kubectl get pods -A -o wide | awk 'NR==1 || /aliyun-worker|ucloud-worker/'
