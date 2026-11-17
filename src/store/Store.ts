import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newId, type Execution, type TestCase } from '../model/actions.js';

/**
 * Persistence port. The PoC ships a JSON-file adapter; docs/schema.sql holds
 * the PostgreSQL schema that a production adapter implements behind the same
 * interface.
 */
export interface Store {
  listTests(projectId?: string): TestCase[];
  getTest(id: string): TestCase | undefined;
  saveTest(t: TestCase): TestCase;
  deleteTest(id: string): boolean;
  cloneTest(id: string): TestCase | undefined;
  saveExecution(e: Execution): void;
  listExecutions(testId: string): Execution[];
  getExecution(id: string): Execution | undefined;
}

interface Db { tests: Record<string, TestCase>; executions: Record<string, Execution> }

export class JsonFileStore implements Store {
  private db: Db = { tests: {}, executions: {} };
  private file: string;
  private timer?: NodeJS.Timeout;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    if (existsSync(this.file)) this.db = JSON.parse(readFileSync(this.file, 'utf8'));
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.db, null, 2));
      renameSync(tmp, this.file);
    }, 50);
  }

  listTests(projectId?: string) {
    return Object.values(this.db.tests).filter((t) => !projectId || t.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  getTest(id: string) { return this.db.tests[id]; }
  saveTest(t: TestCase) { t.updatedAt = Date.now(); this.db.tests[t.id] = t; this.flush(); return t; }
  deleteTest(id: string) { const had = !!this.db.tests[id]; delete this.db.tests[id]; this.flush(); return had; }
  cloneTest(id: string) {
    const t = this.getTest(id);
    if (!t) return undefined;
    const c: TestCase = JSON.parse(JSON.stringify(t));
    c.id = newId('test'); c.name = `${t.name} (copy)`; c.createdAt = Date.now();
    return this.saveTest(c);
  }
  saveExecution(e: Execution) { this.db.executions[e.id] = e; this.flush(); }
  listExecutions(testId: string) { return Object.values(this.db.executions).filter((e) => e.testId === testId).sort((a, b) => b.startedAt - a.startedAt); }
  getExecution(id: string) { return this.db.executions[id]; }
}
