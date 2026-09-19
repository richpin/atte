import {
  flatten,
  resolveTemplate,
  type Translator,
  translator,
} from "@solid-primitives/i18n";
import { makePersisted } from "@solid-primitives/storage";
import {
  createContext,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  type Signal,
  useContext,
} from "solid-js";
import {
  en,
  ko,
  type TranslationDictionary,
  type TranslationKey,
} from "./translations";

export type Locale = "en" | "ko";
export type LocalePreference = "system" | Locale;
type Dictionary = TranslationDictionary;
type Translate = Translator<Dictionary>;

const dictionaries = {
  en: flatten(en),
  ko: flatten(ko),
} satisfies Record<Locale, Dictionary>;

const backendMessages = new Map<string, TranslationKey>(
  (Object.keys(dictionaries.ko) as (keyof Dictionary)[])
    .filter(
      (key): key is TranslationKey =>
        key.startsWith("backend.") && typeof dictionaries.ko[key] === "string",
    )
    .map((key) => [dictionaries.ko[key] as string, key]),
);

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const primary = language.toLowerCase().split("-")[0];
    if (primary === "ko" || primary === "en") return primary;
  }
  return "en";
}

function systemLocale(): Locale {
  return resolveLocale(
    typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language],
  );
}

function createTranslate(locale: () => Locale): Translate {
  return translator(() => dictionaries[locale()], resolveTemplate);
}

interface I18n {
  locale: () => Locale;
  preference: () => LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  t: Translate;
  message: (value: unknown, fallback: TranslationKey) => string;
  content: (value: string | null) => string | null;
}

const fallbackLocale = () => systemLocale();
const fallbackTranslate = createTranslate(fallbackLocale);
const I18nContext = createContext<I18n>({
  locale: fallbackLocale,
  preference: (): LocalePreference => "system",
  setPreference: () => undefined,
  t: fallbackTranslate,
  message: (value, fallback) =>
    translateMessage(value, fallback, fallbackTranslate),
  content: (value) => translateContent(value, fallbackTranslate),
});

export function I18nProvider(props: { children: JSX.Element }) {
  const [system, setSystem] = createSignal(systemLocale());
  const [preference, setPreference] = makePersisted<
    LocalePreference,
    Signal<LocalePreference>
  >(createSignal<LocalePreference>("system"), {
    name: "atte.locale",
    serialize: (value) => value,
    deserialize: (value) => (isLocalePreference(value) ? value : "system"),
  });
  const locale = (): Locale =>
    preference() === "system" ? system() : (preference() as Locale);
  const t = createTranslate(locale);
  const updateSystemLocale = () => setSystem(systemLocale());

  createEffect(() => {
    document.documentElement.lang = locale();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("languagechange", updateSystemLocale);
    onCleanup(() =>
      window.removeEventListener("languagechange", updateSystemLocale),
    );
  }

  return (
    <I18nContext.Provider
      value={{
        locale,
        preference,
        setPreference: (value) => setPreference(value),
        t,
        message: (value, fallback) => translateMessage(value, fallback, t),
        content: (value) => translateContent(value, t),
      }}
    >
      {props.children}
    </I18nContext.Provider>
  );
}

function isLocalePreference(value: string): value is LocalePreference {
  return value === "system" || value === "en" || value === "ko";
}

export function useI18n() {
  return useContext(I18nContext);
}

function translateMessage(
  value: unknown,
  fallback: TranslationKey,
  t: Translate,
) {
  const message =
    typeof value === "string"
      ? value
      : typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof value.message === "string"
        ? value.message
        : undefined;
  return message ? translateContent(message, t) : t(fallback);
}

function translateContent(value: string, t: Translate): string;
function translateContent(value: null, t: Translate): null;
function translateContent(value: string | null, t: Translate): string | null;
function translateContent(value: string | null, t: Translate) {
  if (value === null) return null;
  const exact = backendMessages.get(value);
  if (exact) return t(exact);

  const windowError =
    /^\ucc3d\uc744 \uc5f4 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4:/.test(value);
  if (windowError)
    return `${t("backend.openWindowFailed")} ${value.split(":").slice(1).join(":").trim()}`;
  return value;
}
