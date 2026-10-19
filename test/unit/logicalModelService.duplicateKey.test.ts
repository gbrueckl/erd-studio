/**
 * A model file with a key written twice (#164): read with the last copy
 * winning (as dbt's PyYAML reads it) and reported once, but never written —
 * every writer is refused, naming the file and line, and the bytes stay put.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DuplicateKeyWriteRefused, TableLibraryService, type TableFileError } from '../../src/services/logicalModelService';

const DUP = [
  'name: dim_x',
  '# a comment that must survive',
  'x-team: data',
  'columns:',
  '  - name: id',
  '    dataType: INT',
  '    description: first',
  '    description: second',
  '',
].join('\n');

describe('TableLibraryService with a key written twice (#164)', () => {
  let ws: string;
  let file: string;
  let service: TableLibraryService;
  let reported: TableFileError[];

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-164-'));
    fs.mkdirSync(path.join(ws, '.erd-studio/logical-models'), { recursive: true });
    file = path.join(ws, '.erd-studio/logical-models/dim_x.yml');
    fs.writeFileSync(file, DUP);
    service = new TableLibraryService(ws);
    reported = [];
    service.onParseFailure = (e) => reported.push(e);
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('getModel returns the model with the last value, and reports it once', () => {
    expect(service.getTable('dim_x')?.columns?.[0].description).toBe('second');
    service.getTable('dim_x');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ kind: 'yamlDuplicateKey', line: 8, readable: true, key: 'description' });
  });

  it('listTables includes it, and getTableFileError still names the problem (doctor, diff, Model Library)', () => {
    expect(service.listTables().map((m) => m.name)).toEqual(['dim_x']);
    expect(service.getTableFileError('dim_x')).toMatchObject({ kind: 'yamlDuplicateKey', line: 8, readable: true });
    expect(service.hasUnreadableRelationships()).toBe(false);
  });

  it('clears the problem once one copy is removed', () => {
    service.getTable('dim_x');
    fs.writeFileSync(file, DUP.replace('    description: first\n', ''));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(service.getTable('dim_x')).not.toHaveProperty('loadWarning');
    expect(service.getTableFileError('dim_x')).toBeNull();
  });

  it('refuses every write path, naming file, key and line, and writes nothing', () => {
    const model = service.getTable('dim_x')!;
    model.columns![0].description = 'edited';
    const refusal = /dim_x\.yml, line 8: "description" is written twice in one block/;
    expect(() => service.serializeTable(model)).toThrow(DuplicateKeyWriteRefused);
    expect(() => service.serializeTable(model)).toThrow(refusal);
    expect(() => service.serializeTableAt(model, file)).toThrow(DuplicateKeyWriteRefused);
    expect(() => service.saveTable(model)).toThrow(DuplicateKeyWriteRefused);
    expect(() => service.renameTable('dim_x', 'dim_y')).toThrow(DuplicateKeyWriteRefused);
    expect(fs.readFileSync(file, 'utf-8')).toBe(DUP);
    expect(fs.existsSync(path.join(ws, '.erd-studio/logical-models/dim_y.yml'))).toBe(false);
  });

  it('a model loaded before the duplicate appeared cannot regenerate the file either', () => {
    fs.writeFileSync(file, 'name: dim_x\ncolumns:\n  - name: id\n    dataType: INT\n');
    const stale = service.getTable('dim_x')!;
    fs.writeFileSync(file, DUP);
    expect(() => service.serializeTable(stale)).toThrow(DuplicateKeyWriteRefused);
  });

  it('a duplicated name: cannot point a write at another file', () => {
    fs.writeFileSync(file, 'name: dim_x\nname: dim_z\ncolumns: []\n');
    const model = service.getTable('dim_x')!;
    expect(model.name).toBe('dim_z');
    expect(() => service.serializeTable(model)).toThrow(DuplicateKeyWriteRefused);
    expect(() => service.saveTable(model)).toThrow(DuplicateKeyWriteRefused);
    expect(fs.existsSync(path.join(ws, '.erd-studio/logical-models/dim_z.yml'))).toBe(false);
  });

  it('dataTypeAliasColumns does not throw on it', () => {
    expect(service.dataTypeAliasColumns('dim_x')).toEqual({ columns: [], ignored: [], anchored: [] });
  });

  it('another YAML error still reads as unreadable, with nothing refused differently', () => {
    fs.writeFileSync(file, 'name: dim_x\ndescription: "unterminated\n');
    expect(service.getTable('dim_x')).toBeNull();
    expect(service.getTableFileError('dim_x')).not.toHaveProperty('readable');
  });
});
