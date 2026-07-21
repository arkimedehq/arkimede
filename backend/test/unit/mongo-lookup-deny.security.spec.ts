/**
 * L2 regression — the manifest collection-deny only inspected spec.collection, so an
 * aggregate could read a denied collection via $lookup/$graphLookup/$unionWith. The
 * gate now uses aggregateReferencedCollections to surface every collection a pipeline
 * reaches (including nested sub-pipelines and $facet) and denies them too.
 */
import { describe, it, expect } from 'vitest';
import { aggregateReferencedCollections } from '../../src/custom-tools/custom-tool.factory';

describe('aggregateReferencedCollections — surfaces pipeline collections (L2)', () => {
  it('extracts $lookup.from and $graphLookup.from', () => {
    const cols = aggregateReferencedCollections([
      { $match: {} },
      { $lookup: { from: 'salaries', localField: 'a', foreignField: 'b', as: 'x' } },
      { $graphLookup: { from: 'org_chart', startWith: '$m', connectFromField: 'm', connectToField: 'id', as: 'g' } },
    ]);
    expect(cols).toEqual(expect.arrayContaining(['salaries', 'org_chart']));
  });

  it('extracts $unionWith (string and object) and recurses into sub-pipelines', () => {
    const cols = aggregateReferencedCollections([
      { $unionWith: 'archived_users' },
      { $unionWith: { coll: 'audit', pipeline: [{ $lookup: { from: 'secrets', as: 's' } }] } },
    ]);
    expect(cols).toEqual(expect.arrayContaining(['archived_users', 'audit', 'secrets']));
  });

  it('recurses into $lookup.pipeline and $facet', () => {
    const cols = aggregateReferencedCollections([
      { $lookup: { from: 'a', pipeline: [{ $lookup: { from: 'nested_secret', as: 'n' } }], as: 'x' } },
      { $facet: { branch: [{ $lookup: { from: 'faceted_secret', as: 'f' } }] } },
    ]);
    expect(cols).toEqual(expect.arrayContaining(['a', 'nested_secret', 'faceted_secret']));
  });

  it('returns nothing for a plain read pipeline or a non-array', () => {
    expect(aggregateReferencedCollections([{ $match: {} }, { $group: { _id: '$x' } }])).toEqual([]);
    expect(aggregateReferencedCollections(undefined)).toEqual([]);
  });
});
