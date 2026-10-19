/**
 * computeSubjectAreaDiff — THE cross-stage comparison of one domain file.
 *
 * The canvas's "Compare to …" toggle (`SemanticEditorProvider.handleToggleDiscrepancy`)
 * and the `erd-studio diff` CLI both call this, so the two can only disagree
 * if their inputs do. Do not build a second orchestration next to it: any
 * comparison logic outside this function is a parity bug waiting to happen.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import type { CatalogData } from '../types/catalog';
import type { DiscrepancyReport } from '../types/discrepancy';
import type { DisplaySubjectArea } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { Stage, UnifiedSubjectArea } from '../types/semantic';
import type { YmlData } from '../types/ymlData';
import { compare } from './discrepancyService';
import { SubjectAreaService } from './domainService';
import { buildLogicalDisplaySubjectArea, dbtKeyIndexOf } from './stageDisplay';

/** Everything the comparison reads besides the domain file itself. */
export interface SubjectAreaDiffInputs {
  /** Must have its TableLibraryService set, or v5 model names do not resolve. */
  subjectAreaService: SubjectAreaService;
  ymlData: YmlData;
  manifest: ManifestData;
  catalog?: CatalogData;
}

export interface SubjectAreaDiffResult {
  /** The domain file as read — once — for this comparison. */
  unified: UnifiedSubjectArea;
  /** The stage being viewed. */
  source: DisplaySubjectArea;
  /** The stage compared against. */
  target: DisplaySubjectArea;
  report: DiscrepancyReport;
}

/** The stage a comparison from `stage` is made against. */
export function otherStage(stage: Stage): Stage {
  return stage === 'logical' ? 'physical' : 'logical';
}

/**
 * Build one stage's `DisplaySubjectArea` from an already-read unified domain.
 * Physical is derived from the dbt project; logical is the pure core of the
 * canvas's logical payload (no templates or pickers — the comparison never
 * reads them).
 */
export function buildStageForDiff(
  inputs: SubjectAreaDiffInputs,
  unified: UnifiedSubjectArea,
  stage: Stage,
): DisplaySubjectArea {
  if (stage === 'physical') {
    return inputs.subjectAreaService.buildPhysicalSubjectArea(unified, inputs.ymlData, inputs.manifest, inputs.catalog);
  }
  return buildLogicalDisplaySubjectArea(
    SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns, dbtKeyIndexOf(inputs.ymlData, inputs.manifest),
  );
}

/**
 * Read `domainPath` once, build the source and target stages, and compare
 * them with the domain's `stubColumns` suppression.
 *
 * Throws what `SubjectAreaService.getDomain` throws (`SubjectAreaFileError`, an
 * unsupported-format or unknown-layer error) — the caller decides how to
 * report it.
 *
 * @param targetStage defaults to the other stage; the canvas passes the stage
 *   the user picked.
 */
export function computeSubjectAreaDiff(
  inputs: SubjectAreaDiffInputs,
  domainPath: string,
  sourceStage: Stage,
  targetStage: Stage = otherStage(sourceStage),
): SubjectAreaDiffResult {
  // The read winner sees dbt's key evidence, as the canvas does (#133 L1).
  const unified = inputs.subjectAreaService.getSubjectArea(domainPath, { dbtKeyIndex: dbtKeyIndexOf(inputs.ymlData, inputs.manifest) });
  const source = buildStageForDiff(inputs, unified, sourceStage);
  const target = buildStageForDiff(inputs, unified, targetStage);
  const report = compare(source, target, new Set(unified.stubColumns ?? []));
  return { unified, source, target, report };
}
