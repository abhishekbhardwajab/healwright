import type { ElementTarget } from '../model/actions.js';

/**
 * Sensitive values (passwords, OTPs, card numbers…) never enter the action
 * model, logs, persistence or generated code. The recorder parks them here,
 * in process memory only, so an immediate replay can still log in. Exported
 * code and later sessions read them from environment variables instead.
 */
export class SecretVault {
  private values = new Map<string, string>();

  set(name: string, value: string) { this.values.set(name, value); }
  get(name: string): string | undefined { return this.values.get(name) ?? process.env[name]; }
  has(name: string) { return this.values.has(name) || process.env[name] !== undefined; }
  names() { return [...this.values.keys()]; }
  mergeFrom(other: SecretVault) { for (const [k, v] of other.values) this.values.set(k, v); }

  static variableNameFor(t: ElementTarget): string {
    const raw = t.attributes?.name || t.attributes?.id || t.accessibleName || t.attributes?.placeholder || 'secret';
    const base = raw.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase() || 'SECRET';
    return /PASS|SECRET|TOKEN|OTP|PIN|CVV|CVC|KEY/.test(base) ? `TEST_${base}` : `TEST_SECRET_${base}`;
  }

  /** Replace any known secret value occurring in free text (logs, errors). */
  mask(text: string): string {
    let out = text;
    for (const v of this.values.values()) if (v && v.length >= 3) out = out.split(v).join('••••••');
    return out;
  }
}
