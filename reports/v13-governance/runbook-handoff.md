# V13 Governance Runbook
- 先看 Jenkins `platform-era-v13` 最新构建结论。
- 再看 `reports/v13-governance/release-gate.json`、`slo-budget.json`、`capacity-runway.json`。
- 任何恢复动作必须先通过 dry-run 证据，禁止直接删除 PVC、备份和镜像缓存。
- 云 worker 只承接无状态/低优先级 Pod，核心状态服务优先留在 devops。
