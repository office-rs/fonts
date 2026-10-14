// Error type for slice fetch/hash failures reported by the ensure pipeline.

export class FontLoadError extends Error {
  constructor(public family: string, public sliceId: string, message: string, public cause?: unknown) {
    super(message);
    this.name = 'FontLoadError';
  }
}
