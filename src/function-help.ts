export const functionModuleSyntaxHelp = 'Function interfaces use editable ADT declarations: FUNCTION name IMPORTING VALUE(IV_MATNR) TYPE MATNR OPTIONAL EXPORTING VALUE(EV_MATNR) TYPE MATNR TABLES T_RETURN TYPE BAPIRET2 OPTIONAL. The last declaration ends with a period. Use TYPE for TABLES, not STRUCTURE. Do not declare parameters in SE37 Local Interface comments. EXCEPTIONS lists names, never name = 1 (that belongs to CALL FUNCTION). No template tool is required; use the example returned by create_function_module. Definition formatting/comments may be regenerated; keep durable comments in the implementation. Read the current revision before update_source, then syntax_check and explicitly activate.';

export function functionModuleGuidance(name: string) {
  return {
    format: 'ADT_SOURCE',
    example_source: [
      `FUNCTION ${name}`,
      '  IMPORTING',
      '    VALUE(IV_MATNR) TYPE MATNR OPTIONAL',
      '  EXPORTING',
      '    VALUE(EV_MATNR) TYPE MATNR',
      '  TABLES',
      '    T_RETURN TYPE BAPIRET2 OPTIONAL.',
      '',
      '  EV_MATNR = IV_MATNR.',
      '',
      'ENDFUNCTION.'
    ].join('\r\n'),
    guidance: functionModuleSyntaxHelp,
    example_applied: false
  };
}
