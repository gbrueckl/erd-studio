/**
 * Turn Round for every relationship drawn backwards (#163) is one write:
 * `planRelationshipWrites` folds `planRelationshipWrite` so each op builds on
 * the models the ops before it left. Two backwards links leaving one model
 * file both turn round, and that file is saved once — never two replaces of
 * it from the same snapshot.
 */

import { describe, it, expect } from 'vitest';

import { planRelationshipWrite, planRelationshipWrites } from '../../src/services/libraryRelationships';
import type { RelationshipWriteOp } from '../../src/services/libraryRelationships';
import type { Relationship, SemanticTable } from '../../src/types/semantic';

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'int', description: '', isPrimaryKey });

/** dim_customer saved by 1.6.7 with two backwards many-to-ones, one to each fact. */
const tables = (): SemanticTable[] => [
  {
    name: 'dim_customer', description: '', columns: [col('customer_key', true)],
    relationships: [
      { fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' },
      { fromColumn: 'customer_key', toModel: 'fct_return', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ],
  },
  { name: 'fct_order', description: '', columns: [col('order_key', true), col('customer_key')] },
  { name: 'fct_return', description: '', columns: [col('return_key', true), col('customer_key')] },
] as SemanticTable[];

/** ⇄ on a backwards line, as the ⚠'s Turn round sends it. */
const turnRound = (toModel: string): RelationshipWriteOp => ({
  kind: 'update',
  ends: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel, toColumn: 'customer_key' },
  cardinality: 'one-to-many',
});

const input = () => ({ home: 'library' as const, models: tables(), domainRelationships: [] as Relationship[] });

describe('planRelationshipWrites — Turn round all, one write (#163)', () => {
  it('turns both round and saves each changed file once, as the last op left it', () => {
    const { plan } = planRelationshipWrites([turnRound('fct_order'), turnRound('fct_return')], input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const byName = new Map(plan.changed.map((m) => [m.name, m]));
    expect(plan.changed.map((m) => m.name).sort()).toEqual(['dim_customer', 'fct_order', 'fct_return']);
    expect(byName.get('dim_customer')!.relationships ?? []).toEqual([]);
    expect(byName.get('fct_order')!.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    expect(byName.get('fct_return')!.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
  });

  it('differs from planning each op against the same snapshot, which loses the first turn', () => {
    const second = planRelationshipWrite(turnRound('fct_return'), input());
    // Alone, the second op's copy of dim_customer still holds the fct_order entry.
    expect(second.ok && second.changed.find((m) => m.name === 'dim_customer')!.relationships).toHaveLength(1);
  });

  it('refuses all when one op is refused, and changes none of its inputs', () => {
    const given = input();
    const before = structuredClone(given);
    const { plan } = planRelationshipWrites([turnRound('fct_order'), turnRound('fct_missing')], given);
    expect(plan.ok).toBe(false);
    expect(given).toEqual(before);
  });

  it('records each step with the input it was planned against, for the self-check', () => {
    const { steps } = planRelationshipWrites([turnRound('fct_order'), turnRound('fct_return')], input());
    expect(steps).toHaveLength(2);
    expect(steps[1].input.models.find((m) => m.name === 'dim_customer')!.relationships).toHaveLength(1);
  });
});
