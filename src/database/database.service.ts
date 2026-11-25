import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

@Injectable()
export class Database implements OnApplicationShutdown {
  readonly connection: DatabaseSync;

  constructor() {
    const path = process.env.DATABASE_PATH ?? './data/app.sqlite';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.connection = new DatabaseSync(path);
    this.connection.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  onApplicationShutdown() {
    this.connection.close();
  }
}
