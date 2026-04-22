export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function decimalToBaseUnits(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('Amount must be a positive decimal string.');
  }

  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount has more decimal places than token supports (${decimals}).`);
  }

  const paddedFraction = fraction.padEnd(decimals, '0');
  const combined = `${whole}${paddedFraction}`.replace(/^0+(\d)/, '$1');
  return combined === '' ? '0' : combined;
}

export function baseUnitsToDecimal(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Base-unit amount must be an integer string.');
  }
  if (decimals === 0) {
    return normalized;
  }

  const padded = normalized.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
