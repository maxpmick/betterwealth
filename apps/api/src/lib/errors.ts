export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "unauthorized");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super(message, 403, "forbidden");
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(`${resource} not found`, 404, "not_found");
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(message, 409, code);
  }
}
