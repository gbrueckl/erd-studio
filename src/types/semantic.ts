/**
 * Moved to `@erd-studio/core` (packages/core/src/types/semantic.ts). This module
 * re-exports every symbol so existing imports of this path keep working.
 */

export type {
  Layer,
  Stage,
  ColumnDef,
  Meta,
  MetaValue,
  TableRole,
  Rationale,
  SemanticTable,
  TableLoadError,
  TableLoadErrorKind,
  UnreadableTablePlaceholder,
  DesignTable,
  Cardinality,
  Relationship,
  TableRelationship,
  NodePosition,
  LayoutOptions,
  AnnotationColor,
  Annotation,
  ViewConfig,
  StageData,
  SemanticSubjectArea,
  UnifiedSubjectArea,
  StageDataV5,
  UnifiedSubjectAreaV5,
  RawSubjectAreaFile,
  SubjectAreaFormat,
  SubjectAreaSummary,
  TableTemplate,
} from '@erd-studio/core';
export {
  CURRENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  detectSubjectAreaFormat,
  describeUnsupportedSubjectAreaFormat,
  getRawSubjectAreaTableNames,
  isSubjectAreaV5,
  tableLoadErrorOf,
} from '@erd-studio/core';
