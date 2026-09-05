import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from './recovery.js';

interface CredentialEncryption {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(bytes: Buffer): string;
}

export class CredentialVault<T extends { id: string }> {
  private entries = new Map<string, { value: T; remembered: boolean }>();
  private loaded = false;

  constructor(private path: string, private encryption: CredentialEncryption) {}

  private load(): void {
    if (this.loaded) return;
    if (!existsSync(this.path)) { this.loaded = true; return; }
    try {
      if (!this.encryption.available()) throw new Error('Credential storage is locked.');
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Invalid vault.');
      const entries = new Map<string, { value: T; remembered: boolean }>();
      for (const encrypted of saved.entries) {
        if (typeof encrypted !== 'string') throw new Error('Invalid credentials.');
        const value = JSON.parse(this.encryption.decrypt(Buffer.from(encrypted, 'base64'))) as T;
        if (!value || typeof value.id !== 'string' || !value.id || entries.has(value.id)) throw new Error('Invalid connection.');
        entries.set(value.id, { value, remembered: true });
      }
      this.entries = entries;
      this.loaded = true;
    } catch {
      throw new Error('Could not read saved music server connections. Unlock your system keyring or restore the connection file.');
    }
  }

  list(): Array<{ value: T; remembered: boolean }> {
    this.load();
    return [...this.entries.values()];
  }

  get(id: string): T | undefined {
    this.load();
    return this.entries.get(id)?.value;
  }

  set(value: T, remembered: boolean): void {
    this.load();
    const next = new Map(this.entries);
    next.set(value.id, { value, remembered });
    this.save(next);
    this.entries = next;
  }

  remove(id: string): void {
    this.load();
    const next = new Map(this.entries);
    next.delete(id);
    this.save(next);
    this.entries = next;
  }

  private save(entries: Map<string, { value: T; remembered: boolean }>): void {
    const remembered = [...entries.values()].filter((entry) => entry.remembered);
    if (!remembered.length && !existsSync(this.path)) return;
    if (remembered.length && !this.encryption.available()) {
      throw new Error('Secure credential storage is unavailable. Turn off Remember connection to connect for this session.');
    }
    const saved = remembered.map(({ value }) => this.encryption.encrypt(JSON.stringify(value)).toString('base64'));
    mkdirSync(dirname(this.path), { recursive: true });
    atomicWriteFileSync(this.path, JSON.stringify({ version: 1, entries: saved }));
  }
}
