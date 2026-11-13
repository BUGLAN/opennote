import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { opennoteMarkdown } from "./mdExtensions";

export const markdownSupport = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: opennoteMarkdown,
  addKeymap: true,
});
