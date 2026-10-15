import { AppError, safeError } from './errors.js';

export const enhancementTypes = ['SMOD', 'CMOD', 'SXSD', 'SXCI', 'ENHS', 'ENHO', 'ENSC', 'ENHC'] as const;

export type EnhancementType = typeof enhancementTypes[number];

const enhancementCategories: Record<EnhancementType, string> = {
  SMOD: 'customer_exit',
  CMOD: 'customer_exit_project',
  SXSD: 'classic_badi_definition',
  SXCI: 'classic_badi_implementation',
  ENHS: 'enhancement_spot',
  ENHO: 'enhancement_implementation',
  ENSC: 'composite_enhancement_spot',
  ENHC: 'composite_enhancement_implementation'
};

type ObjectRow = {
  name: string;
  type: string;
  package_name?: string;
  object_uri: string;
  description?: string;
};

type EnhancementRow = ObjectRow & {
  enhancement_type: EnhancementType;
  category: string;
};

type RepositorySearchResult = {
  objects: ObjectRow[];
  truncated: boolean;
};

type SearchRepository = (query: string, type: string, limit: number) => Promise<unknown>;

type ReadActivation = (row: ObjectRow) => Promise<EnhancementActivation>;

export type EnhancementVersionProbe = {
  requested_version: 'active' | 'inactive';
  available: boolean | 'unknown';
  reported_version?: string;
  error?: ReturnType<typeof safeError>;
};

export type EnhancementActivation = {
  status: 'active' | 'active_with_inactive_version' | 'unknown' | 'not_applicable';
  scope: 'repository_version';
  runtime_enabled: 'unknown' | 'not_applicable';
  probes: EnhancementVersionProbe[];
  reason?: string;
};

const implementationTypes = new Set<EnhancementType>(['CMOD', 'SXCI', 'ENHO', 'ENHC']);

export async function probeEnhancementActivation(readMetadata: (version: 'active' | 'inactive') => Promise<{
  name: string;
  type: string;
  version: string;
}>, name: string, type: string): Promise<EnhancementActivation> {
  const probes: EnhancementVersionProbe[] = [];
  for (const version of ['active', 'inactive'] as const) {
    try {
      const metadata = await readMetadata(version);
      const identityMatches = metadata.name?.toUpperCase() === name.toUpperCase()
        && metadata.type?.toUpperCase() === type.toUpperCase();
      probes.push({
        requested_version: version,
        available: identityMatches && metadata.version === version ? true : 'unknown',
        reported_version: metadata.version
      });
    }
    catch (error) {
      // A 404 can mean an unsupported metadata endpoint, not an inactive implementation.
      probes.push({
        requested_version: version,
        available: 'unknown',
        error: safeError(error)
      });
    }
  }
  const hasActiveVersion = probes[0].available === true;
  const hasInactiveVersion = probes[1].available === true;
  let status: EnhancementActivation['status'] = 'unknown';
  if (hasActiveVersion) {
    status = hasInactiveVersion ? 'active_with_inactive_version' : 'active';
  }
  return {
    status,
    scope: 'repository_version',
    runtime_enabled: 'unknown',
    probes,
    ...(!hasActiveVersion ? { reason: 'No matching active-version metadata could be confirmed; this does not prove deactivation.' } : {})
  };
}

function selectEnhancementTypes(type: string): readonly EnhancementType[] {
  const requestedType = type.toUpperCase();
  if (requestedType === 'ALL')
    return enhancementTypes;
  if (!enhancementTypes.includes(requestedType as EnhancementType)) {
    throw new AppError('INVALID_INPUT', 'Unknown enhancement type');
  }
  return [requestedType as EnhancementType];
}

async function readImplementationActivation(row: EnhancementRow, readActivation?: ReadActivation): Promise<EnhancementActivation> {
  if (!implementationTypes.has(row.enhancement_type)) {
    return {
      status: 'not_applicable',
      scope: 'repository_version',
      runtime_enabled: 'not_applicable',
      probes: []
    };
  }
  const unknownState: EnhancementActivation = {
    status: 'unknown',
    scope: 'repository_version',
    runtime_enabled: 'unknown',
    probes: [],
    reason: 'Backend does not expose an activation probe.'
  };
  if (!readActivation)
    return unknownState;
  try {
    return await readActivation(row);
  }
  catch (error) {
    // Preserve the repository result when this object's optional metadata cannot be read.
    return {
      ...unknownState,
      reason: 'Activation query failed.',
      probes: [{
        requested_version: 'active',
        available: 'unknown',
        error: safeError(error)
      }]
    };
  }
}

export async function searchEnhancements(search: SearchRepository, query: string, type: string = 'all', limit = 100, readActivation?: ReadActivation) {
  const requestedTypes = selectEnhancementTypes(type);
  const objects: EnhancementRow[] = [];
  const seenObjectUris = new Set<string>();
  const coverage = [];
  let truncated = false;
  // Query each family separately so unrelated repository objects cannot exhaust the search limit.
  for (const family of requestedTypes) {
    const result = await search(query, family, limit) as RepositorySearchResult;
    coverage.push({
      type: family,
      returned: result.objects.length,
      truncated: result.truncated,
      support: 'not_verified'
    });
    truncated ||= result.truncated;
    for (const row of result.objects) {
      const matchesFamily = row.type.toUpperCase().split('/')[0] === family;
      if (!matchesFamily || seenObjectUris.has(row.object_uri))
        continue;
      seenObjectUris.add(row.object_uri);
      objects.push({
        ...row,
        enhancement_type: family,
        category: enhancementCategories[family]
      });
    }
  }
  objects.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  const selectedObjects = [];
  // Enrich only the returned page and keep backend requests bounded and sequential.
  for (const row of objects.slice(0, limit)) {
    const activation = await readImplementationActivation(row, readActivation);
    selectedObjects.push({
      ...row,
      activation
    });
  }
  return {
    objects: selectedObjects,
    truncated: truncated || objects.length > limit,
    coverage,
    query_scope: 'adt_repository_name_search',
    completeness: 'not_guaranteed',
    limitations: ['ADT visibility depends on SAP release and permissions; empty results do not prove absence or type support.',
      ("New BAdIs are represented by their enhancement spots/implementations; individual BAdI definitions and " +
        "implementation elements are not enumerated."),
      ("Activation describes repository versions only, not runtime enablement, BAdI filters, switches or CMOD " +
        "project enablement. Failed or unsupported probes are unknown, never inactive."),
      'Does not resolve transaction/program associations, CMOD components or implicit enhancement positions.']
  };
}
