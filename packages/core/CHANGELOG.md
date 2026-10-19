# Changelog

All notable changes to `@erd-studio/core`. While `0.x`, a breaking change bumps the minor version.

## 0.2.0

### Changed (breaking)
- **Exports use the new words: table and subject area** ([#180](https://github.com/liam-machine/erd-studio/issues/180), part 2 of [#162](https://github.com/liam-machine/erd-studio/issues/162)). What was called a *model* is a **table**, and a *domain* is a **subject area**. The four error classes `loadDisplaySubjectArea` rejects with are renamed too; `instanceof` works as before, and `SubjectAreaFileError` and `TooManyTablesError` report their new class name in `name` (`SubjectAreaValidationError` still reports `Error`). Only names changed: every function behaves as before, and object shapes, property names (`DisplaySubjectArea.models`, `domainPath`, `ErdCanvas`'s `domain` prop, …), message `type` strings and the files read on disk are the same, so a `DisplaySubjectArea` from 0.2.0 is the `DisplayDomain` of 0.1.x. There are no aliases for the old names. Rename the imports:

| 0.1.x | 0.2.0 |
|---|---|
| `buildUnifiedDomain` | `buildUnifiedSubjectArea` |
| `BuildUnifiedDomainContext` | `BuildUnifiedSubjectAreaContext` |
| `classifyModelLoadError` | `classifyTableLoadError` |
| `computeNewModelPositions` | `computeNewTablePositions` |
| `describeModelLoadError` | `describeTableLoadError` |
| `describeUnsupportedDomainFormat` | `describeUnsupportedSubjectAreaFormat` |
| `DesignModel` | `DesignTable` |
| `detectDomainFormat` | `detectSubjectAreaFormat` |
| `DisplayDomain` | `DisplaySubjectArea` |
| `DisplayDomainEditorPayload` | `DisplaySubjectAreaEditorPayload` |
| `DisplayModel` | `DisplayTable` |
| `DomainFileError` | `SubjectAreaFileError` |
| `DomainFileErrorReason` | `SubjectAreaFileErrorReason` |
| `DomainFormat` | `SubjectAreaFormat` |
| `DomainSummary` | `SubjectAreaSummary` |
| `DomainValidationError` | `SubjectAreaValidationError` |
| `ExistingModelPreview` | `ExistingTablePreview` |
| `getRawDomainModelNames` | `getRawSubjectAreaTableNames` |
| `isDomainV5` | `isSubjectAreaV5` |
| `isSafeModelName` | `isSafeTableName` |
| `isValidModelAlias` | `isValidTableAlias` |
| `KeyedModel` | `KeyedTable` |
| `loadDisplayDomain` | `loadDisplaySubjectArea` |
| `LoadDisplayDomainOptions` | `LoadDisplaySubjectAreaOptions` |
| `MODEL_ALIAS_MAX_LENGTH` | `TABLE_ALIAS_MAX_LENGTH` |
| `MODEL_ALIAS_RULE` | `TABLE_ALIAS_RULE` |
| `ModelDiscrepancy` | `TableDiscrepancy` |
| `ModelLoadError` | `TableLoadError` |
| `ModelLoadErrorKind` | `TableLoadErrorKind` |
| `modelLoadErrorOf` | `tableLoadErrorOf` |
| `ModelLoadWarning` | `TableLoadWarning` |
| `modelLoadWarningOf` | `tableLoadWarningOf` |
| `ModelRelationship` | `TableRelationship` |
| `ModelRole` | `TableRole` |
| `ModelTemplate` | `TableTemplate` |
| `ModelWithLoadWarning` | `TableWithLoadWarning` |
| `NON_DOMAIN_DIRS` | `NON_SUBJECT_AREA_DIRS` |
| `parseDomainJson` | `parseSubjectAreaJson` |
| `ParseLogicalModelOptions` | `ParseTableOptions` |
| `parseLogicalModelText` | `parseTableText` |
| `RawDomainFile` | `RawSubjectAreaFile` |
| `resolveDomainLayer` | `resolveSubjectAreaLayer` |
| `SemanticDomain` | `SemanticSubjectArea` |
| `SemanticModel` | `SemanticTable` |
| `toDisplayDomain` | `toDisplaySubjectArea` |
| `ToDisplayDomainOptions` | `ToDisplaySubjectAreaOptions` |
| `TooManyModelsError` | `TooManyTablesError` |
| `UnifiedDomain` | `UnifiedSubjectArea` |
| `UnifiedDomainV5` | `UnifiedSubjectAreaV5` |
| `UnreadableModelPlaceholder` | `UnreadableTablePlaceholder` |
| `validateDomainDocument` | `validateSubjectAreaDocument` |
