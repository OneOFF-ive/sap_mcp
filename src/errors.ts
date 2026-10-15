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
export function safeError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details };
  const e = (error ?? {}) as { response?: { status?: number }; status?: number; code?: string; message?: string; err?: number;
    localizedMessage?: string; type?: string; properties?: Record<string, string> };
  const adt = isAdtError(error);
  // The library's XML exception parser keeps HTTP status in err, not response/status.
  const rawStatus = e.response?.status ?? e.status ?? (adt ? e.err : undefined);
  const status = typeof rawStatus === 'number' && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const rawMessage = e.localizedMessage || e.message || '';
  const code = status === 401 ? 'AUTH_FAILED' : status === 403 ? (
    /currently editing|当前编辑|locked|锁定/i.test(rawMessage) ? 'OBJECT_LOCKED' :
    /csrf/i.test(rawMessage) ? 'CSRF_FAILED' : 'HTTP_FORBIDDEN') :
    status === 404 ? 'OBJECT_NOT_FOUND' : status === 409 || status === 423 ? 'OBJECT_LOCKED' :
    ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(e.code ?? '') ? 'OUTCOME_UNKNOWN' : 'ADT_ERROR';
  const details = {
    ...(status ? { http_status: status } : {}),
    ...(adt && status !== 401 && rawMessage ? { sap_message: redact(rawMessage) } : {}),
    ...(adt && e.type ? { sap_error_type: redact(e.type).slice(0, 256) } : {}),
    ...(adt && e.properties?.['T100KEY-ID'] ? { sap_message_id: redact(e.properties['T100KEY-ID']).slice(0, 80) } : {}),
    ...(adt && e.properties?.['T100KEY-NO'] ? { sap_message_number: redact(e.properties['T100KEY-NO']).slice(0, 16) } : {})
  };
  return { code, message: 'Operation failed; inspect sanitized SAP details and verify backend state.',
    ...(Object.keys(details).length ? { details } : {}) };
}
