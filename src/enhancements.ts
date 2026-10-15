import { AppError, safeError } from './errors.js';

export const enhancementTypes = ['SMOD', 'CMOD', 'SXSD', 'SXCI', 'ENHS', 'ENHO', 'ENSC', 'ENHC'] as const;
export type EnhancementType = typeof enhancementTypes[number];
const labels: Record<EnhancementType, string> = {
  SMOD: 'customer_exit', CMOD: 'customer_exit_project', SXSD: 'classic_badi_definition',
  SXCI: 'classic_badi_implementation', ENHS: 'enhancement_spot', ENHO: 'enhancement_implementation',
  ENSC: 'composite_enhancement_spot', ENHC: 'composite_enhancement_implementation'
};
type ObjectRow = { name: string; type: string; package_name?: string; object_uri: string; description?: string };
type Search = (query: string, type: string, limit: number) => Promise<unknown>;
export type EnhancementVersionProbe = { requested_version: 'active' | 'inactive';
  available: boolean | 'unknown'; reported_version?: string; error?: ReturnType<typeof safeError> };
export type EnhancementActivation = {
  status: 'active' | 'active_with_inactive_version' | 'unknown' | 'not_applicable';
  scope: 'repository_version'; runtime_enabled: 'unknown' | 'not_applicable';
  probes: EnhancementVersionProbe[]; reason?: string;
};
const implementations = new Set<EnhancementType>(['CMOD', 'SXCI', 'ENHO', 'ENHC']);

export async function probeEnhancementActivation(
  readMetadata: (version: 'active' | 'inactive') => Promise<{ name: string; type: string; version: string }>,
  name: string, type: string
): Promise<EnhancementActivation> {
  const probes: EnhancementVersionProbe[] = [];
  for (const version of ['active', 'inactive'] as const) {
    try {
      const metadata = await readMetadata(version);
      const identityMatches = metadata.name?.toUpperCase() === name.toUpperCase()
        && metadata.type?.toUpperCase() === type.toUpperCase();
      probes.push({ requested_version: version,
        available: identityMatches && metadata.version === version ? true : 'unknown',
        reported_version: metadata.version });
    } catch (error) {
      // A 404 can mean an unsupported metadata endpoint, not an inactive implementation.
      probes.push({ requested_version: version, available: 'unknown', error: safeError(error) });
    }
  }
  const active = probes[0].available === true;
  const draft = probes[1].available === true;
  return { status: active ? (draft ? 'active_with_inactive_version' : 'active') : 'unknown',
    scope: 'repository_version', runtime_enabled: 'unknown', probes,
    ...(!active ? { reason: 'No matching active-version metadata could be confirmed; this does not prove deactivation.' } : {}) };
}

export async function searchEnhancements(search: Search, query: string, type: string = 'all', limit = 100,
  activation?: (row: ObjectRow) => Promise<EnhancementActivation>) {
  const selected = type.toUpperCase();
  if (selected !== 'ALL' && !enhancementTypes.includes(selected as EnhancementType)) {
    throw new AppError('INVALID_INPUT', 'Unknown enhancement type');
  }
  const types = selected === 'ALL' ? enhancementTypes : [selected as EnhancementType];
  const objects: (ObjectRow & { enhancement_type: EnhancementType; category: string })[] = [];
  const seen = new Set<string>();
  const coverage = [];
  let truncated = false;
  // Query each family separately so unrelated repository objects cannot exhaust the search limit.
  for (const family of types) {
    const result = await search(query, family, limit) as { objects: ObjectRow[]; truncated: boolean };
    coverage.push({ type: family, returned: result.objects.length, truncated: result.truncated,
      support: 'not_verified' });
    truncated ||= result.truncated;
    for (const row of result.objects) {
      if (row.type.toUpperCase().split('/')[0] !== family || seen.has(row.object_uri)) continue;
      seen.add(row.object_uri);
      objects.push({ ...row, enhancement_type: family, category: labels[family] });
    }
  }
  objects.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  const selectedObjects = [];
  // Enrich only the returned page and keep backend requests bounded and sequential.
  for (const row of objects.slice(0, limit)) {
    let state: EnhancementActivation = { status: 'not_applicable', scope: 'repository_version', runtime_enabled: 'not_applicable', probes: [] };
    if (implementations.has(row.enhancement_type)) {
      state = { status: 'unknown', scope: 'repository_version', runtime_enabled: 'unknown', probes: [], reason: 'Backend does not expose an activation probe.' };
      if (activation) {
        try { state = await activation(row); }
        catch (error) { state = { ...state, reason: 'Activation query failed.', probes: [{ requested_version: 'active', available: 'unknown', error: safeError(error) }] }; }
      }
    }
    selectedObjects.push({ ...row, activation: state });
  }
  return { objects: selectedObjects, truncated: truncated || objects.length > limit, coverage,
    query_scope: 'adt_repository_name_search', completeness: 'not_guaranteed',
    limitations: ['ADT visibility depends on SAP release and permissions; empty results do not prove absence or type support.',
      'New BAdIs are represented by their enhancement spots/implementations; individual BAdI definitions and implementation elements are not enumerated.',
      'Activation describes repository versions only, not runtime enablement, BAdI filters, switches or CMOD project enablement. Failed or unsupported probes are unknown, never inactive.',
      'Does not resolve transaction/program associations, CMOD components or implicit enhancement positions.'] };
}
