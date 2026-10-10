export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined || value === "") throw new ApiError(503, "CONFIG_REQUIRED", `${name} is not configured`);
  return value;
}
