const errors = {
  invalid_json: { status: 400, message: "Invalid JSON body." },
  invalid_body: { status: 400, message: "JSON body must be an object." },
  invalid_username_type: { status: 400, message: "Username must be a string." },
  short_username: { status: 400, message: "Username must be at least 2 characters." },
  reserved_username: { status: 400, message: "This username is reserved." },
  invalid_reset_scope: { status: 400, message: "Invalid reset scope." },
  invalid_cookie: { status: 400, message: "Invalid cookie encoding." },
  invalid_url: { status: 400, message: "Invalid request URL." },
  body_too_large: { status: 413, message: "Request body is too large." },
  unsupported_content_type: { status: 415, message: "Expected application/json." }
} as const;

// Only these fixed messages may cross the HTTP input-error boundary.
export class PublicInputError extends Error {
  readonly status: number;
  constructor(readonly kind: keyof typeof errors) {
    const description = errors[kind];
    super(description.message);
    this.name = "PublicInputError";
    this.status = description.status;
  }
}
