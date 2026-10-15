import { isAdtError } from 'abap-adt-api';

export class AppError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

function redact(value: string): string {
  return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|passwd|pwd|authorization|cookie|set-cookie|x-csrf-token|csrf(?:\s+token)?|lock(?:\s*handle)?|lock_handle|sap[-_]sessionid[^\s:=]*|密码)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,)]+)/gi, '$1[REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1024);
}

function classifyBackendError(status: number | undefined, message: string, networkCode?: string): string {
  switch (status) {
    case 401:
      return 'AUTH_FAILED';
    case 403:
      if (/currently editing|当前编辑|locked|锁定/i.test(message))
        return 'OBJECT_LOCKED';
      if (/csrf/i.test(message))
        return 'CSRF_FAILED';
      return 'HTTP_FORBIDDEN';
    case 404:
      return 'OBJECT_NOT_FOUND';
    case 409:
    case 423:
      return 'OBJECT_LOCKED';
    default:
      return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(networkCode ?? '')
        ? 'OUTCOME_UNKNOWN'
        : 'ADT_ERROR';
  }
}

export function safeError(error: unknown) {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  const backendError = (error ?? {}) as {
    response?: {
      status?: number;
    };
    status?: number;
    code?: string;
    message?: string;
    err?: number;
    localizedMessage?: string;
    type?: string;
    properties?: Record<string, string>;
  };
  const isSapError = isAdtError(error);
  // The library's XML exception parser keeps HTTP status in err, not response/status.
  const rawStatus = backendError.response?.status ?? backendError.status ?? (isSapError ? backendError.err : undefined);
  const status = typeof rawStatus === 'number' && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const rawMessage = backendError.localizedMessage || backendError.message || '';
  const code = classifyBackendError(status, rawMessage, backendError.code);
  const details = {
    ...(status ? { http_status: status } : {}),
    ...(isSapError && status !== 401 && rawMessage ? { sap_message: redact(rawMessage) } : {}),
    ...(isSapError && backendError.type ? { sap_error_type: redact(backendError.type).slice(0, 256) } : {}),
    ...(isSapError && backendError.properties?.['T100KEY-ID'] ? { sap_message_id: redact(backendError.properties['T100KEY-ID']).slice(0, 80) } : {}),
    ...(isSapError && backendError.properties?.['T100KEY-NO'] ? { sap_message_number: redact(backendError.properties['T100KEY-NO']).slice(0, 16) } : {})
  };
  return {
    code,
    message: 'Operation failed; inspect sanitized SAP details and verify backend state.',
    ...(Object.keys(details).length ? { details } : {})
  };
}
