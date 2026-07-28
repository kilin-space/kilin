import { createTokenizer as createMandarinTokenizer } from "@orama/tokenizers/mandarin";
import type { I18nConfig } from "fumadocs-core/i18n";
import { createFromSource } from "fumadocs-core/search/server";
import type { LoaderConfig, LoaderOutput } from "fumadocs-core/source";

import type { Locale } from "@/lib/i18n";

type DocumentationLoaderConfig = LoaderConfig & {
  i18n: I18nConfig<Locale>;
};

const documentationLocaleMap = {
  en: "english",
  "zh-cn": {
    components: {
      tokenizer: createMandarinTokenizer(),
    },
    search: {
      threshold: 0,
      tolerance: 0,
    },
  },
  "zh-tw": {
    components: {
      tokenizer: createMandarinTokenizer(),
    },
    search: {
      threshold: 0,
      tolerance: 0,
    },
  },
} as const;

export function createDocumentationSearchGET<TConfig extends DocumentationLoaderConfig>(
  source: LoaderOutput<TConfig>,
): ReturnType<typeof createFromSource<TConfig>>["GET"] {
  return createFromSource(source, {
    localeMap: documentationLocaleMap as NonNullable<
      NonNullable<Parameters<typeof createFromSource<TConfig>>[1]>["localeMap"]
    >,
  }).GET;
}
