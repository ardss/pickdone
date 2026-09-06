# -*- coding: utf-8 -*-
"""style-2.css 统计段重构：合并三层覆盖为单层 + 品牌色阶替换 + 删死代码。跑一次即可。"""
import io

p = 'assets/css/style-2.css'
s = io.open(p, encoding='utf-8', newline='').read()
orig_len = len(s)

# 1) 删死 navbar 体系 + 全局裸类 .content 底色 token 化
old1 = """/* ========================= 数据复盘（StatisticsView）========================= */
/* 结构：div.page > div.navbar(4 个 navbar__item) + div.content > div.container > 子页 */
.content{flex:1;overflow:hidden;background-color:#f5f4f5}
.navbar{display:flex;flex-shrink:0;align-items:center;box-sizing:border-box;height:89px;padding:25px;border-bottom:1px solid var(--line);background:var(--panel, #fff)}
.navbar__item{margin-right:50px;color:#595959;font-weight:400;font-size:14px;line-height:20px;cursor:pointer}
.navbar__item--active{color:var(--brand-dark)}
.container{padding:0 25px}

/* 时间范围下拉（设计稿 m-select / vue-multiselect，取其定位与字号参数） */
.page__select{position:fixed;top:29.5px;right:25px;display:flex;justify-content:flex-end;width:120px;z-index:30}
.page__select__inner{width:200px;min-height:auto;color:var(--text-1)}
.page__select__inner .el-input__inner,
.page__select__inner input{min-height:auto;padding:4px;padding-right:24px;font-size:12px;line-height:22px;height:auto}
.m-select-option{position:absolute;top:0;right:0;bottom:0;left:0;min-height:30px;padding:4px;padding-left:12px;font-size:12px;line-height:22px}

"""
new1 = """/* ========================= 数据复盘（StatisticsView）========================= */
/* 结构（2026-08-29 对齐全应用）：.page__header(.title 页头) + .stat-subpage 阅读列。
   历史：本段原为构建产物逆向的 navbar/m-select 体系，页头统一重构时删除。 */
.stat-page .content{flex:1;overflow:auto;background:var(--bg)}
.stat-page .container{padding:0 25px 25px}

"""
assert old1 in s, 'block1 not found'
s = s.replace(old1, new1)

# 2) 热力图色阶：靛蓝 → 品牌明度梯度
old2 = """.hm-l0 { background: var(--gray-bg); }
.hm-l1 { background: #cdd3f2; }
.hm-l2 { background: #93a0f5; }
.hm-l3 { background: #6675ee; }
.hm-l4 { background: #4053d6; }"""
new2 = """.hm-l0 { background: var(--gray-bg); }
.hm-l1 { background: color-mix(in srgb, var(--brand) 30%, var(--gray-bg)); }
.hm-l2 { background: color-mix(in srgb, var(--brand) 55%, var(--gray-bg)); }
.hm-l3 { background: color-mix(in srgb, var(--brand) 80%, var(--gray-bg)); }
.hm-l4 { background: var(--brand); }"""
assert old2 in s, 'block2 not found'
s = s.replace(old2, new2)

# 3) 时间轴 hover 走 token
old3 = ".tl-seg.focus:hover { background: #256fc0; }"
assert old3 in s, 'block3 not found'
s = s.replace(old3, ".tl-seg.focus:hover { background: var(--brand-dark); }")

# 4) 合并三层 .stat-subpage .chart-* + 单层化 review-card/kpi（一大段整体替换）
old4_start = "/* ============ 图表容器优化 ============ */"
old4_end = ".hm-range-btn.on { color: var(--brand); border-color: var(--brand); background: var(--brand-light); }"
i1 = s.index(old4_start)
i2 = s.index(old4_end) + len(old4_end)
new4 = """/* ============ 图表卡（合并历史三层覆盖为单层，全 token 化） ============ */
.stat-subpage .single { margin-bottom: 18px; }
.stat-subpage .double { display: flex; gap: 16px; margin-bottom: 18px; }
.stat-subpage .chart-b { flex: 1; border-radius: var(--radius-md); padding: 18px 20px; color: #fff; }
.stat-subpage .chart-b__title { font-size: 13px; margin-bottom: 8px; }
.stat-subpage .chart-b__content__text { font-size: 20px; font-weight: 600; line-height: 1.3; }
.stat-subpage .chart-b__content__subcontent { display: flex; gap: 12px; font-size: 12px; margin-top: 4px; }
.stat-subpage .chart-a { border-radius: var(--radius-md); padding: 16px 18px; display: flex; align-items: center; gap: 14px; }
.stat-subpage .chart-a__icon { width: 40px; height: 40px; }
.stat-subpage .chart-a__content { font-size: 13px; line-height: 1.6; }
.stat-subpage .chart-d { border-radius: var(--radius-md); padding: 18px 20px; text-align: center; }
.stat-subpage .chart-d__count { font-size: 20px; font-weight: 600; }
.stat-subpage .chart-d__content { font-size: 13px; margin-top: 4px; }
.stat-subpage .chart-empty {
  min-height: 120px; display: flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: 13px; border-radius: var(--radius-md);
}

/* 复盘叙事卡（合并 324/557 两层定义为单层，品牌顶边） */
.review-card {
  max-width: 785px; margin: 0 auto 18px; padding: 24px 28px 22px;
  background: var(--panel, #fff);
  border: 1px solid var(--line); border-radius: 16px;
  position: relative; overflow: hidden;
  box-shadow: 0 4px 18px rgba(31, 56, 88, .08);
}
.review-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: var(--brand);
}
.review-card__head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.review-card__head b { font-size: 14px; letter-spacing: 1px; color: var(--text-1); }
.review-card__tag { font-size: 11px; color: var(--brand); background: var(--brand-light); padding: 2px 8px; border-radius: var(--radius-pill); }
.review-card__headline {
  margin: 0 0 14px; padding: 12px 16px;
  background: color-mix(in srgb, var(--brand) 8%, transparent);
  border-left: 3px solid var(--brand); border-radius: 0 var(--radius-md) var(--radius-md) 0;
  font-size: 15px; font-weight: 600; line-height: 1.6; color: var(--text-1);
}
.review-card__list { margin: 0; padding: 0; list-style: none; }
.review-card__list li {
  display: flex; align-items: baseline; gap: 8px;
  padding: 6px 0; font-size: 14px; line-height: 1.65; color: var(--text-1);
}
.review-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--brand); transform: translateY(-2px); }
html[data-theme="dark"] .review-card { background: var(--panel); border-color: var(--line); }
html[data-theme="dark"] .review-card::before { opacity: .8; }

/* KPI 对比条（品牌顶线 + 差值胶囊，单层） */
.kpi-row { display: flex; gap: 14px; max-width: 785px; margin: 0 auto 18px; }
.kpi-tile {
  flex: 1; padding: 14px 16px 12px; background: var(--panel, #fff);
  border: 1px solid var(--line); border-radius: var(--radius-lg);
}
.kpi-tile__title { font-size: 12px; color: var(--text-3); }
.kpi-tile__value { margin-top: 4px; font-size: 20px; font-weight: 600; color: var(--text-1); line-height: 1.2; }
.kpi-tile__sub { margin-top: 6px; font-size: 11.5px; color: var(--text-3); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.kpi-tile::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: var(--brand); opacity: .5; }
.kpi-delta { font-weight: 700; padding: 1px 8px; border-radius: var(--radius-pill); font-size: 11px; }
.kpi-delta.good { color: var(--ok, #1f7a55); background: color-mix(in srgb, var(--ok, #2ba471) 12%, transparent); }
.kpi-delta.warn { color: var(--warn, #9c6009); background: color-mix(in srgb, var(--warn, #d08b1f) 14%, transparent); }
.kpi-delta.flat { color: var(--text-3); font-weight: 400; }
html[data-theme="dark"] .kpi-tile { background: var(--panel); border-color: var(--line); }

/* 注意力去向（分类条形） */
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
s = s[:i1] + new4 + s[i2:]

# 5) 删除 theme-dark 内联散写里的旧面板色（style-2 内的暗色行改走 token）
s = s.replace('html[data-theme="dark"] .review-card { background: #1c1f26; }',
              'html[data-theme="dark"] .review-card { background: var(--panel); }')
s = s.replace('html[data-theme="dark"] .review-card__tag { color: #a5b0f6; }',
              'html[data-theme="dark"] .review-card__tag { color: #6ea8e8; }')
s = s.replace('html[data-theme="dark"] .review-advice-chip { color: #a5b0f6; }',
              'html[data-theme="dark"] .review-advice-chip { color: #6ea8e8; }')
s = s.replace('html[data-theme="dark"] .kpi-tile { background: #1c1f26; border-color: #2a2f38; }',
              'html[data-theme="dark"] .kpi-tile { background: var(--panel); border-color: var(--line); }')
s = s.replace('html[data-theme="dark"] .review-card { background: #1c1f26; border-color: #2a2f38; }',
              'html[data-theme="dark"] .review-card { background: var(--panel); border-color: var(--line); }')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('done, size', orig_len, '->', len(s))
