'use strict';

// abap-adt-api uses sprintf only for fixed paths with string placeholders.
// Reject every other directive before processing arguments; never interpret an
// argument as formatting syntax or invoke numeric precision/padding functions.
function sprintf(format, ...values) {
  if (typeof format !== 'string' || format.length > 4096 || /%(?![%s])/.test(format.replace(/%%/g, ''))) {
    throw new TypeError('Unsupported ADT path format');
  }
  let cursor = 0;
  return format.replace(/%[%s]/g, directive => {
    if (directive === '%%') return '%';
    const value = values[cursor++];
    if (typeof value !== 'string' || value.length > 16384) throw new TypeError('Invalid ADT path argument');
    return value;
  });
}

module.exports = { sprintf };
