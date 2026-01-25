import { useEffect, useState } from "react";
import i18n from "@/i18n";

export function useI18n() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const handleChange = () => setTick((t) => t + 1);
    i18n.on("languageChanged", handleChange);
    return () => {
      i18n.off("languageChanged", handleChange);
    };
  }, []);

  return {
    t: i18n.t.bind(i18n),
    language: i18n.language,
  };
}
