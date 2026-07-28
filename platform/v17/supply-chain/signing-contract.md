# V17 Cosign signing and verification contract

V17 treats image signing as an evidence gate, not as a reason to place private
keys in a repository or Jenkins log.  The existing Harbor, Trivy, SBOM, and
release evidence become a single immutable release record.

## Required release evidence

- Use an immutable image digest, never a mutable tag.
- Verify the image signature with an approved public key, keyless identity, or
  registry-attached signing policy.
- Record only the image digest, verification result, signer identity reference,
  build number, SBOM digest, and policy revision in observability data.
- Keep private key material, OIDC credentials, and registry tokens in the
  approved secret system. They must not be accepted as pipeline parameters.

## Safe verification shape

```sh
cosign verify --key <approved-public-key> <registry>/<image>@sha256:<digest>
```

V17 records an unavailable `cosign` executable as a coverage gap; it never
downloads a signing tool or silently changes a release policy.
