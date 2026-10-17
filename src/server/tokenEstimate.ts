/** The engine's conservative context-size estimate (about four characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
