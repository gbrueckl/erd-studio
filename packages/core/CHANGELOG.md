# Changelog

All notable changes to `@erd-studio/core`. While `0.x`, a breaking change bumps the minor version.

## Unreleased

### Added
- **Where a domain file's JSON goes wrong** ([#186](https://github.com/liam-machine/erd-studio/issues/186)). A plain `'invalid-json'` `SubjectAreaFileError` (not a merge conflict) now carries optional `line` and `column` (1-based) and `syntaxProblem` (`'trailing-comma' | 'missing-comma' | 'truncated' | 'unexpected'`) when the mistake can be located, pointing where a person would put the fix (the trailing comma itself, the end of the value a comma is missing after) rather than where the parser stopped. `locateJsonSyntaxError(raw, parserMessage)` is the pure helper behind it; it works out the position from the text itself, so it is the same in every engine. `line` used to be set only for a merge conflict, so read it together with `mergeConflict`. `message` is unchanged.

### Fixed
- `parseSubjectAreaJson` (and so `loadDisplaySubjectArea`) reads a domain file that starts with a byte order mark, which used to be rejected as invalid JSON.

## 0.3.0

### Added
- **Reads schema v6, the table naming** ([#181](https://github.com/liam-machine/erd-studio/issues/181), part 3 of [#162](https://github.com/liam-machine/erd-studio/issues/162)): `.erd-studio/tables/`, `logical.tables`, `subjectArea`, `fromTable` / `toTable`, `tableRole` and `linkedTable`. `validateSubjectAreaDocument` returns a v6 document under the v5 keys (`normaliseSubjectAreaDocument`, exported, does the renaming), so `buildUnifiedSubjectArea` and everything after it is unchanged and a v6 file builds the same `DisplaySubjectArea` as its v5 twin, apart from `schemaVersion`. `parseTableText` reads `tableRole` and `toTable` as `modelRole` and `toModel` (the v6 key wins when both are written). `loadDisplaySubjectArea` probes `tables/` after `logical-models/`, in the same order, so a v6 library costs one extra read per folder probed first; a v5 library costs what it did.
- `detectProjectNaming(evidence)` → `'v5' | 'v6' | 'mixed'`, from what a host found on disk; `usesTableLibrary(format)`; `mixesTableNaming(raw)`; `TABLES_DIR` and `TABLE_LIBRARY_DIRS`; `LIBRARY_SCHEMA_VERSION` (5), `TABLE_NAMING_SCHEMA_VERSION` (6) and `WRITTEN_SCHEMA_VERSION` (5, what a writer stamps).

### Changed (breaking)
- `SubjectAreaFormat` gains `'v6'`: an exhaustive `switch` needs a case for it. `detectSubjectAreaFormat` calls a file `hybrid` when it mixes the v5 and v6 names, uses the v6 names under `schemaVersion` 5 (which 0.2.0 drew as an empty diagram), or the v5 names under `schemaVersion` 6, and `describeUnsupportedSubjectAreaFormat` takes the raw document as an optional third argument to say which.
- `CURRENT_SCHEMA_VERSION` is 6: the newest version read. A file declaring 7 or more is refused with "Please update the extension". Code that stamped `CURRENT_SCHEMA_VERSION` on a file it writes should use `WRITTEN_SCHEMA_VERSION`.

## 0.2.0

### Changed (breaking)
- **Exports use the new words: table and subject area** ([#180](https://github.com/liam-machine/erd-studio/issues/180), part 2 of [#162](https://github.com/liam-machine/erd-studio/issues/162)). What was called a *model* is a **table**, and a *domain* is a **subject area**. The four error classes `loadDisplaySubjectArea` rejects with are renamed too; `instanceof` works as before, and `SubjectAreaFileError` and `TooManyTablesError` report their new class name in `name` (`SubjectAreaValidationError` still reports `Error`), and a bad limit option is reported as `loadDisplaySubjectArea: …` / `parseTableText: …`. Only names changed: every function behaves as before, and object shapes, property names (`DisplaySubjectArea.models`, `domainPath`, `ErdCanvas`'s `domain` prop, …), message `type` strings and the files read on disk are the same, so a `DisplaySubjectArea` from 0.2.0 is the `DisplayDomain` of 0.1.x. There are no aliases for the old names. Rename the imports:

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
