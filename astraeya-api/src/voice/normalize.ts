/**
 * Text rewritten the way a person would say it, just before it is spoken.
 *
 * The voice engine reads "2.4" as "two, four" (the point becomes a pause), so
 * "2.4 GB" sounded like "4 GB". Numbers, versions, addresses, money and units
 * are spelled out here so every word is heard. Only the spoken copy changes;
 * the text on screen stays as written.
 */

const UNITS: Record<string, [string, string]> = {
  KB: ["kilobyte", "kilobytes"],
  MB: ["megabyte", "megabytes"],
  GB: ["gigabyte", "gigabytes"],
  TB: ["terabyte", "terabytes"],
  Kbps: ["kilobit per second", "kilobits per second"],
  Mbps: ["megabit per second", "megabits per second"],
  Gbps: ["gigabit per second", "gigabits per second"],
  KHz: ["kilohertz", "kilohertz"],
  kHz: ["kilohertz", "kilohertz"],
  MHz: ["megahertz", "megahertz"],
  GHz: ["gigahertz", "gigahertz"],
  ms: ["millisecond", "milliseconds"],
  km: ["kilometre", "kilometres"],
  kg: ["kilogram", "kilograms"],
};

const CURRENCIES: Record<string, [string, string, string]> = {
  $: ["dollar", "dollars", "cents"],
  "€": ["euro", "euros", "cents"],
  "£": ["pound", "pounds", "pence"],
};

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "14" after a decimal point is said digit by digit: "one four". */
function digits(s: string): string {
  return s.split("").map((d) => DIGIT_WORDS[Number(d)] ?? d).join(" ");
}

export function normalizeForSpeech(input: string): string {
  // A unit written straight after its number ("2.4GHz", "4GB") gets a space.
  let text = input.replace(/(\d)(KB|MB|GB|TB|Kbps|Mbps|Gbps|KHz|kHz|MHz|GHz|ms|km|kg)\b/g, "$1 $2");

  // Thousands separators: "1,024" and "46,000" are single numbers.
  text = text.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => m.replace(/,/g, ""));

  // Money: "$12.50" -> "12 dollars and 50 cents", "$5" -> "5 dollars".
  text = text.replace(/([$€£])\s?(\d+)(?:\.(\d{1,2}))?\b/g, (_m, sym: string, whole: string, cents?: string) => {
    const [one, many, small] = CURRENCIES[sym];
    const main = `${whole} ${whole === "1" ? one : many}`;
    return cents && Number(cents) > 0 ? `${main} and ${Number(cents.padEnd(2, "0"))} ${small}` : main;
  });

  // IP addresses: "192.168.1.1" -> "192 dot 168 dot 1 dot 1".
  text = text.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, "$1 dot $2 dot $3 dot $4");
  // Two addresses in a row (an IP and its mask) get a short pause between them.
  text = text.replace(/(dot \d{1,3}) (\d{1,3} dot)/g, "$1, $2");

  // Versions: "2.0.1" -> "2 point 0 point 1".
  text = text.replace(/\b\d+(?:\.\d+){2,}\b/g, (m) => m.split(".").join(" point "));

  // Decimals: "2.4" -> "2 point four", "3.14" -> "3 point one four".
  // (A unit may follow straight on: "2.4GHz".)
  text = text.replace(/(?<![\d.])(\d+)\.(\d+)(?![\d.])/g, (_m, whole: string, frac: string) => `${whole} point ${digits(frac)}`);

  // Percent: "45%" -> "45 percent".
  text = text.replace(/(\d)\s?%/g, "$1 percent");

  // Units after a number: "4 GB" / "4GB" -> "4 gigabytes", "1 MB" -> "1 megabyte".
  text = text.replace(/\b(\d+(?: point(?: (?:zero|one|two|three|four|five|six|seven|eight|nine))+)?)\s?(KB|MB|GB|TB|Kbps|Mbps|Gbps|KHz|kHz|MHz|GHz|ms|km|kg)\b/g, (_m, n: string, unit: string) => {
    const [one, many] = UNITS[unit];
    return `${n} ${n === "1" ? one : many}`;
  });

  return text;
}
