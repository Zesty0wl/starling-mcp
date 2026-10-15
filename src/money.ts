export interface Money {
  currency: string;
  minorUnits: number;
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let f = formatters.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-GB", { style: "currency", currency });
    } catch {
      f = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    formatters.set(currency, f);
  }
  return f;
}

export function minorDigits(currency: string): number {
  return formatterFor(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

/** 123456 GBP → "£1,234.56". Uses integer maths until the final division to avoid float drift. */
export function formatMoney(minorUnits: number, currency: string): string {
  const digits = minorDigits(currency);
  return formatterFor(currency).format(minorUnits / 10 ** digits);
}

export function formatAmount(money: Money | undefined | null, direction?: "IN" | "OUT"): string | undefined {
  if (!money || typeof money.minorUnits !== "number") return undefined;
  const signed = direction === "OUT" ? -money.minorUnits : money.minorUnits;
  return formatMoney(signed, money.currency);
}
