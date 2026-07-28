# V17 SBOM contract

V17 adds a release-evidence contract for every container image that passes the
platform pipeline. The contract is intentionally compatible with the existing
Harbor, Trivy, SonarQube, Jenkins, GitHub Actions, Elasticsearch, Kibana, and
Grafana path.

## Required evidence

- Generate CycloneDX JSON with an installed `syft` binary against the immutable
  image digest, never an unqualified mutable tag.
- Store `sbom.cyclonedx.json`, image digest, Git commit, build number, Trivy
  result, and SonarQube quality-gate result together as one release record.
- Index only non-secret metadata in Elasticsearch/Kibana. Do not put registry
  credentials, tokens, private package URLs, or source archives in the record.
- Reject a release only through the reviewed Jenkins quality policy; V17's
  evidence generator records missing tools as gaps instead of bypassing them.

## Safe local check

```sh
command -v syft
syft <immutable-image-reference> -o cyclonedx-json > sbom.cyclonedx.json
```

The V17 pipelines do not download a scanner or publish an image implicitly.
