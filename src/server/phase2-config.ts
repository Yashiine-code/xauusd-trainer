export function phase2Enabled(): boolean {
  return process.env.PHASE2_ENABLED === "true";
}
