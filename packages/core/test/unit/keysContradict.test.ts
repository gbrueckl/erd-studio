/**
 * A relationship stored the way round its keys contradict — 1.6.7 could save
 * a many-to-one starting at a dimension's primary key — is flagged
 * `keysContradict` (#163) and drawn as stored, never turned round on read.
 * The flag is set only when the keys decide, and the exports carry the same
 * sentence the canvas's ⚠ shows.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { toDisplaySubjectArea } from '../../src/displayDomain';
import { toDbml } from '../../src/exportDbml';
import { toMermaid } from '../../src/exportMermaid';
import { buildDbtKeyIndex } from '../../src/keyEvidence';
import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { backwardsRelationshipNote } from '../../src/relationships';
import type { DbtKeyIndex } from '../../src/keyEvidence';
import type { Relationship, SemanticSubjectArea, SemanticTable } from '../../src/types/semantic';
import { parseMermaid, parseMermaidOldest, readDbmlEverywhere } from '../exportParsers';

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'int', description: '', isPrimaryKey });

const DIM: SemanticTable = { name: 'dim_customer', description: '', columns: [col('customer_key', true)] } as SemanticTable;
const FCT: SemanticTable = { name: 'fct_order', description: '', columns: [col('order_key', true), col('customer_key')] } as SemanticTable;

/** dim_customer.customer_key → fct_order.customer_key, many-to-one: the 1.6.7 backwards shape. */
const BACKWARDS: Relationship = {
  fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one',
};
const FORWARDS: Relationship = {
  fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
};

function display(
  relationships: Relationship[],
  models: SemanticTable[] = [DIM, FCT],
  extra: { stage?: 'logical' | 'physical'; dbtKeyIndex?: DbtKeyIndex } = {},
) {
  const domain = {
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: extra.stage ?? 'logical', description: '', models, relationships,
  } as SemanticSubjectArea;
  return toDisplaySubjectArea(domain, {
    viewConfig: {}, layerConfig: undefined, readOnly: extra.stage === 'physical',
    ...(extra.dbtKeyIndex ? { dbtKeyIndex: extra.dbtKeyIndex } : {}),
  });
}

const flags = (d: ReturnType<typeof display>) => d.relationships.map((r) => r.keysContradict === true);

describe('keysContradict (#163)', () => {
  it('flags a many-to-one that starts at a whole key and points at a column that is not the other key', () => {
    expect(flags(display([BACKWARDS]))).toEqual([true]);
  });

  it('draws it as stored: the ends and cardinality are never turned round on read', () => {
    const [rel] = display([BACKWARDS]).relationships;
    expect(rel).toMatchObject({ fromModel: 'dim_customer', toModel: 'fct_order', cardinality: 'many-to-one' });
  });

  it('leaves the same link stored the right way round unflagged, and leaves the field out', () => {
    const [rel] = display([FORWARDS]).relationships;
    expect('keysContradict' in rel).toBe(false);
  });

  it('flags a one-to-many by what it means: one from the fact is backwards too', () => {
    // fct_order "one" → dim_customer "many" reads as dim_customer → fct_order many-to-one.
    expect(flags(display([{ ...FORWARDS, cardinality: 'one-to-many' }]))).toEqual([true]);
    expect(flags(display([{ ...BACKWARDS, cardinality: 'one-to-many' }]))).toEqual([false]);
  });

  it('flags nothing when the keys do not decide: the target flags no key', () => {
    const fctNoKey = { ...FCT, columns: [col('order_key'), col('customer_key')] } as SemanticTable;
    expect(flags(display([BACKWARDS], [DIM, fctNoKey]))).toEqual([false]);
  });

  it('counts dbt\'s tests for a model that flags no key, only when the host passes them', () => {
    const dimNoKey = { ...DIM, columns: [col('customer_key')] } as SemanticTable;
    const dbt = buildDbtKeyIndex([{ uniqueColumns: [['dim_customer', ['customer_key']]] }]);
    expect(flags(display([BACKWARDS], [dimNoKey, FCT]))).toEqual([false]);
    expect(flags(display([BACKWARDS], [dimNoKey, FCT], { dbtKeyIndex: dbt }))).toEqual([true]);
  });

  it('never flags one-to-one or many-to-many, which have no many side to prefer', () => {
    expect(flags(display([{ ...BACKWARDS, cardinality: 'one-to-one' }, { ...BACKWARDS, cardinality: 'many-to-many' }]))).toEqual([false, false]);
  });

  it('never flags the physical stage: a dbt test\'s from is always its child column', () => {
    expect(flags(display([BACKWARDS], [DIM, FCT], { stage: 'physical' }))).toEqual([false]);
  });

  it('judges a composite foreign key as a whole and flags every member', () => {
    const dim = { name: 'dim_a', description: '', columns: [col('k1', true), col('k2', true)] } as SemanticTable;
    const fct = { name: 'fct_b', description: '', columns: [col('id', true), col('k1'), col('k2')] } as SemanticTable;
    const member = (c: string): Relationship => ({
      fromModel: 'dim_a', fromColumn: c, toModel: 'fct_b', toColumn: c, cardinality: 'many-to-one', compositeKey: 'fk_a',
    });
    // Each column alone is not dim_a's whole key; together they are.
    expect(flags(display([member('k1'), member('k2')], [dim, fct]))).toEqual([true, true]);
  });
});

describe('the exports carry the canvas\'s sentence above a backwards link (#163)', () => {
  const backwardsDisplay = () => display([BACKWARDS]);
  const note = "This starts at dim_customer's key (customer_key), so it was probably drawn backwards.";

  it('DBML: a // line right above the Ref, which stays as stored, and every pinned parser reads it', () => {
    const text = toDbml(backwardsDisplay());
    const lines = text.split('\n');
    const ref = lines.findIndex((l) => l.startsWith('Ref:') && l.includes('dim_customer.customer_key >'));
    expect(lines[ref - 1]).toBe(`// ${note}`);
    const reading = readDbmlEverywhere(text);
    expect(reading.refs).toHaveLength(1);
  });

  it('Mermaid: a %% line right above the relationship, readable by both pinned versions', async () => {
    const text = toMermaid(backwardsDisplay());
    const lines = text.split('\n');
    const edge = lines.findIndex((l) => l.includes('"dim_customer" }o--|| "fct_order"'));
    expect(lines[edge - 1]).toBe(`  %% ${note}`);
    await parseMermaidOldest(text);
    const parsed = await parseMermaid(text);
    expect(parsed.relationships).toHaveLength(1);
  });

  it('names the "many" end for a backwards one-to-many: the key it wrongly leaves from', () => {
    // fct_order "one" → dim_customer "many": its many end is dim_customer's key.
    const oneToMany = { ...FORWARDS, cardinality: 'one-to-many' as const };
    expect(backwardsRelationshipNote(oneToMany, [oneToMany])).toBe(note);
    expect(toDbml(display([oneToMany]))).toContain(`// ${note}`);
  });

  it('writes no comment for a link drawn the right way round', () => {
    const d = display([FORWARDS]);
    expect(toDbml(d)).not.toContain('drawn backwards');
    expect(toMermaid(d)).not.toContain('drawn backwards');
  });
});

describe('a 1.6.7 file (#163)', () => {
  const root = path.resolve(__dirname, '../fixtures/library-relationships');
  const readFile = async (p: string): Promise<string | null> => {
    try { return fs.readFileSync(path.join(root, p), 'utf-8'); } catch { return null; }
  };

  it("flags only the backwards library entry, through core's loadDisplaySubjectArea", async () => {
    const d = await loadDisplaySubjectArea({ domainPath: '.erd-studio/gold/sales.json', readFile, readOnly: true, warn: () => {} });
    const flagged = d.relationships.filter((r) => r.keysContradict).map((r) => `${r.fromModel}.${r.fromColumn}`);
    expect(flagged).toEqual(['dim_product.product_key']);
  });
});
