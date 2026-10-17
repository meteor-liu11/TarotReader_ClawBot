import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const p = resolve(process.env.DB_PATH ?? './data/demo.db');
for (const f of [p, `${p}-wal`, `${p}-shm`]) {
  if (existsSync(f)) { rmSync(f); console.log('  removed', f); }
}
console.log('  数据库已重置，下次启动会自动重建表结构。\n');
