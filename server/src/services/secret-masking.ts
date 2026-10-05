// F-02 Secrets/Credential Management — display-safe identifier derivation.
// Deliberately does NOT attempt to mask a plaintext secret value: this
// registry never decrypts `company_secret_versions.material` just to
// produce a cosmetic preview (that would add a new decrypt call site for
// no operational reason, working against the existing system's "plaintext
// touches as few code paths as possible" design). Instead:
//   - hash-verified credentials (agent/board API keys) never had their
//     plaintext retained anywhere at all, even encrypted — by design, the
//     raw value exists only once, at creation. A masked identifier here is
//     derived purely from the already-at-rest hash, never from plaintext.
//   - encrypted company secrets are identified by their own non-sensitive
//     `key`/`name` label (already safe, already how the existing system
//     displays them) rather than a synthesized value preview.
// See docs/contracts/nexora-f02-secrets-api.md for the full rationale.

/**
 * Derives a short, stable, non-reversible display fragment from an
 * already-hashed credential value (e.g. `keyHash`). Never call this with
 * plaintext — it exists specifically for values that were never stored in
 * a recoverable form in the first place.
 */
export function maskFromHash(hash: string): string {
  const trimmed = hash.trim();
  if (trimmed.length <= 12) return `hash:${trimmed}`;
  return `hash:${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}
