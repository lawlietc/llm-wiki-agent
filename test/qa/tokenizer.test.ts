/**
 * F5.1 CJK 分词器（06 §1.3 第 3 条，检索正确性的地基）。
 * T5.1-01~06。
 */
import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/qa/tokenizer';

describe('F5.1 CJK 分词器', () => {
  it('T5.1-01 纯中文「大语言模型」→ 输出含 1/2/3-gram，确定性有序', () => {
    const toks = tokenize('大语言模型');
    // 所有 n-gram 都应出现
    for (const g of ['大', '语', '言', '模', '型', '大语', '语言', '言模', '模型', '大语言', '语言模', '言模型']) {
      expect(toks).toContain(g);
    }
    // 确定性：同一输入顺序稳定
    expect(tokenize('大语言模型')).toEqual(toks);
  });

  it('T5.1-02 中英混排「BM25 检索」→ ASCII 词 + CJK n-gram 并存', () => {
    const toks = tokenize('BM25 检索');
    expect(toks).toContain('bm25'); // 小写化
    expect(toks).toContain('检');
    expect(toks).toContain('索');
    expect(toks).toContain('检索');
  });

  it('T5.1-03 NFKC：全角字母/compat 字符归一后命中同一词', () => {
    const full = tokenize('ＡＢＣ向量'); // 全角 ABC
    const half = tokenize('abc向量');
    // 全角 ABC 归一为 abc，两结果在 ASCII 部分应一致
    expect(full).toContain('abc');
    expect(full.filter((t) => t === 'abc')).toEqual(half.filter((t) => t === 'abc'));
  });

  it('T5.1-04 标点剔除但词内撇号/连字符/下划线保留', () => {
    const toks = tokenize("don't state-of-art foo_bar。");
    expect(toks).toContain("don't");
    expect(toks).toContain('state-of-art');
    expect(toks).toContain('foo_bar');
    // 句号等标点不应成为独立 token
    expect(toks).not.toContain('。');
  });

  it('T5.1-05 停用词小表生效（偏召回：仅高频虚词）', () => {
    const toks = tokenize('的 了 向量 数据库');
    expect(toks).toContain('向量');
    expect(toks).toContain('数据库');
    expect(toks).not.toContain('的');
    expect(toks).not.toContain('了');
  });

  it('T5.1-06 平假名/片假名/谚文段同样产 n-gram', () => {
    const hira = tokenize('こんにちは');
    expect(hira).toContain('こ');
    expect(hira).toContain('こん');
    expect(hira).toContain('こんに');
    const kata = tokenize('カタカナ');
    expect(kata).toContain('カ');
    expect(kata).toContain('カタ');
    const hangul = tokenize('한글');
    expect(hangul).toContain('한');
    expect(hangul).toContain('한글');
  });
});
