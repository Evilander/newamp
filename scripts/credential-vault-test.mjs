import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../dist-electron/electron/credential-vault.js').catch(() => ({}));
assert.equal(typeof module.CredentialVault, 'function', 'encrypted server credential storage must be implemented');
const { CredentialVault } = module;
const dir = await mkdtemp(join(tmpdir(), 'newamp-vault-'));
const path = join(dir, 'servers.json');
const crypto = {
  available: () => true,
  encrypt: (text) => Buffer.from([...text].reverse().join('')),
  decrypt: (bytes) => [...bytes.toString()].reverse().join(''),
};
const vault = new CredentialVault(path, crypto);
vault.set({ id: 'one', password: 'unique-private-password' }, true);
assert.equal((await readFile(path, 'utf8')).includes('unique-private-password'), false);
assert.equal(new CredentialVault(path, crypto).get('one').password, 'unique-private-password');
vault.set({ id: 'two', password: 'temporary' }, false);
assert.equal(new CredentialVault(path, crypto).get('two'), undefined);
vault.remove('one');
assert.equal(new CredentialVault(path, crypto).get('one'), undefined);
const locked = new CredentialVault(join(dir, 'locked.json'), { ...crypto, available: () => false });
assert.throws(() => locked.set({ id: 'locked', password: 'secret' }, true), /Remember|storage/i);
locked.set({ id: 'session', password: 'secret' }, false);
assert.equal(locked.get('session').password, 'secret');
await writeFile(path, '{broken');
const corrupt = new CredentialVault(path, crypto);
assert.throws(() => corrupt.list(), /saved.*connection|read.*connection/i);
assert.throws(() => corrupt.set({ id: 'three' }, true));
assert.equal(await readFile(path, 'utf8'), '{broken', 'unreadable existing credentials must never be overwritten');
console.log('Credential vault persistence, session mode, removal and corruption guards passed.');
