# V17 Kubeconform contract

Before server-side dry-run, render the reviewed Kustomize overlay and validate
it against the Kubernetes version targeted by the Jenkins agent. This catches
schema and API deprecation errors before a cluster admission request.

```sh
kubectl kustomize platform/v17 > v17-extension.yaml
kubeconform -strict -summary -kubernetes-version <cluster-version> v17-extension.yaml
```

Missing CustomResourceDefinitions must be treated as a clear compatibility gap,
not bypassed with ignored errors. V17 does not download schemas dynamically.
