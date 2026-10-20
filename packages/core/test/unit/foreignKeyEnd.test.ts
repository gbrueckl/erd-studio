/**
 * One rule decides which end of a relationship holds the foreign key (#163):
 * the `to` end of a `one-to-many`, else the `from` end. The canvas badge
 * (`toDisplaySubjectArea`) and the exports read it, so they cannot disagree.
 */

import { describe, it, expect } from 'vitest';

import { toDisplaySubjectArea } from '../../src/displayDomain';
import { toDbml } from '../../src/exportDbml';
import { toMermaid } from '../../src/exportMermaid';
import { foreignKeyEnd } from '../../src/relationships';
import type { Cardinality, Relationship, SemanticSubjectArea } from '../../src/types/semantic';

const key = (name: string, isPrimaryKey = false) => ({ name, dataType: 'int', description: '', isPrimaryKey });

/** dim_customer.customer_key (its key) and fct_order.customer_key, joined by `rel`. */
function display(rel: Relationship) {
  const domain: SemanticSubjectArea = {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'gold',
    stage: 'logical',
    description: '',
    models: [
      { name: 'dim_customer', description: '', columns: [key('customer_key', true)] },
      { name: 'fct_order', description: '', columns: [key('order_key', true), key('customer_key')] },
    ],
    relationships: [rel],
  } as SemanticSubjectArea;
  return toDisplaySubjectArea(domain, { viewConfig: {}, layerConfig: undefined, readOnly: false });
}

const fkBadges = (d: ReturnType<typeof display>) =>
  d.models.flatMap((m) => m.columns.filter((c) => c.isForeignKey).map((c) => `${m.name}.${c.name}`));

const FROM_FACT: Relationship = {
  fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
};
/** The shape 1.6.6 / 1.6.7 saved: drawn from the dimension, on the "one" side. */
const FROM_DIM: Relationship = {
  fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many',
};

describe('foreignKeyEnd', () => {
  it.each<[Cardinality, string]>([
    ['many-to-one', 'from'],
    ['one-to-many', 'to'],
    ['one-to-one', 'from'],
    ['many-to-many', 'from'],
  ])('a %s holds its foreign key at its %s end', (cardinality, end) => {
    const rel = { fromModel: 'a', fromColumn: 'a_col', toModel: 'b', toColumn: 'b_col', cardinality };
    expect(foreignKeyEnd(rel)).toEqual(end === 'to' ? { model: 'b', column: 'b_col' } : { model: 'a', column: 'a_col' });
  });
});

describe('the FK badge lands on the foreign key, however the relationship was saved (#163)', () => {
  it('a one-to-many from the dimension badges the fact\'s column, not the dimension\'s key', () => {
    expect(fkBadges(display(FROM_DIM))).toEqual(['fct_order.customer_key']);
  });

  it('reads the same as the many-to-one it means', () => {
    expect(fkBadges(display(FROM_DIM))).toEqual(fkBadges(display(FROM_FACT)));
  });

  it('a one-to-many does not mark the dimension\'s key as declared either', () => {
    const dim = display(FROM_DIM).models.find((m) => m.name === 'dim_customer')!;
    expect(dim.columns[0]).toMatchObject({ isPrimaryKey: true, isForeignKey: false });
    expect(dim.columns[0].isForeignKeyDeclared).toBeUndefined();
  });

  it('the DBML export notes no foreign key on the dimension\'s key', () => {
    const tables = (d: string) => d.split('\nRef:')[0];
    const dbml = toDbml(display(FROM_DIM));
    expect(dbml).toMatch(/Table dim_customer \{\n\s+customer_key int \[pk\]\n/);
    expect(tables(dbml)).toBe(tables(toDbml(display(FROM_FACT))));
  });

  it('the Mermaid export marks the fact\'s column FK and the dimension\'s key PK only', () => {
    const mmd = toMermaid(display(FROM_DIM));
    expect(mmd).toMatch(/"dim_customer" \{\n\s+int customer_key PK\n/);
    expect(mmd).toMatch(/"fct_order" \{\n\s+int order_key PK\n\s+int customer_key FK\n/);
  });
});
