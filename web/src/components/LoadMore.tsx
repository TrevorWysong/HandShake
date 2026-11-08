// The end of a long list: the next page is read as it comes into view, the
// way the big delivery apps scroll -- with a button for the same, for a
// keyboard, or once a page fails to load (it isn't retried on its own).
import { useCallback } from "react";
import { Button } from "./ui";
import { useT } from "../i18n";

export function LoadMore({ loading, failed = false, onMore, className }: { loading: boolean; failed?: boolean; onMore: () => void; className?: string }) {
  const t = useT();
  const watch = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || loading || failed) return;
      const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && onMore(), { rootMargin: "600px 0px" });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [loading, failed, onMore],
  );
  return (
    <div ref={watch} className={className}>
      <Button variant="ghost" loading={loading} onClick={onMore} className="w-full py-2 text-xs">
        {t("common.loadMore")}
      </Button>
    </div>
  );
}
