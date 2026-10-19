// Entry point `@erd-studio/renderer`: the viewer API — rendering a
// `DisplayDomain` as an entity-relationship diagram, and the graph types.
//
//   import { ErdCanvas } from '@erd-studio/renderer';
//   import '@erd-studio/renderer/styles.css';

export { ErdCanvas, type ErdCanvasProps, type ErdCanvasHandle } from './ErdCanvas';

export {
  transformSubjectArea,
  pickHandleSides,
  type TransformResult,
  type TransformOptions,
  type NodeRect,
  type NodeDimensions,
} from './lib/graphTransformer';
export { repickHandleSides, nodeRect } from './lib/dragHandleSides';

export type {
  DisplaySubjectArea,
  DisplayTable,
  DisplayColumn,
  DisplayRelationship,
  PhysicalColumnSource,
  PhysicalProvenance,
  Annotation,
  AnnotationColor,
  Cardinality,
  Layer,
  TableRole,
  NodePosition,
  Rationale,
  Stage,
  ViewConfig,
  LayerConfig,
} from '@erd-studio/core';

// One-way text exports of a diagram (Mermaid erDiagram, DBML), re-exported
// from @erd-studio/core so a page that renders with this package can offer
// them without depending on core directly.
export {
  toMermaid,
  toDbml,
  exportDiagram,
  diagramExportFileName,
  DIAGRAM_EXPORT_FORMATS,
  DIAGRAM_EXPORT_FILE_EXTENSIONS,
  type DiagramExportFormat,
} from '@erd-studio/core';

export type {
  TableFlowNode,
  TableNodeData,
  FkFlowEdge,
  FkEdgeData,
  AnnotationFlowNode,
  AnnotationFlowEdge,
  ColumnDisplay,
} from './types/graph';
