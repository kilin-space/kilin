import { defineI18n, type I18nConfig } from "fumadocs-core/i18n";
import { defineI18nUI } from "fumadocs-ui/i18n";

export const locales = ["en", "zh-cn", "zh-tw"] as const;

export type Locale = (typeof locales)[number];

export const i18nConfig = {
  languages: [...locales],
  defaultLanguage: "en",
  hideLocale: "never",
  parser: "dir",
  fallbackLanguage: null,
} satisfies I18nConfig<Locale>;

export const i18n = defineI18n(i18nConfig);

const simplifiedChineseTranslations = {
  displayName: "简体中文",
  "Ask AI(AI chat button)": "询问 AI",
  "Back to Home(404 page)": "返回首页",
  "Choose a language(language switcher)": "选择语言",
  "Choose a language(language switcher)(aria-label)": "选择语言",
  "Close Banner(banner)(aria-label)": "关闭横幅",
  "Close Search(search dialog)(aria-label)": "关闭搜索",
  "Close Sidebar(aria-label)": "关闭侧边栏",
  "Close Sidebar(sidebar)(aria-label)": "关闭侧边栏",
  "Collapse Sidebar(sidebar)(aria-label)": "收起侧边栏",
  "Copied Text(code block)(aria-label)": "已复制",
  "Copy Anchor Link(heading anchor)(aria-label)": "复制标题链接",
  "Copy Link(accordion)(aria-label)": "复制链接",
  "Copy Markdown(page actions)": "复制 Markdown",
  "Copy Text(code block)(aria-label)": "复制文本",
  "Dark(theme switcher)(aria-label)": "深色",
  "Default(type table)": "默认值",
  "Edit on GitHub(edit page)": "在 GitHub 编辑",
  "Hide Sidebar(sidebar)": "隐藏侧边栏",
  "Last updated on(page footer)": "最后更新于",
  "Layout Tab(layout tab trigger)": "布局标签",
  "Light(theme switcher)(aria-label)": "浅色",
  "Next Page(pagination)": "下一页",
  "No Headings(table of contents)": "无标题",
  "No results found(search dialog)": "未找到结果",
  "On this page(table of contents)": "本页内容",
  "Open Search(search trigger)(aria-label)": "打开搜索",
  "Open Sidebar(sidebar)(aria-label)": "打开侧边栏",
  "Open in ChatGPT(page actions)": "在 ChatGPT 中打开",
  "Open in Claude(page actions)": "在 Claude 中打开",
  "Open in Cursor(page actions)": "在 Cursor 中打开",
  "Open in GitHub(page actions)": "在 GitHub 中打开",
  "Open in Scira AI(page actions)": "在 Scira AI 中打开",
  "Open(page actions)": "打开",
  "Page Not Found(404 page)": "页面不存在",
  "Parameters(type table)": "参数",
  "Previous Page(pagination)": "上一页",
  "Prop(type table)": "属性",
  "Read {url}, I want to ask questions about it.(page actions)": "阅读 {url}，我想询问其中的内容。",
  "Returns(type table)": "返回值",
  "Search(search dialog)": "搜索文档",
  "Search(search trigger)": "搜索",
  "Show Sidebar(sidebar)": "显示侧边栏",
  "System(theme switcher)(aria-label)": "跟随系统",
  "Table of Contents(inline table of contents)": "目录",
  "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)":
    "该页面可能已被删除、更名或暂时不可用。",
  "Toggle Menu(mobile menu)(aria-label)": "切换菜单",
  "Toggle Theme(theme switcher)(aria-label)": "切换主题",
  "Type(type table)": "类型",
  "View as Markdown(page actions)": "查看 Markdown",
};

const traditionalChineseTranslations = {
  displayName: "繁體中文",
  "Ask AI(AI chat button)": "詢問 AI",
  "Back to Home(404 page)": "返回首頁",
  "Choose a language(language switcher)": "選擇語言",
  "Choose a language(language switcher)(aria-label)": "選擇語言",
  "Close Banner(banner)(aria-label)": "關閉橫幅",
  "Close Search(search dialog)(aria-label)": "關閉搜尋",
  "Close Sidebar(aria-label)": "關閉側邊欄",
  "Close Sidebar(sidebar)(aria-label)": "關閉側邊欄",
  "Collapse Sidebar(sidebar)(aria-label)": "收起側邊欄",
  "Copied Text(code block)(aria-label)": "已複製",
  "Copy Anchor Link(heading anchor)(aria-label)": "複製標題連結",
  "Copy Link(accordion)(aria-label)": "複製連結",
  "Copy Markdown(page actions)": "複製 Markdown",
  "Copy Text(code block)(aria-label)": "複製文字",
  "Dark(theme switcher)(aria-label)": "深色",
  "Default(type table)": "預設值",
  "Edit on GitHub(edit page)": "在 GitHub 編輯",
  "Hide Sidebar(sidebar)": "隱藏側邊欄",
  "Last updated on(page footer)": "最後更新於",
  "Layout Tab(layout tab trigger)": "版面標籤",
  "Light(theme switcher)(aria-label)": "淺色",
  "Next Page(pagination)": "下一頁",
  "No Headings(table of contents)": "無標題",
  "No results found(search dialog)": "找不到結果",
  "On this page(table of contents)": "本頁內容",
  "Open Search(search trigger)(aria-label)": "開啟搜尋",
  "Open Sidebar(sidebar)(aria-label)": "開啟側邊欄",
  "Open in ChatGPT(page actions)": "在 ChatGPT 中開啟",
  "Open in Claude(page actions)": "在 Claude 中開啟",
  "Open in Cursor(page actions)": "在 Cursor 中開啟",
  "Open in GitHub(page actions)": "在 GitHub 中開啟",
  "Open in Scira AI(page actions)": "在 Scira AI 中開啟",
  "Open(page actions)": "開啟",
  "Page Not Found(404 page)": "頁面不存在",
  "Parameters(type table)": "參數",
  "Previous Page(pagination)": "上一頁",
  "Prop(type table)": "屬性",
  "Read {url}, I want to ask questions about it.(page actions)": "閱讀 {url}，我想詢問其中的內容。",
  "Returns(type table)": "傳回值",
  "Search(search dialog)": "搜尋文件",
  "Search(search trigger)": "搜尋",
  "Show Sidebar(sidebar)": "顯示側邊欄",
  "System(theme switcher)(aria-label)": "跟隨系統",
  "Table of Contents(inline table of contents)": "目錄",
  "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)":
    "該頁面可能已被刪除、更名或暫時無法使用。",
  "Toggle Menu(mobile menu)(aria-label)": "切換選單",
  "Toggle Theme(theme switcher)(aria-label)": "切換主題",
  "Type(type table)": "類型",
  "View as Markdown(page actions)": "檢視 Markdown",
};

export const i18nUi = defineI18nUI(i18nConfig, {
  en: { displayName: "English" },
  "zh-cn": simplifiedChineseTranslations,
  "zh-tw": traditionalChineseTranslations,
});

export function isLocale(value: string): value is Locale {
  return locales.some((locale) => locale === value);
}
