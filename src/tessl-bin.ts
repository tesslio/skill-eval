/** Prefer the CLI installed by setup-tessl, falling back to PATH behavior. */
export function tesslBin(): string {
  const envBin = process.env.TESSL_BIN?.trim();
  return envBin && envBin.length > 0 ? envBin : 'tessl';
}
