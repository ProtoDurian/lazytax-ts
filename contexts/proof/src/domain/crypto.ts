// Tokens are encrypted at rest (LazyTax IEncryptor): AES-256-GCM, a fresh 12-byte nonce per value.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface Encryptor {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export function createEncryptor(secret: string): Encryptor {
  const key = createHash('sha256').update(secret).digest();
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    decrypt(sealed) {
      const [v, iv, tag, ct] = sealed.split(':');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unreadable encrypted value');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}
