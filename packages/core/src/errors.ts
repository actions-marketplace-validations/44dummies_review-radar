export type RadarErrorCode = 'BASE_NOT_FOUND' | 'NOT_A_REPO' | 'BAD_INPUT' | 'GIT_FAILED' | 'NO_COMMITS';
export class RadarError extends Error {
  constructor(public readonly code: RadarErrorCode, message: string) {
    super(message);
    this.name = 'RadarError';
  }
}
