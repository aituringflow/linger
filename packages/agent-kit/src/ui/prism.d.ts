// PrismJS 轻量语法高亮：只用到 languages + highlight（只读预览，无编辑器功能）。
// 语言包（prismjs/components/prism-*）为副作用导入，无需类型。
declare module "prismjs" {
  export interface PrismGrammar {
    [name: string]: unknown;
  }
  const Prism: {
    languages: Record<string, PrismGrammar>;
    highlight: (code: string, grammar: PrismGrammar, language?: string) => string;
  };
  export default Prism;
}

declare module "prismjs/components/*";
