import type { Flatten } from "@solid-primitives/i18n";
import { en } from "./locales/en";
import { ko } from "./locales/ko";

export { en, ko };

type FlatTranslation = Flatten<typeof en>;
export type TranslationKey = {
  [K in keyof FlatTranslation]: FlatTranslation[K] extends string ? K : never;
}[keyof FlatTranslation];
export type TranslationDictionary = Record<TranslationKey, string>;
