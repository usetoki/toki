/** A rejected upload. Carries a `statusCode`, so toki-sensible renders it as that status. */
export class MultipartError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "MultipartError";
    this.statusCode = statusCode;
  }
}
