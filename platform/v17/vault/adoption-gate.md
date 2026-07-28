# V17 Vault adoption gate

Recent DevOps roles frequently list secret management. V17 therefore adds a
Vault adoption path, but does **not** install Vault or migrate a secret simply
because an evidence pipeline runs. That would create availability and recovery
risk without an approved owner.

## Required approvals before deployment

1. Name a security owner, a platform owner, and a 24/7 recovery owner.
2. Choose storage, unseal method, backup interval, retention, and restore RTO.
3. Inventory every credential to migrate; classify each by rotation and outage
   impact. Never place an inventory of plaintext secrets in Git.
4. Prove least-privilege policies and Kubernetes authentication in a disposable
   non-production namespace.
5. Perform a restore drill and a client rollback drill before production use.
6. Review audit-log routing, access reviews, and break-glass controls.

Until all gates are signed off, the V17 evidence record must report Vault as
`adoption-gated`, not `active`.
