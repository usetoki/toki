import { useEffect, useState } from "react";

/** Track which section is in view, for highlighting the active nav link. */
export function useScrollSpy(ids: readonly string[], topOffset = 96): string | null {
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first !== undefined) setActiveId(first.target.id);
      },
      { rootMargin: `-${topOffset}px 0px -65% 0px`, threshold: 0 },
    );

    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    elements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [ids, topOffset]);

  return activeId;
}
