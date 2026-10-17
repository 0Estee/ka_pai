# -*- coding: utf-8 -*-
"""生成 app/js/pinyin.js：卡名首字 -> 拼音首字母。

为什么生成而不是运行时算：
  Android WebView 里没有 Intl 的拼音数据，Intl.Collator('zh-Hans-CN')
  能排序但取不到首字母；引第三方库又违背本项目「零 npm 依赖」的约定。
  所以把卡牌里出现过的汉字一次性算好，打成一张静态表。

用法（新增卡牌后重跑一次）：
  python tools/gen-pinyin.py

依赖：pip install pypinyin
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 卡牌分散在 engine/cards/*.js（test / user / user-b3 …），只扫一个文件会漏字，
# 漏掉的字在工坊里会被全丢进「其他」分组（首批卡名的首字几乎都没收进来过）。
CARD_DIR = os.path.join(ROOT, 'engine', 'cards')
OUT = os.path.join(ROOT, 'app', 'js', 'pinyin.js')

try:
    from pypinyin import pinyin, Style
except ImportError:
    sys.exit('缺少 pypinyin：python -m pip install pypinyin')

Q = chr(39)
text = ''
for name in sorted(os.listdir(CARD_DIR)):
    if name.endswith('.js'):
        text += io.open(os.path.join(CARD_DIR, name), encoding='utf-8').read() + '\n'
chars = sorted({c for c in text if '一' <= c <= '鿿'})

pairs = []
missing = []
for ch in chars:
    letter = ''
    try:
        got = pinyin(ch, style=Style.FIRST_LETTER, errors='ignore')
        if got and got[0] and got[0][0]:
            letter = got[0][0][:1].lower()
    except Exception:
        letter = ''
    if letter and 'a' <= letter <= 'z':
        pairs.append((ch, letter))
    else:
        missing.append(ch)

lines = []
lines.append('/**')
lines.append(' * 汉字 -> 拼音首字母。强化工坊按卡名首字分组排序用。')
lines.append(' *')
lines.append(' * ⚠️ 本文件由 python tools/gen-pinyin.py 生成，不要手改。')
lines.append(' *    新增卡牌后重跑一次；表里没有的字会落到 # 分组（见 initialOf）。')
lines.append(' */')
lines.append('export const PINYIN_INITIAL = {')
row = []
for ch, letter in pairs:
    row.append(Q + ch + Q + ': ' + Q + letter + Q)
    if len(row) == 12:
        lines.append('  ' + ', '.join(row) + ',')
        row = []
if row:
    lines.append('  ' + ', '.join(row) + ',')
lines.append('};')
lines.append('')
lines.append('/** 取卡名首字的拼音首字母；非汉字或未收录返回 #。 */')
lines.append('export function initialOf(name) {')
lines.append("  const s = String(name || '').trim();")
lines.append("  if (!s) return '#';")
lines.append("  return PINYIN_INITIAL[s[0]] || '#';")
lines.append('}')
lines.append('')
io.open(OUT, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print('wrote %s: %d chars' % (os.path.relpath(OUT, ROOT), len(pairs)))
if missing:
    print('no letter for %d chars: %s' % (len(missing), ''.join(missing[:40])))
