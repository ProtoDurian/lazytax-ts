// Causes: reads and admin writes (LazyTax Domain/Cause).
import { conflict, notFound } from '@lazytax/kernel';
import type { CauseRepository } from '../data/cause-repository';
import { isId } from './charity-service';
import type { CauseDto, CauseSearch } from './model';

export class CauseService {
  constructor(private readonly repo: CauseRepository) {}

  async get(id: string): Promise<CauseDto> {
    const cause = isId(id) ? await this.repo.get(id) : null;
    if (!cause) throw notFound('Cause', id);
    return cause;
  }

  search(q: CauseSearch): Promise<CauseDto[]> {
    return this.repo.search(q);
  }

  getByKey(key: string): Promise<CauseDto | null> {
    return this.repo.getByKey(key);
  }

  async create(key: string, name: string): Promise<CauseDto> {
    const created = await this.repo.create(key, name);
    if (!created) throw conflict('entity_conflict', 'Cause already exists', { entity: 'Cause' });
    return created;
  }

  // The key is immutable; only the name changes.
  async update(id: string, name: string): Promise<CauseDto> {
    const updated = isId(id) ? await this.repo.update(id, name) : null;
    if (!updated) throw notFound('Cause', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!isId(id) || !(await this.repo.delete(id))) throw notFound('Cause', id);
  }
}
