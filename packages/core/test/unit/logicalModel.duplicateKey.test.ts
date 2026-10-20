/**
 * A key written twice in one block of a model file (#164): strict by default,
 * and read the way dbt's PyYAML reads it — the last copy wins — when the host
 * asks, with a loadWarning naming the key and the line of the copy used.
 */

import { describe, it, expect } from 'vitest';

import { parseTableText } from '../../src/logicalModel';
import { classifyTableLoadError } from '../../src/domain';
import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { tableLoadWarningOf } from '../../src/types/semantic';

const COLUMN_DUP = [
  'name: dim_x',
  'columns:',
  '  - name: id',
  '    dataType: INT',
  '    description: first',
  '    description: second',
  '',
].join('\n');
const TOP_DUP = ['name: dim_x', 'description: first', 'columns: []', 'description: second', ''].join('\n');

describe('a key written twice in a model file (#164)', () => {
  it('still throws DUPLICATE_KEY by default', () => {
    let thrown: unknown;
    try { parseTableText(COLUMN_DUP, 'dim_x'); } catch (err) { thrown = err; }
    expect(classifyTableLoadError(thrown)).toMatchObject({ kind: 'yamlDuplicateKey', line: 6 });
  });

  it('reads the last copy under a column, with a warning naming the key and its line', () => {
    const model = parseTableText(COLUMN_DUP, 'dim_x', { duplicateKeys: 'last' })!;
    expect(model.columns?.[0].description).toBe('second');
    expect(tableLoadWarningOf(model)).toEqual({ kind: 'yamlDuplicateKey', key: 'description', line: 6 });
  });

  it('reads the last copy at the top level', () => {
    const model = parseTableText(TOP_DUP, 'dim_x', { duplicateKeys: 'last' })!;
    expect(model.description).toBe('second');
    expect(tableLoadWarningOf(model)).toEqual({ kind: 'yamlDuplicateKey', key: 'description', line: 4 });
  });

  it('names the duplicate that comes first in the file', () => {
    const text = ['name: dim_x', 'grain: a', 'grain: b', 'columns:', '  - name: id', '    name: id2', 'grain: c', ''].join('\n');
    const model = parseTableText(text, 'dim_x', { duplicateKeys: 'last' })!;
    expect(model.grain).toBe('c');
    expect(tableLoadWarningOf(model)).toEqual({ kind: 'yamlDuplicateKey', key: 'grain', line: 3 });
  });

  it('leaves a clean file without a warning', () => {
    const model = parseTableText('name: dim_x\ndescription: one\n', 'dim_x', { duplicateKeys: 'last' })!;
    expect(tableLoadWarningOf(model)).toBeUndefined();
    expect('loadWarning' in model).toBe(false);
  });

  it('still throws any other YAML error, even beside a duplicate key', () => {
    const text = 'name: dim_x\ndescription: a\ndescription: b\ngrain: "unterminated\n';
    expect(() => parseTableText(text, 'dim_x', { duplicateKeys: 'last' })).toThrow();
  });

  it('still reports unresolved merge conflicts as such', () => {
    const text = 'name: dim_x\n<<<<<<< HEAD\ndescription: a\n=======\ndescription: b\n>>>>>>> branch\n';
    let thrown: unknown;
    try { parseTableText(text, 'dim_x', { duplicateKeys: 'last' }); } catch (err) { thrown = err; }
    expect(classifyTableLoadError(thrown)).toMatchObject({ mergeConflict: true });
  });

  it('loadDisplaySubjectArea draws the model, with the last value and a loadWarning', async () => {
    const files: Record<string, string> = {
      '.erd-studio/silver/sales.json': JSON.stringify({
        schemaVersion: 5, domain: 'sales', layer: 'silver', logical: { models: ['dim_x'], relationships: [] },
      }),
      '.erd-studio/logical-models/dim_x.yml': COLUMN_DUP,
    };
    const domain = await loadDisplaySubjectArea({
      domainPath: '.erd-studio/silver/sales.json',
      readFile: async (p) => files[p] ?? null,
      readOnly: true,
      warn: () => {},
    });
    const model = domain.models[0];
    expect(model.loadError).toBeUndefined();
    expect(model.columns.map((c) => c.description)).toEqual(['second']);
    expect(model.loadWarning).toEqual({ kind: 'yamlDuplicateKey', key: 'description', line: 6 });
  });
});
