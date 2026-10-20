import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { detectSubjectAreaFormat, normaliseSubjectAreaDocument, parseTableText, toTableNamingDocument } from '@erd-studio/core';

import {
  describeNamingMigration,
  namingMigrationIsEmpty,
  planNamingMigration,
  type NamingMigrationFile,
  type NamingMigrationInput,
  type NamingMigrationPlan,
} from '../../src/services/namingMigration';

const FIXTURE = path.resolve(__dirname, '../fixtures/dbt-project/.erd-studio');
const V6_SHOWCASE = path.resolve(__dirname, '../../packages/core/test/fixtures/naming-v6/showcase/.erd-studio');

/** Every file under `root` matching `keep`, by `/`-separated relative path. */
function read(root: string, keep: (rel: string) => boolean): NamingMigrationFile[] {
  const out: NamingMigrationFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (keep(rel)) out.push({ path: rel, text: fs.readFileSync(abs, 'utf-8') });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const isTable = (rel: string): boolean => /^(logical-models|tables)\/([^/]+\/)?[^/]+\.yml$/.test(rel);
const isSubjectArea = (rel: string): boolean => /^[^/]+\/[^/]+\.json$/.test(rel) && !rel.startsWith('templates/') && rel !== 'layers.json';

/** The files a plan leaves behind: the project as it would be on disk after applying it. */
function apply(input: NamingMigrationInput, plan: NamingMigrationPlan): Map<string, string> {
  const files = new Map<string, string>([...input.subjectAreas, ...input.tables].map((f) => [f.path, f.text]));
  for (const move of plan.moves) {
    const text = files.get(move.from)!;
    files.delete(move.from);
    files.set(move.to, move.text ?? text);
  }
  for (const rewrite of plan.rewrites) files.set(rewrite.path, rewrite.text);
  return files;
}

function inputOf(files: Map<string, string>, tablesFolderIsLayer = false): NamingMigrationInput {
  const list = [...files].map(([p, text]) => ({ path: p, text }));
  return { subjectAreas: list.filter((f) => isSubjectArea(f.path)), tables: list.filter((f) => isTable(f.path)), tablesFolderIsLayer };
}

/**
 * The whole dbt-project fixture: its library, its v5 subject areas and its
 * v4 ones, which hold no inline table, so they are renamed in place too.
 */
function v5Fixture(): NamingMigrationInput {
  return { subjectAreas: read(FIXTURE, isSubjectArea), tables: read(FIXTURE, isTable), tablesFolderIsLayer: false };
}

describe('planNamingMigration (#182)', () => {
  it('turns the v5 showcase into exactly the v6 showcase that #181 reads', () => {
    const input = v5Fixture();
    const plan = planNamingMigration(input);
    expect(plan.refusals).toEqual([]);
    const after = apply(input, plan);
    for (const v6 of [...read(V6_SHOWCASE, isTable), ...read(V6_SHOWCASE, isSubjectArea)]) {
      const migrated = after.get(v6.path);
      expect(migrated, v6.path).toBeDefined();
      // The v6 fixture spells one character as an escape; everything else is byte for byte.
      expect(JSON.stringify(migrated!.includes('{') ? JSON.parse(migrated!) : migrated), v6.path)
        .toBe(JSON.stringify(v6.text.includes('{') && v6.path.endsWith('.json') ? JSON.parse(v6.text) : v6.text));
      if (v6.path.endsWith('.yml')) expect(migrated).toBe(v6.text);
    }
    expect([...after.keys()].filter((p) => p.startsWith('logical-models/'))).toEqual([]);
  });

  it('changes only the renamed keys and schemaVersion: every other line is byte-identical', () => {
    const input = v5Fixture();
    const plan = planNamingMigration(input);
    const renamed = /"(subjectArea|tables|fromTable|toTable|linkedTable)"|tableRole|toTable|fromTable|"schemaVersion": 6/;
    expect(plan.rewrites.map((r) => r.path).sort()).toEqual(input.subjectAreas.map((f) => f.path).sort());
    for (const rewrite of plan.rewrites) {
      const before = input.subjectAreas.find((f) => f.path === rewrite.path)!.text.split('\n');
      const after = rewrite.text.split('\n');
      expect(after.length).toBe(before.length);
      after.forEach((line, i) => { if (line !== before[i]) expect(line).toMatch(renamed); });
    }
    for (const move of plan.moves) {
      if (move.text === undefined) continue;
      const before = input.tables.find((f) => f.path === move.from)!.text.split('\n');
      move.text.split('\n').forEach((line, i) => { if (line !== before[i]) expect(line).toMatch(renamed); });
    }
  });

  it('reads back as the same project: every table and subject area means what it meant', () => {
    const input = v5Fixture();
    const after = apply(input, planNamingMigration(input));
    for (const t of input.tables) {
      const moved = after.get(t.path.replace(/^logical-models\//, 'tables/'))!;
      expect(parseTableText(moved, 'x')).toEqual(parseTableText(t.text, 'x'));
    }
    for (const s of input.subjectAreas) {
      const doc = JSON.parse(after.get(s.path)!);
      expect(detectSubjectAreaFormat(doc)).toBe('v6');
      const { schemaVersion: _a, ...was } = JSON.parse(s.text);
      const { schemaVersion: _b, ...now } = normaliseSubjectAreaDocument(doc);
      expect(now).toEqual(was);
      expect(doc.schemaVersion).toBe(6);
    }
  });

  it('is idempotent: a migrated project plans nothing', () => {
    const input = v5Fixture();
    const once = apply(input, planNamingMigration(input));
    const again = planNamingMigration(inputOf(once));
    expect(namingMigrationIsEmpty(again)).toBe(true);
    expect(again.refusals).toEqual([]);
    expect(describeNamingMigration(again)).toMatch(/already uses the new file naming/);
  });

  it('keeps comments, quoting, anchors, unknown keys, number text and every relationship as stored', () => {
    const yml = [
      '# Customer dimension — hand-written',
      'name: dim_customer',
      '"modelRole": &role dimension   # the role',
      'x-owner: data-team',
      'grain: 0010',
      'relationships:',
      '  - fromColumn: region_key',
      "    'toModel': dim_region",
      '    toColumn: region_key',
      '    cardinality: one-to-many # written by 1.6.7',
      '  - { fromColumn: a, toModel: dim_a, toColumn: a, cardinality: many-to-one }',
      'columns: []',
      '',
    ].join('\r\n');
    const domain = '{\r\n  "domain": "x",\r\n  "layer": "silver",\r\n  "zzz": 1.50,\r\n  "logical": {\r\n    "relationships": [{ "toModel": "b", "fromModel": "a", "toColumn": "k", "fromColumn": "k", "cardinality": "one-to-many" }],\r\n    "models": ["a"]\r\n  },\r\n  "viewConfig": { "annotations": [{ "id": "n1", "linkedModel": "a" }] }\r\n}\r\n';
    const input: NamingMigrationInput = {
      subjectAreas: [{ path: 'silver/x.json', text: domain }],
      tables: [{ path: 'logical-models/silver/dim_customer.yml', text: yml }],
      tablesFolderIsLayer: false,
    };
    const plan = planNamingMigration(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.moves).toEqual([expect.objectContaining({ from: 'logical-models/silver/dim_customer.yml', to: 'tables/silver/dim_customer.yml' })]);
    expect(plan.moves[0].text).toBe(yml
      .replace('"modelRole"', '"tableRole"')
      .replace("'toModel'", "'toTable'")
      .replace('toModel: dim_a', 'toTable: dim_a'));
    // No schemaVersion: added first, in the file's layout; `toModel` before `fromModel` keeps each value at its own key.
    expect(plan.rewrites[0].text).toBe('{\r\n  "schemaVersion": 6,\r\n  "subjectArea": "x",\r\n  "layer": "silver",\r\n  "zzz": 1.50,\r\n  "logical": {\r\n    "relationships": [{ "toTable": "b", "fromTable": "a", "toColumn": "k", "fromColumn": "k", "cardinality": "one-to-many" }],\r\n    "tables": ["a"]\r\n  },\r\n  "viewConfig": { "annotations": [{ "id": "n1", "linkedTable": "a" }] }\r\n}\r\n');
    expect(plan.rewrites[0].keys).toEqual(expect.arrayContaining(['domain → subjectArea', 'models → tables', 'toModel → toTable', 'fromModel → fromTable', 'linkedModel → linkedTable']));
  });

  it('moves a file it cannot parse as it is, and says so', () => {
    const plan = planNamingMigration({
      subjectAreas: [],
      tables: [{ path: 'logical-models/broken.yml', text: 'name: [unclosed\n' }],
      tablesFolderIsLayer: false,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.moves).toEqual([{ from: 'logical-models/broken.yml', to: 'tables/broken.yml', keys: [] }]);
    expect(plan.notes[0]).toMatch(/moved as it is/);
  });

  it('refuses a layer called tables', () => {
    const plan = planNamingMigration({ subjectAreas: [], tables: [{ path: 'logical-models/a.yml', text: 'name: a\n' }], tablesFolderIsLayer: true });
    expect(plan.refusals[0]).toMatch(/layer called "tables"/);
  });

  it('refuses a name in both libraries, ignoring case (a mixed project)', () => {
    const plan = planNamingMigration({
      subjectAreas: [],
      tables: [{ path: 'logical-models/Dim_Date.yml', text: 'name: Dim_Date\n' }, { path: 'tables/gold/dim_date.yml', text: 'name: dim_date\n' }],
      tablesFolderIsLayer: false,
    });
    expect(plan.refusals).toEqual(['"Dim_Date" has a file in both logical-models/Dim_Date.yml and tables/gold/dim_date.yml. Keep one of them, then migrate.']);
  });

  it('refuses two files that would be one on a case-insensitive file system', () => {
    const plan = planNamingMigration({
      subjectAreas: [],
      tables: [{ path: 'logical-models/Gold/a.yml', text: 'name: a\n' }, { path: 'logical-models/gold/a.yml', text: 'name: a\n' }],
      tablesFolderIsLayer: false,
    });
    expect(plan.refusals.join('\n')).toMatch(/differ only in case/);
  });

  it('migrates the v5 half of a mixed project and leaves the v6 half alone', () => {
    const plan = planNamingMigration({
      subjectAreas: [
        { path: 'gold/a.json', text: '{\n  "schemaVersion": 6,\n  "subjectArea": "a",\n  "layer": "gold",\n  "logical": { "tables": ["t6"] }\n}\n' },
        { path: 'gold/b.json', text: '{\n  "schemaVersion": 5,\n  "domain": "b",\n  "layer": "gold",\n  "logical": { "models": ["t5"] }\n}\n' },
      ],
      tables: [{ path: 'tables/t6.yml', text: 'name: t6\nmodelRole: fact\n' }, { path: 'logical-models/t5.yml', text: 'name: t5\n' }],
      tablesFolderIsLayer: false,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.moves.map((m) => m.from)).toEqual(['logical-models/t5.yml']);
    expect(plan.rewrites.map((r) => r.path)).toEqual(['gold/b.json']);
  });

  it('lists v4 subject areas with inline tables for "Migrate to v5" and refuses hybrid, legacy and broken ones', () => {
    const plan = planNamingMigration({
      subjectAreas: [
        { path: 'gold/v4.json', text: JSON.stringify({ schemaVersion: 4, domain: 'v4', layer: 'gold', logical: { models: [{ name: 'x', columns: [] }] } }) },
        { path: 'gold/legacy.json', text: JSON.stringify({ schemaVersion: 3, models: [] }) },
        { path: 'gold/broken.json', text: '{ <<<<<<< HEAD' },
      ],
      tables: [],
      tablesFolderIsLayer: false,
    });
    expect(plan.v4SubjectAreas).toEqual(['gold/v4.json']);
    expect(plan.refusals.join('\n')).toMatch(/legacy file/);
    expect(plan.refusals.join('\n')).toMatch(/broken\.json is not valid JSON/);
    expect(plan.refusals.join('\n')).toMatch(/still in schema v4/);
  });

  it('renames the key, not an anchor of the same name written before it', () => {
    const plan = planNamingMigration({
      subjectAreas: [],
      tables: [{ path: 'logical-models/a.yml', text: 'name: a\n&modelRole modelRole: fact\nother: *modelRole\n' }],
      tablesFolderIsLayer: false,
    });
    expect(plan.moves[0].text).toBe('name: a\n&modelRole tableRole: fact\nother: *modelRole\n');
  });

  it('keeps a BOM and renames inside it', () => {
    const plan = planNamingMigration({
      subjectAreas: [{ path: 'gold/b.json', text: '\uFEFF{"schemaVersion": 5, "domain": "b", "layer": "gold", "logical": {"models": [], "relationships": []}}' }],
      tables: [],
      tablesFolderIsLayer: false,
    });
    expect(plan.rewrites[0].text).toBe('\uFEFF{"schemaVersion": 6, "subjectArea": "b", "layer": "gold", "logical": {"tables": [], "relationships": []}}');
  });

  it('a key already written in both namings is left for the v6 one', () => {
    const plan = planNamingMigration({
      subjectAreas: [],
      tables: [{ path: 'logical-models/a.yml', text: 'name: a\nmodelRole: fact\ntableRole: dimension\n' }],
      tablesFolderIsLayer: false,
    });
    expect(plan.moves[0]).toEqual({ from: 'logical-models/a.yml', to: 'tables/a.yml', keys: [] });
  });
});

describe('toTableNamingDocument (#182)', () => {
  it('is the inverse of normaliseSubjectAreaDocument, key order kept', () => {
    for (const file of read(V6_SHOWCASE, isSubjectArea)) {
      const doc = JSON.parse(file.text);
      expect(JSON.stringify(toTableNamingDocument(normaliseSubjectAreaDocument(doc)))).toBe(JSON.stringify(doc));
    }
  });

  it('keeps a __proto__ key a key', () => {
    const doc = JSON.parse('{"domain":"x","__proto__":{"polluted":true},"logical":{"models":[]}}');
    const out = toTableNamingDocument(doc);
    expect(Object.keys(out)).toEqual(['schemaVersion', 'subjectArea', '__proto__', 'logical']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
