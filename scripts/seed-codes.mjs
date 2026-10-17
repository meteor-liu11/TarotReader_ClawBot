import { db, now } from '../src/db.mjs';
import { randomBytes } from 'node:crypto';

const count = Number(process.argv[2] ?? 10);
const credits = Number(process.argv[3] ?? 10);
const batch = `demo-${new Date().toISOString().slice(0, 10)}`;

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const block = (n) => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');

const insert = db.prepare(
  'INSERT OR IGNORE INTO redeem_codes (code, batch_id, credits, status, created_at) VALUES (?,?,?,?,?)',
);

const codes = [];
for (let i = 0; i < count; i++) {
  const code = `DEMO-${block(4)}-${block(4)}`;
  insert.run(code, batch, credits, 'unused', now());
  codes.push(code);
}

console.log(`\n  已生成 ${codes.length} 个兑换码（每个 ${credits} 点，批次 ${batch}）\n`);
for (const c of codes) console.log('   ', c);
console.log('');
