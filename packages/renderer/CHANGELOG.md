# Changelog

All notable changes to `@erd-studio/renderer`. While `0.x`, a breaking change bumps the minor version.

## 0.2.0

### Changed (breaking)
- **Exports use the new words: table and subject area** ([#180](https://github.com/liam-machine/erd-studio/issues/180), part 2 of [#162](https://github.com/liam-machine/erd-studio/issues/162)). What was called a *model* is a **table**, and a *domain* is a **subject area**. Pins `@erd-studio/core` 0.2.0. The types re-exported from core carry its new names. Only names changed: every function behaves as before, and object shapes, property names (`DisplaySubjectArea.models`, `domainPath`, `ErdCanvas`'s `domain` prop, …), message `type` strings and the files read on disk are the same, so a `DisplaySubjectArea` from 0.2.0 is the `DisplayDomain` of 0.1.x. There are no aliases for the old names. Rename the imports:

| 0.1.x | 0.2.0 |
|---|---|
| `computeModelLabels` | `computeTableLabels` |
| `DisplayDomain` | `DisplaySubjectArea` |
| `DisplayModel` | `DisplayTable` |
| `LabelledModel` | `LabelledTable` |
| `matchesModelSearch` | `matchesTableSearch` |
| `ModelFlowNode` | `TableFlowNode` |
| `ModelNode` | `TableNode` |
| `ModelNodeData` | `TableNodeData` |
| `ModelRole` | `TableRole` |
| `transformDomain` | `transformSubjectArea` |
