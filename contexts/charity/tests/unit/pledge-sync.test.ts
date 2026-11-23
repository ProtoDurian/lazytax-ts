import { describe, expect, it } from 'bun:test';
import { hierarchicalName, slugOf } from '../../src/domain/pledge-sync-service';
import { FakePledgeGateway, type PledgeCause, PledgeFixture } from '../../src/gateway/pledge-gateway';

const cause = (id: number, name: string, parentId: number | null): PledgeCause => ({ id, name, parentId });
const lookupOf = (cs: PledgeCause[]) => new Map(cs.map(c => [c.id, c]));

describe('hierarchicalName', () => {
  it('should join the cause under all its parents, root first', () => {
    // Arrange
    const cs = [cause(1, 'Animals', null), cause(2, 'Wildlife', 1), cause(3, 'Birds', 2)];
    // Act
    const name = hierarchicalName(cs[2] as PledgeCause, lookupOf(cs));
    // Assert
    expect(name).toBe('Animals > Wildlife > Birds');
  });

  it('should stop at a parent loop instead of walking forever', () => {
    const cs = [cause(1, 'A', 2), cause(2, 'B', 1)];
    expect(hierarchicalName(cs[0] as PledgeCause, lookupOf(cs))).toBe('B > A');
  });

  it('should keep the cause alone when its parent is unknown', () => {
    const cs = [cause(5, 'Orphan', 99)];
    expect(hierarchicalName(cs[0] as PledgeCause, lookupOf(cs))).toBe('Orphan');
  });
});

describe('slugOf', () => {
  it.each([
    ['World Wildlife Fund', 'world-wildlife-fund'],
    ['  Save -- the  Children!  ', 'save-the-children'],
    ['Médecins Sans Frontières', 'mdecins-sans-frontires'],
    ['', ''],
    ['!!!', ''],
  ])('should turn %p into %p', (name, slug) => {
    expect(slugOf(name)).toBe(slug);
  });
});

describe('FakePledgeGateway', () => {
  const gateway = new FakePledgeGateway(PledgeFixture.parse({}));

  it('should list organisations of a country and cause only', async () => {
    const page = await gateway.getOrganizations({ page: 1, perPage: 25, causeKey: '2', country: 'US' });
    expect(page.data.map(o => o.id)).toEqual(['org-wwf-us']);
    expect(page.totalCount).toBe(1);
  });

  it('should page the results', async () => {
    const second = await gateway.getOrganizations({ page: 2, perPage: 2 });
    expect(second.data).toHaveLength(1);
    expect(second.totalCount).toBe(3);
  });

  it('should serve a fixture given in config instead of the default', async () => {
    const g = new FakePledgeGateway(PledgeFixture.parse({ causes: [{ id: 7, name: 'Only' }], organizations: [] }));
    expect(await g.getCauses()).toEqual([{ id: 7, name: 'Only', parentId: null }]);
    expect((await g.getOrganizations({ page: 1, perPage: 25 })).data).toEqual([]);
  });
});
