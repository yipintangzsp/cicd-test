# V17 DingTalk alert contract

The existing DingTalk relay remains an opt-in alert route. V17 produces a
structured build summary only after the webhook credential is supplied through
the approved Jenkins credential store.

- No webhook URL, token, or recipient identity may be stored in Git or reports.
- The message includes build number, evidence URL, high-risk gaps, and rollback
  owner; it does not include logs, SBOM contents, or secret-bearing metadata.
- A failed notification is recorded as notification evidence and does not hide a
  failed quality or security gate.
