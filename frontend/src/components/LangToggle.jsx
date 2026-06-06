import { useTranslation } from "react-i18next";

export default function LangToggle() {
  const { i18n } = useTranslation();
  const lng = i18n.language?.startsWith("en") ? "en" : "es";
  const toggle = () => i18n.changeLanguage(lng === "es" ? "en" : "es");
  return (
    <button className="lang-toggle" onClick={toggle} aria-label="Toggle language">
      <span className={lng === "es" ? "on" : ""}>ES</span>
      <span className="sep">/</span>
      <span className={lng === "en" ? "on" : ""}>EN</span>
    </button>
  );
}
