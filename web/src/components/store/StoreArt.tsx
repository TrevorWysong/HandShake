import clsx from "clsx";
import { storeArt } from "../../lib/storefront/storeArt";

/// A store with no banner photo, as it looks everywhere (`storeArt`): sized
/// by `className`.
export function StoreArt({ storeHex, cuisine, className }: { storeHex: string; cuisine: string | null | undefined; className?: string }) {
  const { gradient, emoji } = storeArt(storeHex, cuisine);
  return (
    <div aria-hidden className={clsx("flex items-center justify-center bg-gradient-to-br", gradient, className)}>
      {emoji}
    </div>
  );
}
