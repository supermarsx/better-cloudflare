import { useEffect, useState } from "react";
import i18n from "@/i18n";

/**
 * Subscribe to the active i18next language.
 *
 * The bound `t` is kept in state next to the language it was bound for, so its
 * identity is stable between renders and only changes when the locale actually
 * changes. That stability is what lets callers list `t` in hook dependency
 * arrays without recreating every callback -- and re-firing every effect that
 * depends on one -- on each render.
 */
export function useI18n() {
  const [snapshot, setSnapshot] = useState(() => ({
    language: i18n.language,
    t: i18n.t.bind(i18n),
  }));

  useEffect(() => {
    const handleChange = () => {
      setSnapshot((prev) =>
        prev.language === i18n.language
          ? prev
          : { language: i18n.language, t: i18n.t.bind(i18n) },
      );
    };
    i18n.on("languageChanged", handleChange);
    // Resync in case the language settled between the first render and this
    // subscription (i18n initialises asynchronously).
    handleChange();
    return () => {
      i18n.off("languageChanged", handleChange);
    };
  }, []);

  return snapshot;
}
