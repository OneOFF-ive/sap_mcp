import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ActivationResult } from 'abap-adt-api/build/api/activate.js';
import { AppError } from './errors.js';

export function groupActivationBody(result: ActivationResult, group: string, members: string[], username: string): string {
  const allowed = new Set([group, `${group}/source/main`, ...members]);
  const refs = new Map<string, Record<string, string>>();
  if (result.inactive.length > 502) throw new AppError('ACTIVATION_SCOPE_INVALID', 'Too many preaudit entries');
  for (const entry of result.inactive) {
    // Transport entries describe grouping context; they are not activation targets.
    if (!entry.object) {
      if (entry.transport) continue;
      throw new AppError('ACTIVATION_SCOPE_INVALID', 'Preaudit entry has no object or transport');
    }
    const object = entry.object;
    const uri = object['adtcore:uri'];
    const expectedType = uri === group || uri === `${group}/source/main` ? 'FUGR/F'
      : uri?.includes('/fmodules/') ? 'FUGR/FF' : 'FUGR/I';
    if (!allowed.has(uri) || object.deleted ||
        (object.user && object.user.toUpperCase() !== username.toUpperCase()) ||
        object['adtcore:type'] !== expectedType || !object['adtcore:name'] ||
        (object['adtcore:parentUri'] && object['adtcore:parentUri'] !== group)) {
      throw new AppError('ACTIVATION_SCOPE_INVALID', 'Preaudit returned an unapproved object; no second-phase activation was sent');
    }
    const ref: Record<string, string> = {};
    for (const key of ['uri', 'name', 'type', 'parentUri']) {
      const value = object[`adtcore:${key}` as keyof typeof object];
      if (typeof value === 'string' && value) ref[`@_adtcore:${key}`] = value;
    }
    refs.set(uri, ref);
  }
  if (!refs.size) throw new AppError('ACTIVATION_SCOPE_INVALID', 'Preaudit returned no approved activation objects');
  return new XMLBuilder({ ignoreAttributes: false }).build({ 'adtcore:objectReferences': {
    '@_xmlns:adtcore': 'http://www.sap.com/adt/core', 'adtcore:objectReference': [...refs.values()]
  } });
}

export function activationResponse(body: string): ActivationResult {
  if (!body.trim()) return { success: true, messages: [], inactive: [] };
  if (XMLValidator.validate(body) !== true) throw new AppError('ACTIVATION_RESPONSE_INVALID', 'Invalid activation XML');
  const data = new XMLParser({ ignoreAttributes: false }).parse(body);
  const array = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
  if (!('ioc:inactiveObjects' in data) && !('chkl:messages' in data)) {
    throw new AppError('ACTIVATION_RESPONSE_INVALID', 'Unrecognized activation response');
  }
  const messages: Record<string, any>[] = array(data['chkl:messages']?.msg).map(message => ({
    ...Object.fromEntries(Object.entries(message).filter(([key]) => key.startsWith('@_')).map(([key, value]) => [key.slice(2), value])),
    shortText: message.shortText?.txt || 'Activation message'
  }));
  const inactive = array(data['ioc:inactiveObjects']?.['ioc:entry']);
  return { success: !inactive.length && !messages.some(message => /[EAX]/.test(String(message.type))),
    messages: messages as ActivationResult['messages'], inactive };
}
