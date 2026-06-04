/** Prefer the CLI installed by setup-tessl, falling back to PATH behavior. */
export function tesslBin(): string {
  return process.env.TESSL_BIN?.trim() || 'tessl';
}
