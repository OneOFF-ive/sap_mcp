export class AppError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export function safeError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details };
  const e = error as { response?: { status?: number }; status?: number; code?: string };
  const status = e.response?.status ?? e.status;
  const code = status === 401 ? 'AUTH_FAILED' : status === 403 ? 'AUTHORIZATION_DENIED' :
    status === 404 ? 'OBJECT_NOT_FOUND' : status === 409 || status === 423 ? 'OBJECT_LOCKED' :
    ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(e.code ?? '') ? 'OUTCOME_UNKNOWN' : 'ADT_ERROR';
  return { code, message: 'Operation failed; verify connectivity, credentials and backend state. Raw responses are withheld.' };
}
