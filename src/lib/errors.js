import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what) => new HttpError(404, "not_found", `${what} not found.`);

// Lets async route handlers throw instead of calling next(err).
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      if (!fields[key]) fields[key] = issue.message;
    }
    return res.status(400).json({ error: { code: "validation_failed", message: "Some details need fixing.", fields } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "The request body is not valid JSON." } });
  }
  console.error(err);
  res.status(500).json({ error: { code: "server_error", message: "Something went wrong on our side. Please try again." } });
}
