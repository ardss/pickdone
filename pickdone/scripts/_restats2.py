# -*- coding: utf-8 -*-
"""style-2.css 统计段第二遍：去除与“改版二”层的重复，收口死规则。"""
import io

p = 'assets/css/style-2.css'
s = io.open(p, encoding='utf-8', newline='').read()

# A) 从“图表卡合并块”中删除与改版二层重复的规则（改版二层为最终生效值）
dup_start = "/* 复盘叙事卡（合并 324/557 两层定义为单层，品牌顶边） */"
dup_end = ".hm-range-btn.on { color: var(--brand); border-color: var(--brand); background: var(--brand-light); }"
i1 = s.index(dup_start)
i2 = s.index(dup_end) + len(dup_end)
# 保留 .att-* 与 .hm-range*（改版二层没有它们）
keep_att = """/* 注意力去向（分类条形） */
.att-rows { display: flex; flex-direction: column; gap: 10px; padding: 14px 4px 8px; }
.att-row { display: flex; align-items: center; gap: 12px; }
.att-label { flex-shrink: 0; width: 90px; font-size: 12.5px; color: var(--text-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-track { flex: 1; height: 14px; background: var(--gray-bg); border-radius: 7px; overflow: hidden; }
.att-bar { height: 100%; border-radius: 7px; background: var(--brand); transition: width .3s ease; }
.att-value { flex-shrink: 0; width: 72px; font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }

/* 热力图范围切换 */
.hm-range-toggle { display: inline-flex; gap: 4px; margin: 0 10px; }
.hm-range-btn {
  border: 1px solid var(--line); background: none; color: var(--text-3);
  font-size: 11px; padding: 2px 10px; border-radius: var(--radius-pill); cursor: pointer;
}
.hm-range-btn.on { color: var(--brand); border-color: var(--brand); background: var(--brand-light); }"""
s = s[:i1] + keep_att + s[i2:]

# B) 清理改版二层：重复 ::before 三连 → 单条；删死掉的 stat-empty/stat-hero/重复 headline
old_kpi = """.kpi-tile { position: relative; padding-top: 16px; overflow: hidden;  }
.kpi-tile::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: var(--brand); opacity: .55; }
.kpi-tile::before { background: var(--brand); opacity: .5; }
.kpi-tile::before { background: var(--brand); opacity: .5; }
.kpi-tile::before { background: var(--brand); opacity: .5; }"""
new_kpi = """.kpi-tile { position: relative; padding-top: 16px; overflow: hidden; }
.kpi-tile::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: var(--brand); opacity: .55; }"""
assert old_kpi in s, 'kpi triple not found'
s = s.replace(old_kpi, new_kpi)

# 删两处 .stat-empty*（模板已改用 .empty 插画结构）
old_empty1 = """.stat-empty { text-align: center; padding: 60px 24px; }
.stat-empty .stat-empty-icon { width: 64px; height: 64px; margin: 0 auto 16px; border-radius: 16px; background: var(--brand-light); display: flex; align-items: center; justify-content: center; }
.stat-empty .stat-empty-btn { margin-top: 16px; background: var(--brand); color: #fff; border: 0; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.stat-empty .stat-empty-btn:hover { background: var(--brand-dark, #0e8f92); }

"""
assert old_empty1 in s, 'stat-empty 1 not found'
s = s.replace(old_empty1, '')

# 删 .stat-hero / .stat-hero__title / .stat-hero__sub（标题已升页头，不再使用）
old_hero = """.stat-hero {
  padding: 0 0 4px; margin-bottom: 8px;
}
.stat-hero__title { font-size: 18px; font-weight: 700; color: var(--text-1); }
.stat-hero__sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }

"""
assert old_hero in s, 'stat-hero not found'
s = s.replace(old_hero, '')

# 两个 stat-hero__headline 重复 → 保留一个（用于基线对比卡的左线强调条）
old_hl = """.stat-hero__headline {
  margin-top: 14px; padding: 12px 16px;
  background: linear-gradient(135deg, var(--brand-light, #eef1fe), transparent);
  border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0;
  font-size: 15px; font-weight: 600; line-height: 1.6; color: var(--text-1);
}

/* 复盘卡 headline */
.stat-hero__headline {
  padding: 12px 16px; margin-bottom: 12px;
  background: linear-gradient(135deg, var(--brand-light, #eef1fe), transparent);
  border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0;
  font-size: 15px; font-weight: 600; line-height: 1.6; color: var(--text-1);
}"""
new_hl = """.stat-hero__headline {
  margin-bottom: 12px; padding: 12px 16px;
  background: color-mix(in srgb, var(--brand) 8%, transparent);
  border-left: 3px solid var(--brand); border-radius: 0 var(--radius-md) var(--radius-md) 0;
  font-size: 15px; font-weight: 600; line-height: 1.6; color: var(--text-1);
}"""
assert old_hl in s, 'headline dup not found'
s = s.replace(old_hl, new_hl)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('pass2 done')
