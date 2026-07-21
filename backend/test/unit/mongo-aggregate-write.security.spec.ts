/**
 * M1 regression — a Mongo aggregate pipeline that ends in $out/$merge WRITES a
 * collection, but `aggregate` is classified as a read op, so a read-only Mongo tool
 * used to let it through. `aggregateHasWriteStage` is the detection the capability
 * gate now uses to block such pipelines unless the tool permits writes.
 */
import { describe, it, expect } from 'vitest';
import { aggregateHasWriteStage } from '../../src/custom-tools/custom-tool.factory';

describe('aggregateHasWriteStage — detects $out/$merge (M1)', () => {
  it.each([
    [[{ $match: {} }, { $out: 'users' }], '$out (string target)'],
    [[{ $match: {} }, { $merge: { into: 'users' } }], '$merge (object target)'],
    [[{ $group: {} }, { $merge: 'otherColl' }], '$merge (string target)'],
    [[{ $out: { db: 'admin', coll: 'x' } }], '$out (cross-db object)'],
  ])('flags a pipeline with %s', (pipeline) => {
    expect(aggregateHasWriteStage(pipeline)).toBe(true);
  });

  it.each([
    [[{ $match: { a: 1 } }, { $group: { _id: '$a' } }, { $sort: { a: 1 } }], 'read-only pipeline'],
    [[{ $lookup: { from: 'other', as: 'j' } }], '$lookup only'],
    [[], 'empty pipeline'],
    [undefined, 'no pipeline'],
    ['not-an-array', 'non-array'],
  ])('does not flag %s', (pipeline) => {
    expect(aggregateHasWriteStage(pipeline as unknown)).toBe(false);
  });
});
