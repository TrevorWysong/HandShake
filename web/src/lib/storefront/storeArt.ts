// How a store with no banner photo looks: a gradient and an emoji, the same
// on its card, its page and its cart -- the emoji from its cuisine where
// that says what it serves, and otherwise, like the gradient, picked from
// the store's own hash, so the same store always looks the same.

const GRADIENTS = [
  "from-orange-400 to-rose-500",
  "from-amber-400 to-orange-500",
  "from-lime-400 to-emerald-500",
  "from-sky-400 to-indigo-500",
  "from-fuchsia-400 to-purple-500",
  "from-teal-400 to-cyan-500",
];

/// What a cuisine's words say it serves, English and Spanish alike, most
/// particular first: "Taco bar" is tacos, not a bar.
const CUISINES: [RegExp, string][] = [
  [/taco|mexic|burrito|tex-?mex|taquer/i, "🌮"],
  [/pizz|itali/i, "🍕"],
  [/sushi|japan|jap[oó]n/i, "🍣"],
  [/ramen|noodle|fideo|chin[ae]|pho|vietnam/i, "🍜"],
  [/curry|india|thai|tailand/i, "🍛"],
  [/burger|hamburgues|american|diner/i, "🍔"],
  [/caf[eé]|coffee|espresso/i, "☕"],
  [/bak|pastr|panader|pasteler|donut|dona/i, "🥐"],
  [/dessert|postre|ice ?cream|helad/i, "🍨"],
  [/salad|ensalad|vegan|healthy|saludable/i, "🥗"],
  [/sandwich|s[aá]ndwich|deli|bocadill/i, "🥪"],
  [/bbq|barbec|grill|parrill|asador/i, "🍖"],
  [/breakfast|brunch|desayun/i, "🥞"],
  [/chicken|pollo|wings|alitas/i, "🍗"],
  [/seafood|fish|marisc|pescad/i, "🦐"],
  [/bento|korea|corea/i, "🍱"],
];
const OTHERWISE = ["🍽️", "🥘", "🍲", "🥙"];

export interface StoreArt {
  /// Tailwind gradient stops, for `bg-gradient-to-br`.
  gradient: string;
  emoji: string;
}

/// `storeHex` is the store's catalog hash, as hex.
export function storeArt(storeHex: string, cuisine: string | null | undefined): StoreArt {
  let seed = 0;
  for (let i = 0; i < storeHex.length; i++) seed = (seed * 31 + storeHex.charCodeAt(i)) >>> 0;
  const named = cuisine ? CUISINES.find(([words]) => words.test(cuisine))?.[1] : undefined;
  return { gradient: GRADIENTS[seed % GRADIENTS.length], emoji: named ?? OTHERWISE[(seed >>> 8) % OTHERWISE.length] };
}
