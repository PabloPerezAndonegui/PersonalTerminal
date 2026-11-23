export type {
  SectionId, SourceKind, Criticality, SourceFeed, AreaId, AreaMeta,
  DataSourceMeta, TrafficLight, SectionImpact,
} from './types.ts';
export { SECTION_LABELS, SECTION_ORDER, SECTION_AREA, AREAS, sectionsOfArea } from './types.ts';
export { NON_VENUE_SOURCES, allSources, sourcesForVenues, sourcesForSection } from './registry.ts';
export { resolveImpact, impactForSection, statusToLight, type SourceState } from './impact.ts';
